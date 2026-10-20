//! Closed renderer domain bridge. Paths are selected by native dialogs only.
use crate::{
    Asset, AssetKind, Baseline, Beat, BeatPatch, Episode, EpisodePatch, Error, Hooks,
    ImportRequest, Job, Outcome, Project, Result, Shot, ShotPatch, State, StorageWorker,
    VideoProject, paths,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const UI_BYTES: usize = 32 * 1024 * 1024;
const MAX_READS: usize = 4;

#[derive(Default)]
pub struct ProductBridge {
    lifecycle: Arc<crate::desktop_lifecycle::Lifecycle>,
    worker: Mutex<Option<Arc<StorageWorker>>>,
    previews: Arc<crate::product_media::MediaPreviews>,
    media_server: Mutex<Option<crate::product_media::MediaServer>>,
    local_media: crate::desktop_media::DesktopMedia,
    skill_import: crate::skill_import::SkillDirectoryImport,
    mcp: Mutex<Option<Arc<crate::mcp::service::Service>>>,
}
impl ProductBridge {
    pub(crate) fn quiesce(
        self: &Arc<Self>,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let imports = self.local_media.shutdown();
        self.skill_import.quiesce();
        if let Some(service) = self.mcp.lock().unwrap().as_ref() {
            service.quiesce();
        }
        let bridge = self.clone();
        async move {
            tokio::join!(imports, bridge.skill_import.drain());
        }
    }
    pub(crate) async fn cleanup(self: Arc<Self>) {
        let service = self.mcp.lock().unwrap().as_ref().cloned();
        if let Some(service) = service {
            while !service.shutdown().await {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
        self.local_media.stop_all();
        self.previews.clear();
        self.media_server.lock().unwrap().take();
    }
    pub(crate) fn close_worker(&self) {
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.close();
        }
    }
}
fn validate_lifecycle_session(
    worker: &StorageWorker,
    session: crate::full_product_store::protocol::Session,
) -> Result<()> {
    worker.run_product(crate::ProductJob::Validate(session))?;
    Ok(())
}
#[tauri::command]
async fn product_lifecycle_request(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: crate::desktop_lifecycle::Envelope,
) -> Result<crate::desktop_lifecycle::Snapshot> {
    use crate::desktop_lifecycle::Action;
    trusted(&window)?;
    if request.version != 1 {
        return Err(Error::new("invalid", "Invalid lifecycle version"));
    }
    match &request.session {
        Some(session) if cfg!(any(feature = "product-sqlite", feature = "acceptance")) => {
            let worker = full_product_worker(&window, &bridge, false)?;
            let session = session.clone();
            tauri::async_runtime::spawn_blocking(move || {
                validate_lifecycle_session(&worker, session)
            })
            .await
            .map_err(|_| Error::new("closed", "Lifecycle session unavailable"))??;
        }
        None if !cfg!(any(feature = "product-sqlite", feature = "acceptance")) => {}
        _ => return Err(Error::new("invalid", "Lifecycle storage owner mismatch")),
    }
    if matches!(request.action, Action::Status {}) {
        bridge.lifecycle.attach(request.session)?;
    } else {
        bridge
            .lifecycle
            .acknowledge(&request.session, request.action)?;
    }
    Ok(bridge.lifecycle.snapshot(
        window.is_visible().unwrap_or(false),
        window.is_focused().unwrap_or(false),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BinaryEnvelope {
    version: u32,
    session: String,
    workspace_id: String,
    generation: u64,
    action: crate::product_binary::BinaryRequest,
}
impl BinaryEnvelope {
    fn session(&self) -> crate::full_product_store::protocol::Session {
        crate::full_product_store::protocol::Session {
            version: self.version,
            session: self.session.clone(),
            workspace_id: self.workspace_id.clone(),
            generation: self.generation,
        }
    }
}
fn full_product_worker(
    window: &WebviewWindow,
    bridge: &ProductBridge,
    opening: bool,
) -> Result<Arc<StorageWorker>> {
    if opening {
        bridge.lifecycle.admit_effect()?;
    }
    let mut current = bridge
        .worker
        .lock()
        .map_err(|_| Error::new("worker", "Product worker lifecycle poisoned"))?;
    // The resource lock is the final worker reservation boundary. A queued
    // bootstrap may have passed its entrance check before Quit closed admission.
    if opening {
        bridge.lifecycle.admit_effect()?;
    }
    if let Some(worker) = current.as_ref() {
        return Ok(Arc::clone(worker));
    }
    if !opening {
        return Err(Error::new("closed", "Full-product store is not open"));
    }
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| Error::new("unavailable", "Application data directory unavailable"))?;
    fs::create_dir_all(&root)?;
    let root = root.join("product-workspace-v1");
    let create = match fs::symlink_metadata(&root) {
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(e.into()),
    };
    let worker = Arc::new(StorageWorker::product(root, create, Hooks::default())?);
    *current = Some(Arc::clone(&worker));
    Ok(worker)
}
fn invalidate_mcp(bridge: &ProductBridge) {
    if let Ok(mut slot) = bridge.mcp.lock() {
        if let Some(service) = slot.take() {
            service.invalidate()
        }
    }
}
fn close_product(bridge: &ProductBridge) {
    invalidate_mcp(bridge);
    bridge.skill_import.invalidate();
    bridge.local_media.stop_all();
    bridge.previews.clear();
    if let Ok(mut server) = bridge.media_server.lock() {
        server.take();
    }
    if let Ok(mut slot) = bridge.worker.lock()
        && let Some(worker) = slot.take()
    {
        let _ = worker.close();
    }
}
#[tauri::command]
async fn mcp_service_request(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: crate::mcp::protocol::Envelope,
) -> Result<crate::mcp::protocol::Reply> {
    trusted(&window)?;
    if matches!(
        request.action,
        crate::mcp::protocol::Action::PrivatePrepare { .. }
            | crate::mcp::protocol::Action::Connect { .. }
            | crate::mcp::protocol::Action::Prepare { .. }
            | crate::mcp::protocol::Action::Invoke { .. }
            | crate::mcp::protocol::Action::OauthBegin { .. }
    ) {
        bridge.lifecycle.admit_effect()?;
    }
    let worker = full_product_worker(&window, &bridge, false)?;
    let session = request.session.clone();
    let validate_worker = worker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        validate_worker.run_product(crate::ProductJob::Validate(session))
    })
    .await
    .map_err(|_| Error::new("unavailable", "MCP store validation interrupted"))??;
    let service = {
        let mut slot = bridge
            .mcp
            .lock()
            .map_err(|_| Error::new("unavailable", "MCP owner unavailable"))?;
        if slot
            .as_ref()
            .is_some_and(|s| !s.matches_session(&request.session))
        {
            if let Some(previous) = slot.take() {
                previous.invalidate()
            }
        }
        if slot.is_none() {
            bridge.lifecycle.admit_effect()?;
            let source = Arc::new(
                move |session: &crate::full_product_store::protocol::Session| {
                    let value = worker
                        .run_product(crate::ProductJob::McpCatalogue(session.clone()))
                        .map_err(|_| crate::mcp::McpError::VaultConflict)?;
                    crate::mcp::catalogue::Catalogue::parse(value)
                },
            );
            let open_window = window.clone();
            let open = Arc::new(move |url: &str| {
                crate::runtime_services::product_open_external(open_window.clone(), url.to_owned())
                    .map_err(|_| crate::mcp::McpError::Transport)
            });
            let consent_window = window.clone();
            let consent: crate::mcp::service::Consent = Arc::new(move |exe, args| {
                use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
                let shown = args.iter().take(8).cloned().collect::<Vec<_>>().join(" ");
                let shown: String = shown.chars().take(400).collect();
                consent_window
                    .dialog()
                    .message(format!(
                        "要启动本机程序作为 MCP 服务：\n{exe}\n参数：{shown}\n\n该程序将以你的用户权限运行，没有沙箱。仅在信任它时继续。"
                    ))
                    .title("启动本机 MCP 服务")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "启动".into(),
                        "取消".into(),
                    ))
                    .blocking_show()
            });
            let app = window.app_handle().config().identifier.clone();
            let profile = if cfg!(feature = "acceptance") {
                "isolated"
            } else if cfg!(feature = "product-sqlite") {
                "product-sqlite"
            } else {
                "reference"
            }
            .to_owned();
            *slot = Some(
                crate::mcp::service::Service::native(
                    request.session.clone(),
                    source,
                    app,
                    profile,
                    open,
                    bridge.lifecycle.effects.clone(),
                    consent,
                )
                .map_err(|_| {
                    Error::new(
                        "vaultUnavailable",
                        "Native MCP credential owner unavailable",
                    )
                })?,
            );
        }
        slot.as_ref().unwrap().clone()
    };
    Ok(service.request(request).await)
}
#[tauri::command]
async fn skill_import_directory(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: crate::skill_import::SkillImportEnvelope,
) -> Result<serde_json::Value> {
    trusted(&window)?;
    bridge.lifecycle.admit_effect()?;
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err(Error::new(
            "platform",
            "Skill directory import is supported on macOS and Windows",
        ));
    }
    let session = request.scope()?;
    let bridge = Arc::clone(bridge.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let worker = full_product_worker(&window, &bridge, false)?;
        bridge.skill_import.pick(
            &request.operation_id,
            || {
                select_path(
                    window
                        .dialog()
                        .file()
                        .set_title("选择技能文件夹")
                        .blocking_pick_folder(),
                )
            },
            || {
                trusted(&window)?;
                worker.run_product(crate::ProductJob::Validate(session.clone()))?;
                Ok(())
            },
        )
    })
    .await
    .map_err(|_| Error::new("unavailable", "Skill directory request interrupted"))?
}
#[tauri::command]
async fn desktop_media_request(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: crate::desktop_media::MediaEnvelope,
) -> Result<serde_json::Value> {
    trusted(&window)?;
    if matches!(
        request.action,
        crate::desktop_media::MediaAction::PickDirectory { .. }
            | crate::desktop_media::MediaAction::Scan { .. }
            | crate::desktop_media::MediaAction::PrepareVideo { .. }
    ) {
        bridge.lifecycle.admit_effect()?;
    }
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err(Error::new(
            "platform",
            "Local media is supported on macOS and Windows",
        ));
    }
    let scope = request.scope()?;
    let bridge = Arc::clone(bridge.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let worker = full_product_worker(&window, &bridge, false)?;
        worker.run_product(crate::ProductJob::Validate(scope.session.clone()))?;
        if let crate::desktop_media::MediaAction::PickDirectory { operation_id } = request.action {
            bridge.local_media.pick(&scope, &operation_id, || {
                select_path(
                    window
                        .dialog()
                        .file()
                        .set_title("选择要导入的视频素材目录")
                        .blocking_pick_folder(),
                )
            })
        } else {
            let staging = window
                .app_handle()
                .path()
                .app_cache_dir()
                .map_err(|_| Error::new("unavailable", "Application cache directory unavailable"))?
                .join("media-operations-v1");
            let resources = window.app_handle().path().resource_dir().map_err(|_| {
                Error::new("decoderUnavailable", "Application resources unavailable")
            })?;
            bridge
                .local_media
                .request(&scope, request.action, &worker, &staging, &resources)
        }
    })
    .await
    .map_err(|_| Error::new("unavailable", "Local media request interrupted"))?
}
#[tauri::command]
async fn product_store_request(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: crate::full_product_store::protocol::Request,
) -> Result<serde_json::Value> {
    trusted(&window)?;
    let opening = matches!(
        request,
        crate::full_product_store::protocol::Request::Open(_)
    );
    let bridge = Arc::clone(bridge.inner());
    if opening {
        bridge.lifecycle.detach();
        invalidate_mcp(&bridge);
        bridge.skill_import.invalidate();
        bridge.previews.clear();
        bridge.local_media.stop_all();
    }
    let event_window = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let worker = full_product_worker(&window, &bridge, opening)?;
        worker.run_product(crate::ProductJob::Store(request))
    })
    .await
    .map_err(|_| Error::new("unavailable", "Product storage request interrupted"))??;
    Ok(deliver_product_result(result, |change| {
        event_window.emit("product-store-changed", change)
    }))
}

