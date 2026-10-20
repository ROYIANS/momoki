use super::*;
use crate::{
    contracts::CHUNK,
    product_binary::{
        BINARY_SCHEMA, BinaryReply, BinaryRequest, BinaryStore, ManagedBinaryRef, claim_prepared,
    },
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    path::PathBuf,
    time::{Duration, Instant},
};

struct Disk {
    db: rusqlite::Connection,
    binaries: BinaryStore,
}
struct Fixture {
    root: PathBuf,
    disk: Arc<Mutex<Option<Disk>>>,
    session: Session,
    reference: ManagedBinaryRef,
    previews: Arc<MediaPreviews>,
    server: MediaServer,
    current: Arc<AtomicBool>,
    id: String,
}
impl Fixture {
    fn new(length: usize) -> Self {
        let root =
            std::env::temp_dir().join(format!("momoki-media-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut db = rusqlite::Connection::open(root.join("fixture.sqlite")).unwrap();
        db.execute_batch(BINARY_SCHEMA).unwrap();
        let workspace = uuid::Uuid::new_v4().to_string();
        let mut binaries = BinaryStore::new(&root, &workspace).unwrap();
        let BinaryReply::Prepared { stage_id, .. } = binaries
            .run(
                &db,
                BinaryRequest::Prepare {
                    byte_length: length as u64,
                    mime_type: "video/mp4".into(),
                },
            )
            .unwrap()
        else {
            panic!("prepare")
        };
        let mut hash = Sha256::new();
        for offset in (0..length).step_by(CHUNK) {
            let bytes: Vec<u8> = (offset..(offset + CHUNK).min(length))
                .map(|n| (n % 251) as u8)
                .collect();
            hash.update(&bytes);
            binaries
                .write_raw(&stage_id, offset as u64, &bytes)
                .unwrap();
        }
        let BinaryReply::Sealed { claim } = binaries
            .run(
                &db,
                BinaryRequest::Seal {
                    stage_id,
                    content_hash: crate::paths::hex_digest(hash.finalize()),
                },
            )
            .unwrap()
        else {
            panic!("seal")
        };
        let verified = binaries
            .verify_claims(&db, std::slice::from_ref(&claim), &mut || Ok(()))
            .unwrap();
        let tx = db.transaction().unwrap();
        claim_prepared(&tx, &uuid::Uuid::new_v4().to_string(), &verified).unwrap();
        tx.commit().unwrap();
        let session = Session {
            version: 1,
            session: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace,
            generation: 1,
        };
        let previews = Arc::new(MediaPreviews::default());
        let initial = binaries
            .playback(&db, &claim.reference, &mut || Ok(()))
            .unwrap();
        let id = previews.insert(session.clone(), initial).unwrap();
        let disk = Arc::new(Mutex::new(Some(Disk { db, binaries })));
        let current = Arc::new(AtomicBool::new(true));
        let checked = Arc::clone(&current);
        let expected = session.clone();
        let server = MediaServer::start(
            Arc::clone(&previews),
            "tauri://localhost".into(),
            Arc::new(move |actual| {
                if !checked.load(Ordering::SeqCst)
                    || actual.session != expected.session
                    || actual.generation != expected.generation
                    || actual.workspace_id != expected.workspace_id
                {
                    return Err(Error::new("closed", "Fixture session changed"));
                }
                Ok(())
            }),
        )
        .unwrap();
        Self {
            root,
            disk,
            session,
            reference: claim.reference,
            previews,
            server,
            current,
            id,
        }
    }
    fn address(&self) -> String {
        self.server
            .url(&self.id)
            .unwrap()
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap()
            .into()
    }
    fn connect(&self, method: &str, path: &str, headers: &str) -> TcpStream {
        let mut stream = TcpStream::connect(self.address()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {}\r\n{headers}\r\n",
            self.address()
        )
        .unwrap();
        stream
    }
    fn request(&self, method: &str, headers: &str) -> Outcome {
        outcome(
            self.connect(method, &format!("/{}", self.id), headers),
            0,
            method == "HEAD",
            true,
        )
    }
    fn idle(&self) {
        self.wait_idle().unwrap();
    }
    fn wait_idle(&self) -> Result<()> {
        let start = Instant::now();
        while self.server.active_connections() != 0 {
            if start.elapsed() >= Duration::from_secs(8) {
                return Err(Error::new(
                    "fixture",
                    "Readers retained after completion/cancel",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
    fn path(&self) -> PathBuf {
        let encoded: String = self
            .reference
            .binary_id
            .as_bytes()
            .iter()
            .map(|n| format!("{n:02x}"))
            .collect();
        self.root.join("assets").join(format!("id-{encoded}"))
    }
    fn cleanup(&mut self) -> Result<()> {
        self.server.stop();
        self.wait_idle()?;
        self.previews.clear();
        if Arc::strong_count(&self.disk) != 1 {
            return Err(Error::new(
                "fixture",
                "Media fixture disk still has another owner",
            ));
        }
        let Disk { db, mut binaries } = self
            .disk
            .lock()
            .map_err(|_| Error::new("fixture", "Media fixture disk lock is poisoned"))?
            .take()
            .ok_or_else(|| Error::new("fixture", "Media fixture disk is already closed"))?;
        binaries.close(&db)?;
        drop(binaries);
        db.close().map_err(|(_, error)| error)?;
        std::fs::remove_dir_all(&self.root)?;
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            if std::thread::panicking() {
                eprintln!(
                    "Media fixture cleanup during unwind failed: {} {}",
                    error.code, error.message
                );
            } else {
                panic!(
                    "Media fixture cleanup failed: {} {}",
                    error.code, error.message
                );
            }
        }
    }
}

#[test]
fn fixture_drop_revokes_idle_preview_authority_and_closes_disk_before_removing_root() {
    let fixture = Fixture::new(33);
    let root = fixture.root.clone();
    let previews = Arc::clone(&fixture.previews);
    assert_eq!(previews.leases.lock().unwrap().len(), 1);
    assert_eq!(fixture.server.active_connections(), 0);
    drop(fixture);
    assert!(previews.leases.lock().unwrap().is_empty());
    assert!(
        !root.exists(),
        "Closed media fixture left its private directory"
    );
}

#[test]
fn fixture_shared_disk_is_a_cleanup_failure_without_masking_an_existing_body_panic() {
    for body_panics in [false, true] {
        let fixture = Fixture::new(33);
        let root = fixture.root.clone();
        let other_owner = Arc::clone(&fixture.disk);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _fixture = fixture;
            if body_panics {
                panic!("Original media fixture body failure");
            }
        }));
        let payload = outcome.expect_err("Shared disk ownership must fail fixture cleanup");
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .expect("String panic payload");
        if body_panics {
            assert_eq!(message, "Original media fixture body failure");
        } else {
            assert!(message.contains("Media fixture disk still has another owner"));
        }
        assert!(
            root.exists(),
            "Shared live disk was removed despite failed cleanup"
        );
        drop(other_owner);
        std::fs::remove_dir_all(&root).unwrap();
    }
}

struct Outcome {
    status: u16,
    headers: HashMap<String, String>,
    length: usize,
    hash: String,
}
fn headers(stream: &mut TcpStream) -> (u16, HashMap<String, String>) {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192);
    }
    let text = String::from_utf8(bytes).unwrap();
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|line| line.split_once(": "))
        .map(|(a, b)| (a.to_lowercase(), b.to_owned()))
        .collect();
    (status, headers)
}
fn outcome(mut stream: TcpStream, offset: usize, head: bool, complete: bool) -> Outcome {
    let (status, headers) = headers(&mut stream);
    let mut hash = Sha256::new();
    let mut length = 0;
    let mut bytes = [0u8; 65536];
    loop {
        let n = match stream.read(&mut bytes) {
            Ok(n) => n,
            Err(error) if status >= 400 && error.kind() == std::io::ErrorKind::ConnectionReset => {
                break;
            }
            Err(error) => panic!("Unexpected response read failure: {error}"),
        };
        if n == 0 {
            break;
        }
        assert!(!head, "HEAD returned body bytes");
        for (at, byte) in bytes[..n].iter().enumerate() {
            assert_eq!(*byte, ((offset + length + at) % 251) as u8);
        }
        hash.update(&bytes[..n]);
        length += n;
    }
    if complete && !head {
        assert_eq!(length, headers["content-length"].parse::<usize>().unwrap());
    }
    Outcome {
        status,
        headers,
        length,
        hash: crate::paths::hex_digest(hash.finalize()),
    }
}

