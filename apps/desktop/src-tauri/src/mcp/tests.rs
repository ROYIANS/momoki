use super::*;
use rmcp::{
    ClientServiceExt,
    model::{CallToolRequestParams, ClientJsonRpcMessage, ProtocolVersion},
    service::ClientLifecycleMode,
    transport::{
        StreamableHttpClientTransport, async_rw::AsyncRwTransport,
        streamable_http_client::StreamableHttpClient,
    },
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::V_2025_11_25),
    }
}
#[cfg(unix)]
#[tokio::test]
async fn mcp_real_stdio_current_discover_and_legacy_initialize() {
    for mode in ["modern", "legacy"] {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/fixtures/server.py");
        let (mut owner, read, write) = process::OwnedProcess::spawn(
            std::path::Path::new("/usr/bin/python3"),
            &["-u".into(), path.to_string_lossy().into(), mode.into()],
            None,
            &HashMap::new(),
        )
        .unwrap();
        let mut peer = tokio::time::timeout(
            Duration::from_secs(5),
            ().serve_with_lifecycle(AsyncRwTransport::new_client(read, write), lifecycle()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            peer.list_tools(None).await.unwrap().tools[0].name,
            "counter"
        );
        assert!(
            peer.call_tool_once(CallToolRequestParams::new("counter"))
                .await
                .is_ok()
        );
        assert_eq!(
            peer.peer_info().unwrap().protocol_version,
            if mode == "modern" {
                ProtocolVersion::V_2026_07_28
            } else {
                ProtocolVersion::V_2025_11_25
            }
        );
        peer.close().await.unwrap();
        owner.stop().await.unwrap();
        owner.stop().await.unwrap();
    }
}
#[cfg(unix)]
#[tokio::test]
async fn mcp_real_stdio_oversized_unterminated_reply_is_closed() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/fixtures/server.py");
    let (mut owner, read, write) = process::OwnedProcess::spawn(
        std::path::Path::new("/usr/bin/python3"),
        &[
            "-u".into(),
            path.to_string_lossy().into(),
            "oversized".into(),
        ],
        None,
        &HashMap::new(),
    )
    .unwrap();
    let mut peer =
        ().serve_with_lifecycle(AsyncRwTransport::new_client(read, write), lifecycle())
            .await
            .unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_secs(5),
            peer.call_tool_once(CallToolRequestParams::new("counter"))
        )
        .await
        .unwrap()
        .is_err()
    );
    peer.close().await.unwrap();
    owner.stop().await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn mcp_real_owned_process_group_drains_child_and_descendant() {
    use tokio::io::AsyncBufReadExt;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/fixtures/server.py");
    let (mut owner, read, _write) = process::OwnedProcess::spawn(
        std::path::Path::new("/usr/bin/python3"),
        &["-u".into(), path.to_string_lossy().into(), "tree".into()],
        None,
        &HashMap::new(),
    )
    .unwrap();
    let parent = owner.id().unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(3),
        tokio::io::BufReader::new(read).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let descendant: u32 = line.trim().parse().unwrap();
    owner.stop().await.unwrap();
    owner.stop().await.unwrap();
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if unsafe { kill(parent as i32, 0) } == -1 && unsafe { kill(descendant as i32, 0) } == -1 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owned processes survived stop"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(owner.stderr_bytes.load(Ordering::Relaxed), 0);
}

