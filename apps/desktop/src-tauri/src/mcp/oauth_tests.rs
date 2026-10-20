//! Real local OAuth HTTP/callback fixtures. SecretStore is deliberately memory
//! only: these tests do not establish OS vault, installed browser or firewall IO.
use super::{
    McpError, Result,
    oauth::{self, Login, VaultCredentials},
    protocol::{Action, Auth, Identity, PrivateConfig, Target},
    service_tests::Harness,
    vault::{CredentialVault, SecretStore},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rmcp::transport::auth::{CredentialStore, StoredCredentials};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, Semaphore},
    task::{JoinHandle, JoinSet},
};

#[derive(Default)]
struct MemorySecrets {
    values: Mutex<HashMap<String, Vec<u8>>>,
    fail_writes: AtomicBool,
    lose_head_ack: AtomicBool,
    lose_delete_ack: AtomicBool,
}
impl SecretStore for MemorySecrets {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        if self.fail_writes.load(Ordering::SeqCst) {
            return Err(McpError::VaultUnavailable);
        }
        self.values.lock().unwrap().insert(key.into(), value.into());
        if key.ends_with(":oauth-head") && self.lose_head_ack.swap(false, Ordering::SeqCst) {
            return Err(McpError::VaultUnknown);
        }
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.values.lock().unwrap().remove(key);
        if key.ends_with(":0") && self.lose_delete_ack.swap(false, Ordering::SeqCst) {
            return Err(McpError::VaultUnknown);
        }
        Ok(())
    }
}

struct Owner {
    credentials: VaultCredentials,
    alive: Arc<AtomicBool>,
    fence: Arc<Mutex<()>>,
    secrets: Arc<MemorySecrets>,
}
impl Owner {
    fn new() -> Self {
        let secrets = Arc::new(MemorySecrets::default());
        let vault = Arc::new(
            CredentialVault::new(
                secrets.clone(),
                "oauth-fixture",
                "isolated",
                "store",
                "server",
            )
            .unwrap(),
        );
        Self::with_vault(vault, secrets, "login_generation_1")
    }
    fn with_vault(vault: Arc<CredentialVault>, secrets: Arc<MemorySecrets>, slot: &str) -> Self {
        let alive = Arc::new(AtomicBool::new(true));
        let current = alive.clone();
        let fence = Arc::new(Mutex::new(()));
        Self {
            credentials: VaultCredentials {
                vault,
                slot: slot.into(),
                current: Arc::new(move || current.load(Ordering::SeqCst)),
                fence: fence.clone(),
            },
            alive,
            fence,
            secrets,
        }
    }
    fn retire(&self) {
        let _guard = self.fence.lock().unwrap();
        self.alive.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy)]
struct Options {
    registration: bool,
    wrong_resource: bool,
    wrong_issuer: bool,
    refresh_rejected: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            registration: true,
            wrong_resource: false,
            wrong_issuer: false,
            refresh_rejected: false,
        }
    }
}
struct ServerState {
    requests: Mutex<Vec<(String, String)>>,
    registrations: Mutex<Vec<Value>>,
    token_forms: Mutex<Vec<HashMap<String, String>>>,
    authorization: Mutex<Option<String>>,
    refresh_token: Mutex<String>,
    refresh_scope: Mutex<String>,
    resource_override: Mutex<Option<String>>,
    active_refreshes: AtomicUsize,
    max_refreshes: AtomicUsize,
    refreshes: AtomicUsize,
    effects: AtomicUsize,
    hold_refresh: AtomicBool,
    refresh_entered: Notify,
    release_refresh: Semaphore,
    pkce_verified: AtomicBool,
}
impl Default for ServerState {
    fn default() -> Self {
        Self {
            requests: Mutex::default(),
            registrations: Mutex::default(),
            token_forms: Mutex::default(),
            authorization: Mutex::default(),
            refresh_token: Mutex::new("fixture_refresh_0".into()),
            refresh_scope: Mutex::new("read offline_access".into()),
            resource_override: Mutex::new(None),
            active_refreshes: AtomicUsize::new(0),
            max_refreshes: AtomicUsize::new(0),
            refreshes: AtomicUsize::new(0),
            effects: AtomicUsize::new(0),
            hold_refresh: AtomicBool::new(false),
            refresh_entered: Notify::new(),
            release_refresh: Semaphore::new(0),
            pkce_verified: AtomicBool::new(false),
        }
    }
}
struct Fixture {
    base: String,
    state: Arc<ServerState>,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn start(options: Options) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(ServerState {
            refresh_token: Mutex::new("fixture_refresh_0".into()),
            release_refresh: Semaphore::new(0),
            ..ServerState::default()
        });
        let task_base = base.clone();
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            // JoinSet owns accepted sockets; dropping the fixture aborts their
            // tasks as well as the listener, including a deliberately held token.
            let mut sockets = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let base = task_base.clone();
                        let state = task_state.clone();
                        sockets.spawn(async move {
                            serve(stream, &base, &state, options).await;
                        });
                    }
                    _ = sockets.join_next(), if !sockets.is_empty() => {}
                }
            }
        });
        Self { base, state, task }
    }
    fn resource(&self) -> String {
        format!("{}/mcp", self.base)
    }
    fn issuer(&self) -> String {
        format!("{}/issuer", self.base)
    }
    fn config(&self, preregistered: bool) -> PrivateConfig {
        PrivateConfig::StreamableHttp {
            endpoint: self.resource(),
            auth: Auth::Oauth {
                client_id: preregistered.then(|| "fixture_public_client".into()),
                scopes: vec!["read".into()],
            },
        }
    }
    async fn login(&self, owner: &Owner, preregistered: bool, timeout: Duration) -> Login {
        let state = self.state.clone();
        oauth::begin_with_timeout(
            self.config(preregistered),
            owner.credentials.clone(),
            owner.credentials.current.clone(),
            Arc::new(move |url| {
                *state.authorization.lock().unwrap() = Some(url.to_owned());
                Ok(())
            }),
            timeout,
        )
        .await
        .expect("fixture login must create a real loopback receiver")
    }
    fn callback(&self, login: &Login) -> reqwest::Url {
        self.callback_url(&login.authorization_url, &login.redirect)
    }
    fn callback_url(&self, authorization_url: &str, redirect: &str) -> reqwest::Url {
        let auth = reqwest::Url::parse(authorization_url).unwrap();
        let state = pairs(&auth)["state"].clone();
        let mut callback = reqwest::Url::parse(redirect).unwrap();
        callback.query_pairs_mut().extend_pairs([
            ("code", "fixture_code"),
            ("state", state.as_str()),
            ("iss", self.issuer().as_str()),
        ]);
        callback
    }
}