#[test]
fn exact_ranges_keep_full_selected_response_not_a_transport_chunk() {
    assert_eq!(
        select_range(None, 90_000_000).unwrap(),
        SelectedRange {
            start: 0,
            end: 90_000_000,
            partial: false
        }
    );
    assert_eq!(
        select_range(Some("bytes=500000-"), 1_000_000).unwrap(),
        SelectedRange {
            start: 500000,
            end: 1_000_000,
            partial: true
        }
    );
    assert_eq!(
        select_range(Some("bytes=-7"), 100).unwrap(),
        SelectedRange {
            start: 93,
            end: 100,
            partial: true
        }
    );
    for range in [
        "bytes=3-1",
        "bytes=100-",
        "bytes=-0",
        "bytes=1-2,3-4",
        "bytes=+1-2",
        "bytes=1--2",
        "bytes=18446744073709551616-",
    ] {
        assert!(select_range(Some(range), 100).is_err(), "{range}");
    }
    assert_eq!(select_range(None, 0).unwrap().end, 0);
    assert_eq!(
        select_range(Some("items=0-2"), 100).unwrap(),
        SelectedRange {
            start: 0,
            end: 100,
            partial: false
        }
    );
}
#[test]
fn actual_http_streams_complete_ninety_mib_and_exact_seek_ranges() {
    let fixture = Fixture::new(90 * 1024 * 1024 + 17);
    let verified_before = crate::product_binary::test_verified_scan_bytes(&fixture.root);
    assert!(
        verified_before >= fixture.reference.byte_length,
        "The real initial whole-file scan counter must be populated"
    );
    let result = fixture.request("GET", "");
    assert_eq!(result.status, 200);
    assert_eq!(result.length, fixture.reference.byte_length as usize);
    assert_eq!(result.hash, fixture.reference.content_hash);
    assert!(!result.headers.contains_key("content-range"));
    assert!(!result.headers.contains_key("access-control-allow-origin"));
    for (start, end) in [
        (CHUNK + 11, CHUNK * 4 + 35),
        (64 * 1024 * 1024, 65 * 1024 * 1024 + 27),
        (89 * 1024 * 1024, fixture.reference.byte_length as usize),
    ] {
        let result = outcome(
            fixture.connect(
                "GET",
                &format!("/{}", fixture.id),
                &format!(
                    "Range: bytes={start}-{}\r\nOrigin: tauri://localhost\r\n",
                    end - 1
                ),
            ),
            start,
            false,
            true,
        );
        assert_eq!(result.status, 206);
        assert_eq!(result.length, end - start);
        assert_eq!(
            result.headers["content-range"],
            format!(
                "bytes {start}-{}/{}",
                end - 1,
                fixture.reference.byte_length
            )
        );
        assert_eq!(
            result.headers["access-control-allow-origin"],
            "tauri://localhost"
        );
    }
    for range in [
        "",
        "Range: bytes=262144-\r\n",
        "Range: invalid\r\n",
        "Range: bytes=999999999999-\r\n",
    ] {
        let result = fixture.request("HEAD", range);
        assert_eq!(result.status, 200);
        assert_eq!(result.length, 0);
        assert_eq!(
            result.headers["content-length"],
            fixture.reference.byte_length.to_string()
        );
        assert!(!result.headers.contains_key("content-range"));
    }
    let invalid = fixture.request("GET", "Range: bytes=999999999999-\r\n");
    assert_eq!(invalid.status, 416);
    assert_eq!(
        invalid.headers["content-range"],
        format!("bytes */{}", fixture.reference.byte_length)
    );
    fixture.idle();
    assert_eq!(
        crate::product_binary::test_verified_scan_bytes(&fixture.root),
        verified_before,
        "HTTP GET/seek/HEAD must not repeat whole-file SHA verification"
    );
    eprintln!(
        "actual media HTTP: fullBytes={} seekResponses=3 headResponses=4 extraWholeHashBytes=0 initialWholeHashBytes={verified_before}",
        fixture.reference.byte_length
    );
}
#[test]
fn sixty_five_idle_capabilities_hold_no_file_descriptor_or_reader_slot() {
    // Isolate descriptor accounting from other concurrently running fixture
    // tests. The child executes the same real disk/server test, not a mock.
    #[cfg(unix)]
    if std::env::var_os("MOMOKI_MEDIA_FD_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "product_media::tests::sixty_five_idle_capabilities_hold_no_file_descriptor_or_reader_slot", "--nocapture"])
            .env("MOMOKI_MEDIA_FD_CHILD", "1").output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        eprintln!("{}", String::from_utf8_lossy(&result.stdout));
        eprintln!("{}", String::from_utf8_lossy(&result.stderr));
        return;
    }
    let fixture = Fixture::new(33);
    #[cfg(unix)]
    let descriptors_before = own_descriptor_count();
    let mut ids = Vec::new();
    for _ in 0..66 {
        let disk = fixture.disk.lock().unwrap();
        let disk = disk.as_ref().expect("Owned media fixture disk");
        let file = disk
            .binaries
            .playback(&disk.db, &fixture.reference, &mut || Ok(()))
            .unwrap();
        ids.push(
            fixture
                .previews
                .insert(fixture.session.clone(), file)
                .unwrap(),
        );
    }
    assert_eq!(fixture.server.active_connections(), 0);
    assert_eq!(fixture.previews.leases.lock().unwrap().len(), 67);
    #[cfg(unix)]
    {
        let descriptors_after = own_descriptor_count();
        assert_eq!(
            descriptors_after, descriptors_before,
            "Idle capabilities leaked file descriptors"
        );
        eprintln!(
            "actual media idle authority: capabilities=67 fdBefore={descriptors_before} fdAfter={descriptors_after} activeReaders=0"
        );
    }
    // Every capability still works after >64 preceding live cards; no FIFO deadlock.
    for id in &ids {
        let result = outcome(
            fixture.connect("GET", &format!("/{id}"), ""),
            0,
            false,
            true,
        );
        assert_eq!(result.status, 200);
        assert_eq!(result.length, 33);
    }
    let mut foreign = fixture.session.clone();
    foreign.generation += 1;
    assert!(fixture.previews.release(&foreign, &ids[65]).is_err());
    fixture
        .previews
        .release(&fixture.session, &ids[65])
        .unwrap();
    assert_eq!(
        outcome(
            fixture.connect("HEAD", &format!("/{}", ids[65]), "Range: bytes=0-1\r\n"),
            0,
            true,
            true
        )
        .status,
        410
    );
    fixture.idle();
}