pub(super) struct Fixture {
    pub(super) url: String,
    pub(super) effects: Arc<AtomicUsize>,
    pub(super) requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub(super) async fn fixture(mode: &'static str) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let effects = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&effects);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&requests);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let counter = Arc::clone(&counter);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut buf = [0u8; 4096];
                let (header_len, body_len) = loop {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if bytes.len() > 65536 {
                        return;
                    }
                    if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let size = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        break (end + 4, size);
                    }
                };
                while bytes.len() < header_len + body_len {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                }
                let get = bytes.starts_with(b"GET ");
                let delete = bytes.starts_with(b"DELETE ");
                if get && mode == "oversized_oauth" {
                    counter.fetch_add(1, Ordering::SeqCst);
                    let body = "x".repeat(4097);
                    let response = format!(
                        "HTTP/1.1 200 Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    return;
                }
                if get || delete {
                    let status = if get { 405 } else { 204 };
                    let response = format!(
                        "HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    return;
                }
                let request: Value =
                    serde_json::from_slice(&bytes[header_len..header_len + body_len])
                        .unwrap_or(json!({}));
                let method = request["method"].as_str().unwrap_or("").to_owned();
                log.lock().unwrap().push(method.clone());
                let id = request["id"].clone();
                let mut status = 200;
                let mut content_type = "application/json";
                let result = match method.as_str() {
                    "server/discover" if mode == "legacy" || mode == "expired" => {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"legacy"}})
                    }
                    "server/discover" => {
                        json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{},"resources":{}},"ttlMs":0,"cacheScope":"private"}})
                    }
                    "initialize" => {
                        json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"fixture","version":"1"}}})
                    }
                    "tools/list" => {
                        json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","tools":[{"name":"counter","inputSchema":{"type":"object"}}]}})
                    }
                    "resources/list" => {
                        json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","resources":[{"uri":"fixture://note/镜头?x=\"q\"","name":"note"}]}})
                    }
                    "resources/read" => {
                        json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","contents":[{"uri":"fixture://note/镜头?x=\"q\"","text":"fixture note"}]}})
                    }
                    "tools/call" => {
                        counter.fetch_add(1, Ordering::SeqCst);
                        if mode == "slow_call" {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                        }
                        if mode == "lost" {
                            return;
                        }
                        if mode == "expired" {
                            status = 404;
                        }
                        if mode == "unauthorized" {
                            status = 401;
                        }
                        json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","content":[{"type":"text","text":"one"}]}})
                    }
                    _ => {
                        status = 202;
                        json!({})
                    }
                };
                if mode == "deadline" {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                let mut body = if status == 202 {
                    String::new()
                } else {
                    result.to_string()
                };
                if mode == "oversized_json" {
                    body = "x".repeat(4097);
                }
                if mode == "oversized_sse" {
                    body = format!("data: {}\n\n", "x".repeat(4097));
                    content_type = "text/event-stream";
                }
                let session = if method == "initialize" {
                    "Mcp-Session-Id: fixture-session\r\n"
                } else {
                    ""
                };
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{session}Connection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    Fixture {
        url: format!("http://{address}/mcp"),
        effects,
        requests,
        task,
    }
}
#[tokio::test]
async fn mcp_real_http_current_and_legacy_discovery_and_call() {
    for mode in ["modern", "legacy"] {
        let server = fixture(mode).await;
        let client =
            transport::BoundedHttpClient::new(vec![server.url.parse().unwrap()], MESSAGE_BYTES)
                .unwrap();
        let mut peer = ()
            .serve_with_lifecycle(
                StreamableHttpClientTransport::with_client(client, transport::config(&server.url)),
                lifecycle(),
            )
            .await
            .unwrap();
        assert_eq!(
            peer.list_tools(None).await.unwrap().tools[0].name,
            "counter"
        );
        assert!(
            peer.call_tool_once(CallToolRequestParams::new("counter"))
                .await
                .is_ok()
        );
        assert_eq!(server.effects.load(Ordering::SeqCst), 1);
        peer.close().await.unwrap();
    }
}
#[tokio::test]
async fn mcp_real_http_session_expiration_lost_reply_and_401_never_repost_effect() {
    for mode in ["expired", "lost", "unauthorized"] {
        let server = fixture(mode).await;
        let client =
            transport::BoundedHttpClient::new(vec![server.url.parse().unwrap()], MESSAGE_BYTES)
                .unwrap();
        let mut peer = ()
            .serve_with_lifecycle(
                StreamableHttpClientTransport::with_client(client, transport::config(&server.url)),
                lifecycle(),
            )
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_secs(5),
                peer.call_tool_once(CallToolRequestParams::new("counter"))
            )
            .await
            .unwrap()
            .is_err()
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            server.effects.load(Ordering::SeqCst),
            1,
            "effect repeated for {mode}"
        );
        assert_eq!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|m| m.as_str() == "initialize")
                .count(),
            usize::from(mode == "expired")
        );
        peer.close().await.unwrap();
    }
}
#[tokio::test]
async fn mcp_http_json_and_sse_are_bounded_before_parse() {
    for mode in ["oversized_json", "oversized_sse"] {
        let server = fixture(mode).await;
        let client =
            transport::BoundedHttpClient::new(vec![server.url.parse().unwrap()], 4096).unwrap();
        let message: ClientJsonRpcMessage = serde_json::from_value(
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"counter"}}),
        )
        .unwrap();
        let response = client
            .post_message(
                server.url.clone().into(),
                message,
                None,
                None,
                HashMap::new(),
            )
            .await;
        if mode == "oversized_json" {
            assert!(response.is_err());
        } else {
            let rmcp::transport::streamable_http_client::StreamableHttpPostResponse::Sse(
                mut stream,
                _,
            ) = response.unwrap()
            else {
                panic!("SSE expected")
            };
            use futures::StreamExt;
            assert!(stream.next().await.unwrap().is_err());
        }
    }
}

