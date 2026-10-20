#![cfg(feature = "test-hooks")]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};
struct Probe {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Probe {
    fn open(root: &Path, create: bool, pause: Option<(&str, &Path, &Path)>) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_product_store_probe"));
        cmd.arg(if create { "create" } else { "open" })
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some((point, marker, release)) = pause {
            cmd.args(["--pause", point, "--marker"])
                .arg(marker)
                .arg("--release")
                .arg(release);
        }
        let mut child = cmd.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut p = Self {
            child,
            input,
            output,
        };
        assert_eq!(p.read()["ready"], true);
        p
    }
    fn read(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "Probe ended");
        serde_json::from_str(&line).unwrap()
    }
    fn send(&mut self, r: Value) {
        writeln!(self.input, "{}", r).unwrap();
        self.input.flush().unwrap();
    }
    fn request(&mut self, kind: &str, r: Value) -> Value {
        self.send(json!({"type":"store","request":{"type":kind,"request":r}}));
        let result = self.read();
        assert_eq!(result["ok"], true, "{result}");
        result["value"].clone()
    }
    fn kill(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn root() -> PathBuf {
    std::env::temp_dir().join(format!("momoki-full-process-{}", uuid::Uuid::new_v4()))
}
fn begin(p: &mut Probe, session: &Value) -> Value {
    let mut r = session.clone();
    r.as_object_mut().unwrap().remove("changeSequence");
    r["operationId"] = json!(uuid::Uuid::new_v4().to_string());
    r["mode"] = json!("rw");
    r["tables"] = json!(["projects", "agentToolCalls"]);
    p.request("begin", r)
}
fn prepare(p: &mut Probe, h: &Value) -> Value {
    let entry = json!({"kind":"mutation","mutation":{"kind":"put","table":"projects","key":"p","value":["obj",[["id",["str","p"]],["title",["str","Durable"]]]]}});
    let payload = entry.to_string() + "\n";
    let mut sha = Sha256::new();
    sha.update(b"momoki-batch-v1\n");
    sha.update(payload.as_bytes());
    let fingerprint = sha
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let mut r = h.clone();
    r["payload"] = json!(payload);
    r["chunkIndex"] = json!(0);
    p.request("prepare", r);
    let mut r = h.clone();
    r["chunkCount"] = json!(1);
    r["fingerprint"] = json!(fingerprint);
    let sealed = p.request("seal", r);
    let mut r = h.clone();
    r["capability"] = sealed["capability"].clone();
    r["fingerprint"] = json!(fingerprint);
    r
}
fn wait_marker(marker: &Path, p: &mut Probe) {
    let until = Instant::now() + Duration::from_secs(15);
    while !marker.exists() {
        assert!(
            p.child.try_wait().unwrap().is_none(),
            "Process exited before fault point"
        );
        assert!(Instant::now() < until, "Fault hook timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn kill_roundtrip(point: &str, committed: bool) {
    let root = root();
    let parent = root.parent().unwrap();
    let marker = parent.join(format!("{}.marker", uuid::Uuid::new_v4()));
    let release = parent.join(format!("{}.release", uuid::Uuid::new_v4()));
    let mut p = Probe::open(&root, true, Some((point, &marker, &release)));
    let session = p.request("open", json!({}));
    let h = begin(&mut p, &session);
    let commit = prepare(&mut p, &h);
    p.send(json!({"type":"store","request":{"type":"commit","request":commit}}));
    wait_marker(&marker, &mut p);
    p.kill();
    drop(p);
    for _ in 0..2 {
        let mut p = Probe::open(&root, false, None);
        let mut session = p.request("open", json!({}));
        session.as_object_mut().unwrap().remove("changeSequence");
        let mut r = session.clone();
        r["operationId"] = h["operationId"].clone();
        r["fingerprint"] = commit["fingerprint"].clone();
        let status = p.request("status", r);
        assert_eq!(
            status["status"],
            if committed { "committed" } else { "pending" }
        );
        let h = begin(&mut p, &session);
        let mut r = h.clone();
        r["table"] = json!("projects");
        r["keys"] = json!(["p"]);
        let rows = p.request("get", r);
        assert_eq!(rows["rows"][0].is_null(), !committed);
        p.request("abort", h);
    }
    fs::remove_file(marker).unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn actual_process_death_before_commit_leaves_no_ready_rows_or_false_rollback() {
    kill_roundtrip("product-precommit", false)
}
#[test]
fn actual_process_death_after_commit_preserves_receipt_without_replay() {
    kill_roundtrip("product-committed", true)
}
#[test]
fn actual_second_process_exclusive_lock_and_release_barrier() {
    let root = root();
    let mut p = Probe::open(&root, true, None);
    let status = Command::new(env!("CARGO_BIN_EXE_product_store_probe"))
        .arg("open")
        .arg(&root)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!status.status.success());
    p.kill();
    drop(p);
    let p = Probe::open(&root, false, None);
    drop(p);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn unknown_files_and_unsupported_roots_are_not_overwritten() {
    let root = root();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("keep.txt"), b"unchanged").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_product_store_probe"))
        .arg("open")
        .arg(&root)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(fs::read(root.join("keep.txt")).unwrap(), b"unchanged");
    assert!(!root.join(".local").exists());
    fs::remove_dir_all(root).unwrap();
}