#[cfg(unix)]
fn own_descriptor_count() -> usize {
    #[cfg(target_os = "macos")]
    let directory = "/dev/fd";
    #[cfg(not(target_os = "macos"))]
    let directory = "/proc/self/fd";
    std::fs::read_dir(directory).unwrap().count()
}
#[test]
fn actual_http_rejects_foreign_host_origin_paths_body_and_methods() {
    let fixture = Fixture::new(100);
    for origin in [
        "null",
        "https://evil.example",
        "tauri://localhost.evil",
        "http://localhost",
    ] {
        assert_eq!(
            fixture
                .request("GET", &format!("Origin: {origin}\r\n"))
                .status,
            403
        );
    }
    for path in [
        "/../assets",
        "/file:///private/secret",
        "/%2e%2e",
        &format!("/{}?path=x", fixture.id),
        &format!("/{}#x", fixture.id),
    ] {
        assert_eq!(
            outcome(fixture.connect("GET", path, ""), 0, false, true).status,
            400
        );
    }
    assert_eq!(fixture.request("POST", "").status, 405);
    assert_eq!(fixture.request("OPTIONS", "").status, 405);
    for header in [
        "Content-Length: 1\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Authorization: Bearer x\r\n",
        "Cookie: x=1\r\n",
        "Origin: tauri://localhost\r\nOrigin: null\r\n",
    ] {
        assert_eq!(fixture.request("GET", header).status, 400);
    }
    let mut raw = TcpStream::connect(fixture.address()).unwrap();
    write!(
        raw,
        "GET /{} HTTP/1.1\r\nHost: evil.example\r\n\r\n",
        fixture.id
    )
    .unwrap();
    assert_eq!(outcome(raw, 0, false, true).status, 403);
    let oversized = format!("X-Fill: {}\r\n", "x".repeat(9000));
    assert_eq!(fixture.request("GET", &oversized).status, 400);
    fixture.idle();
}
#[test]
fn current_session_revocation_missing_and_symlink_containment_fail_closed() {
    let fixture = Fixture::new(CHUNK * 3 + 9);
    fixture.current.store(false, Ordering::SeqCst);
    assert_eq!(fixture.request("HEAD", "").status, 410);
    fixture.current.store(true, Ordering::SeqCst);
    let path = fixture.path();
    std::fs::remove_file(&path).unwrap();
    assert_eq!(fixture.request("HEAD", "").status, 410);
    assert_eq!(fixture.request("HEAD", "Range: bytes=0-1\r\n").status, 410);
    #[cfg(unix)]
    {
        let outside =
            std::env::temp_dir().join(format!("momoki-media-outside-{}", uuid::Uuid::new_v4()));
        std::fs::write(&outside, b"outside unchanged").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert_eq!(fixture.request("GET", "").status, 410);
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside unchanged");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(outside).unwrap();
    }
    fixture.previews.clear();
    assert_eq!(fixture.request("HEAD", "").status, 410);
    fixture.idle();
}