#[tokio::test]
async fn mcp_real_oauth_metadata_limit_and_http_deadline() {
    let server = fixture("oversized_oauth").await;
    let base = reqwest::Url::parse(&server.url).unwrap();
    let endpoints = vec![
        base.clone(),
        base.join("/.well-known/oauth-protected-resource/mcp")
            .unwrap(),
        base.join("/.well-known/oauth-protected-resource").unwrap(),
        base.join("/.well-known/oauth-authorization-server")
            .unwrap(),
        base.join("/.well-known/openid-configuration").unwrap(),
    ];
    let client = transport::BoundedHttpClient::new(endpoints, 4096).unwrap();
    let manager = rmcp::transport::auth::AuthorizationManager::new_with_oauth_http_client(
        &server.url,
        Arc::new(client),
    )
    .await
    .unwrap();
    assert!(manager.resolve_metadata().await.is_err());
    assert!(
        server.effects.load(Ordering::SeqCst) > 0,
        "OAuth metadata never reached real TCP fixture"
    );
    let server = fixture("deadline").await;
    let client = transport::BoundedHttpClient::with_timeout(
        vec![server.url.parse().unwrap()],
        4096,
        Duration::from_millis(80),
    )
    .unwrap();
    let message: ClientJsonRpcMessage = serde_json::from_value(
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"counter"}}),
    )
    .unwrap();
    let start = std::time::Instant::now();
    assert!(
        client
            .post_message(
                server.url.clone().into(),
                message,
                None,
                None,
                HashMap::new()
            )
            .await
            .is_err()
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(server.effects.load(Ordering::SeqCst), 1);

    // The MCP session client has no total-body timeout: a slow (>80 ms here,
    // >30 s in production) reply is still delivered within the call policy.
    let server = fixture("deadline").await;
    let client =
        transport::BoundedHttpClient::streaming(vec![server.url.parse().unwrap()], 4096).unwrap();
    let message: ClientJsonRpcMessage = serde_json::from_value(
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"counter"}}),
    )
    .unwrap();
    let start = std::time::Instant::now();
    assert!(
        client
            .post_message(
                server.url.clone().into(),
                message,
                None,
                None,
                HashMap::new()
            )
            .await
            .is_ok()
    );
    assert!(start.elapsed() >= Duration::from_millis(900));
    assert_eq!(server.effects.load(Ordering::SeqCst), 1);
}