// Durable storage acknowledgement is authoritative. Notification delivery may
// fail after COMMIT (including during a status lookup) without changing it.
fn deliver_product_result<E>(
    result: serde_json::Value,
    notify: impl FnOnce(serde_json::Value) -> std::result::Result<(), E>,
) -> serde_json::Value {
    if result["status"] == "committed" {
        let _ = notify(serde_json::json!({"changeSequence":result["changeSequence"]}));
    }
    result
}
#[tauri::command]
async fn product_binary_request(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: BinaryEnvelope,
) -> Result<serde_json::Value> {
    trusted(&window)?;
    let bridge = Arc::clone(bridge.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let worker = full_product_worker(&window, &bridge, false)?;
        worker.run_product(crate::ProductJob::Binary {
            session: request.session(),
            request: request.action,
        })
    })
    .await
    .map_err(|_| Error::new("unavailable", "Managed binary request interrupted"))?
}
#[tauri::command]
async fn product_binary_read(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: BinaryEnvelope,
) -> Result<tauri::ipc::Response> {
    if !matches!(
        request.action,
        crate::product_binary::BinaryRequest::ReadChunk { .. }
    ) {
        return Err(Error::new(
            "invalid",
            "Raw managed reader only accepts readChunk",
        ));
    }
    let result = product_binary_request(window, bridge, request).await?;
    let bytes = result
        .get("bytes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| Error::new("invalid", "Invalid managed byte reply"))?
        .iter()
        .map(|n| {
            n.as_u64()
                .filter(|n| *n <= 255)
                .map(|n| n as u8)
                .ok_or_else(|| Error::new("invalid", "Invalid byte"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
async fn product_binary_write(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: tauri::ipc::Request<'_>,
) -> Result<serde_json::Value> {
    trusted(&window)?;
    let metadata = request
        .headers()
        .get("x-momoki-binary")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::new("invalid", "Missing managed byte metadata"))?;
    if metadata.len() > 2048 {
        return Err(Error::new(
            "invalid",
            "Managed byte metadata exceeds boundary",
        ));
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Metadata {
        version: u32,
        session: String,
        workspace_id: String,
        generation: u64,
        stage_id: String,
        offset: u64,
    }
    let meta: Metadata = serde_json::from_str(metadata)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if !bytes.is_empty() && bytes.len() <= 262144 => {
            bytes.clone()
        }
        _ => {
            return Err(Error::new(
                "invalid",
                "Managed byte write needs a bounded raw chunk",
            ));
        }
    };
    let session = crate::full_product_store::protocol::Session {
        version: meta.version,
        session: meta.session,
        workspace_id: meta.workspace_id,
        generation: meta.generation,
    };
    let bridge = Arc::clone(bridge.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let worker = full_product_worker(&window, &bridge, false)?;
        worker.run_product(crate::ProductJob::Binary {
            session,
            request: crate::product_binary::BinaryRequest::Write {
                stage_id: meta.stage_id,
                offset: meta.offset,
                bytes,
            },
        })
    })
    .await
    .map_err(|_| Error::new("unavailable", "Managed byte write interrupted"))?
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MediaPreviewRequest {
    version: u32,
    session: String,
    workspace_id: String,
    generation: u64,
    reference: crate::product_binary::ManagedBinaryRef,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MediaReleaseRequest {
    version: u32,
    session: String,
    workspace_id: String,
    generation: u64,
    preview_id: String,
}
#[tauri::command]
async fn product_media_preview(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: MediaPreviewRequest,
) -> Result<serde_json::Value> {
    trusted(&window)?;
    let bridge = Arc::clone(bridge.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let worker=full_product_worker(&window,&bridge,false)?;
        let session=crate::full_product_store::protocol::Session {version:request.version,session:request.session,workspace_id:request.workspace_id,generation:request.generation};
        let file=worker.playback(session.clone(),request.reference.clone())?;
        // Opening another store session during hash verification cannot publish an old lease.
        worker.run_product(crate::ProductJob::Validate(session.clone()))?;
        let id=bridge.previews.insert(session, file)?;
        let mut server=bridge.media_server.lock().map_err(|_|Error::new("worker","Media transport lifecycle poisoned"))?;
        if server.is_none() {
            let validator_worker=Arc::clone(&worker);
            let validator_window=window.clone();
            *server=Some(crate::product_media::MediaServer::start(
                Arc::clone(&bridge.previews),crate::bundled_origin::origin().into(),
                Arc::new(move|session|{
                    trusted(&validator_window)?;
                    validator_worker.run_product(crate::ProductJob::Validate(session.clone()))?;
                    Ok(())
                }),
            )?);
        }
        let url=server.as_ref().ok_or_else(||Error::new("closed","Media transport stopped"))?.url(&id)?;
        Ok(serde_json::json!({"previewId":id,"url":url,"byteLength":request.reference.byte_length,"mimeType":request.reference.mime_type}))
    }).await.map_err(|_| Error::new("unavailable","Media preview preparation interrupted"))?
}
#[tauri::command]
async fn product_media_release(
    window: WebviewWindow,
    bridge: tauri::State<'_, Arc<ProductBridge>>,
    request: MediaReleaseRequest,
) -> Result<serde_json::Value> {
    trusted(&window)?;
    let session = crate::full_product_store::protocol::Session {
        version: request.version,
        session: request.session,
        workspace_id: request.workspace_id,
        generation: request.generation,
    };
    Ok(serde_json::json!({"released":bridge.previews.release(&session,&request.preview_id)?}))
}

#[derive(Default)]
pub struct Bridge {
    inner: Mutex<Inner>,
    lifecycle: Mutex<()>,
}
#[derive(Default)]
struct Inner {
    generation: u64,
    pending: bool,
    closing: bool,
    worker: Option<Arc<StorageWorker>>,
    last_root: Option<PathBuf>,
    requests: HashMap<String, RequestOwner>,
    reads: HashMap<String, ReadSession>,
}
struct RequestOwner {
    canceled: Arc<AtomicBool>,
    native: Option<(Arc<StorageWorker>, String)>,
}
struct ReadSession {
    generation: u64,
    asset: Asset,
    bytes: Arc<[u8]>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Envelope {
    version: u32,
    operation_id: String,
    expected_generation: u64,
    action: Action,
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Action {
    Ensure {},
    State {},
    Create {},
    Open {},
    Reopen {},
    Close {},
    Restore {},
    Project {
        project: Project,
    },
    CreateVideoProject {
        project: Project,
        video: VideoProject,
    },
    DeleteProject {
        project_id: String,
    },
    VideoState {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    VideoProject {
        video: VideoProject,
        #[serde(default)]
        baseline: Option<Baseline>,
    },
    PatchVideoProject {
        project_id: String,
        patch: crate::VideoProjectPatch,
        baseline: Option<Baseline>,
    },
    PatchEpisode {
        episode_id: String,
        patch: EpisodePatch,
        baseline: Option<Baseline>,
    },
    Episode {
        episode: Episode,
    },
    DeleteEpisode {
        episode_id: String,
    },
    ReorderEpisodes {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    Beat {
        beat: Beat,
    },
    PatchBeat {
        episode_id: String,
        beat_id: String,
        patch: BeatPatch,
        baseline: Option<Baseline>,
    },
    DuplicateBeat {
        episode_id: String,
        beat_id: String,
        include_shots: bool,
    },
    DeleteBeat {
        episode_id: String,
        beat_id: String,
    },
    ReorderBeats {
        #[serde(rename = "episodeId")]
        episode_id: String,
        #[serde(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    Shot {
        shot: Shot,
    },
    AddShots {
        project_id: String,
        episode_id: String,
        count: u32,
        at_order: Option<u32>,
        beat_id: Option<String>,
    },
    PatchShot {
        shot_id: String,
        patch: ShotPatch,
        baseline: Option<Baseline>,
    },
    DuplicateShot {
        episode_id: String,
        shot_id: String,
    },
    DeleteShots {
        episode_id: String,
        shot_ids: Vec<String>,
    },
    BulkShots {
        episode_id: String,
        shot_ids: Vec<String>,
        patch: ShotPatch,
    },
    VideoUndo {
        receipt: crate::UndoReceipt,
    },
    ReorderShots {
        #[serde(rename = "episodeId")]
        episode_id: String,
        #[serde(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    Import {
        metadata: ImportMetadata,
    },
    Availability {},
    Backup {},
    ReadStart {
        #[serde(rename = "assetId")]
        asset_id: String,
    },
    ReadChunk {
        session: String,
        offset: usize,
        length: usize,
    },
    ReadClose {
        session: String,
    },
    Export {
        #[serde(rename = "assetId")]
        asset_id: String,
    },
    SaveGenerated {
        metadata: GeneratedMetadata,
        mode: SaveMode,
        bytes: BoundedBytes,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportMetadata {
    project_id: String,
    asset_id: String,
    kind: AssetKind,
    display_name: String,
    mime_type: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedMetadata {
    project_id: String,
    asset_id: String,
    format: GeneratedFormat,
    recorded_mime: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum GeneratedFormat {
    Csv,
    Zip,
    Wav,
    Microphone,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum SaveMode {
    Retain,
    Export,
}
/// A visitor enforces observed input count while decoding, not after a Vec allocation.
struct BoundedBytes(Vec<u8>);
impl<'de> Deserialize<'de> for BoundedBytes {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = BoundedBytes;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("at most 32 MiB of byte values")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(UI_BYTES));
                while let Some(byte) = seq.next_element::<u8>()? {
                    if bytes.len() == UI_BYTES {
                        return Err(serde::de::Error::custom("generated byte boundary"));
                    }
                    bytes.push(byte);
                }
                Ok(BoundedBytes(bytes))
            }
        }
        deserializer.deserialize_seq(Visitor)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    version: u32,
    generation: u64,
    result: Value,
}
#[derive(Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
enum Value {
    State(Option<State>),
    Outcome(Box<Outcome>),
    Canceled,
    Closed,
    Read(ReadDescription),
    Chunk(Vec<u8>),
    Released,
    Saved(Saved),
    Exported(Exported),
}
impl Value {
    fn outcome(value: Outcome) -> Self {
        Self::Outcome(Box::new(value))
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadDescription {
    session: String,
    asset: Asset,
    chunk_bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    asset: Asset,
    exported: bool,
    byte_length: usize,
    content_hash: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Exported {
    byte_length: usize,
    content_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelEnvelope {
    version: u32,
    expected_generation: u64,
    operation_id: String,
}

fn lock(bridge: &Bridge) -> Result<std::sync::MutexGuard<'_, Inner>> {
    bridge
        .inner
        .lock()
        .map_err(|_| Error::new("bridge", "Bridge state poisoned"))
}
fn packaged(window: &WebviewWindow) -> bool {
    window.label() == "main"
        && window
            .url()
            .is_ok_and(|u| crate::bundled_origin::accepts(&u))
}
pub(crate) fn trusted(window: &WebviewWindow) -> Result<()> {
    if packaged(window) {
        Ok(())
    } else {
        Err(Error::new(
            "caller",
            "Only the bundled main window is trusted",
        ))
    }
}
fn current(inner: &Inner, generation: u64) -> Result<()> {
    if inner.generation != generation {
        Err(Error::new("closed", "Workspace generation changed"))
    } else {
        Ok(())
    }
}
fn checked(bridge: &Bridge, generation: u64, cancel: &AtomicBool) -> Result<()> {
    {
        let inner = lock(bridge)?;
        current(&inner, generation)?;
    }
    if cancel.load(Ordering::Acquire) {
        return Err(Error::new("canceled", "Operation canceled"));
    }
    Ok(())
}
fn worker(bridge: &Bridge, generation: u64) -> Result<Arc<StorageWorker>> {
    let inner = lock(bridge)?;
    current(&inner, generation)?;
    if inner.closing {
        return Err(Error::new("closed", "Workspace is closing"));
    }
    inner
        .worker
        .clone()
        .ok_or_else(|| Error::new("closed", "Open a workspace first"))
}
fn execute(
    bridge: &Bridge,
    generation: u64,
    request_id: &str,
    cancel: &AtomicBool,
    job: Job,
) -> Result<Outcome> {
    checked(bridge, generation, cancel)?;
    let worker = worker(bridge, generation)?;
    let conflict_job = job.clone();
    let operation = worker.submit(job)?;
    {
        let mut inner = lock(bridge)?;
        let owner = inner
            .requests
            .get_mut(request_id)
            .ok_or_else(|| Error::new("operation", "Request owner missing"))?;
        owner.native = Some((worker.clone(), operation.id.clone()));
        // Cancellation may have won between submit and binding. Never queue cancellation.
        if cancel.load(Ordering::Acquire) || inner.generation != generation {
            worker.cancel(&operation.id)?;
        }
    }
    match operation.wait() {
        Err(error) if error.code == "conflict" => {
            checked(bridge, generation, cancel)?;
            let state = state_of(&worker)?;
            checked(bridge, generation, cancel)?;
            match crate::workspace::conflict_for_job(&state, &conflict_job)? {
                Some(conflict) => Ok(Outcome::Conflict(conflict)),
                None => Err(error),
            }
        }
        result => result,
    }
}
fn state_of(worker: &StorageWorker) -> Result<State> {
    match worker.run(Job::State)? {
        Outcome::State(state) => Ok(state),
        _ => Err(Error::new("bridge", "Unexpected state reply")),
    }
}
fn select_path(selection: Option<tauri_plugin_dialog::FilePath>) -> Result<Option<PathBuf>> {
    selection
        .map(|p| {
            p.into_path()
                .map_err(|e| Error::new("dialog", e.to_string()))
        })
        .transpose()
}
fn select_fresh(window: &WebviewWindow, title: &str, name: &str) -> Result<Option<PathBuf>> {
    select_path(
        window
            .dialog()
            .file()
            .set_title(title)
            .set_file_name(name)
            .blocking_save_file(),
    )
}
fn transition(
    bridge: &Bridge,
    generation: u64,
    cancel: &AtomicBool,
    build: impl FnOnce() -> Result<(StorageWorker, PathBuf)>,
) -> Result<Value> {
    {
        let inner = lock(bridge)?;
        current(&inner, generation)?;
        if inner.closing {
            return Err(Error::new("busy", "Workspace is closing"));
        }
    }
    let _admission = bridge
        .lifecycle
        .lock()
        .map_err(|_| Error::new("bridge", "Lifecycle barrier poisoned"))?;
    {
        let mut inner = lock(bridge)?;
        current(&inner, generation)?;
        if inner.worker.is_some() || inner.pending || inner.closing {
            return Err(Error::new(
                "busy",
                "Close the current workspace before opening another",
            ));
        }
        if cancel.load(Ordering::Acquire) {
            return Err(Error::new("canceled", "Operation canceled"));
        }
        inner.pending = true;
    }
    let built = build();
    let mut inner = lock(bridge)?;
    inner.pending = false;
    if inner.generation != generation || cancel.load(Ordering::Acquire) {
        drop(inner);
        if let Ok((worker, _)) = built {
            worker.close()?;
        }
        return Err(Error::new("closed", "Opening operation was superseded"));
    }
    let (worker, root) = built?;
    let state = state_of(&worker)?;
    inner.last_root = Some(root);
    inner.worker = Some(Arc::new(worker));
    inner.generation += 1;
    Ok(Value::State(Some(state)))
}
fn close_bridge(bridge: &Bridge, generation: u64) -> Result<()> {
    {
        let mut inner = lock(bridge)?;
        current(&inner, generation)?;
        if !inner.closing {
            inner.closing = true;
            inner.generation += 1;
        }
        inner.reads.clear();
    }
    let _release = bridge
        .lifecycle
        .lock()
        .map_err(|_| Error::new("bridge", "Lifecycle barrier poisoned"))?;
    let previous = lock(bridge)?.worker.clone();
    if let Some(worker) = previous {
        worker.close()?;
    }
    let mut inner = lock(bridge)?;
    inner.worker = None;
    inner.closing = false;
    Ok(())
}
fn finish_reply(
    inner: &Inner,
    operation_generation: u64,
    reply_generation: u64,
    pure: bool,
    result: Value,
) -> Result<Reply> {
    let produced_generation = if matches!(result, Value::Canceled) {
        operation_generation
    } else {
        reply_generation
    };
    if pure && !matches!(result, Value::Canceled) {
        current(inner, produced_generation)?;
    }
    Ok(Reply {
        version: 1,
        generation: produced_generation,
        result,
    })
}
fn read_asset(
    bridge: &Bridge,
    generation: u64,
    request_id: &str,
    cancel: &AtomicBool,
    id: &str,
) -> Result<(Asset, Vec<u8>)> {
    let worker = worker(bridge, generation)?;
    let asset = state_of(&worker)?
        .assets
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| Error::new("missing", "Asset is missing"))?;
    let bytes = match execute(
        bridge,
        generation,
        request_id,
        cancel,
        Job::ReadAsset {
            asset_id: id.into(),
            max_bytes: UI_BYTES,
        },
    )? {
        Outcome::Bytes(bytes) => bytes,
        _ => return Err(Error::new("bridge", "Unexpected verified read result")),
    };
    checked(bridge, generation, cancel)?;
    Ok((asset, bytes))
}
fn publish_bytes(path: &Path, bytes: &[u8], check: impl Fn() -> Result<()>) -> Result<String> {
    publish_bytes_with_flush(path, bytes, check, paths::flush_published_file)
}
fn publish_bytes_with_flush(
    path: &Path,
    bytes: &[u8],
    check: impl Fn() -> Result<()>,
    flush: impl FnOnce(&Path, (u64, u64), u64, u64) -> Result<()>,
) -> Result<String> {
    use sha2::Digest;
    check()?;
    if !path.is_absolute() || path.exists() {
        return Err(Error::new(
            "exists",
            "Export needs a fresh file destination",
        ));
    }
    let parent = paths::canonical_root(
        path.parent()
            .ok_or_else(|| Error::new("containment", "Missing export parent"))?,
    )?;
    #[cfg(windows)]
    let _directory_guards = paths::pin_ancestors(&parent)?;
    let parent_identity = paths::ordinary_directory(&parent)?.identity();
    let destination = parent.join(
        path.file_name()
            .ok_or_else(|| Error::new("containment", "Missing export name"))?,
    );
    let stage = parent.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = paths::exclusive(&stage)?;
    let stage_identity = paths::stat_file(&file)?.identity();
    let verify_stage = |file: &fs::File, links: u64, length: u64| -> Result<()> {
        let current_parent = paths::ordinary_directory(&parent)?.identity();
        let named = paths::ordinary(&stage, links)?;
        let opened = paths::stat_file(file)?;
        if (current_parent.0, current_parent.1) != (parent_identity.0, parent_identity.1)
            || named.identity() != (stage_identity.0, stage_identity.1, links)
            || opened.identity() != named.identity()
            || named.len() != length
            || opened.len() != length
        {
            return Err(Error::new(
                "changed",
                "Export stage or parent identity changed",
            ));
        }
        Ok(())
    };
    let mut published = false;
    let result = (|| {
        for chunk in bytes.chunks(crate::CHUNK) {
            check()?;
            file.write_all(chunk)?;
        }
        file.sync_all()?;
        check()?;
        verify_stage(&file, 1, bytes.len() as u64)?;
        fs::hard_link(&stage, &destination)?; // Atomic no-overwrite publication, including empty existing files.
        published = true;
        flush(
            &destination,
            (stage_identity.0, stage_identity.1),
            bytes.len() as u64,
            2,
        )
        .map_err(|_| published_export_error("fileSync"))?;
        paths::namespace_checkpoint(&parent)
            .map_err(|_| published_export_error("directorySync"))?;
        Ok(paths::hex_digest(sha2::Sha256::digest(bytes)))
    })();
    let cleanup_authority = (|| -> Result<()> {
        let length = paths::stat_file(&file)?.len();
        verify_stage(&file, if published { 2 } else { 1 }, length)?;
        if published {
            let target = paths::ordinary(&destination, 2)?;
            if target.identity() != (stage_identity.0, stage_identity.1, 2)
                || target.len() != bytes.len() as u64
                || length != bytes.len() as u64
            {
                return Err(Error::new("changed", "Published export identity changed"));
            }
        }
        Ok(())
    })();
    drop(file);
    let cleanup = cleanup_authority.and_then(|()| {
        fs::remove_file(&stage)?;
        paths::namespace_checkpoint(&parent)?;
        Ok(())
    });
    match result {
        Err(error) => Err(error), // Cleanup must not erase a reached publication result.
        Ok(hash) => {
            cleanup.map_err(|error| {
                if published {
                    published_export_error("stageCleanup")
                } else {
                    error
                }
            })?;
            Ok(hash)
        }
    }
}
fn published_export_error(phase: &str) -> Error {
    Error::new(
        "published",
        format!(
            "File already saved; {phase} confirmation failed. Check the saved file before another export."
        ),
    )
}
fn generated<'a>(metadata: &'a GeneratedMetadata, bytes: &[u8]) -> Result<(&'static str, &'a str)> {
    if matches!(metadata.format, GeneratedFormat::Microphone) {
        let mime = metadata
            .recorded_mime
            .as_deref()
            .ok_or_else(|| Error::new("format", "Actual recorded MIME is required"))?;
        if mime.len() > 256 || mime.chars().any(char::is_control) {
            return Err(Error::new("format", "Recorded MIME boundary"));
        }
        let parts: Vec<_> = mime.split(';').collect();
        if parts.len() > 2
            || parts.get(1).is_some_and(|part| {
                !matches!(
                    part.trim().strip_prefix("codecs="),
                    Some("opus" | "mp4a.40.2" | "mp4a.40.5" | "pcm" | "\"opus\"" | "\"mp4a.40.2\"")
                )
            })
        {
            return Err(Error::new("format", "Unsupported recorded MIME parameter"));
        }
        let (name, valid) = match parts[0] {
            "audio/mp4" => ("microphone.m4a", bytes.get(4..8) == Some(b"ftyp")),
            "audio/webm" => (
                "microphone.webm",
                bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
            ),
            "audio/ogg" => ("microphone.ogg", bytes.starts_with(b"OggS")),
            "audio/wav" => (
                "microphone.wav",
                bytes.len() >= 44
                    && bytes.get(..4) == Some(b"RIFF")
                    && bytes.get(8..12) == Some(b"WAVE"),
            ),
            _ => return Err(Error::new("format", "Unsupported actual recording MIME")),
        };
        if bytes.is_empty() || bytes.len() > UI_BYTES || !valid {
            return Err(Error::new(
                "format",
                "Recording bytes do not match actual MIME",
            ));
        }
        return Ok((name, mime));
    }
    if metadata.recorded_mime.is_some() {
        return Err(Error::new(
            "wire",
            "Only microphone format accepts recordedMime",
        ));
    }
    let pair = match metadata.format {
        GeneratedFormat::Csv => ("delivery.csv", "text/csv;charset=utf-8"),
        GeneratedFormat::Zip => ("project.zip", "application/zip"),
        GeneratedFormat::Wav => ("mix.wav", "audio/wav"),
        GeneratedFormat::Microphone => ("microphone.wav", "audio/wav"),
    };
    let valid = match metadata.format {
        GeneratedFormat::Csv => {
            bytes.starts_with(&[0xef, 0xbb, 0xbf]) && std::str::from_utf8(bytes).is_ok()
        }
        GeneratedFormat::Zip => bytes.starts_with(&[0x50, 0x4b, 3, 4]),
        GeneratedFormat::Wav | GeneratedFormat::Microphone => {
            bytes.len() >= 44 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
        }
    };
    if bytes.is_empty() || bytes.len() > UI_BYTES || !valid {
        return Err(Error::new("format", "Generated fixture bytes are invalid"));
    }
    Ok(pair)
}
fn handle(
    window: &WebviewWindow,
    bridge: &Bridge,
    envelope: Envelope,
    cancel: &AtomicBool,
) -> Result<Value> {
    let generation = envelope.expected_generation;
    let operation_id = &envelope.operation_id;
    checked(bridge, generation, cancel)?;
    match envelope.action {
        Action::Ensure {} => {
            if let Some(current) = lock(bridge)?.worker.clone() {
                return Ok(Value::State(Some(state_of(&current)?)));
            }
            let parent = window
                .app_handle()
                .path()
                .app_data_dir()
                .map_err(|e| Error::new("profile", e.to_string()))?;
            fs::create_dir_all(&parent)?;
            let root = parent.join("workspace");
            let worker = if root.join("workspace.ready.json").is_file() {
                StorageWorker::open(&root, Hooks::default())?
            } else {
                StorageWorker::create(&root, Hooks::default())?
            };
            transition(bridge, generation, cancel, || Ok((worker, root)))
        }
        Action::State {} => {
            let current = lock(bridge)?.worker.clone();
            Ok(Value::State(current.map(|w| state_of(&w)).transpose()?))
        }
        Action::Create {} | Action::Open {} => {
            let create = matches!(envelope.action, Action::Create {});
            let selection = if create {
                select_fresh(window, "创建全新工作区目录", "momoki-workspace")?
            } else {
                select_path(
                    window
                        .dialog()
                        .file()
                        .set_title("打开工作区")
                        .blocking_pick_folder(),
                )?
            };
            let Some(root) = selection else {
                return Ok(Value::Canceled);
            };
            checked(bridge, generation, cancel)?;
            transition(bridge, generation, cancel, || {
                let worker = if create {
                    StorageWorker::create(&root, Hooks::default())?
                } else {
                    StorageWorker::open(&root, Hooks::default())?
                };
                Ok((worker, root))
            })
        }
        Action::Reopen {} => {
            let root = lock(bridge)?
                .last_root
                .clone()
                .ok_or_else(|| Error::new("missing", "No previous workspace"))?;
            transition(bridge, generation, cancel, || {
                Ok((StorageWorker::open(&root, Hooks::default())?, root))
            })
        }
        Action::Close {} => {
            close_bridge(bridge, generation)?;
            Ok(Value::Closed)
        }
        Action::Restore {} => {
            let Some(source) = select_path(
                window
                    .dialog()
                    .file()
                    .set_title("选择完整备份目录")
                    .blocking_pick_folder(),
            )?
            else {
                return Ok(Value::Canceled);
            };
            checked(bridge, generation, cancel)?;
            let Some(root) = select_fresh(window, "恢复到全新工作区目录", "momoki-restored")?
            else {
                return Ok(Value::Canceled);
            };
            checked(bridge, generation, cancel)?;
            transition(bridge, generation, cancel, || {
                Ok((
                    StorageWorker::restore(&source, &root, Hooks::default())?,
                    root,
                ))
            })
        }
        Action::Project { project } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::SaveProject(project),
        )?)),
        Action::CreateVideoProject { project, video } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::CreateVideoProject { project, video },
        )?)),
        Action::DeleteProject { project_id } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::DeleteProject { project_id },
        )?)),
        Action::VideoState { project_id } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::VideoState(project_id),
        )?)),
        Action::VideoProject { video, baseline } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::PatchVideoProject { video, baseline },
        )?)),
        Action::PatchVideoProject {
            project_id,
            patch,
            baseline,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::UpdateVideoProject {
                project_id,
                patch,
                baseline,
            },
        )?)),
        Action::PatchEpisode {
            episode_id,
            patch,
            baseline,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::PatchEpisode {
                episode_id,
                patch,
                baseline,
            },
        )?)),
        Action::DeleteEpisode { episode_id } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::DeleteEpisode { episode_id },
        )?)),
        Action::Episode { episode } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::SaveEpisode(episode),
        )?)),
        Action::ReorderEpisodes {
            project_id,
            ordered_ids,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::ReorderEpisodes {
                project_id,
                ordered_ids,
            },
        )?)),
        Action::Beat { beat } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::SaveBeat(beat),
        )?)),
        Action::PatchBeat {
            episode_id,
            beat_id,
            patch,
            baseline,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::PatchBeat {
                episode_id,
                beat_id,
                patch,
                baseline,
            },
        )?)),
        Action::DuplicateBeat {
            episode_id,
            beat_id,
            include_shots,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::DuplicateBeat {
                episode_id,
                beat_id,
                include_shots,
            },
        )?)),
        Action::DeleteBeat {
            episode_id,
            beat_id,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::DeleteBeat {
                episode_id,
                beat_id,
            },
        )?)),
        Action::ReorderBeats {
            episode_id,
            ordered_ids,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::ReorderBeats {
                episode_id,
                ordered_ids,
            },
        )?)),
        Action::Shot { shot } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::SaveShot(shot),
        )?)),
        Action::AddShots {
            project_id,
            episode_id,
            count,
            at_order,
            beat_id,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::AddShots {
                project_id,
                episode_id,
                count,
                at_order,
                beat_id,
            },
        )?)),
        Action::PatchShot {
            shot_id,
            patch,
            baseline,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::PatchShot {
                shot_id,
                patch,
                baseline,
            },
        )?)),
        Action::DuplicateShot {
            episode_id,
            shot_id,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::DuplicateShot {
                episode_id,
                shot_id,
            },
        )?)),
        Action::DeleteShots {
            episode_id,
            shot_ids,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::DeleteShots {
                episode_id,
                shot_ids,
            },
        )?)),
        Action::BulkShots {
            episode_id,
            shot_ids,
            patch,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::BulkShots {
                episode_id,
                shot_ids,
                patch,
            },
        )?)),
        Action::VideoUndo { receipt } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::VideoUndo { receipt },
        )?)),
        Action::ReorderShots {
            episode_id,
            ordered_ids,
        } => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::ReorderShots {
                episode_id,
                ordered_ids,
            },
        )?)),
        Action::Import { metadata } => {
            let selected_worker = worker(bridge, generation)?;
            let state = state_of(&selected_worker)?;
            if metadata.project_id != "studio"
                && !state.projects.iter().any(|p| p.id == metadata.project_id)
            {
                return Err(Error::new("ownership", "Selected project is missing"));
            }
            let Some(source) = select_path(
                window
                    .dialog()
                    .file()
                    .set_title("复制素材到当前工作区")
                    .blocking_pick_file(),
            )?
            else {
                return Ok(Value::Canceled);
            };
            checked(bridge, generation, cancel)?;
            Ok(Value::outcome(execute(
                bridge,
                generation,
                operation_id,
                cancel,
                Job::Import(ImportRequest {
                    source,
                    asset_id: metadata.asset_id,
                    project_id: metadata.project_id,
                    kind: metadata.kind,
                    display_name: metadata.display_name,
                    mime_type: metadata.mime_type,
                    timing: None,
                }),
            )?))
        }
        Action::Availability {} => Ok(Value::outcome(execute(
            bridge,
            generation,
            operation_id,
            cancel,
            Job::Availability,
        )?)),
        Action::Backup {} => {
            let _selected_worker = worker(bridge, generation)?;
            let Some(destination) = select_fresh(window, "备份到全新目录", "momoki-backup")?
            else {
                return Ok(Value::Canceled);
            };
            checked(bridge, generation, cancel)?;
            Ok(Value::outcome(execute(
                bridge,
                generation,
                operation_id,
                cancel,
                Job::Backup(destination),
            )?))
        }
        Action::ReadStart { asset_id } => {
            if lock(bridge)?.reads.len() >= MAX_READS {
                return Err(Error::new("size", "Close an existing read session first"));
            }
            let (asset, bytes) = read_asset(bridge, generation, operation_id, cancel, &asset_id)?;
            let session = uuid::Uuid::new_v4().to_string();
            let mut inner = lock(bridge)?;
            current(&inner, generation)?;
            if inner.reads.len() >= MAX_READS {
                return Err(Error::new("size", "Read session boundary"));
            }
            inner.reads.insert(
                session.clone(),
                ReadSession {
                    generation,
                    asset: asset.clone(),
                    bytes: bytes.into(),
                },
            );
            Ok(Value::Read(ReadDescription {
                session,
                asset,
                chunk_bytes: crate::CHUNK,
            }))
        }
        Action::ReadChunk {
            session,
            offset,
            length,
        } => {
            let owner = worker(bridge, generation)?;
            let state = state_of(&owner)?;
            let inner = lock(bridge)?;
            current(&inner, generation)?;
            let read = inner
                .reads
                .get(&session)
                .ok_or_else(|| Error::new("missing", "Read session missing"))?;
            if read.generation != generation || !state.assets.iter().any(|a| a == &read.asset) {
                return Err(Error::new("ownership", "Read owner changed"));
            }
            let end = offset
                .checked_add(length)
                .ok_or_else(|| Error::new("size", "Read offset overflow"))?;
            if length == 0 || length > crate::CHUNK || end > read.bytes.len() {
                return Err(Error::new("size", "Read chunk boundary"));
            }
            Ok(Value::Chunk(read.bytes[offset..end].to_vec()))
        }
        Action::ReadClose { session } => {
            lock(bridge)?.reads.remove(&session);
            Ok(Value::Released)
        }
        Action::Export { asset_id } => {
            let (asset, bytes) = read_asset(bridge, generation, operation_id, cancel, &asset_id)?;
            let Some(destination) =
                select_fresh(window, "导出经过校验的素材", &asset.display_name)?
            else {
                return Ok(Value::Canceled);
            };
            let hash = publish_bytes(&destination, &bytes, || checked(bridge, generation, cancel))?;
            Ok(Value::Saved(Saved {
                byte_length: bytes.len(),
                asset,
                exported: true,
                content_hash: hash,
            }))
        }
        Action::SaveGenerated {
            metadata,
            mode,
            bytes: BoundedBytes(bytes),
        } => {
            let (name, mime) = generated(&metadata, &bytes)?;
            let mime = mime.to_owned();
            let selected_worker = worker(bridge, generation)?;
            let selected_state = state_of(&selected_worker)?;
            if metadata.project_id != "studio"
                && !selected_state
                    .projects
                    .iter()
                    .any(|p| p.id == metadata.project_id)
            {
                return Err(Error::new("ownership", "Generated output owner missing"));
            }
            if matches!(mode, SaveMode::Export) {
                let Some(destination) = select_fresh(window, "导出到全新文件", name)? else {
                    return Ok(Value::Canceled);
                };
                let hash =
                    publish_bytes(&destination, &bytes, || checked(bridge, generation, cancel))?;
                return Ok(Value::Exported(Exported {
                    byte_length: bytes.len(),
                    content_hash: hash,
                }));
            }
            checked(bridge, generation, cancel)?;
            // The scratch source is native-owned, fresh, and never selected or addressed by the renderer.
            let scratch = window
                .app_handle()
                .path()
                .app_cache_dir()
                .map_err(|e| Error::new("profile", e.to_string()))?;
            fs::create_dir_all(&scratch)?;
            let scratch = paths::canonical_root(&scratch)?;
            let source = scratch.join(format!("{}.fixture", uuid::Uuid::new_v4()));
            let mut output = paths::exclusive(&source)?;
            output.write_all(&bytes)?;
            output.sync_all()?;
            drop(output);
            let result = execute(
                bridge,
                generation,
                operation_id,
                cancel,
                Job::Import(ImportRequest {
                    source: source.clone(),
                    asset_id: metadata.asset_id,
                    project_id: metadata.project_id,
                    kind: AssetKind::Output,
                    display_name: name.into(),
                    mime_type: mime,
                    timing: None,
                }),
            );
            fs::remove_file(&source)?;
            let asset = match result? {
                Outcome::Asset(asset) => asset,
                _ => return Err(Error::new("bridge", "Unexpected generated import result")),
            };
            Ok(Value::Saved(Saved {
                byte_length: bytes.len(),
                content_hash: asset.content_hash.clone(),
                asset,
                exported: false,
            }))
        }
    }
}