#[test]
fn warm_capability_rewrite_replacement_and_restoration_never_reauthorize_or_rescan() {
    for rewrite_same_inode in [true, false] {
        let fixture = Fixture::new(CHUNK * 3 + 9);
        let scanned = crate::product_binary::test_verified_scan_bytes(&fixture.root);
        assert!(scanned >= fixture.reference.byte_length);
        let path = fixture.path();
        let original = path.with_extension("original-fixture-file");
        if rewrite_same_inode {
            let mut file = std::fs::File::options().write(true).open(&path).unwrap();
            file.write_all(b"changed").unwrap();
            file.set_modified(std::time::SystemTime::now() + Duration::from_secs(1))
                .unwrap();
        } else {
            std::fs::rename(&path, &original).unwrap();
            std::fs::write(&path, vec![0; fixture.reference.byte_length as usize]).unwrap();
        }
        assert_eq!(fixture.request("HEAD", "Range: bytes=0-1\r\n").status, 410);
        if rewrite_same_inode {
            let mut file = std::fs::File::options().write(true).open(&path).unwrap();
            file.write_all(&(0..7).map(|n| (n % 251) as u8).collect::<Vec<_>>())
                .unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
            std::fs::rename(&original, &path).unwrap();
        }
        assert_eq!(
            fixture.request("HEAD", "").status,
            410,
            "Observed physical failure permanently retires this UUID"
        );
        assert_eq!(
            crate::product_binary::test_verified_scan_bytes(&fixture.root),
            scanned
        );
        fixture.idle();
    }
}

