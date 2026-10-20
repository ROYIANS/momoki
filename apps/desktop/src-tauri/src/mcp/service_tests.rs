use super::{
    catalogue::{Catalogue, CatalogueSource},
    protocol::*,
    service::Service,
    vault::SecretStore,
    *,
};
use crate::full_product_store::protocol::Session;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
#[derive(Default)]
pub(super) struct Memory {
    values: Mutex<HashMap<String, Vec<u8>>>,
    lose_manifest: AtomicBool,
    unavailable: AtomicBool,
}
impl SecretStore for Memory {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(McpError::VaultUnavailable);
        }
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        self.values.lock().unwrap().insert(key.into(), value.into());
        if key.ends_with(":manifest") && self.lose_manifest.swap(false, Ordering::SeqCst) {
            return Err(McpError::VaultUnknown);
        }
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}
pub(super) struct Harness {
    pub(super) service: Arc<Service>,
    pub(super) catalogue: Arc<Mutex<Value>>,
    pub(super) session: Session,
    pub(super) memory: Arc<Memory>,
}
impl Harness {
    pub(super) fn new() -> Self {
        Self::new_with_opener(Arc::new(|_| Ok(())))
    }
    pub(super) fn new_with_opener(open: Arc<dyn Fn(&str) -> Result<()> + Send + Sync>) -> Self {
        Self::build(open, None)
    }
    pub(super) fn new_with_consent(consent: super::service::Consent) -> Self {
        Self::build(Arc::new(|_| Ok(())), Some(consent))
    }
    fn build(
        open: Arc<dyn Fn(&str) -> Result<()> + Send + Sync>,
        consent: Option<super::service::Consent>,
    ) -> Self {
        let session = Session {
            version: 1,
            session: "session1".into(),
            workspace_id: "workspace1".into(),
            generation: 1,
        };
        let catalogue = Arc::new(Mutex::new(Value::Null));
        let current = catalogue.clone();
        let source: CatalogueSource =
            Arc::new(move |_| Catalogue::parse(current.lock().unwrap().clone()));
        let memory = Arc::new(Memory::default());
        let service = Service::new(
            session.clone(),
            source,
            memory.clone(),
            "dev.momoki".into(),
            "isolated".into(),
            open,
        )
        .unwrap();
        let service = match consent {
            Some(consent) => Service::with_consent(service, consent),
            None => service,
        };
        Self {
            service,
            catalogue,
            session,
            memory,
        }
    }
    pub(super) async fn call(&self, op: &str, action: Action) -> Reply {
        self.service
            .request(Envelope {
                version: 1,
                operation_id: op.into(),
                session: self.session.clone(),
                host_session_id: Some(self.service.host_session_id.clone()),
                action,
            })
            .await
    }
    pub(super) async fn config(&self, config: PrivateConfig) -> PrivateRef {
        let reply = self
            .call(
                "save1",
                Action::PrivatePrepare {
                    server_id: "server1".into(),
                    catalogue_revision: 0,
                    expected_config_revision: 0,
                    config: config.clone(),
                },
            )
            .await;
        assert_eq!(reply.status, "prepared");
        let reference: PrivateRef =
            serde_json::from_value(reply.result.unwrap()["reference"].clone()).unwrap();
        let (transport, auth, origin) = match config {
            PrivateConfig::Stdio { .. } => ("stdio", "none", None),
            PrivateConfig::StreamableHttp { endpoint, auth } => (
                "streamable_http",
                match auth {
                    Auth::None => "none",
                    Auth::Manual { .. } => "manual",
                    Auth::Oauth { .. } => "oauth",
                },
                Some(
                    reqwest::Url::parse(&endpoint)
                        .unwrap()
                        .origin()
                        .ascii_serialization(),
                ),
            ),
        };
        let mut entry = json!({"serverId":"server1","configRevision":1,"enabled":true,"label":"Fixture","transport":transport,"auth":auth,"privateRevision":reference});
        if let Some(origin) = origin {
            entry["endpointDisplay"] = json!(origin)
        }
        *self.catalogue.lock().unwrap() = json!({"version":1,"revision":1,"entries":[entry],"receipts":[{"operationId":"save1","fingerprint":"a".repeat(64),"kind":"save","serverId":"server1","catalogueRevision":1,"configRevision":1,"publishedPrivateRevision":reference}]});
        let confirmed = self
            .call(
                "save1",
                Action::PrivateConfirm {
                    server_id: "server1".into(),
                    reference: reference.clone(),
                    catalogue_fingerprint: "a".repeat(64),
                },
            )
            .await;
        assert_eq!(confirmed.status, "completed");
        reference
    }
    pub(super) async fn connect(&self, reference: &PrivateRef) -> Binding {
        let result = self
            .call(
                "connect1",
                Action::Connect {
                    server_id: "server1".into(),
                    config_revision: 1,
                    private_revision: reference.clone(),
                },
            )
            .await;
        assert_eq!(
            result.status,
            "connected",
            "{:?}",
            result.error.map(|e| e.code)
        );
        serde_json::from_value(result.result.unwrap()["binding"].clone()).unwrap()
    }
    pub(super) async fn prepare(&self, binding: &Binding, target: Target) -> Authority {
        let result = self
            .call(
                "prepare1",
                Action::Prepare {
                    binding: binding.clone(),
                    scope: Scope {
                        run_id: "run1".into(),
                        call_id: "call1".into(),
                        scope_id: "scope1".into(),
                    },
                    target,
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(result.status, "prepared");
        serde_json::from_value(result.result.unwrap()).unwrap()
    }
}
fn http(url: String) -> PrivateConfig {
    PrivateConfig::StreamableHttp {
        endpoint: url,
        auth: Auth::None,
    }
}
fn identity(authority: Authority) -> Identity {
    Identity {
        operation_id: "effect1".into(),
        authority,
    }
}
#[tokio::test]
async fn desktop_lifecycle_mcp_quiesce_preserves_original_stop_status_and_result() {
    let fixture = tests::fixture("slow_call").await;
    let h = Arc::new(Harness::new());
    let reference = h.config(http(fixture.url.clone())).await;
    let binding = h.connect(&reference).await;
    let original = identity(
        h.prepare(
            &binding,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await,
    );
    let worker = h.clone();
    let target = original.clone();
    let work = tokio::spawn(async move {
        worker
            .call(
                "effect1",
                Action::Invoke {
                    identity: target,
                    arguments: json!({}),
                },
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while fixture.effects.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    h.service.quiesce();
    let stop = h
        .call(
            "effect1",
            Action::Stop {
                identity: original.clone(),
            },
        )
        .await;
    assert_ne!(stop.status, "notStarted");
    assert_eq!(
        h.call(
            "fresh",
            Action::Connect {
                server_id: "server1".into(),
                config_revision: 1,
                private_revision: reference
            }
        )
        .await
        .status,
        "notStarted"
    );
    let reply = work.await.unwrap();
    // Stop after dispatch cannot establish a remote rollback. Preserve that
    // original terminal uncertainty and its exact retained readback.
    assert_eq!(reply.status, "unknown");
    let retained = h
        .call("effect1", Action::Status { identity: original })
        .await;
    assert_eq!(retained.status, reply.status);
    assert_eq!(retained.result, reply.result);
    assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
    assert!(h.service.shutdown().await);
    assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn mcp_service_real_http_lifecycles_original_receipts_and_resources() {
    for mode in ["modern", "legacy"] {
        let fixture = tests::fixture(mode).await;
        let h = Harness::new();
        let reference = h.config(http(fixture.url.clone())).await;
        let binding = h.connect(&reference).await;
        let again = h
            .call(
                "connect1",
                Action::Connect {
                    server_id: "server1".into(),
                    config_revision: 1,
                    private_revision: reference,
                },
            )
            .await;
        assert_eq!(
            again.result.unwrap()["binding"],
            serde_json::to_value(&binding).unwrap()
        );
        let authority = h
            .prepare(
                &binding,
                Target::Tool {
                    raw_name: "counter".into(),
                },
            )
            .await;
        let original = identity(authority);
        let r = h
            .call(
                "effect1",
                Action::Invoke {
                    identity: original.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(r.status, "completed");
        let r = h
            .call(
                "effect1",
                Action::Invoke {
                    identity: original.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(r.status, "completed");
        assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
        let handle = format!(
            "resource_{}",
            catalogue::digest(
                &serde_json::to_vec(&["server1", "fixture://note/镜头?x=\"q\""]).unwrap()
            )
        );
        let a = h
            .prepare(&binding, Target::Resource { handle_id: handle })
            .await;
        let r = h
            .call(
                "read1",
                Action::Invoke {
                    identity: Identity {
                        operation_id: "read1".into(),
                        authority: a,
                    },
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(r.status, "completed");
        let d = h
            .call(
                "disconnect1",
                Action::Disconnect {
                    binding: binding.clone(),
                },
            )
            .await;
        assert_eq!(d.status, "drained");
        let late = h
            .call("effect1", Action::Status { identity: original })
            .await;
        assert_eq!(late.status, "completed");
        let d = h.call("disconnect2", Action::Disconnect { binding }).await;
        assert_eq!(d.status, "drained");
    }
}
#[tokio::test]
async fn mcp_service_effect_lost_expired_401_never_replays() {
    for mode in ["lost", "expired", "unauthorized"] {
        let fixture = tests::fixture(mode).await;
        let h = Harness::new();
        let reference = h.config(http(fixture.url.clone())).await;
        let b = h.connect(&reference).await;
        let a = h
            .prepare(
                &b,
                Target::Tool {
                    raw_name: "counter".into(),
                },
            )
            .await;
        let i = identity(a);
        let r = h
            .call(
                "effect1",
                Action::Invoke {
                    identity: i.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(r.status, "unknown");
        let r = h
            .call(
                "effect1",
                Action::Invoke {
                    identity: i.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        assert_eq!(r.status, "unknown");
        let _ = h.call("effect1", Action::Status { identity: i }).await;
        assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|m| m.as_str() == "tools/call")
                .count(),
            1
        );
        h.call("dispose1", Action::Dispose {}).await;
    }
}
#[tokio::test]
async fn mcp_service_retirement_cannot_start_old_authority_and_duplicate_op_is_atomic() {
    let fixture = tests::fixture("modern").await;
    let h = Harness::new();
    let r = h.config(http(fixture.url.clone())).await;
    let b = h.connect(&r).await;
    let a = h
        .prepare(
            &b,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await;
    let i = identity(a.clone());
    let (r1, r2) = tokio::join!(
        h.call(
            "effect1",
            Action::Invoke {
                identity: i.clone(),
                arguments: json!({})
            }
        ),
        h.call(
            "effect1",
            Action::Invoke {
                identity: i.clone(),
                arguments: json!({})
            }
        )
    );
    assert_eq!(r1.status, "completed");
    assert_eq!(r2.status, "completed");
    assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
    let old = h
        .prepare(
            &b,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await;
    h.call(
        "retire1",
        Action::Retire {
            server_id: "server1".into(),
            expected_config_revision: Some(1),
        },
    )
    .await;
    let r = h
        .call(
            "effect2",
            Action::Invoke {
                identity: Identity {
                    operation_id: "effect2".into(),
                    authority: old,
                },
                arguments: json!({}),
            },
        )
        .await;
    assert_eq!(r.status, "notStarted");
    assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
    let replay = h
        .call(
            "effect1",
            Action::Invoke {
                identity: i,
                arguments: json!({}),
            },
        )
        .await;
    assert_eq!(replay.status, "completed");
}
#[tokio::test]
async fn mcp_service_http_stop_keeps_unknown_and_never_replays() {
    let fixture = tests::fixture("slow_call").await;
    let h = Arc::new(Harness::new());
    let r = h.config(http(fixture.url.clone())).await;
    let b = h.connect(&r).await;
    let i = identity(
        h.prepare(
            &b,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await,
    );
    let work = {
        let h = h.clone();
        let i = i.clone();
        tokio::spawn(async move {
            h.call(
                "effect1",
                Action::Invoke {
                    identity: i,
                    arguments: json!({}),
                },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        while fixture.effects.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
    let stop = h
        .call(
            "effect1",
            Action::Stop {
                identity: i.clone(),
            },
        )
        .await;
    assert_eq!(stop.status, "unknown");
    let reply = work.await.unwrap();
    assert_eq!(reply.status, "unknown");
    let status = h.call("effect1", Action::Status { identity: i }).await;
    assert_eq!(status.status, "unknown");
    assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
    h.call("dispose1", Action::Dispose {}).await;
}
#[cfg(unix)]
#[tokio::test]
async fn mcp_service_real_stdio_discovery_invoke_and_drain() {
    let h = Harness::new();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/fixtures/server.py");
    let reference = h
        .config(PrivateConfig::Stdio {
            executable: "/usr/bin/python3".into(),
            args: vec!["-u".into(), path.to_string_lossy().into(), "modern".into()],
            cwd: None,
            environment: HashMap::new(),
        })
        .await;
    let b = h.connect(&reference).await;
    let i = identity(
        h.prepare(
            &b,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await,
    );
    assert_eq!(
        h.call(
            "effect1",
            Action::Invoke {
                identity: i,
                arguments: json!({})
            }
        )
        .await
        .status,
        "completed"
    );
    assert_eq!(
        h.call("dispose1", Action::Dispose {}).await.status,
        "drained"
    );
}
fn stdio_fixture_config() -> PrivateConfig {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/fixtures/server.py");
    PrivateConfig::Stdio {
        executable: "/usr/bin/python3".into(),
        args: vec!["-u".into(), path.to_string_lossy().into(), "modern".into()],
        cwd: None,
        environment: HashMap::new(),
    }
}
#[tokio::test]
async fn mcp_service_stdio_start_requires_native_consent_and_decline_spawns_nothing() {
    let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = asked.clone();
    let h = Harness::new_with_consent(Arc::new(move |exe, args| {
        assert_eq!(exe, "/usr/bin/python3");
        assert!(args.iter().any(|a| a == "modern"));
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        false
    }));
    let reference = h.config(stdio_fixture_config()).await;
    let reply = h
        .call(
            "connect1",
            Action::Connect {
                server_id: "server1".into(),
                config_revision: 1,
                private_revision: reference.clone(),
            },
        )
        .await;
    assert_eq!(reply.status, "unknown");
    assert_eq!(reply.error.unwrap().code, "denied");
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        h.call("dispose1", Action::Dispose {}).await.status,
        "drained"
    );
}
#[tokio::test]
async fn mcp_service_stdio_consent_is_asked_once_per_launch_and_then_connects() {
    let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = asked.clone();
    let h = Harness::new_with_consent(Arc::new(move |_, _| {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        true
    }));
    let reference = h.config(stdio_fixture_config()).await;
    let _ = h.connect(&reference).await;
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
    h.call("dispose1", Action::Dispose {}).await;
}
#[tokio::test]
async fn mcp_service_private_lost_ack_reconciles_same_original_and_rejects_current_cleanup() {
    let h = Harness::new();
    h.memory.lose_manifest.store(true, Ordering::SeqCst);
    let config = http("https://fixture.invalid/mcp".into());
    let request = Action::PrivatePrepare {
        server_id: "server1".into(),
        catalogue_revision: 0,
        expected_config_revision: 0,
        config: config.clone(),
    };
    let r = h.call("save1", request.clone()).await;
    assert_eq!(r.status, "unknown");
    let prepared = h
        .call(
            "save1",
            Action::PrivateStatus {
                server_id: "server1".into(),
            },
        )
        .await;
    assert_eq!(prepared.status, "prepared");
    let reference: PrivateRef =
        serde_json::from_value(prepared.result.unwrap()["reference"].clone()).unwrap();
    let original = h.call("save1", request).await;
    assert_eq!(original.status, "unknown");
    let mut changed = config;
    if let PrivateConfig::StreamableHttp { endpoint, .. } = &mut changed {
        *endpoint = "https://changed.invalid".into()
    }
    assert_eq!(
        h.call(
            "save1",
            Action::PrivatePrepare {
                server_id: "server1".into(),
                catalogue_revision: 0,
                expected_config_revision: 0,
                config: changed
            }
        )
        .await
        .status,
        "notStarted"
    );
    *h.catalogue.lock().unwrap() = json!({"version":1,"revision":1,"entries":[{"serverId":"server1","configRevision":1,"enabled":false,"label":"Fixture","transport":"streamable_http","auth":"none","endpointDisplay":"https://fixture.invalid","privateRevision":reference}],"receipts":[{"operationId":"save1","fingerprint":"a".repeat(64),"kind":"save","serverId":"server1","catalogueRevision":1,"configRevision":1,"publishedPrivateRevision":reference}]});
    let cleanup = h
        .call(
            "cleanup1",
            Action::PrivateDiscard {
                server_id: "server1".into(),
                reference,
            },
        )
        .await;
    assert_eq!(cleanup.status, "notStarted");
}
#[tokio::test]
async fn mcp_service_native_current_catalogue_and_session_are_final_guards() {
    let fixture = tests::fixture("modern").await;
    let h = Harness::new();
    let r = h.config(http(fixture.url.clone())).await;
    let b = h.connect(&r).await;
    let i = identity(
        h.prepare(
            &b,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await,
    );
    h.catalogue.lock().unwrap()["entries"][0]["enabled"] = json!(false);
    assert_eq!(
        h.call(
            "effect1",
            Action::Invoke {
                identity: i,
                arguments: json!({})
            }
        )
        .await
        .status,
        "notStarted"
    );
    assert_eq!(fixture.effects.load(Ordering::SeqCst), 0);
    let mut bad = h.session.clone();
    bad.generation += 1;
    let r = h
        .service
        .request(Envelope {
            version: 1,
            operation_id: "caps1".into(),
            session: bad,
            host_session_id: None,
            action: Action::Capabilities {},
        })
        .await;
    assert_eq!(r.status, "notStarted");
    h.call("dispose1", Action::Dispose {}).await;
}

#[cfg(unix)]
#[tokio::test]
async fn mcp_service_stdio_stop_keeps_unknown_when_sdk_cancels_original() {
    let h = Arc::new(Harness::new());
    let marker = std::env::temp_dir().join(format!("momoki-mcp-effect-{}", uuid::Uuid::new_v4()));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/fixtures/server.py");
    let reference = h
        .config(PrivateConfig::Stdio {
            executable: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                path.to_string_lossy().into(),
                "slow_call".into(),
                marker.to_string_lossy().into(),
            ],
            cwd: None,
            environment: HashMap::new(),
        })
        .await;
    let b = h.connect(&reference).await;
    let i = identity(
        h.prepare(
            &b,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await,
    );
    let work = {
        let h = h.clone();
        let i = i.clone();
        tokio::spawn(async move {
            h.call(
                "effect1",
                Action::Invoke {
                    identity: i,
                    arguments: json!({}),
                },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        while !marker.exists() {
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
    assert_eq!(
        h.call(
            "effect1",
            Action::Stop {
                identity: i.clone()
            }
        )
        .await
        .status,
        "unknown"
    );
    assert_eq!(work.await.unwrap().status, "unknown");
    assert_eq!(
        h.call("effect1", Action::Status { identity: i })
            .await
            .status,
        "unknown"
    );
    h.call("dispose1", Action::Dispose {}).await;
    std::fs::remove_file(marker).unwrap();
}

#[tokio::test]
async fn mcp_service_verified_original_ack_survives_retirement() {
    let fixture = tests::fixture("slow_call").await;
    let h = Arc::new(Harness::new());
    let r = h.config(http(fixture.url.clone())).await;
    let b = h.connect(&r).await;
    let i = identity(
        h.prepare(
            &b,
            Target::Tool {
                raw_name: "counter".into(),
            },
        )
        .await,
    );
    let work = {
        let h = h.clone();
        let i = i.clone();
        tokio::spawn(async move {
            h.call(
                "effect1",
                Action::Invoke {
                    identity: i,
                    arguments: json!({}),
                },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let status = h
                .call(
                    "effect1",
                    Action::Status {
                        identity: i.clone(),
                    },
                )
                .await;
            if status.status == "completed" {
                break;
            }
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
    h.call(
        "retire1",
        Action::Retire {
            server_id: "server1".into(),
            expected_config_revision: Some(1),
        },
    )
    .await;
    assert_eq!(work.await.unwrap().status, "completed");
    assert_eq!(
        h.call("effect1", Action::Status { identity: i })
            .await
            .status,
        "completed"
    );
    assert_eq!(fixture.effects.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn mcp_service_pending_connect_retirement_drains_unpublished_process_tree() {
    let h = Arc::new(Harness::new());
    let dir = std::env::temp_dir().join(format!("momoki-mcp-pending-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let marker = dir.join("pids");
    let release = dir.join("release");
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/fixtures/server.py");
    let reference = h
        .config(PrivateConfig::Stdio {
            executable: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into(),
                "slow_discovery".into(),
                marker.to_string_lossy().into(),
                release.to_string_lossy().into(),
            ],
            cwd: None,
            environment: HashMap::new(),
        })
        .await;
    let work = {
        let h = h.clone();
        let reference = reference.clone();
        tokio::spawn(async move {
            h.call(
                "connect1",
                Action::Connect {
                    server_id: "server1".into(),
                    config_revision: 1,
                    private_revision: reference,
                },
            )
            .await
        })
    };
    let pids = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(bytes) = std::fs::read(&marker) {
                if let Ok(pids) = serde_json::from_slice::<Vec<i32>>(&bytes) {
                    break pids;
                }
            }
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
    assert_eq!(
        h.call(
            "retire1",
            Action::Retire {
                server_id: "server1".into(),
                expected_config_revision: Some(1)
            }
        )
        .await
        .status,
        "draining"
    );
    std::fs::write(&release, "release").unwrap();
    assert_ne!(work.await.unwrap().status, "connected");
    assert_eq!(
        h.call(
            "retire2",
            Action::Retire {
                server_id: "server1".into(),
                expected_config_revision: Some(1)
            }
        )
        .await
        .status,
        "drained"
    );
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    for pid in pids {
        assert_eq!(
            unsafe { kill(pid, 0) },
            -1,
            "owned descendant survived actual drain"
        )
    }
    let repeated = h
        .call(
            "connect1",
            Action::Connect {
                server_id: "server1".into(),
                config_revision: 1,
                private_revision: reference,
            },
        )
        .await;
    assert_ne!(repeated.status, "connected");
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn mcp_service_finite_original_receipts_refuse_without_evicting() {
    let h = Harness::new();
    for i in 0..256 {
        let op = format!("save{i}");
        assert_eq!(
            h.call(
                &op,
                Action::PrivatePrepare {
                    server_id: "server1".into(),
                    catalogue_revision: 0,
                    expected_config_revision: 0,
                    config: http("https://fixture.invalid/mcp".into())
                }
            )
            .await
            .status,
            "prepared"
        )
    }
    let refused = h
        .call(
            "save256",
            Action::PrivatePrepare {
                server_id: "server1".into(),
                catalogue_revision: 0,
                expected_config_revision: 0,
                config: http("https://fixture.invalid/mcp".into()),
            },
        )
        .await;
    assert_eq!(refused.status, "notStarted");
    assert_eq!(refused.error.unwrap().code, "limit");
    assert_eq!(
        h.call(
            "save0",
            Action::PrivateStatus {
                server_id: "server1".into()
            }
        )
        .await
        .status,
        "prepared"
    );
}