#[tauri::command]
async fn workspace_request(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<Bridge>>,
    request: Envelope,
) -> Result<Reply> {
    trusted(&window)?;
    if request.version != 1 || uuid::Uuid::parse_str(&request.operation_id).is_err() {
        return Err(Error::new(
            "wire",
            "Invalid request version or operation ID",
        ));
    }
    let bridge = state.inner().clone();
    let canceled = Arc::new(AtomicBool::new(false));
    let operation_generation = request.expected_generation;
    let advances = matches!(
        request.action,
        Action::Ensure {}
            | Action::Create {}
            | Action::Open {}
            | Action::Reopen {}
            | Action::Restore {}
            | Action::Close {}
    );
    let pure = matches!(
        request.action,
        Action::State {}
            | Action::Ensure {}
            | Action::Create {}
            | Action::Open {}
            | Action::Reopen {}
            | Action::Restore {}
            | Action::ReadStart { .. }
            | Action::ReadChunk { .. }
            | Action::ReadClose { .. }
            | Action::Availability {}
            | Action::VideoState { .. }
    );
    let reply_generation;
    {
        let mut inner = lock(&bridge)?;
        current(&inner, request.expected_generation)?;
        let ensure_existing = matches!(request.action, Action::Ensure {}) && inner.worker.is_some();
        reply_generation = operation_generation
            + u64::from(
                advances
                    && !ensure_existing
                    && !(matches!(request.action, Action::Close {}) && inner.closing),
            );
        if inner.requests.len() >= 64 || inner.requests.contains_key(&request.operation_id) {
            return Err(Error::new(
                "operation",
                "Duplicate or excessive active request",
            ));
        }
        inner.requests.insert(
            request.operation_id.clone(),
            RequestOwner {
                canceled: canceled.clone(),
                native: None,
            },
        );
    }
    let id = request.operation_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = handle(&window, &bridge, request, &canceled);
        let mut inner = lock(&bridge)?;
        inner.requests.remove(&id);
        finish_reply(
            &inner,
            operation_generation,
            reply_generation,
            pure,
            result?,
        )
    })
    .await
    .map_err(|e| Error::new("bridge", e.to_string()))?
}
#[tauri::command]
async fn workspace_cancel(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<Bridge>>,
    request: CancelEnvelope,
) -> Result<bool> {
    trusted(&window)?;
    if request.version != 1 {
        return Err(Error::new("wire", "Cancel version"));
    }
    let inner = lock(state.inner())?;
    current(&inner, request.expected_generation)?;
    let Some(owner) = inner.requests.get(&request.operation_id) else {
        return Ok(false);
    };
    owner.canceled.store(true, Ordering::Release);
    if let Some((worker, id)) = &owner.native {
        worker.cancel(id)?;
    }
    Ok(true)
}