#[cfg(unix)]
#[test]
fn warm_http_capabilities_retire_on_parent_or_root_replacement_without_touching_outside() {
    for replace_root in [false, true] {
        let fixture = Fixture::new(100);
        let scanned = crate::product_binary::test_verified_scan_bytes(&fixture.root);
        let outside = fixture.root.with_extension("outside-media-identity");
        let assets = fixture.root.join("assets");
        if replace_root {
            std::fs::rename(&fixture.root, &outside).unwrap();
            std::fs::create_dir(&fixture.root).unwrap();
            std::fs::rename(outside.join("assets"), &assets).unwrap();
        } else {
            std::fs::rename(&assets, &outside).unwrap();
            std::os::unix::fs::symlink(&outside, &assets).unwrap();
        }
        assert_eq!(fixture.request("HEAD", "").status, 410);
        if replace_root {
            std::fs::rename(&assets, outside.join("assets")).unwrap();
            std::fs::remove_dir(&fixture.root).unwrap();
            std::fs::rename(&outside, &fixture.root).unwrap();
        } else {
            std::fs::remove_file(&assets).unwrap();
            std::fs::rename(&outside, &assets).unwrap();
        }
        assert_eq!(fixture.request("HEAD", "").status, 410);
        assert_eq!(
            std::fs::read(fixture.path()).unwrap(),
            (0..100).map(|n| (n % 251) as u8).collect::<Vec<_>>()
        );
        assert_eq!(
            crate::product_binary::test_verified_scan_bytes(&fixture.root),
            scanned
        );
        fixture.idle();
    }
}

