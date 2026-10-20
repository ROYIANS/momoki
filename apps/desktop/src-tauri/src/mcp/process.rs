//! One explicit user-configured executable and its ordinary process tree.
use super::{MESSAGE_BYTES, McpError, Result, bounded::BoundedLines};
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};

/// Minimal names a child needs to locate executables and the OS runtime. The
/// rest of the parent environment (credentials, tokens) is never inherited;
/// explicit per-server variables are applied afterwards and win.
const INHERITED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "LANG",
    "TMPDIR",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "TEMP",
    "TMP",
];
fn inherited_env(lookup: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    INHERITED_ENV
        .iter()
        .filter_map(|name| {
            lookup(name)
                .filter(|v| v.len() <= 8192 && !v.contains('\0'))
                .map(|v| ((*name).to_owned(), v))
        })
        .collect()
}

pub(crate) struct OwnedProcess {
    child: Option<Box<dyn ChildWrapper>>,
    stderr: Option<JoinHandle<()>>,
    pub(crate) stderr_bytes: Arc<AtomicUsize>,
    drain: Option<JoinHandle<Result<()>>>,
    drain_result: Option<Result<()>>,
}
impl OwnedProcess {
    pub(crate) fn spawn(
        executable: &Path,
        args: &[String],
        cwd: Option<&Path>,
        env: &HashMap<String, String>,
    ) -> Result<(Self, BoundedLines<ChildStdout>, ChildStdin)> {
        if !executable.is_absolute()
            || args.len() > 128
            || env.len() > 64
            || executable.to_string_lossy().len() > 4096
            || args.iter().any(|s| s.len() > 8192 || s.contains('\0'))
            || env.iter().any(|(k, v)| {
                k.is_empty()
                    || k.len() > 256
                    || k.contains(['\0', '='])
                    || v.len() > 8192
                    || v.contains('\0')
            })
        {
            return Err(McpError::Limit);
        }
        #[cfg(windows)]
        if executable
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
        {
            return Err(McpError::Endpoint);
        }
        let mut command = Command::new(executable);
        command
            .args(args)
            .env_clear()
            .envs(inherited_env(|name| std::env::var(name).ok()))
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut command: CommandWrap = command.into();
        command.wrap(KillOnDrop);
        #[cfg(unix)]
        command.wrap(process_wrap::tokio::ProcessGroup::leader());
        #[cfg(windows)]
        command.wrap(process_wrap::tokio::JobObject);
        let mut child = command.spawn().map_err(|_| McpError::Transport)?;
        let stdout = child.stdout().take().ok_or(McpError::Transport)?;
        let stdin = child.stdin().take().ok_or(McpError::Transport)?;
        let stderr = child.stderr().take().ok_or(McpError::Transport)?;
        let count = Arc::new(AtomicUsize::new(0));
        let read_count = Arc::clone(&count);
        let stderr = tokio::spawn(async move {
            let mut read = BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            while let Ok(n) = read.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                // Retain only a saturated count; never stderr text or credentials.
                let _ = read_count.try_update(Ordering::Relaxed, Ordering::Relaxed, |n0| {
                    Some(n0.saturating_add(n).min(64 * 1024))
                });
            }
        });
        Ok((
            Self {
                child: Some(child),
                stderr: Some(stderr),
                stderr_bytes: count,
                drain: None,
                drain_result: None,
            },
            BoundedLines::new(stdout, MESSAGE_BYTES),
            stdin,
        ))
    }
    pub(crate) fn id(&self) -> Option<u32> {
        self.child.as_ref().and_then(|child| child.id())
    }
    pub(crate) async fn stop(&mut self) -> Result<()> {
        self.wait_for_drain(std::time::Duration::from_secs(5)).await
    }
    async fn wait_for_drain(&mut self, deadline: std::time::Duration) -> Result<()> {
        if let Some(result) = self.drain_result {
            return result;
        }
        if self.drain.is_none() {
            let mut child = self.child.take().ok_or(McpError::DrainUnknown)?;
            let stderr = self.stderr.take();
            let _ = child.start_kill();
            // process-wrap caches the parent's exit before waiting for the
            // complete group/job. Never cancel and recreate that wait: a later
            // wait could return the cached parent status without drainage.
            self.drain = Some(tokio::spawn(async move {
                child.wait().await.map_err(|_| McpError::DrainUnknown)?;
                if let Some(stderr) = stderr {
                    stderr.await.map_err(|_| McpError::DrainUnknown)?;
                }
                Ok(())
            }));
        }
        // A timeout or cancellation only stops this caller's wait. The original
        // task retains the process owner and is polled again on repeated Stop.
        let joined =
            tokio::time::timeout(deadline, self.drain.as_mut().ok_or(McpError::DrainUnknown)?)
                .await
                .map_err(|_| McpError::DrainUnknown)?;
        let result = joined.unwrap_or(Err(McpError::DrainUnknown));
        self.drain.take();
        self.drain_result = Some(result);
        result
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // Drop is best effort, not a stopped acknowledgement. Normal disconnect
        // awaits stop() and retains the owner when that returns DrainUnknown.
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

#[cfg(all(test, any(unix, windows)))]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;
    use std::{future::Future, io, pin::Pin, process::ExitStatus, time::Duration};
    use tokio::{io::AsyncReadExt as _, sync::Notify};

    #[test]
    fn mcp_stdio_env_inherits_only_the_minimal_allowlist() {
        let parent: HashMap<&str, &str> = HashMap::from([
            ("PATH", "/usr/bin"),
            ("SystemRoot", "C:\\Windows"),
            ("OPENAI_API_KEY", "secret"),
            ("AWS_SECRET_ACCESS_KEY", "secret"),
        ]);
        let got = inherited_env(|n| parent.get(n).map(|v| (*v).to_owned()));
        assert!(got.contains(&("PATH".into(), "/usr/bin".into())));
        assert!(got.contains(&("SystemRoot".into(), "C:\\Windows".into())));
        assert!(got.iter().all(|(k, _)| INHERITED_ENV.contains(&k.as_str())));
        assert!(!got.iter().any(|(k, _)| k.contains("KEY")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_stdio_child_sees_path_but_not_other_parent_secrets() {
        // SAFETY: test-only variable with a unique name; only read by the child.
        unsafe { std::env::set_var("MOMOKI_TEST_PARENT_SECRET", "x") };
        let (mut p, mut out, _stdin) = OwnedProcess::spawn(
            Path::new("/bin/sh"),
            &[
                "-c".into(),
                "printf '%s|%s|%s' \"${PATH:+path}\" \"${MOMOKI_TEST_PARENT_SECRET:-none}\" \"$EXPLICIT\"".into(),
            ],
            None,
            &HashMap::from([("EXPLICIT".to_owned(), "yes".to_owned())]),
        )
        .unwrap();
        let mut text = String::new();
        out.read_to_string(&mut text).await.unwrap();
        assert_eq!(text, "path|none|yes");
        p.stop().await.unwrap();
    }

    /// Reproduces process-wrap's cached parent status while descendants drain.
    #[derive(Debug)]
    struct CachedParentChild {
        waits: Arc<AtomicUsize>,
        kills: Arc<AtomicUsize>,
        release: Arc<Notify>,
    }
    impl ChildWrapper for CachedParentChild {
        fn inner(&self) -> &dyn ChildWrapper {
            self
        }
        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            self
        }
        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            self
        }
        fn start_kill(&mut self) -> io::Result<()> {
            self.kills.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>> {
            let first = self.waits.fetch_add(1, Ordering::SeqCst) == 0;
            Box::pin(async move {
                if first {
                    self.release.notified().await;
                }
                Ok(ExitStatus::from_raw(0))
            })
        }
    }

    #[tokio::test]
    async fn mcp_stop_timeout_and_cancellation_keep_the_original_group_drain() {
        let waits = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let mut owner = OwnedProcess {
            child: Some(Box::new(CachedParentChild {
                waits: waits.clone(),
                kills: kills.clone(),
                release: release.clone(),
            })),
            stderr: None,
            stderr_bytes: Arc::new(AtomicUsize::new(0)),
            drain: None,
            drain_result: None,
        };
        assert_eq!(
            owner.wait_for_drain(Duration::from_millis(10)).await,
            Err(McpError::DrainUnknown)
        );
        assert_eq!(waits.load(Ordering::SeqCst), 1);
        // Cancelling a later caller must not restart wait() and receive the
        // parent's cached status before the held descendant has actually exited.
        assert!(
            tokio::time::timeout(Duration::from_millis(10), owner.stop())
                .await
                .is_err()
        );
        assert_eq!(waits.load(Ordering::SeqCst), 1);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        release.notify_one();
        owner.stop().await.unwrap();
        owner.stop().await.unwrap();
        assert_eq!(waits.load(Ordering::SeqCst), 1);
    }
}