#[cfg(feature = "acceptance")]
mod acceptance;

pub fn run() {
    use crate::runtime_services::*;
    let context = tauri::generate_context!();
    let singleton = crate::desktop_lifecycle::native::preflight(&context.config().identifier)
        .expect("Acquire Momoki application ownership");
    let lifecycle = Arc::new(crate::desktop_lifecycle::Lifecycle::default());
    let services = Arc::new(RuntimeServices::with_gate(lifecycle.effects.clone()));
    let builder = tauri::Builder::default()
        .manage(singleton)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        // External opening is only reachable through our HTTP(S)-validated command.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Arc::new(Bridge::default()))
        .manage(Arc::new(ProductBridge {
            lifecycle: lifecycle.clone(),
            local_media: crate::desktop_media::DesktopMedia::with_gate(lifecycle.effects.clone()),
            skill_import: crate::skill_import::SkillDirectoryImport::with_gate(
                lifecycle.effects.clone(),
            ),
            ..ProductBridge::default()
        }))
        .manage(lifecycle)
        .manage(services.clone())
        .setup(|app| {
            crate::desktop_lifecycle::native::setup(
                app,
                app.state::<Arc<crate::desktop_lifecycle::Lifecycle>>()
                    .inner()
                    .clone(),
            )?;
            let (script, store) = profile(
                &app.config().identifier,
                cfg!(feature = "acceptance") || cfg!(feature = "product-sqlite"),
            )?;
            let weak = Arc::downgrade(app.state::<Arc<RuntimeServices>>().inner());
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let Some(state) = weak.upgrade() else {
                        break;
                    };
                    state.saves.reap();
                }
            });
            let builder =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .initialization_script(script)
                    .initialization_script(window_chrome_script());
            #[cfg(target_os = "macos")]
            let builder = builder
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .data_store_identifier(store)
                .decorations(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(16.0, 24.0));
            #[cfg(not(target_os = "macos"))]
            let builder = builder.data_directory(webview_profile_directory(
                &app.path()
                    .app_data_dir()
                    .map_err(|_| Error::new("profile", "Application data directory unavailable"))?,
                store,
            )?);
            builder
                .on_navigation(crate::bundled_origin::accepts)
                .build()?;
            crate::desktop_lifecycle::native::ready(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if window.hide().is_err() {
                            eprintln!("Momoki: unable to hide existing window");
                        }
                        crate::desktop_lifecycle::native::window_state(window);
                    }
                    tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_) => {
                        crate::desktop_lifecycle::native::window_state(window)
                    }
                    _ => {}
                }
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<Arc<crate::desktop_lifecycle::Lifecycle>>()
                    .detach();
                window.state::<Arc<RuntimeServices>>().saves.close();
                close_product(window.state::<Arc<ProductBridge>>().inner());
            }
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                webview
                    .state::<Arc<crate::desktop_lifecycle::Lifecycle>>()
                    .detach();
                webview.state::<Arc<RuntimeServices>>().saves.close();
                webview.state::<Arc<ProductBridge>>().previews.clear();
                webview.state::<Arc<ProductBridge>>().local_media.stop_all();
                webview
                    .state::<Arc<ProductBridge>>()
                    .skill_import
                    .invalidate();
                invalidate_mcp(webview.state::<Arc<ProductBridge>>().inner());
            }
        })
        .on_permission_request(|window, kind| {
            let trusted = window.label() == "main"
                && window
                    .url()
                    .is_ok_and(|url| crate::bundled_origin::accepts(&url));
            if trusted && matches!(kind, tauri::webview::PermissionKind::Microphone) {
                tauri::webview::PermissionResponse::Default
            } else {
                tauri::webview::PermissionResponse::Deny
            }
        });
    #[cfg(feature = "acceptance")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        product_lifecycle_request,
        workspace_request,
        product_store_request,
        mcp_service_request,
        product_binary_request,
        product_binary_read,
        product_binary_write,
        desktop_media_request,
        skill_import_directory,
        product_media_preview,
        product_media_release,
        workspace_cancel,
        authorize_http_origin,
        product_save_begin,
        product_save_chunk,
        product_save_finish,
        product_save_cancel,
        product_print_storyboard,
        product_open_external,
        acceptance::acceptance_request
    ]);
    #[cfg(not(feature = "acceptance"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        product_lifecycle_request,
        workspace_request,
        product_store_request,
        mcp_service_request,
        product_binary_request,
        product_binary_read,
        product_binary_write,
        desktop_media_request,
        skill_import_directory,
        product_media_preview,
        product_media_release,
        workspace_cancel,
        authorize_http_origin,
        product_save_begin,
        product_save_chunk,
        product_save_finish,
        product_save_cancel,
        product_print_storyboard,
        product_open_external
    ]);
    builder
        .build(context)
        .expect("Build Momoki native host")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                let phase = app
                    .state::<Arc<crate::desktop_lifecycle::Lifecycle>>()
                    .phase();
                eprintln!(
                    "Momoki lifecycle: native exit requested code={code:?} phase={phase:?}"
                );
                if phase != crate::desktop_lifecycle::Phase::Exiting {
                    api.prevent_exit();
                    crate::desktop_lifecycle::native::request_quit(app);
                }
            }
            tauri::RunEvent::Exit => {
                eprintln!("Momoki lifecycle: native event loop exited");
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => crate::desktop_lifecycle::native::show(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_lifecycle_ack_validation_uses_actual_product_store_generation() {
        use crate::desktop_lifecycle::{Action, DrainOutcome, Lifecycle};
        use crate::full_product_store::protocol::{Request, Session};
        let root = std::env::temp_dir().join(format!(
            "momoki-lifecycle-session-{}",
            uuid::Uuid::new_v4()
        ));
        let worker = StorageWorker::product(&root, true, Hooks::default()).unwrap();
        let open = || {
            serde_json::from_value::<Request>(serde_json::json!({"type":"open","request":{}}))
                .unwrap()
        };
        let session = |mut token: serde_json::Value| -> Session {
            token.as_object_mut().unwrap().remove("changeSequence");
            serde_json::from_value(token).unwrap()
        };
        let initial = session(
            worker
                .run_product(crate::ProductJob::Store(open()))
                .unwrap(),
        );
        let lifecycle = Lifecycle::default();
        lifecycle.attach(Some(initial.clone())).unwrap();
        let intent = lifecycle.begin().unwrap();
        assert!(lifecycle.quiesce(&intent));
        validate_lifecycle_session(&worker, initial.clone()).unwrap();
        let replacement = session(
            worker
                .run_product(crate::ProductJob::Store(open()))
                .unwrap(),
        );
        assert_ne!(initial.session, replacement.session);
        // Validate through the real worker before acknowledging the cached
        // intent. A live document cannot reuse a retired storage generation.
        assert!(validate_lifecycle_session(&worker, initial).is_err());
        assert!(intent.outcome().is_none());
        assert!(
            lifecycle
                .acknowledge(
                    &Some(replacement),
                    Action::Drained {
                        intent_id: intent.id.clone(),
                        outcome: DrainOutcome::Drained
                    }
                )
                .is_err()
        );
        assert!(intent.outcome().is_none());
        worker.close().unwrap();
        drop(worker);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn notification_failure_preserves_confirmed_commit_and_status_acknowledgements() {
        let acknowledged = serde_json::json!({
            "status": "committed", "operationId": "durable-operation",
            "changeSequence": 19, "fingerprint": "confirmed-fingerprint",
            "changes": [{"table": "projects", "key": "project"}]
        });
        for _ in 0..2 {
            let result = deliver_product_result(acknowledged.clone(), |event| {
                assert_eq!(event, serde_json::json!({"changeSequence": 19}));
                Err::<(), _>("window closed")
            });
            assert_eq!(result, acknowledged);
        }
        let aborted = serde_json::json!({"status": "aborted"});
        assert_eq!(
            deliver_product_result(aborted.clone(), |_| -> std::result::Result<(), ()> {
                panic!("An aborted operation must not emit a success notification")
            }),
            aborted
        );
    }
    #[test]
    fn typed_baseline_diagnostic_contains_live_expected_requested_without_writing() {
        let root = std::env::temp_dir().join(format!("momoki-conflict-{}", uuid::Uuid::new_v4()));
        let worker = StorageWorker::create(&root, Hooks::default()).unwrap();
        worker
            .run(Job::SaveProject(Project {
                id: "video".into(),
                title: "Original".into(),
            }))
            .unwrap();
        worker
            .run(Job::UpdateVideoProject {
                project_id: "video".into(),
                patch: serde_json::from_value(serde_json::json!({"brief": "Live value"})).unwrap(),
                baseline: None,
            })
            .unwrap();
        let job = Job::UpdateVideoProject {
            project_id: "video".into(),
            patch: serde_json::from_value(serde_json::json!({"brief": "Requested value"})).unwrap(),
            baseline: Some(
                serde_json::from_value(serde_json::json!({
                    "fields": [{"field": "brief", "value": "Original value"}]
                }))
                .unwrap(),
            ),
        };
        let before = state_of(&worker).unwrap();
        assert_eq!(worker.run(job.clone()).unwrap_err().code, "conflict");
        let conflict = crate::workspace::conflict_for_job(&before, &job)
            .unwrap()
            .unwrap();
        assert_eq!(conflict.fields.len(), 1);
        assert_eq!(conflict.resource, "project");
        assert_eq!(conflict.id, "video");
        assert_eq!(conflict.fields[0].field, "brief");
        assert_eq!(conflict.fields[0].current, "Live value");
        assert_eq!(conflict.fields[0].expected, "Original value");
        assert_eq!(conflict.fields[0].requested, "Requested value");
        let encoded = serde_json::to_value(Outcome::Conflict(conflict)).unwrap();
        assert_eq!(encoded["kind"], "conflict");
        assert_eq!(state_of(&worker).unwrap(), before);
        worker.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_product_ensure_action_is_closed_and_generation_aware() {
        let request = serde_json::json!({
            "version": 1,
            "operationId": uuid::Uuid::new_v4().to_string(),
            "expectedGeneration": 0,
            "action": {"type": "ensure"}
        });
        assert!(serde_json::from_value::<Envelope>(request.clone()).is_ok());
        let mut extra = request;
        extra["action"]["path"] = serde_json::json!("/outside");
        assert!(serde_json::from_value::<Envelope>(extra).is_err());
    }
    #[test]
    fn closed_payload_denies_path_sql_extra_fields_and_oversized_chunks() {
        let base = serde_json::json!({"version":1,"operationId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":0,"action":{"type":"state"}});
        assert!(serde_json::from_value::<Envelope>(base.clone()).is_ok());
        for extra in ["path", "sql", "root", "unexpected"] {
            let mut changed = base.clone();
            changed[extra] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<Envelope>(changed).is_err());
            let mut changed = base.clone();
            changed["action"][extra] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<Envelope>(changed).is_err());
        }
        assert!(serde_json::from_str::<BoundedBytes>("[256]").is_err());
        assert!(serde_json::from_str::<BoundedBytes>("[-1]").is_err());
    }
    #[test]
    fn exclusive_export_never_overwrites_even_empty_files() {
        let root = std::env::temp_dir().join(format!("momoki-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("output");
        fs::write(&path, []).unwrap();
        assert!(publish_bytes(&path, b"new", || Ok(())).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"");
        fs::remove_file(&path).unwrap();
        assert!(publish_bytes(&path, b"new", || Err(Error::new("canceled", "stop"))).is_err());
        assert!(!path.exists());
        let hash = publish_bytes(&path, b"new", || Ok(())).unwrap();
        assert_eq!(hash.len(), 64);
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retained_export_final_flush_failure_preserves_published_file_and_warning() {
        let root = std::env::temp_dir().join(format!("momoki-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("output");
        let error = publish_bytes_with_flush(
            &path,
            b"already saved",
            || Ok(()),
            |destination, _, size, links| {
                assert_eq!(destination, fs::canonicalize(&path).unwrap());
                assert_eq!(fs::read(destination).unwrap(), b"already saved");
                assert_eq!((size, links), (13, 2));
                Err(Error::new("io", "Injected final-file flush failure"))
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "published");
        assert!(error.message.contains("File already saved"));
        assert!(error.message.contains("fileSync"));
        assert_eq!(fs::read(&path).unwrap(), b"already saved");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retained_export_flush_failure_never_deletes_a_stage_with_unowned_links() {
        let root = std::env::temp_dir().join(format!("momoki-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("output");
        let alias = root.join("unowned-link");
        let error = publish_bytes_with_flush(
            &path,
            b"saved",
            || Ok(()),
            |destination, _, _, _| {
                fs::hard_link(destination, &alias)?;
                Err(Error::new(
                    "changed",
                    "Injected unowned alias after publication",
                ))
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "published");
        assert_eq!(fs::read(&path).unwrap(), b"saved");
        assert_eq!(fs::read(&alias).unwrap(), b"saved");
        let stages = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "tmp"))
            .collect::<Vec<_>>();
        assert_eq!(stages.len(), 1, "Unproven stage must remain untouched");
        assert_eq!(fs::read(&stages[0]).unwrap(), b"saved");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stale_pure_replies_reject_and_committed_outcomes_keep_their_producer_generation() {
        let inner = Inner {
            generation: 2,
            ..Inner::default()
        };
        assert!(finish_reply(&inner, 1, 1, true, Value::State(None)).is_err());
        let result = finish_reply(
            &inner,
            1,
            1,
            false,
            Value::outcome(Outcome::Project(Project {
                id: "owned".into(),
                title: "committed".into(),
            })),
        )
        .unwrap();
        assert_eq!(result.generation, 1);
        assert!(
            matches!(result.result, Value::Outcome(value) if matches!(*value, Outcome::Project(_)))
        );
        assert_eq!(
            finish_reply(&inner, 1, 2, false, Value::Closed)
                .unwrap()
                .generation,
            2
        );
    }
    #[test]
    fn original_microphone_container_and_mime_are_preserved_without_relabeling() {
        let mut metadata = GeneratedMetadata {
            project_id: "project".into(),
            asset_id: "recording".into(),
            format: GeneratedFormat::Microphone,
            recorded_mime: Some("audio/mp4;codecs=mp4a.40.2".into()),
        };
        let mp4 = b"\0\0\0\x18ftypM4A synthetic container";
        assert_eq!(
            generated(&metadata, mp4).unwrap(),
            ("microphone.m4a", "audio/mp4;codecs=mp4a.40.2")
        );
        assert!(generated(&metadata, b"OggS wrong container").is_err());
        metadata.recorded_mime = Some("audio/webm;codecs=opus".into());
        assert_eq!(
            generated(&metadata, &[0x1a, 0x45, 0xdf, 0xa3, 0]).unwrap(),
            ("microphone.webm", "audio/webm;codecs=opus")
        );
        metadata.recorded_mime = Some("audio/mp4;unexpected=sql".into());
        assert!(generated(&metadata, mp4).is_err());
        metadata.format = GeneratedFormat::Zip;
        assert!(generated(&metadata, &[0x50, 0x4b, 3, 4]).is_err());
    }
    #[cfg(feature = "test-hooks")]
    #[test]
    fn every_successful_bridge_close_waits_for_native_release_and_blocks_admission() {
        use std::sync::mpsc;
        use std::time::Duration;
        let root =
            std::env::temp_dir().join(format!("momoki-bridge-close-{}", uuid::Uuid::new_v4()));
        let (hit_tx, hit_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release = Mutex::new(release_rx);
        let hooks = Hooks::new(move |point| {
            if point == "project-precommit" {
                hit_tx
                    .send(())
                    .map_err(|e| Error::new("test", e.to_string()))?;
                release.lock().unwrap().recv().unwrap();
            }
            Ok(())
        });
        let worker = Arc::new(StorageWorker::create(&root, hooks).unwrap());
        let bridge = Arc::new(Bridge::default());
        lock(&bridge).unwrap().worker = Some(worker.clone());
        let operation = worker
            .submit(Job::SaveProject(Project {
                id: "paused".into(),
                title: "pending".into(),
            }))
            .unwrap();
        hit_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let first = bridge.clone();
        let first_tx = done_tx.clone();
        let a = std::thread::spawn(move || {
            let result = close_bridge(&first, 0);
            first_tx.send(result).unwrap();
        });
        for _ in 0..100 {
            if lock(&bridge).unwrap().closing {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(lock(&bridge).unwrap().closing);
        assert!(super::worker(&bridge, 1).is_err());
        assert!(
            transition(&bridge, 1, &AtomicBool::new(false), || panic!(
                "Closing must reject before creating any root"
            ))
            .is_err()
        );
        let second = bridge.clone();
        let b = std::thread::spawn(move || {
            done_tx.send(close_bridge(&second, 1)).unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(40)).is_err());
        release_tx.send(()).unwrap();
        assert!(operation.wait().is_err());
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        a.join().unwrap();
        b.join().unwrap();
        let reopened = StorageWorker::open(&root, Hooks::default()).unwrap();
        assert!(state_of(&reopened).unwrap().projects.is_empty());
        reopened.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