fn pairs(url: &reqwest::Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}
async fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 2048];
    let (end, length) = loop {
        let n = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buffer))
            .await
            .ok()?
            .ok()?;
        if n == 0 || bytes.len() + n > 32 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            let text = std::str::from_utf8(&bytes[..end]).ok()?;
            let length = text
                .lines()
                .find_map(|line| {
                    line.split_once(':').and_then(|(k, v)| {
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().ok())
                            .flatten()
                    })
                })
                .unwrap_or(0);
            if end + 4 + length > 32 * 1024 {
                return None;
            }
            break (end + 4, length);
        }
    };
    while bytes.len() < end + length {
        let n = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buffer))
            .await
            .ok()?
            .ok()?;
        if n == 0 || bytes.len() + n > 32 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    let mut line = std::str::from_utf8(&bytes[..end])
        .ok()?
        .lines()
        .next()?
        .split_whitespace();
    Some((
        line.next()?.into(),
        line.next()?.into(),
        bytes[end..end + length].to_vec(),
    ))
}
async fn respond(stream: &mut TcpStream, status: u16, value: Value) {
    let body = serde_json::to_vec(&value).unwrap();
    let header = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&body).await;
}
async fn serve(mut stream: TcpStream, base: &str, state: &ServerState, options: Options) {
    let Some((method, path, body)) = read_request(&mut stream).await else {
        return;
    };
    state
        .requests
        .lock()
        .unwrap()
        .push((method.clone(), path.clone()));
    let resource = state
        .resource_override
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| format!("{base}/mcp"));
    let issuer = format!("{base}/issuer");
    if method == "POST" && path == "/mcp" {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let result = match request["method"].as_str().unwrap_or("") {
            "server/discover" => {
                json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{},"resources":{}},"ttlMs":0,"cacheScope":"private"})
            }
            "tools/list" => {
                json!({"resultType":"complete","tools":[{"name":"counter","inputSchema":{"type":"object"}}]})
            }
            "resources/list" => json!({"resultType":"complete","resources":[]}),
            "tools/call" => {
                state.effects.fetch_add(1, Ordering::SeqCst);
                json!({"resultType":"complete","content":[{"type":"text","text":"fixture effect completed"}],"isError":false})
            }
            "ping" => json!({}),
            _ => {
                respond(&mut stream, 200, json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"unsupported fixture method"}})).await;
                return;
            }
        };
        respond(
            &mut stream,
            200,
            json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
        )
        .await;
    } else if method == "GET" && path == "/mcp" {
        respond(&mut stream, 405, json!({})).await;
    } else if method == "DELETE" && path == "/mcp" {
        respond(&mut stream, 200, json!({})).await;
    } else if method == "GET" && path.starts_with("/.well-known/oauth-protected-resource") {
        respond(
            &mut stream,
            200,
            json!({
                "resource": if options.wrong_resource {format!("{base}/foreign")} else {resource},
                "authorization_servers": [issuer], "scopes_supported": ["read", "offline_access"]
            }),
        )
        .await;
    } else if method == "GET"
        && (path.starts_with("/.well-known/oauth-authorization-server")
            || path.starts_with("/.well-known/openid-configuration"))
    {
        let mut metadata = json!({
            "issuer": if options.wrong_issuer {format!("{base}/foreign")} else {issuer},
            "authorization_endpoint":format!("{base}/authorize"),
            "token_endpoint":format!("{base}/token"),
            "response_types_supported":["code"],
            "grant_types_supported":["authorization_code","refresh_token"],
            "token_endpoint_auth_methods_supported":["none"],
            "code_challenge_methods_supported":["S256"],
            "authorization_response_iss_parameter_supported":true,
            "scopes_supported":["read","offline_access"]
        });
        if options.registration {
            metadata["registration_endpoint"] = json!(format!("{base}/register"));
        }
        respond(&mut stream, 200, metadata).await;
    } else if method == "POST" && path == "/register" && options.registration {
        let registration: Value = serde_json::from_slice(&body).unwrap();
        state
            .registrations
            .lock()
            .unwrap()
            .push(registration.clone());
        respond(
            &mut stream,
            201,
            json!({
                "client_id":"fixture_dynamic_client", "redirect_uris":registration["redirect_uris"]
            }),
        )
        .await;
    } else if method == "POST" && path == "/token" {
        let form = pairs(
            &reqwest::Url::parse(&format!(
                "http://fixture/?{}",
                String::from_utf8(body).unwrap()
            ))
            .unwrap(),
        );
        state.token_forms.lock().unwrap().push(form.clone());
        if form.get("resource") != Some(&resource) {
            respond(&mut stream, 400, json!({"error":"invalid_target"})).await;
            return;
        }
        if form.get("grant_type").map(String::as_str) == Some("authorization_code") {
            let expected = state
                .authorization
                .lock()
                .unwrap()
                .clone()
                .expect("opener ran before callback");
            let auth = pairs(&reqwest::Url::parse(&expected).unwrap());
            let verifier = form.get("code_verifier").map(String::as_str).unwrap_or("");
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let valid = !verifier.is_empty()
                && Some(&challenge) == auth.get("code_challenge")
                && form.get("redirect_uri") == auth.get("redirect_uri")
                && form.get("client_id") == auth.get("client_id")
                && form.get("code").map(String::as_str) == Some("fixture_code");
            state.pkce_verified.store(valid, Ordering::SeqCst);
            if valid {
                respond(&mut stream, 200, json!({"access_token":"fixture_access_0","token_type":"Bearer","expires_in":3600,"refresh_token":"fixture_refresh_0","scope":"read offline_access"})).await;
            } else {
                respond(&mut stream, 400, json!({"error":"invalid_grant"})).await;
            }
        } else if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
            let active = state.active_refreshes.fetch_add(1, Ordering::SeqCst) + 1;
            state.max_refreshes.fetch_max(active, Ordering::SeqCst);
            state.refresh_entered.notify_one();
            if state.hold_refresh.load(Ordering::SeqCst) {
                let Ok(permit) = state.release_refresh.acquire().await else {
                    return;
                };
                permit.forget();
            } else {
                // Leave a bounded overlap window so an absent refresh guard is
                // observable at the server, rather than inferred from a mock.
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            let expected = state.refresh_token.lock().unwrap().clone();
            let valid = form.get("refresh_token") == Some(&expected) && !options.refresh_rejected;
            if valid {
                let generation = state.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
                let refresh = format!("fixture_refresh_{generation}");
                *state.refresh_token.lock().unwrap() = refresh.clone();
                let scope = state.refresh_scope.lock().unwrap().clone();
                respond(&mut stream, 200, json!({"access_token":format!("fixture_access_{generation}"),"token_type":"Bearer","expires_in":3600,"refresh_token":refresh,"scope":scope})).await;
            } else {
                respond(&mut stream, 400, json!({"error":"invalid_grant"})).await;
            }
            state.active_refreshes.fetch_sub(1, Ordering::SeqCst);
        } else {
            respond(&mut stream, 400, json!({"error":"unsupported_grant_type"})).await;
        }
    } else {
        respond(&mut stream, 404, json!({"error":"not_found"})).await;
    }
}