#[derive(Default)]
struct MemoryVault {
    values: Mutex<HashMap<String, Vec<u8>>>,
    writes: Mutex<Vec<(String, usize)>>,
    fail_after_write: AtomicUsize,
    fail_manifest: std::sync::atomic::AtomicBool,
    fail_chunk: std::sync::atomic::AtomicBool,
    fail_delete: std::sync::atomic::AtomicBool,
    unavailable: std::sync::atomic::AtomicBool,
}
impl vault::SecretStore for MemoryVault {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(McpError::VaultUnavailable);
        }
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        assert!(value.len() <= 2048);
        self.values
            .lock()
            .unwrap()
            .insert(key.to_owned(), value.to_vec());
        self.writes
            .lock()
            .unwrap()
            .push((key.to_owned(), value.len()));
        if self.fail_after_write.swap(0, Ordering::SeqCst) > 0
            || key.ends_with(":manifest") && self.fail_manifest.swap(false, Ordering::SeqCst)
            || key.ends_with(":0") && self.fail_chunk.swap(false, Ordering::SeqCst)
        {
            Err(McpError::VaultUnknown)
        } else {
            Ok(())
        }
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.values.lock().unwrap().remove(key);
        if self.fail_delete.swap(false, Ordering::SeqCst) {
            Err(McpError::VaultUnknown)
        } else {
            Ok(())
        }
    }
}
#[test]
fn mcp_vault_maximum_payload_chunks_commit_last_and_profile_isolation() {
    let store = Arc::new(MemoryVault::default());
    let vault =
        vault::CredentialVault::new(store.clone(), "app", "normal", "workspace", "server").unwrap();
    let payload = vec![0xa5; 32768];
    let receipt = vault.prepare("operation", "revision", &payload).unwrap();
    assert!(
        store
            .writes
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .0
            .ends_with(":manifest")
    );
    assert_eq!(vault.read("revision").unwrap().unwrap().1, payload);
    assert_eq!(
        vault.prepare("operation", "revision", &payload).unwrap(),
        receipt
    );
    assert!(vault.prepare("other", "revision", b"replacement").is_err());
    let isolated =
        vault::CredentialVault::new(store.clone(), "app", "isolated", "workspace", "server")
            .unwrap();
    assert!(isolated.read("revision").unwrap().is_none());
    assert!(vault.prepare("too-big", "r2", &vec![0; 32769]).is_err());
    vault.collect_unreferenced("revision", &receipt).unwrap();
    assert!(store.values.lock().unwrap().is_empty());
}
#[test]
fn mcp_vault_lost_intent_acknowledgement_is_reconciled_without_plaintext_or_overwrite() {
    let store = Arc::new(MemoryVault::default());
    store.fail_after_write.store(1, Ordering::SeqCst);
    let vault =
        vault::CredentialVault::new(store.clone(), "app", "normal", "workspace", "server").unwrap();
    assert_eq!(
        vault.prepare("operation", "revision", b"private-secret"),
        Err(McpError::VaultUnknown)
    );
    assert!(vault.read("revision").unwrap().is_none());
    assert!(
        vault
            .prepare("different", "revision", b"other-secret")
            .is_err()
    );
    let receipt = vault
        .prepare("operation", "revision", b"private-secret")
        .unwrap();
    assert_eq!(
        vault.read("revision").unwrap().unwrap().1,
        b"private-secret"
    );
    vault.collect_unreferenced("revision", &receipt).unwrap();
}

