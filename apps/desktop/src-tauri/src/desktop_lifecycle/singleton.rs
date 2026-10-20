//! The lock, not successful activation, admits the one product owner.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
    time::{Instant, timeout},
};

const FRAME_BYTES: usize = 256;
const IO_TIMEOUT: Duration = Duration::from_secs(1);
const READY_TIMEOUT: Duration = Duration::from_secs(3);
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u32,
    port: u16,
    nonce: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    version: u32,
    activate: bool,
    nonce: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Ack {
    Accepted,
    Closing,
    NotReady,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u32,
    status: Ack,
}
pub(crate) enum Admission {
    Owner(Singleton),
    Contender(PathBuf),
}
pub(crate) struct Singleton {
    _lock: File,
    root: PathBuf,
    stop: tokio_util::sync::CancellationToken,
    #[cfg(windows)]
    _directories: Vec<crate::paths::DirectoryGuard>,
}
impl Drop for Singleton {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
#[derive(Default)]
pub(crate) struct ActivationState {
    pub ready: AtomicBool,
    pub closing: AtomicBool,
    pub pending: AtomicBool,
}

fn private_directory(root: &Path) -> Result<()> {
    fs::create_dir_all(root)?;
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::new(
            "profile",
            "Invalid application lifecycle directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    crate::paths::ordinary_directory(root)?;
    #[cfg(windows)]
    windows_private(root)?;
    Ok(())
}
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}
pub(crate) fn acquire(root: &Path) -> Result<Admission> {
    private_directory(root)?;
    #[cfg(windows)]
    let directories = crate::paths::pin_ancestors(root)?;
    let path = root.join("owner.lock");
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(Error::new("profile", "Invalid application lifecycle lock"));
    }
    // Never truncate or unlink this path, even after an unclean previous exit.
    let file = private_options().create(true).truncate(false).open(&path)?;
    let named = crate::paths::ordinary(&path, 1)?;
    let opened = crate::paths::stat_file(&file)?;
    if !opened.is_file() || opened.is_alias() || named.identity() != opened.identity() {
        return Err(Error::new("profile", "Invalid application lifecycle lock"));
    }
    match file.try_lock() {
        Ok(()) => Ok(Admission::Owner(Singleton {
            _lock: file,
            root: root.to_owned(),
            stop: tokio_util::sync::CancellationToken::new(),
            #[cfg(windows)]
            _directories: directories,
        })),
        Err(std::fs::TryLockError::WouldBlock) => Ok(Admission::Contender(root.to_owned())),
        Err(std::fs::TryLockError::Error(_)) => Err(Error::new(
            "profile",
            "Application ownership lock unavailable",
        )),
    }
}
async fn frame(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::with_capacity(FRAME_BYTES);
    // A bounded single JSON line; no read_until allocation before enforcing cap.
    loop {
        let byte = stream.read_u8().await?;
        if byte == b'\n' {
            return Ok(result);
        }
        if result.len() == FRAME_BYTES {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        result.push(byte);
    }
}
fn metadata(root: &Path) -> Result<Metadata> {
    let path = root.join("activation.json");
    if !fs::symlink_metadata(&path)?.is_file() {
        return Err(Error::new("profile", "Activation metadata unavailable"));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take((FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > FRAME_BYTES {
        return Err(Error::new("profile", "Invalid activation metadata"));
    }
    let meta: Metadata = serde_json::from_slice(&bytes)?;
    if meta.version != 1 || meta.port == 0 || uuid::Uuid::parse_str(&meta.nonce).is_err() {
        return Err(Error::new("profile", "Invalid activation metadata"));
    }
    Ok(meta)
}
pub(crate) async fn activate(root: &Path) -> Ack {
    let deadline = Instant::now() + READY_TIMEOUT;
    let operation = async {
        loop {
            if let Ok(meta) = metadata(root) {
                let attempt = async {
                    let mut stream = timeout(
                        IO_TIMEOUT,
                        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, meta.port)),
                    )
                    .await
                    .ok()?
                    .ok()?;
                    let mut bytes = serde_json::to_vec(&Activation {
                        version: 1,
                        activate: true,
                        nonce: meta.nonce,
                    })
                    .ok()?;
                    bytes.push(b'\n');
                    timeout(IO_TIMEOUT, stream.write_all(&bytes))
                        .await
                        .ok()?
                        .ok()?;
                    let reply: Reply = serde_json::from_slice(
                        &timeout(IO_TIMEOUT, frame(&mut stream)).await.ok()?.ok()?,
                    )
                    .ok()?;
                    (reply.version == 1).then_some(reply.status)
                };
                if let Some(ack @ (Ack::Accepted | Ack::Closing)) = attempt.await {
                    return ack;
                }
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    };
    tokio::time::timeout_at(deadline, operation)
        .await
        .unwrap_or(Ack::NotReady)
}
impl Singleton {
    pub(crate) fn matches_root(&self, root: &Path) -> bool {
        self.root == root
    }
    pub(crate) fn listen(
        &self,
        state: Arc<ActivationState>,
        show: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let meta = Metadata {
            version: 1,
            port: listener.local_addr()?.port(),
            nonce: uuid::Uuid::new_v4().to_string(),
        };
        let nonce = meta.nonce.clone();
        let temporary = self
            .root
            .join(format!("activation-{}.tmp", uuid::Uuid::new_v4()));
        let mut file = private_options().create_new(true).open(&temporary)?;
        file.write_all(&serde_json::to_vec(&meta)?)?;
        file.sync_all()?;
        drop(file);
        // Windows rename cannot replace an existing destination. Only the held
        // owner may retire stale metadata; the lock file remains untouched.
        let destination = self.root.join("activation.json");
        #[cfg(not(windows))]
        fs::rename(&temporary, &destination)?;
        #[cfg(windows)]
        windows_replace(&temporary, &destination)?;
        let stop = self.stop.clone();
        tauri_spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                return;
            };
            let slots = Arc::new(Semaphore::new(8));
            loop {
                let accepted = tokio::select! { _=stop.cancelled()=>break, accepted=listener.accept()=>accepted };
                let Ok((mut stream, peer)) = accepted else {
                    break;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(slot) = slots.clone().try_acquire_owned() else {
                    continue;
                };
                let state = state.clone();
                let show = show.clone();
                let nonce = nonce.clone();
                let stop = stop.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    let operation = timeout(IO_TIMEOUT, async {
                        let bytes = frame(&mut stream).await?;
                        let request: Activation = serde_json::from_slice(&bytes)
                            .map_err(|_| std::io::ErrorKind::InvalidData)?;
                        if request.version != 1 || !request.activate || request.nonce != nonce {
                            return Err(std::io::ErrorKind::PermissionDenied.into());
                        }
                        let status = if state.closing.load(Ordering::Acquire) {
                            Ack::Closing
                        } else if state.ready.load(Ordering::Acquire) {
                            show();
                            Ack::Accepted
                        } else {
                            state.pending.store(true, Ordering::Release);
                            Ack::NotReady
                        };
                        let mut reply = serde_json::to_vec(&Reply { version: 1, status })
                            .map_err(|_| std::io::ErrorKind::InvalidData)?;
                        reply.push(b'\n');
                        stream.write_all(&reply).await
                    });
                    tokio::select! { _=stop.cancelled()=>{}, _=operation=>{} }
                });
            }
        });
        Ok(())
    }
}
#[cfg(windows)]
fn windows_replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // SAFETY: owned NUL-terminated paths survive the synchronous Win32 call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(Error::new(
            "profile",
            "Unable to publish application activation metadata",
        ));
    }
    Ok(())
}
#[cfg(windows)]
fn windows_private(root: &Path) -> Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                SE_FILE_OBJECT, SetNamedSecurityInfoW,
            },
            DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
            PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    // Protected DACL: only each object's actual owner and SYSTEM. Inherit it
    // into metadata/lock children, rather than trusting generic parent ACLs.
    let sddl = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)"
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let path = root
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut descriptor = ptr::null_mut();
    // SAFETY: Win32 allocates the descriptor; LocalFree below owns its release.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(Error::new("profile", "Application private ACL unavailable"));
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = ptr::null_mut();
    // SAFETY: descriptor remains live and outputs are valid local pointers.
    let inspected =
        unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) };
    let result = if inspected != 0 && present != 0 && !dacl.is_null() {
        unsafe {
            SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            )
        }
    } else {
        1
    };
    unsafe {
        LocalFree(descriptor);
    }
    if result != 0 {
        return Err(Error::new("profile", "Application private ACL unavailable"));
    }
    Ok(())
}
fn tauri_spawn(future: impl std::future::Future<Output = ()> + Send + 'static) {
    #[cfg(feature = "desktop")]
    {
        tauri::async_runtime::spawn(future);
    }
    #[cfg(not(feature = "desktop"))]
    {
        tokio::spawn(future);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_lifecycle_lock_child() {
        let Some(path) = std::env::var_os("MOMOKI_LIFECYCLE_TEST_ROOT") else {
            return;
        };
        let admission = acquire(Path::new(&path)).unwrap();
        let acquired = matches!(admission, Admission::Owner(_));
        if std::env::var_os("MOMOKI_LIFECYCLE_RACE").is_some() {
            if acquired {
                fs::write(
                    Path::new(&path).join(format!("primary-{}", std::process::id())),
                    b"held",
                )
                .unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while !Path::new(&path).join("release").exists()
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            return;
        }
        assert_eq!(
            acquired,
            std::env::var_os("MOMOKI_LIFECYCLE_EXPECT_OWNER").is_some()
        );
    }
    fn child(root: &Path, owner: bool) {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "desktop_lifecycle::singleton::tests::desktop_lifecycle_lock_child",
                "--nocapture",
            ])
            .env("MOMOKI_LIFECYCLE_TEST_ROOT", root);
        if owner {
            command.env("MOMOKI_LIFECYCLE_EXPECT_OWNER", "1");
        } else {
            command.env_remove("MOMOKI_LIFECYCLE_EXPECT_OWNER");
        }
        assert!(command.status().unwrap().success());
    }
    #[tokio::test]
    async fn desktop_lifecycle_real_process_lock_activation_and_release() {
        let root =
            std::env::temp_dir().join(format!("momoki-lifecycle-{}", uuid::Uuid::new_v4()));
        let Admission::Owner(owner) = acquire(&root).unwrap() else {
            panic!("fresh owner");
        };
        child(&root, false);
        let state = Arc::new(ActivationState::default());
        let shows = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = shows.clone();
        owner
            .listen(
                state.clone(),
                Arc::new(move || {
                    count.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .unwrap();
        state.ready.store(true, Ordering::Release);
        assert_eq!(activate(&root).await, Ack::Accepted);
        assert_eq!(shows.load(Ordering::SeqCst), 1);
        state.closing.store(true, Ordering::Release);
        assert_eq!(activate(&root).await, Ack::Closing);
        assert_eq!(shows.load(Ordering::SeqCst), 1);
        drop(owner);
        child(&root, true); // stale metadata never grants ownership.
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn desktop_lifecycle_invalid_lock_fails_closed() {
        let root =
            std::env::temp_dir().join(format!("momoki-lifecycle-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("owner.lock")).unwrap();
        assert!(acquire(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn desktop_lifecycle_simultaneous_processes_and_crash_release() {
        let root =
            std::env::temp_dir().join(format!("momoki-lifecycle-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let spawn = || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "desktop_lifecycle::singleton::tests::desktop_lifecycle_lock_child",
                    "--nocapture",
                ])
                .env("MOMOKI_LIFECYCLE_TEST_ROOT", &root)
                .env("MOMOKI_LIFECYCLE_RACE", "1")
                .spawn()
                .unwrap()
        };
        let mut children = (0..4).map(|_| spawn()).collect::<Vec<_>>();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let primary = loop {
            let rows = fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("primary-"))
                .collect::<Vec<_>>();
            if !rows.is_empty() {
                assert_eq!(rows.len(), 1);
                break rows[0].clone();
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        };
        let pid = primary
            .trim_start_matches("primary-")
            .parse::<u32>()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("primary-"))
                .count(),
            1
        );
        for process in &mut children {
            if process.id() == pid {
                process.kill().unwrap();
                assert!(!process.wait().unwrap().success());
            } else {
                assert!(process.wait().unwrap().success());
            }
        }
        fs::write(
            root.join("activation.json"),
            br#"{"version":1,"port":1,"nonce":"00000000-0000-0000-0000-000000000000"}"#,
        )
        .unwrap();
        child(&root, true);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn desktop_lifecycle_activation_readiness_frames_slots_and_owner_drop() {
        let root =
            std::env::temp_dir().join(format!("momoki-lifecycle-{}", uuid::Uuid::new_v4()));
        let Admission::Owner(owner) = acquire(&root).unwrap() else {
            panic!("owner")
        };
        let state = Arc::new(ActivationState::default());
        let shows = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = shows.clone();
        owner
            .listen(
                state.clone(),
                Arc::new(move || {
                    count.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .unwrap();
        let ready = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            ready.ready.store(true, Ordering::Release);
        });
        assert_eq!(activate(&root).await, Ack::Accepted);
        assert!(state.pending.load(Ordering::Acquire));
        assert_eq!(shows.load(Ordering::SeqCst), 1);
        let meta = metadata(&root).unwrap();
        for bytes in [
            vec![b'x'; FRAME_BYTES + 20],
            br#"{"version":1,"activate":true,"nonce":"wrong","url":"forbidden"}"#.to_vec(),
        ] {
            let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, meta.port))
                .await
                .unwrap();
            stream.write_all(&bytes).await.unwrap();
            stream.write_all(b"\n").await.unwrap();
            assert!(
                timeout(Duration::from_secs(2), frame(&mut stream))
                    .await
                    .unwrap()
                    .is_err()
            );
        }
        let mut held = Vec::new();
        for _ in 0..8 {
            held.push(
                TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, meta.port))
                    .await
                    .unwrap(),
            );
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
        let mut ninth = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, meta.port))
            .await
            .unwrap();
        assert!(
            timeout(Duration::from_millis(500), frame(&mut ninth))
                .await
                .unwrap()
                .is_err()
        );
        for stream in &mut held {
            assert!(
                timeout(Duration::from_secs(2), frame(stream))
                    .await
                    .unwrap()
                    .is_err()
            );
        }
        assert_eq!(activate(&root).await, Ack::Accepted);
        assert_eq!(shows.load(Ordering::SeqCst), 2);
        drop(owner);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, meta.port))
                .await
                .is_err()
        );
        let start = Instant::now();
        assert_eq!(activate(&root).await, Ack::NotReady);
        assert!(
            start.elapsed() >= Duration::from_secs(2) && start.elapsed() < Duration::from_secs(4)
        );
        let Admission::Owner(replacement) = acquire(&root).unwrap() else {
            panic!("replacement")
        };
        let replacement_state = Arc::new(ActivationState::default());
        replacement_state.ready.store(true, Ordering::Release);
        replacement
            .listen(replacement_state, Arc::new(|| {}))
            .unwrap();
        assert_ne!(metadata(&root).unwrap().nonce, meta.nonce);
        assert_eq!(activate(&root).await, Ack::Accepted);
        drop(replacement);
        fs::remove_dir_all(root).unwrap();
    }
}