async fn callback(url: &reqwest::Url, method: &str, host: Option<&str>) -> Option<u16> {
    let mut socket = tokio::time::timeout(
        Duration::from_secs(2),
        TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())),
    )
    .await
    .ok()?
    .ok()?;
    let authority = format!("{}:{}", url.host_str().unwrap(), url.port().unwrap());
    let target = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    let request = format!(
        "{method} {target} HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        host.unwrap_or(&authority)
    );
    socket.write_all(request.as_bytes()).await.ok()?;
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes))
        .await
        .ok()?
        .ok()?;
    String::from_utf8(bytes)
        .ok()?
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}
async fn finish(login: Login, expected: &str) {
    let state = login.state.clone();
    tokio::time::timeout(Duration::from_secs(3), login.task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*state.lock().unwrap(), expected);
}
async fn authorize(fixture: &Fixture, owner: &Owner) {
    let login = fixture.login(owner, true, Duration::from_secs(5)).await;
    assert_eq!(
        callback(&fixture.callback(&login), "GET", None).await,
        Some(200)
    );
    finish(login, "authorized").await;
}
async fn expire(owner: &Owner) {
    expire_credentials(&owner.credentials).await;
}
async fn expire_credentials(credentials: &VaultCredentials) {
    let stored = credentials.load().await.unwrap().unwrap();
    let mut value = serde_json::to_value(stored).unwrap();
    value["token_received_at"] = json!(0);
    value["token_response"]["expires_in"] = json!(1);
    credentials
        .save(serde_json::from_value::<StoredCredentials>(value).unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn mcp_oauth_preregistered_public_client_pkce_resource_and_exact_callback() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    let login = fixture.login(&owner, true, Duration::from_secs(5)).await;
    let auth = reqwest::Url::parse(&login.authorization_url).unwrap();
    let query = pairs(&auth);
    assert_eq!(
        auth.as_str().split('?').next().unwrap(),
        format!("{}/authorize", fixture.base)
    );
    assert_eq!(query["client_id"], "fixture_public_client");
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["resource"], fixture.resource());
    assert_eq!(query["redirect_uri"], login.redirect);
    assert!(
        query["scope"]
            .split_whitespace()
            .any(|s| s == "offline_access")
    );
    assert!(!query.contains_key("code_verifier"));
    assert!(fixture.state.registrations.lock().unwrap().is_empty());
    let legitimate = fixture.callback(&login);
    assert_eq!(callback(&legitimate, "GET", None).await, Some(200));
    finish(login, "authorized").await;
    assert!(fixture.state.pkce_verified.load(Ordering::SeqCst));
    assert_eq!(
        oauth::token(&fixture.config(true), owner.credentials.clone())
            .await
            .unwrap(),
        "fixture_access_0"
    );
    assert_eq!(fixture.state.token_forms.lock().unwrap().len(), 1);
    // Successful login closes its receiver; a duplicate cannot exchange again.
    assert_eq!(callback(&legitimate, "GET", None).await, None);
    assert_eq!(fixture.state.token_forms.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn mcp_oauth_advertised_dynamic_registration_is_a_public_native_client() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    let login = fixture.login(&owner, false, Duration::from_secs(5)).await;
    let registrations = fixture.state.registrations.lock().unwrap().clone();
    assert_eq!(registrations.len(), 1);
    assert_eq!(registrations[0]["application_type"], "native");
    assert_eq!(registrations[0]["token_endpoint_auth_method"], "none");
    assert_eq!(registrations[0]["redirect_uris"], json!([login.redirect]));
    assert!(registrations[0].get("client_secret").is_none());
    assert_eq!(
        pairs(&reqwest::Url::parse(&login.authorization_url).unwrap())["client_id"],
        "fixture_dynamic_client"
    );
    assert_eq!(
        callback(&fixture.callback(&login), "GET", None).await,
        Some(200)
    );
    finish(login, "authorized").await;
    assert!(fixture.state.pkce_verified.load(Ordering::SeqCst));
    assert_eq!(
        owner.credentials.load().await.unwrap().unwrap().client_id,
        "fixture_dynamic_client"
    );
}

#[tokio::test]
async fn mcp_oauth_rejected_callback_does_not_consume_legitimate_attempt() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    let login = fixture.login(&owner, true, Duration::from_secs(5)).await;
    let legitimate = fixture.callback(&login);
    let mut invalid = Vec::new();
    for (key, value) in [
        ("state", "foreign_state"),
        ("iss", "https://foreign.invalid"),
    ] {
        let mut url = legitimate.clone();
        let mut query = pairs(&url);
        query.insert(key.into(), value.into());
        url.query_pairs_mut().clear().extend_pairs(query);
        invalid.push(url);
    }
    let mut missing_issuer = legitimate.clone();
    let query = pairs(&missing_issuer)
        .into_iter()
        .filter(|(k, _)| k != "iss")
        .collect::<Vec<_>>();
    missing_issuer.query_pairs_mut().clear().extend_pairs(query);
    invalid.push(missing_issuer);
    let mut duplicate = legitimate.clone();
    duplicate
        .query_pairs_mut()
        .append_pair("state", "foreign_state");
    invalid.push(duplicate);
    let mut wrong_path = legitimate.clone();
    wrong_path.set_path("/different-callback");
    invalid.push(wrong_path);
    let mut forged_error = legitimate.clone();
    let state = pairs(&forged_error)["state"].clone();
    forged_error.query_pairs_mut().clear().extend_pairs([
        ("state", state.as_str()),
        ("error", "access_denied"),
        ("iss", "https://foreign.invalid"),
    ]);
    invalid.push(forged_error);
    for url in invalid {
        assert_eq!(callback(&url, "GET", None).await, Some(400));
        assert_eq!(*login.state.lock().unwrap(), "pending");
        assert!(fixture.state.token_forms.lock().unwrap().is_empty());
    }
    assert_eq!(callback(&legitimate, "POST", None).await, Some(400));
    assert_eq!(
        callback(&legitimate, "GET", Some("foreign.invalid")).await,
        Some(400)
    );
    assert_eq!(callback(&legitimate, "GET", None).await, Some(200));
    finish(login, "authorized").await;
    assert_eq!(fixture.state.token_forms.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn mcp_oauth_stray_empty_closed_slow_and_oversized_connections_do_not_end_login() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    let login = fixture.login(&owner, true, Duration::from_secs(10)).await;
    let url = fixture.callback(&login);
    let address = (url.host_str().unwrap().to_owned(), url.port().unwrap());
    // Connect-and-close (EOF before any byte).
    drop(TcpStream::connect(address.clone()).await.unwrap());
    // Partial head that is then closed.
    let mut partial = TcpStream::connect(address.clone()).await.unwrap();
    partial.write_all(b"GET /momoki").await.unwrap();
    drop(partial);
    // Oversized head without a terminator.
    let mut big = TcpStream::connect(address.clone()).await.unwrap();
    let _ = big.write_all(&vec![b'a'; 9000]).await;
    // Silent connection kept open: it must not block later callbacks.
    let silent = TcpStream::connect(address.clone()).await.unwrap();
    // Invalid UTF-8 and malformed request target.
    let mut binary = TcpStream::connect(address.clone()).await.unwrap();
    let _ = binary.write_all(b"\xff\xfe\r\n\r\n").await;
    let mut malformed = TcpStream::connect(address.clone()).await.unwrap();
    let _ = malformed
        .write_all(b"GET http://[::bad/ HTTP/1.1\r\nHost: x\r\n\r\n")
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(*login.state.lock().unwrap(), "pending");
    assert_eq!(callback(&url, "GET", None).await, Some(200));
    finish(login, "authorized").await;
    drop(silent);
    assert_eq!(fixture.state.token_forms.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn mcp_oauth_error_callback_cancellation_timeout_and_retirement_never_exchange() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    let login = fixture.login(&owner, true, Duration::from_secs(5)).await;
    let mut error = fixture.callback(&login);
    let state = pairs(&error)["state"].clone();
    error.query_pairs_mut().clear().extend_pairs([
        ("state", state.as_str()),
        ("error", "access_denied"),
        ("iss", fixture.issuer().as_str()),
    ]);
    let _ = callback(&error, "GET", None).await;
    finish(login, "failed").await;
    let login = fixture.login(&owner, true, Duration::from_secs(5)).await;
    let canceled_url = fixture.callback(&login);
    login.cancel.cancel();
    finish(login, "canceled").await;
    assert_eq!(callback(&canceled_url, "GET", None).await, None);
    let login = fixture.login(&owner, true, Duration::from_millis(25)).await;
    let expired_url = fixture.callback(&login);
    finish(login, "expired").await;
    assert_eq!(callback(&expired_url, "GET", None).await, None);
    let login = fixture.login(&owner, true, Duration::from_secs(5)).await;
    owner.retire();
    assert_eq!(
        callback(&fixture.callback(&login), "GET", None).await,
        Some(400)
    );
    login.cancel.cancel();
    finish(login, "canceled").await;
    assert!(fixture.state.token_forms.lock().unwrap().is_empty());
    assert!(owner.secrets.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mcp_oauth_missing_registration_and_wrong_metadata_do_not_open_browser() {
    for options in [
        Options {
            registration: false,
            ..Options::default()
        },
        Options {
            wrong_resource: true,
            ..Options::default()
        },
        Options {
            wrong_issuer: true,
            ..Options::default()
        },
    ] {
        let fixture = Fixture::start(options).await;
        let owner = Owner::new();
        let opened = Arc::new(AtomicUsize::new(0));
        let captured = opened.clone();
        let result = oauth::begin(
            fixture.config(false),
            owner.credentials.clone(),
            owner.credentials.current.clone(),
            Arc::new(move |_| {
                captured.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(opened.load(Ordering::SeqCst), 0);
        assert!(fixture.state.token_forms.lock().unwrap().is_empty());
        assert!(owner.secrets.values.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn mcp_oauth_refreshes_are_serialized_and_use_rotated_token() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    authorize(&fixture, &owner).await;
    expire(&owner).await;
    let config = fixture.config(true);
    let (first, second) = tokio::join!(
        oauth::token(&config, owner.credentials.clone()),
        oauth::token(&config, owner.credentials.clone()),
    );
    assert!(first.unwrap().starts_with("fixture_access_"));
    assert!(second.unwrap().starts_with("fixture_access_"));
    assert_eq!(fixture.state.max_refreshes.load(Ordering::SeqCst), 1);
    let forms = fixture.state.token_forms.lock().unwrap().clone();
    let refreshes = forms
        .iter()
        .filter(|f| f.get("grant_type").map(String::as_str) == Some("refresh_token"))
        .collect::<Vec<_>>();
    assert!(!refreshes.is_empty());
    assert!(refreshes.len() <= 2);
    for (index, form) in refreshes.iter().enumerate() {
        assert_eq!(form["refresh_token"], format!("fixture_refresh_{index}"));
        assert_eq!(form["resource"], fixture.resource());
    }
    let last = owner.credentials.load().await.unwrap().unwrap();
    let stored = serde_json::to_value(last).unwrap();
    assert_eq!(
        stored["token_response"]["refresh_token"],
        format!("fixture_refresh_{}", refreshes.len())
    );
}

#[tokio::test]
async fn mcp_oauth_scope_change_replaces_principal_but_normal_rotation_preserves_it() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    authorize(&fixture, &owner).await;
    let config = fixture.config(true);
    let initial = oauth::token_with_identity(&config, owner.credentials.clone())
        .await
        .unwrap();
    assert_eq!(initial.access_token, "fixture_access_0");

    expire(&owner).await;
    let rotated = oauth::token_with_identity(&config, owner.credentials.clone())
        .await
        .unwrap();
    assert_ne!(rotated.access_token, initial.access_token);
    assert_eq!(rotated.principal_identity, initial.principal_identity);

    // OAuth scopes are a set. A server changing only their order must not
    // invalidate an approval for the same resource, client and granted set.
    *fixture.state.refresh_scope.lock().unwrap() = "offline_access read".into();
    expire(&owner).await;
    let reordered = oauth::token_with_identity(&config, owner.credentials.clone())
        .await
        .unwrap();
    assert_eq!(reordered.principal_identity, initial.principal_identity);

    *fixture.state.refresh_scope.lock().unwrap() = "read".into();
    expire(&owner).await;
    let narrowed = oauth::token_with_identity(&config, owner.credentials.clone())
        .await
        .unwrap();
    assert_ne!(narrowed.principal_identity, initial.principal_identity);
    assert_eq!(
        owner
            .credentials
            .load()
            .await
            .unwrap()
            .unwrap()
            .granted_scopes,
        vec!["read"]
    );
    assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.state.token_forms.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn mcp_oauth_rotated_revisions_are_collected_and_cleanup_reconciles_lost_ack() {
    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    let private = owner
        .credentials
        .vault
        .prepare(
            "private_op",
            "private_revision",
            b"private fixture configuration",
        )
        .unwrap();
    authorize(&fixture, &owner).await;
    let initial = owner
        .credentials
        .vault
        .read_slot(&owner.credentials.slot)
        .unwrap()
        .unwrap();

    for _ in 0..3 {
        let previous = owner
            .credentials
            .vault
            .read_slot(&owner.credentials.slot)
            .unwrap()
            .unwrap();
        expire(&owner).await;
        // The expiry fixture is itself a committed immutable revision, so its
        // publication must collect the prior token just like a real rotation.
        assert!(owner.credentials.vault.read(&previous).unwrap().is_none());
        let expired = owner
            .credentials
            .vault
            .read_slot(&owner.credentials.slot)
            .unwrap()
            .unwrap();
        oauth::token(&fixture.config(true), owner.credentials.clone())
            .await
            .unwrap();
        assert!(owner.credentials.vault.read(&expired).unwrap().is_none());
    }
    assert!(owner.credentials.vault.read(&initial).unwrap().is_none());
    assert_eq!(
        owner
            .secrets
            .values
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.ends_with(":manifest"))
            .count(),
        2
    );
    assert_eq!(
        owner
            .credentials
            .vault
            .read("private_revision")
            .unwrap()
            .unwrap()
            .0,
        private
    );

    let mut updated =
        serde_json::to_value(owner.credentials.load().await.unwrap().unwrap()).unwrap();
    updated["token_response"]["access_token"] = json!("confirmed_after_lost_head_ack");
    owner.secrets.lose_head_ack.store(true, Ordering::SeqCst);
    owner
        .credentials
        .save(serde_json::from_value(updated).unwrap())
        .await
        .unwrap();
    assert_eq!(
        oauth::token(&fixture.config(true), owner.credentials.clone())
            .await
            .unwrap(),
        "confirmed_after_lost_head_ack"
    );

    let old = owner
        .credentials
        .vault
        .read_slot(&owner.credentials.slot)
        .unwrap()
        .unwrap();
    let mut updated =
        serde_json::to_value(owner.credentials.load().await.unwrap().unwrap()).unwrap();
    updated["token_response"]["access_token"] = json!("published_before_cleanup_ack_loss");
    owner.secrets.lose_delete_ack.store(true, Ordering::SeqCst);
    assert!(
        owner
            .credentials
            .save(serde_json::from_value(updated).unwrap())
            .await
            .is_err()
    );
    // The head's readback established publication before cleanup lost its ack.
    // Its token remains readable; a cleanup error cannot roll it back.
    assert_ne!(
        owner
            .credentials
            .vault
            .read_slot(&owner.credentials.slot)
            .unwrap()
            .unwrap(),
        old
    );
    assert_eq!(
        oauth::token(&fixture.config(true), owner.credentials.clone())
            .await
            .unwrap(),
        "published_before_cleanup_ack_loss"
    );
    owner.credentials.clear().await.unwrap();
    assert!(owner.credentials.load().await.unwrap().is_none());
    assert!(owner.credentials.vault.read(&old).unwrap().is_none());
    assert_eq!(
        owner
            .secrets
            .values
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.ends_with(":manifest"))
            .count(),
        1
    );
    assert_eq!(
        owner
            .credentials
            .vault
            .read("private_revision")
            .unwrap()
            .unwrap()
            .0,
        private
    );
    owner
        .credentials
        .vault
        .collect_unreferenced("private_revision", &private)
        .unwrap();
    assert!(owner.secrets.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mcp_oauth_service_drain_waits_for_the_real_canceled_callback_listener() {
    for dispose in [false, true] {
        let fixture = Fixture::start(Options::default()).await;
        let harness = Harness::new();
        let reference = harness.config(fixture.config(true)).await;
        let login = harness
            .call(
                "login1",
                Action::OauthBegin {
                    server_id: "server1".into(),
                    config_revision: 1,
                    private_revision: reference,
                },
            )
            .await;
        assert_eq!(login.status, "prepared");
        let result = login.result.unwrap();
        let redirect = reqwest::Url::parse(result["redirectDisplay"].as_str().unwrap()).unwrap();
        let address = ("127.0.0.1", redirect.port().unwrap());
        // Admit a real socket and keep its request incomplete. Cancellation must
        // drop both the receiver and this in-progress callback before drainage.
        let mut socket = TcpStream::connect(address).await.unwrap();
        let action = if dispose {
            Action::Dispose {}
        } else {
            Action::Retire {
                server_id: "server1".into(),
                expected_config_revision: Some(1),
            }
        };
        // On this current-thread runtime the cancellation task has not run yet:
        // merely setting its token cannot be a completed drainage receipt.
        assert_eq!(
            harness.call("drain1", action.clone()).await.status,
            "draining"
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if harness.call("drain2", action.clone()).await.status == "drained" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(TcpStream::connect(address).await.is_err());
        let mut byte = [0];
        let closed = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
            .await
            .unwrap();
        assert!(
            matches!(closed, Ok(0))
                || closed.is_err_and(|error| matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ))
        );
        assert!(fixture.state.token_forms.lock().unwrap().is_empty());
        assert_eq!(
            harness
                .call("dispose_final", Action::Dispose {})
                .await
                .status,
            "drained"
        );
    }
}

#[tokio::test]
async fn mcp_oauth_service_retires_original_authority_on_scope_change_before_effect() {
    for (scope, expected_status, expected_effects) in [
        ("offline_access read", "completed", 1),
        ("read", "notStarted", 0),
    ] {
        let fixture = Fixture::start(Options::default()).await;
        let opened = fixture.state.clone();
        let harness = Harness::new_with_opener(Arc::new(move |url| {
            *opened.authorization.lock().unwrap() = Some(url.to_owned());
            Ok(())
        }));
        let reference = harness.config(fixture.config(true)).await;
        let login = harness
            .call(
                "login1",
                Action::OauthBegin {
                    server_id: "server1".into(),
                    config_revision: 1,
                    private_revision: reference.clone(),
                },
            )
            .await;
        assert_eq!(login.status, "prepared");
        let result = login.result.unwrap();
        let attempt_id = result["attemptId"].as_str().unwrap().to_owned();
        let redirect = result["redirectDisplay"].as_str().unwrap();
        let authorization = fixture.state.authorization.lock().unwrap().clone().unwrap();
        assert_eq!(
            callback(&fixture.callback_url(&authorization, redirect), "GET", None).await,
            Some(200)
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = harness
                    .call(
                        "login-status",
                        Action::OauthStatus {
                            attempt_id: attempt_id.clone(),
                        },
                    )
                    .await;
                let state = state.result.unwrap();
                match state["state"].as_str().unwrap() {
                    "authorized" => break,
                    "pending" => tokio::task::yield_now().await,
                    _ => panic!("fixture OAuth failed before connection"),
                }
            }
        })
        .await
        .unwrap();
        let binding = harness.connect(&reference).await;
        let authority = harness
            .prepare(
                &binding,
                Target::Tool {
                    raw_name: "counter".into(),
                },
            )
            .await;

        // The fixture changes expiry while no Service request is running. It
        // uses the real immutable vault envelope, not a mocked token provider.
        let vault = Arc::new(
            CredentialVault::new(
                harness.memory.clone(),
                "dev.momoki",
                "isolated",
                "workspace1",
                "server1",
            )
            .unwrap(),
        );
        let credentials = VaultCredentials {
            vault,
            slot: reference.revision_id.clone(),
            current: Arc::new(|| true),
            fence: Arc::new(Mutex::new(())),
        };
        expire_credentials(&credentials).await;
        *fixture.state.refresh_scope.lock().unwrap() = scope.into();
        let identity = Identity {
            operation_id: "effect1".into(),
            authority,
        };
        let reply = harness
            .call(
                "effect1",
                Action::Invoke {
                    identity: identity.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(reply.status, expected_status);
        assert_eq!(
            fixture.state.effects.load(Ordering::SeqCst),
            expected_effects
        );
        assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 1);
        if expected_status == "notStarted" {
            assert_eq!(
                reply.error.as_ref().map(|e| e.code.as_str()),
                Some("auth_required")
            );
            let original = harness
                .call(
                    "status1",
                    Action::Status {
                        identity: identity.clone(),
                    },
                )
                .await;
            assert_eq!(original.status, "notStarted");
            let repeated = harness
                .call(
                    "effect1",
                    Action::Invoke {
                        identity,
                        arguments: json!({}),
                    },
                )
                .await;
            assert_eq!(repeated.status, "notStarted");
            let retired = harness
                .call(
                    "prepare-stale",
                    Action::Prepare {
                        binding,
                        scope: super::protocol::Scope {
                            run_id: "run1".into(),
                            call_id: "call2".into(),
                            scope_id: "scope1".into(),
                        },
                        target: Target::Tool {
                            raw_name: "counter".into(),
                        },
                        arguments: json!({}),
                    },
                )
                .await;
            assert_ne!(retired.status, "prepared");
            assert_eq!(fixture.state.effects.load(Ordering::SeqCst), 0);
        }
        let dispose = harness.call("dispose1", Action::Dispose {}).await;
        assert_eq!(dispose.status, "drained");
    }
}

#[tokio::test]
async fn mcp_oauth_retired_refresh_cannot_publish_into_a_replacement_owner() {
    let fixture = Fixture::start(Options::default()).await;
    let old = Owner::new();
    authorize(&fixture, &old).await;
    expire(&old).await;
    let old_head = old
        .credentials
        .vault
        .read_slot(&old.credentials.slot)
        .unwrap();
    fixture.state.hold_refresh.store(true, Ordering::SeqCst);
    let entered = fixture.state.refresh_entered.notified();
    let config = fixture.config(true);
    let credentials = old.credentials.clone();
    let refresh = tokio::spawn(async move { oauth::token(&config, credentials).await });
    tokio::time::timeout(Duration::from_secs(3), entered)
        .await
        .unwrap();
    old.retire();
    let replacement = Owner::with_vault(
        old.credentials.vault.clone(),
        old.secrets.clone(),
        "login_generation_2",
    );
    // New account/generation has its own immutable pointer slot. A completed
    // refresh from the retired owner must not overwrite it after network IO.
    replacement.credentials.save(serde_json::from_value(json!({
        "client_id":"fixture_public_client", "token_response":{"access_token":"replacement_access","token_type":"Bearer","expires_in":3600},
        "granted_scopes":["read"], "issuer":fixture.issuer()
    })).unwrap()).await.unwrap();
    let new_head = replacement
        .credentials
        .vault
        .read_slot(&replacement.credentials.slot)
        .unwrap();
    fixture.state.release_refresh.add_permits(1);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), refresh)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert_eq!(
        old.credentials
            .vault
            .read_slot(&old.credentials.slot)
            .unwrap(),
        old_head
    );
    assert_eq!(
        replacement
            .credentials
            .vault
            .read_slot(&replacement.credentials.slot)
            .unwrap(),
        new_head
    );
    assert_eq!(
        oauth::token(&fixture.config(true), replacement.credentials.clone())
            .await
            .unwrap(),
        "replacement_access"
    );
    assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn mcp_oauth_rejected_refresh_and_unavailable_vault_do_not_reauthorize() {
    let fixture = Fixture::start(Options {
        refresh_rejected: true,
        ..Options::default()
    })
    .await;
    let owner = Owner::new();
    authorize(&fixture, &owner).await;
    expire(&owner).await;
    let before = fixture.state.authorization.lock().unwrap().clone();
    assert!(
        oauth::token(&fixture.config(true), owner.credentials.clone())
            .await
            .is_err()
    );
    assert_eq!(*fixture.state.authorization.lock().unwrap(), before);
    assert_eq!(fixture.state.token_forms.lock().unwrap().len(), 2);

    let fixture = Fixture::start(Options::default()).await;
    let owner = Owner::new();
    let login = fixture.login(&owner, true, Duration::from_secs(5)).await;
    owner.secrets.fail_writes.store(true, Ordering::SeqCst);
    let _ = callback(&fixture.callback(&login), "GET", None).await;
    finish(login, "failed").await;
    assert_eq!(fixture.state.token_forms.lock().unwrap().len(), 1);
    assert!(owner.secrets.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mcp_oauth_service_retires_old_authority_when_actual_resource_changes() {
    for suffix in ["/", "/mcp?audience=changed"] {
        let fixture = Fixture::start(Options::default()).await;
        let opened = fixture.state.clone();
        let harness = Harness::new_with_opener(Arc::new(move |url| {
            *opened.authorization.lock().unwrap() = Some(url.to_owned());
            Ok(())
        }));
        let reference = harness.config(fixture.config(true)).await;
        let login = harness
            .call(
                "login1",
                Action::OauthBegin {
                    server_id: "server1".into(),
                    config_revision: 1,
                    private_revision: reference.clone(),
                },
            )
            .await;
        assert_eq!(login.status, "prepared");
        let result = login.result.unwrap();
        let attempt = result["attemptId"].as_str().unwrap().to_owned();
        let redirect = result["redirectDisplay"].as_str().unwrap();
        let authorization = fixture.state.authorization.lock().unwrap().clone().unwrap();
        assert_eq!(
            callback(&fixture.callback_url(&authorization, redirect), "GET", None).await,
            Some(200)
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let reply = harness
                    .call(
                        "login-status",
                        Action::OauthStatus {
                            attempt_id: attempt.clone(),
                        },
                    )
                    .await;
                let state = reply.result.unwrap();
                match state["state"].as_str().unwrap() {
                    "authorized" => break,
                    "pending" => tokio::task::yield_now().await,
                    _ => panic!("fixture OAuth failed"),
                }
            }
        })
        .await
        .unwrap();
        let binding = harness.connect(&reference).await;
        let authority = harness
            .prepare(
                &binding,
                Target::Tool {
                    raw_name: "counter".into(),
                },
            )
            .await;
        // The configured endpoint, AS issuer, client and scopes stay unchanged.
        // rmcp accepts a same-origin parent resource and same-path query changes.
        let actual = format!("{}{suffix}", fixture.base);
        *fixture.state.resource_override.lock().unwrap() = Some(actual);
        let identity = Identity {
            operation_id: "effect1".into(),
            authority,
        };
        let reply = harness
            .call(
                "effect1",
                Action::Invoke {
                    identity: identity.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(reply.status, "notStarted");
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("auth_required")
        );
        assert_eq!(fixture.state.effects.load(Ordering::SeqCst), 0);
        let repeated = harness
            .call(
                "effect1",
                Action::Invoke {
                    identity: identity.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(repeated.status, "notStarted");
        let original = harness.call("effect1", Action::Status { identity }).await;
        assert_eq!(original.status, "notStarted");
        assert_eq!(fixture.state.effects.load(Ordering::SeqCst), 0);
        let stale = harness
            .call(
                "prepare-stale",
                Action::Prepare {
                    binding,
                    scope: super::protocol::Scope {
                        run_id: "run1".into(),
                        call_id: "call2".into(),
                        scope_id: "scope1".into(),
                    },
                    target: Target::Tool {
                        raw_name: "counter".into(),
                    },
                    arguments: json!({}),
                },
            )
            .await;
        assert_ne!(stale.status, "prepared");
        assert_eq!(
            harness.call("dispose1", Action::Dispose {}).await.status,
            "drained"
        );
    }
}