#[test]
fn mcp_vault_manifest_lost_ack_readback_and_unavailable_fail_closed() {
    let store = Arc::new(MemoryVault::default());
    let vault =
        vault::CredentialVault::new(store.clone(), "app", "normal", "workspace", "server").unwrap();
    store.fail_manifest.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.prepare("operation", "revision", b"secret"),
        Err(McpError::VaultUnknown)
    );
    let (receipt, payload) = vault.read("revision").unwrap().unwrap();
    assert_eq!(payload, b"secret");
    let writes = store.writes.lock().unwrap().len();
    assert_eq!(
        vault.prepare("operation", "revision", b"secret").unwrap(),
        receipt
    );
    assert_eq!(
        store.writes.lock().unwrap().len(),
        writes,
        "receipt lookup rewrote a credential"
    );
    store.unavailable.store(true, Ordering::SeqCst);
    assert_eq!(vault.read("revision"), Err(McpError::VaultUnavailable));
    assert_eq!(
        vault.prepare("next", "replacement", b"new-secret"),
        Err(McpError::VaultUnavailable)
    );
    store.unavailable.store(false, Ordering::SeqCst);
    vault.collect_unreferenced("revision", &receipt).unwrap();
}
#[tokio::test]
async fn mcp_vault_refresh_guard_serializes_rotations_and_exact_revision_cleanup() {
    let store = Arc::new(MemoryVault::default());
    let vault = Arc::new(
        vault::CredentialVault::new(store.clone(), "app", "normal", "workspace", "server").unwrap(),
    );
    let first = vault.acquire_refresh_guard().await;
    let next = vault.clone();
    let (entered, mut observed) = tokio::sync::oneshot::channel();
    let second = tokio::spawn(async move {
        let _guard = next.acquire_refresh_guard().await;
        let receipt = next.prepare("refresh-two", "r2", b"rotated-token").unwrap();
        let _ = entered.send(receipt);
    });
    tokio::task::yield_now().await;
    assert!(observed.try_recv().is_err());
    let old = vault
        .prepare("refresh-one", "r1", b"original-token")
        .unwrap();
    drop(first);
    let new = observed.await.unwrap();
    second.await.unwrap();
    vault.collect_unreferenced("r1", &old).unwrap();
    assert_eq!(vault.read("r2").unwrap().unwrap().0, new);
    assert!(vault.collect_unreferenced("r2", &old).is_err());
    vault.collect_unreferenced("r2", &new).unwrap();
}
#[cfg(target_os = "macos")]
#[test]
#[ignore = "Opt-in unsigned-host Keychain access may require a user prompt; installed acceptance is separate"]
fn mcp_real_available_host_vault_roundtrip() {
    let store = Arc::new(vault::NativeSecretStore::open().unwrap());
    let server = uuid::Uuid::new_v4().to_string();
    let vault = vault::CredentialVault::new(
        store,
        "dev.momoki.mcp.fixture",
        "isolated-test",
        "temporary-store",
        &server,
    )
    .unwrap();
    let receipt = vault
        .prepare(
            "fixture-op",
            "fixture-revision",
            b"temporary-fixture-secret",
        )
        .unwrap();
    assert_eq!(
        vault.read("fixture-revision").unwrap().unwrap().1,
        b"temporary-fixture-secret"
    );
    vault
        .collect_unreferenced("fixture-revision", &receipt)
        .unwrap();
    assert!(vault.read("fixture-revision").unwrap().is_none());
}

#[test]
fn mcp_vault_lost_chunk_and_delete_acknowledgements_reconcile_original_revision() {
    let store = Arc::new(MemoryVault::default());
    let vault =
        vault::CredentialVault::new(store.clone(), "app", "normal", "workspace", "server").unwrap();
    store.fail_chunk.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.prepare("operation", "revision", b"private-secret"),
        Err(McpError::VaultUnknown)
    );
    assert!(vault.read("revision").unwrap().is_none());
    let receipt = vault
        .prepare("operation", "revision", b"private-secret")
        .unwrap();
    store.fail_delete.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.collect_unreferenced("revision", &receipt),
        Err(McpError::VaultUnknown)
    );
    vault.collect_unreferenced("revision", &receipt).unwrap();
    vault.collect_unreferenced("revision", &receipt).unwrap();
    assert!(store.values.lock().unwrap().is_empty());
}