#[test]
fn conditional_range_and_unknown_units_keep_rfc_complete_responses() {
    let fixture = Fixture::new(100);
    for header in [
        "Range: items=0-2\r\n",
        "Range: bytes=3-6\r\nIf-Range: \"foreign-validator\"\r\n",
    ] {
        let result = fixture.request("GET", header);
        assert_eq!(result.status, 200);
        assert_eq!(result.length, 100);
        assert!(!result.headers.contains_key("content-range"));
    }
    let result = outcome(
        fixture.connect(
            "GET",
            &format!("/{}", fixture.id),
            &format!(
                "Range: bytes=3-6\r\nIf-Range: \"sha256:{}\"\r\n",
                fixture.reference.content_hash
            ),
        ),
        3,
        false,
        true,
    );
    assert_eq!(result.status, 206);
    assert_eq!(result.length, 4);
    fixture.idle();
}
#[test]
fn active_stream_revoke_disconnect_and_admission_release_real_readers() {
    let fixture = Fixture::new(90 * 1024 * 1024 + 17);
    let mut stream = fixture.connect("GET", &format!("/{}", fixture.id), "");
    let (status, response) = headers(&mut stream);
    assert_eq!(status, 200);
    let mut first = vec![0; CHUNK];
    stream.read_exact(&mut first).unwrap();
    fixture
        .previews
        .release(&fixture.session, &fixture.id)
        .unwrap();
    let mut remainder = Vec::new();
    stream.read_to_end(&mut remainder).unwrap();
    assert!((first.len() + remainder.len()) < response["content-length"].parse::<usize>().unwrap());
    fixture.idle();
    let id = {
        let disk = fixture.disk.lock().unwrap();
        let disk = disk.as_ref().expect("Owned media fixture disk");
        fixture
            .previews
            .insert(
                fixture.session.clone(),
                disk.binaries
                    .playback(&disk.db, &fixture.reference, &mut || Ok(()))
                    .unwrap(),
            )
            .unwrap()
    };
    let mut stream = fixture.connect("GET", &format!("/{id}"), "");
    assert_eq!(headers(&mut stream).0, 200);
    stream.shutdown(Shutdown::Both).unwrap();
    drop(stream);
    fixture.idle();
    let mut pending = Vec::new();
    for _ in 0..8 {
        let mut socket = TcpStream::connect(fixture.address()).unwrap();
        socket.write_all(b"GET ").unwrap();
        pending.push(socket);
    }
    let start = Instant::now();
    while fixture.server.active_connections() != 8 {
        assert!(start.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fixture.request("HEAD", "").status, 503);
    drop(pending);
    fixture.idle();
    assert_eq!(
        outcome(
            fixture.connect("HEAD", &format!("/{id}"), ""),
            0,
            true,
            true
        )
        .status,
        200
    );
}
