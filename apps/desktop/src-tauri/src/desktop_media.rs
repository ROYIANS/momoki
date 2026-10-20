//! Session/project-bound local video grants. The renderer receives opaque IDs,
//! never source paths. All managed bytes still pass through the sole store owner.
use crate::{
    Error, ProductJob, Result, StorageWorker,
    full_product_store::protocol::Session,
    paths,
    product_binary::{BinaryClaim, BinaryRequest},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_GRANTS: usize = 8;
const MAX_OPERATIONS: usize = 256;
const MAX_TOMBSTONES: usize = 4096;
const MAX_ACTIVE: usize = 2;
const MAX_ENTRIES: usize = 4096;
const MAX_VIDEOS: usize = 256;
const MAX_DEPTH: usize = 8;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PAGE: usize = 100;
const GRANT_IDLE: Duration = Duration::from_secs(30 * 60);

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct MediaEnvelope {
    pub version: u32,
    pub session: String,
    pub workspace_id: String,
    pub generation: u64,
    pub project_id: String,
    pub action: MediaAction,
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MediaAction {
    PickDirectory {
        operation_id: String,
    },
    Scan {
        operation_id: String,
        grant_id: String,
    },
    ReadScanPage {
        grant_id: String,
        scan_id: String,
        offset: usize,
        limit: usize,
    },
    PrepareVideo {
        operation_id: String,
        grant_id: String,
        scan_id: String,
        entry_id: String,
        expected_revision: String,
    },
    ReadOperation {
        operation_id: String,
    },
    CancelOperation {
        operation_id: String,
    },
    DiscardPrepared {
        operation_id: String,
    },
    ReleaseOperation {
        operation_id: String,
    },
    RevokeDirectory {
        grant_id: String,
    },
}
impl MediaEnvelope {
    pub(crate) fn scope(&self) -> Result<MediaScope> {
        if self.version != 1
            || self.project_id.is_empty()
            || self.project_id.len() > 160
            || self.project_id.chars().any(char::is_control)
        {
            return Err(Error::new("invalid", "Invalid local media scope"));
        }
        uuid(&self.session)?;
        uuid(&self.workspace_id)?;
        Ok(MediaScope {
            session: Session {
                version: self.version,
                session: self.session.clone(),
                workspace_id: self.workspace_id.clone(),
                generation: self.generation,
            },
            project_id: self.project_id.clone(),
        })
    }
}
#[derive(Clone)]
pub(crate) struct MediaScope {
    pub session: Session,
    project_id: String,
}
impl MediaScope {
    fn matches(&self, other: &Self) -> bool {
        self.project_id == other.project_id
            && self.session.session == other.session.session
            && self.session.workspace_id == other.session.workspace_id
            && self.session.generation == other.session.generation
    }
}
fn uuid(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).is_err() || value.len() != 36 {
        return Err(Error::new("invalid", "Invalid local media identity"));
    }
    Ok(())
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn directory_identity(path: &Path) -> Result<(u64, u64)> {
    let (device, inode, _) = paths::ordinary_directory(path)?.identity();
    Ok((device, inode))
}
fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| Error::new("unavailable", "Local media owner unavailable"))
}
#[derive(Clone)]
struct Version {
    identity: (u64, u64, u64),
    bytes: u64,
    modified: std::time::SystemTime,
}
impl Version {
    fn read(path: &Path) -> Result<Self> {
        let s = paths::ordinary(path, 1)?;
        Ok(Self {
            identity: s.identity(),
            bytes: s.len(),
            modified: s.modified()?,
        })
    }
    fn check(&self, path: &Path) -> Result<()> {
        let now = Self::read(path)?;
        if self.identity != now.identity || self.bytes != now.bytes || self.modified != now.modified
        {
            return Err(Error::new(
                "changed",
                "Selected video changed; scan the directory again",
            ));
        }
        Ok(())
    }
    fn revision(&self) -> String {
        paths::hex_digest(Sha256::digest(
            format!("{:?}:{}:{:?}", self.identity, self.bytes, self.modified).as_bytes(),
        ))
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntrySummary {
    entry_id: String,
    display_name: String,
    relative_name: String,
    mime_type: String,
    byte_length: u64,
    revision: String,
}
#[derive(Clone)]
struct Entry {
    summary: EntrySummary,
    relative: PathBuf,
    version: Version,
    content_hash: String,
    ancestors: Vec<(PathBuf, (u64, u64))>,
}
struct Manifest {
    id: String,
    entries: Vec<Entry>,
    skipped: usize,
    total_bytes: u64,
}
struct Grant {
    id: String,
    scope: MediaScope,
    root: PathBuf,
    identity: (u64, u64),
    label: String,
    revoked: AtomicBool,
    touched: Mutex<Instant>,
    manifest: Mutex<Option<Manifest>>,
    #[cfg(windows)]
    _pins: Vec<paths::DirectoryGuard>,
}
impl Grant {
    fn check(&self) -> Result<()> {
        if self.revoked.load(Ordering::SeqCst) || lock(&self.touched)?.elapsed() > GRANT_IDLE {
            return Err(Error::new(
                "grantRevoked",
                "Directory permission expired; select the directory again",
            ));
        }
        if directory_identity(&self.root)? != self.identity {
            return Err(Error::new("changed", "Selected directory changed"));
        }
        Ok(())
    }
    fn check_entry(&self, entry: &Entry) -> Result<PathBuf> {
        self.check_ancestors(&entry.ancestors)?;
        let path = self.root.join(&entry.relative);
        entry.version.check(&path)?;
        Ok(path)
    }
    fn check_ancestors(&self, ancestors: &[(PathBuf, (u64, u64))]) -> Result<()> {
        self.check()?;
        for (relative, identity) in ancestors {
            if directory_identity(&self.root.join(relative))? != *identity {
                return Err(Error::new("changed", "Video directory changed"));
            }
        }
        Ok(())
    }
}
struct Operation {
    id: String,
    scope: MediaScope,
    grant_id: Option<String>,
    cancel: AtomicBool,
    active: AtomicBool,
    done: tokio::sync::Notify,
    started: Instant,
    result: Mutex<Value>,
}
impl Operation {
    fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(Error::new("canceled", "Local media operation stopped"));
        }
        if self.started.elapsed() > Duration::from_secs(10 * 60) {
            return Err(Error::new(
                "mediaTimeout",
                "Local media operation timed out",
            ));
        }
        Ok(())
    }
}
#[derive(Default)]
struct Owner {
    closing: bool,
    grants: HashMap<String, Arc<Grant>>,
    operations: HashMap<String, Arc<Operation>>,
    released: HashMap<String, Instant>,
}
#[derive(Default)]
pub(crate) struct DesktopMedia {
    owner: Mutex<Owner>,
    gate: Option<Arc<AtomicBool>>,
}
impl DesktopMedia {
    pub(crate) fn with_gate(gate: Arc<AtomicBool>) -> Self {
        Self {
            owner: Mutex::new(Owner::default()),
            gate: Some(gate),
        }
    }
    fn reserve(
        &self,
        scope: &MediaScope,
        operation_id: &str,
        grant_id: Option<&str>,
        phase: &str,
    ) -> Result<Arc<Operation>> {
        uuid(operation_id)?;
        let mut owner = lock(&self.owner)?;
        if owner.closing
            || self
                .gate
                .as_ref()
                .is_some_and(|gate| !gate.load(Ordering::SeqCst))
        {
            return Err(Error::new("closing", "Application is shutting down"));
        }
        owner
            .released
            .retain(|_, released| released.elapsed() <= GRANT_IDLE);
        if owner.operations.contains_key(operation_id) || owner.released.contains_key(operation_id)
        {
            return Err(Error::new(
                "duplicate",
                "Media operation already exists; read its status",
            ));
        }
        if owner
            .operations
            .values()
            .filter(|o| {
                o.active.load(Ordering::SeqCst)
                    || o.result.lock().is_ok_and(|r| r["status"] == "unknown")
            })
            .count()
            >= MAX_ACTIVE
        {
            return Err(Error::new(
                "busy",
                "Another local media operation is running",
            ));
        }
        if owner.operations.len() >= MAX_OPERATIONS || owner.released.len() >= MAX_TOMBSTONES {
            return Err(Error::new(
                "mediaLimit",
                "Local media operation retention limit reached",
            ));
        }
        let operation = Arc::new(Operation {
            id: operation_id.into(),
            scope: scope.clone(),
            grant_id: grant_id.map(str::to_owned),
            cancel: AtomicBool::new(false),
            active: AtomicBool::new(true),
            done: tokio::sync::Notify::new(),
            started: Instant::now(),
            result: Mutex::new(
                json!({"status":"running","operationId":operation_id,"phase":phase}),
            ),
        });
        owner
            .operations
            .insert(operation_id.into(), Arc::clone(&operation));
        Ok(operation)
    }
    fn finish(
        &self,
        operation: &Operation,
        operation_id: &str,
        result: Result<Value>,
    ) -> Result<Value> {
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                json!({"status":if error.code == "canceled" {"stopped"} else if error.code=="decoderStopUnknown" {"unknown"} else {"failed"},"operationId":operation_id,"error":{"code":error.code,"message":safe_message(error.code)}})
            }
        };
        *lock(&operation.result)? = value.clone();
        operation.active.store(false, Ordering::SeqCst);
        operation.done.notify_waiters();
        Ok(value)
    }
    fn operation(&self, scope: &MediaScope, operation_id: &str) -> Result<Arc<Operation>> {
        uuid(operation_id)?;
        let owner = lock(&self.owner)?;
        let operation = owner
            .operations
            .get(operation_id)
            .ok_or_else(|| Error::new("notFound", "Local media operation not found"))?;
        if !scope.matches(&operation.scope) {
            return Err(Error::new(
                "ownership",
                "Local media operation belongs to another scope",
            ));
        }
        Ok(Arc::clone(operation))
    }
    fn grant(&self, scope: &MediaScope, grant_id: &str) -> Result<Arc<Grant>> {
        uuid(grant_id)?;
        let owner = lock(&self.owner)?;
        let grant = owner
            .grants
            .get(grant_id)
            .ok_or_else(|| Error::new("grantRevoked", "Directory permission expired"))?;
        if !scope.matches(&grant.scope) {
            return Err(Error::new(
                "ownership",
                "Directory belongs to another project or session",
            ));
        }
        grant.check()?;
        *lock(&grant.touched)? = Instant::now();
        Ok(Arc::clone(grant))
    }
    pub(crate) fn pick(
        &self,
        scope: &MediaScope,
        operation_id: &str,
        picker: impl FnOnce() -> Result<Option<PathBuf>>,
    ) -> Result<Value> {
        let operation = self.reserve(scope, operation_id, None, "picking")?;
        let result = (|| {
            operation.check()?;
            let Some(path) = picker()? else {
                return Ok(json!({"status":"canceled","operationId":operation_id}));
            };
            operation.check()?;
            let root = paths::canonical_root(&path)?;
            let identity = directory_identity(&root)?;
            #[cfg(windows)]
            let pins = paths::pin_ancestors(&root)?;
            let label = display(
                root.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("素材目录"),
            );
            let grant = Arc::new(Grant {
                id: id(),
                scope: scope.clone(),
                root,
                identity,
                label,
                revoked: AtomicBool::new(false),
                touched: Mutex::new(Instant::now()),
                manifest: Mutex::new(None),
                #[cfg(windows)]
                _pins: pins,
            });
            let mut owner = lock(&self.owner)?;
            owner.grants.retain(|_, g| {
                !g.revoked.load(Ordering::SeqCst)
                    && lock(&g.touched).is_ok_and(|t| t.elapsed() <= GRANT_IDLE)
            });
            if owner.grants.len() >= MAX_GRANTS {
                return Err(Error::new(
                    "mediaLimit",
                    "Directory permission limit reached",
                ));
            }
            operation.check()?;
            let summary = json!({"status":"granted","operationId":operation_id,"grantId":grant.id,"label":grant.label,"limits":limits()});
            owner.grants.insert(grant.id.clone(), grant);
            Ok(summary)
        })();
        self.finish(&operation, operation_id, result)
    }
    pub(crate) fn request(
        &self,
        scope: &MediaScope,
        action: MediaAction,
        worker: &StorageWorker,
        staging: &Path,
        resources: &Path,
    ) -> Result<Value> {
        match action {
            MediaAction::PickDirectory { .. } => Err(Error::new(
                "invalid",
                "Directory selection requires the native picker",
            )),
            MediaAction::Scan {
                operation_id,
                grant_id,
            } => {
                let grant = self.grant(scope, &grant_id)?;
                let operation = self.reserve(scope, &operation_id, Some(&grant_id), "scanning")?;
                let result = scan(&grant,&operation).and_then(|manifest| {
                    operation.check()?; grant.check()?;
                    for entry in &manifest.entries {
                        operation.check()?; grant.check_entry(entry)?;
                    }
                    let summary = json!({"status":"scanned","operationId":operation_id,"grantId":grant_id,"scanId":manifest.id,"count":manifest.entries.len(),"skipped":manifest.skipped,"totalBytes":manifest.total_bytes,"limits":limits()});
                    *lock(&grant.manifest)? = Some(manifest); Ok(summary)
                });
                self.finish(&operation, &operation_id, result)
            }
            MediaAction::ReadScanPage {
                grant_id,
                scan_id,
                offset,
                limit,
            } => {
                uuid(&scan_id)?;
                if limit == 0 || limit > MAX_PAGE || offset > MAX_VIDEOS {
                    return Err(Error::new("mediaLimit", "Scan page exceeded its limit"));
                }
                let grant = self.grant(scope, &grant_id)?;
                let guard = lock(&grant.manifest)?;
                let manifest = guard
                    .as_ref()
                    .filter(|m| m.id == scan_id)
                    .ok_or_else(|| Error::new("staleScan", "Directory scan expired"))?;
                let entries: Vec<_> = manifest
                    .entries
                    .iter()
                    .skip(offset)
                    .take(limit)
                    .map(|e| &e.summary)
                    .collect();
                Ok(
                    json!({"status":"scanPage","grantId":grant_id,"scanId":scan_id,"offset":offset,"entries":entries,"total":manifest.entries.len(),"nextOffset":(offset+entries.len()<manifest.entries.len()).then_some(offset+entries.len())}),
                )
            }
            MediaAction::PrepareVideo {
                operation_id,
                grant_id,
                scan_id,
                entry_id,
                expected_revision,
            } => {
                uuid(&scan_id)?;
                uuid(&entry_id)?;
                if expected_revision.len() != 64
                    || !expected_revision
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                {
                    return Err(Error::new("invalid", "Invalid video revision"));
                }
                let grant = self.grant(scope, &grant_id)?;
                let entry = {
                    let guard = lock(&grant.manifest)?;
                    let manifest = guard
                        .as_ref()
                        .filter(|m| m.id == scan_id)
                        .ok_or_else(|| Error::new("staleScan", "Directory scan expired"))?;
                    manifest
                        .entries
                        .iter()
                        .find(|e| {
                            e.summary.entry_id == entry_id
                                && e.summary.revision == expected_revision
                        })
                        .cloned()
                        .ok_or_else(|| {
                            Error::new("changed", "Selected video is absent or changed")
                        })?
                };
                let operation = self.reserve(scope, &operation_id, Some(&grant_id), "copying")?;
                let result=prepare(&grant,&entry,&operation,scope,worker,staging,resources).map(|prepared| json!({"status":"prepared","operationId":operation_id,"grantId":grant_id,"scanId":scan_id,"entry":entry.summary,"sourceClaim":prepared.source,"thumbnailClaim":prepared.thumbnail,"thumbnail":{"width":prepared.width,"height":prepared.height,"preset":"thumbnail-v1","atSeconds":0,"decoder":"FFmpeg 8.0.3"}}));
                self.finish(&operation, &operation_id, result)
            }
            MediaAction::ReadOperation { operation_id } => {
                let operation = self.operation(scope, &operation_id)?;
                let result = lock(&operation.result)?.clone();
                Ok(result)
            }
            MediaAction::CancelOperation { operation_id } => {
                let operation = self.operation(scope, &operation_id)?;
                if !operation.active.load(Ordering::SeqCst) {
                    return Ok(lock(&operation.result)?.clone());
                }
                operation.cancel.store(true, Ordering::SeqCst);
                Ok(json!({"status":"stopping","operationId":operation_id}))
            }
            MediaAction::DiscardPrepared { operation_id } => {
                let operation = self.operation(scope, &operation_id)?;
                if operation.active.load(Ordering::SeqCst) {
                    return Err(Error::new(
                        "busy",
                        "Stop the running operation before discarding",
                    ));
                }
                let mut result = lock(&operation.result)?;
                if result["status"] == "prepared" {
                    let adopted = ["sourceClaim", "thumbnailClaim"].iter().all(|field| {
                        serde_json::from_value::<BinaryClaim>(result[*field].clone()).is_ok_and(
                            |claim| {
                                binary(
                                    worker,
                                    scope,
                                    BinaryRequest::Availability {
                                        reference: claim.reference,
                                    },
                                )
                                .is_ok()
                            },
                        )
                    });
                    if adopted {
                        *result = json!({"status":"alreadyAdopted","operationId":operation_id});
                        return Ok(result.clone());
                    }
                    // Abort checks durable intent ownership. A consumed claim has
                    // no intent and cannot delete committed managed bytes.
                    for field in ["sourceClaim", "thumbnailClaim"] {
                        let claim: BinaryClaim = serde_json::from_value(result[field].clone())?;
                        binary(
                            worker,
                            scope,
                            BinaryRequest::Abort {
                                stage_id: claim.stage_id,
                            },
                        )?;
                    }
                    *result = json!({"status":"discarded","operationId":operation_id});
                }
                Ok(result.clone())
            }
            MediaAction::ReleaseOperation { operation_id } => {
                let operation = self.operation(scope, &operation_id)?;
                if operation.active.load(Ordering::SeqCst) {
                    return Err(Error::new("busy", "Running operation cannot be released"));
                }
                let result = lock(&operation.result)?;
                if result["status"] == "unknown" {
                    return Err(Error::new(
                        "unknown",
                        "Unresolved media operation must be retained",
                    ));
                }
                if result["status"] == "prepared" {
                    for field in ["sourceClaim", "thumbnailClaim"] {
                        let claim: BinaryClaim = serde_json::from_value(result[field].clone())?;
                        binary(
                            worker,
                            scope,
                            BinaryRequest::Availability {
                                reference: claim.reference,
                            },
                        )?;
                    }
                }
                drop(result);
                let mut owner = lock(&self.owner)?;
                owner.operations.remove(&operation_id);
                owner.released.insert(operation_id.clone(), Instant::now());
                Ok(json!({"status":"released","operationId":operation_id}))
            }
            MediaAction::RevokeDirectory { grant_id } => {
                uuid(&grant_id)?;
                let mut owner = lock(&self.owner)?;
                let Some(grant) = owner.grants.get(&grant_id) else {
                    return Ok(json!({"status":"revoked","grantId":grant_id}));
                };
                if !scope.matches(&grant.scope) {
                    return Err(Error::new(
                        "ownership",
                        "Directory belongs to another project or session",
                    ));
                }
                // Revocation removes authority even after expiry or source changes.
                // Only reading/using a grant requires its live filesystem checks.
                grant.revoked.store(true, Ordering::SeqCst);
                for operation in owner.operations.values() {
                    if operation.grant_id.as_deref() == Some(&grant_id) {
                        operation.cancel.store(true, Ordering::SeqCst);
                    }
                }
                owner.grants.remove(&grant_id);
                Ok(json!({"status":"revoked","grantId":grant_id}))
            }
        }
    }
    /// Teardown invalidates authority immediately. Active blocking owners keep
    /// their Arc, observe Stop, kill/wait and clean before publishing terminal.
    pub(crate) fn stop_all(&self) {
        if let Ok(mut owner) = self.owner.lock() {
            for grant in owner.grants.values() {
                grant.revoked.store(true, Ordering::SeqCst);
            }
            for operation in owner.operations.values() {
                operation.cancel.store(true, Ordering::SeqCst);
            }
            owner.grants.clear();
        }
    }
    /// Close reservation and capture original operations under the same lock.
    /// Cancellation is only a signal; completion follows finish after decoder
    /// wait/cleanup and retained result publication.
    pub(crate) fn shutdown(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let originals = {
            let mut owner = self.owner.lock().unwrap();
            owner.closing = true;
            let originals = owner.operations.values().cloned().collect::<Vec<_>>();
            for operation in &originals {
                operation.cancel.store(true, Ordering::SeqCst);
            }
            originals
        };
        async move {
            for operation in originals {
                loop {
                    let done = operation.done.notified();
                    tokio::pin!(done);
                    done.as_mut().enable();
                    if !operation.active.load(Ordering::SeqCst) {
                        break;
                    }
                    done.await;
                }
            }
        }
    }
}
fn limits() -> Value {
    json!({"maxDepth":MAX_DEPTH,"maxEntries":MAX_ENTRIES,"maxVideos":MAX_VIDEOS,"maxFileBytes":MAX_FILE_BYTES,"maxTotalBytes":MAX_TOTAL_BYTES,"maxPage":MAX_PAGE,"maxActiveOperations":MAX_ACTIVE})
}
fn display(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(240)
        .collect()
}
fn safe_message(code: &str) -> &'static str {
    match code {
        "canceled" => "本地素材处理已停止",
        "changed" => "所选文件或目录已变化，请重新扫描",
        "grantRevoked" => "目录授权已失效，请重新选择目录",
        "decoderUnavailable" => "当前安装尚未提供可用的视频解码器",
        "decoderTimeout" => "视频解码超时",
        "decoderLimit" | "mediaLimit" => "素材处理超过当前支持的范围",
        "platform" | "nativeFilesystem" => "当前系统或磁盘类型暂不支持；Windows 首版需要本地固定 NTFS 磁盘",
        "containment" => "所选文件包含链接或不受支持的文件类型",
        _ => "本地素材处理失败，请检查文件后重试",
    }
}
fn mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        _ => None,
    }
}
fn scan(grant: &Grant, operation: &Operation) -> Result<Manifest> {
    scan_with_read_check(grant, operation, |_| Ok(()))
}
fn scan_with_read_check(
    grant: &Grant,
    operation: &Operation,
    mut before_read_check: impl FnMut(&Path) -> Result<()>,
) -> Result<Manifest> {
    let mut entries = Vec::new();
    let mut visited = 0;
    let mut skipped = 0;
    let mut total_bytes = 0;
    let mut pending = vec![(PathBuf::new(), Vec::new())];
    while let Some((relative, ancestors)) = pending.pop() {
        operation.check()?;
        grant.check_ancestors(&ancestors)?;
        let mut children = Vec::new();
        for child in fs::read_dir(grant.root.join(&relative))? {
            operation.check()?;
            grant.check_ancestors(&ancestors)?;
            visited += 1;
            if visited > MAX_ENTRIES {
                return Err(Error::new("mediaLimit", "Directory entry limit exceeded"));
            }
            children.push(child?);
        }
        children.sort_by_key(|child| child.file_name());
        for child in children.into_iter().rev() {
            operation.check()?;
            grant.check_ancestors(&ancestors)?;
            let path = child.path();
            let metadata = paths::stat_path(&path)?;
            if metadata.is_alias() {
                skipped += 1;
                continue;
            }
            let child_relative = relative.join(child.file_name());
            if metadata.is_dir() {
                if child_relative.components().count() > MAX_DEPTH {
                    skipped += 1;
                    continue;
                }
                let mut next = ancestors.clone();
                let identity = metadata.identity();
                next.push((child_relative.clone(), (identity.0, identity.1)));
                pending.push((child_relative, next));
                continue;
            }
            let Some(mime_type) = mime(&path) else {
                continue;
            };
            if !metadata.is_file()
                || metadata.identity().2 != 1
                || metadata.len() == 0
                || metadata.len() > MAX_FILE_BYTES
            {
                skipped += 1;
                continue;
            }
            if entries.len() >= MAX_VIDEOS || total_bytes + metadata.len() > MAX_TOTAL_BYTES {
                return Err(Error::new("mediaLimit", "Video scan limit exceeded"));
            }
            let Some(relative_name) = child_relative.to_str() else {
                skipped += 1;
                continue;
            };
            if relative_name.len() > 1024 || relative_name.chars().any(char::is_control) {
                skipped += 1;
                continue;
            }
            let version = Version::read(&path)?;
            let (_, content_hash) = paths::hash_file(&path, MAX_FILE_BYTES, || {
                before_read_check(&path)?;
                operation.check()?;
                grant.check_ancestors(&ancestors)?;
                Ok(())
            })?;
            grant.check_ancestors(&ancestors)?;
            version.check(&path)?;
            total_bytes += version.bytes;
            let revision = paths::hex_digest(Sha256::digest(
                format!("{}:{content_hash}", version.revision()).as_bytes(),
            ));
            entries.push(Entry {
                summary: EntrySummary {
                    entry_id: id(),
                    display_name: display(&child.file_name().to_string_lossy()),
                    relative_name: relative_name.replace('\\', "/"),
                    mime_type: mime_type.into(),
                    byte_length: version.bytes,
                    revision,
                },
                relative: child_relative,
                version,
                content_hash,
                ancestors: ancestors.clone(),
            });
        }
    }
    entries.sort_by(|a, b| a.summary.relative_name.cmp(&b.summary.relative_name));
    Ok(Manifest {
        id: id(),
        entries,
        skipped,
        total_bytes,
    })
}
struct Prepared {
    source: BinaryClaim,
    thumbnail: BinaryClaim,
    width: u32,
    height: u32,
}
struct OwnedDirectory {
    root: PathBuf,
    identity: (u64, u64),
    files: Vec<(PathBuf, (u64, u64, u64))>,
    preserve: bool,
}
impl OwnedDirectory {
    fn create(parent: &Path) -> Result<Self> {
        fs::create_dir_all(parent)?;
        let parent = paths::canonical_root(parent)?;
        let root = parent.join(id());
        fs::create_dir(&root)?;
        let identity = directory_identity(&root)?;
        Ok(Self {
            root,
            identity,
            files: Vec::new(),
            preserve: false,
        })
    }
    fn file(&mut self, name: &str) -> Result<File> {
        let path = self.root.join(name);
        let file = paths::exclusive(&path)?;
        self.files.push((path, paths::stat_file(&file)?.identity()));
        Ok(file)
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        if self.preserve {
            return;
        }
        if !directory_identity(&self.root).is_ok_and(|identity| identity == self.identity) {
            return;
        }
        for (path, identity) in &self.files {
            if paths::ordinary(path, 1).is_ok_and(|s| s.identity() == *identity) {
                let _ = fs::remove_file(path);
            }
        }
        let _ = fs::remove_dir(&self.root); // Never recursively remove unknown bytes.
    }
}
fn binary(worker: &StorageWorker, scope: &MediaScope, request: BinaryRequest) -> Result<Value> {
    worker.run_product(ProductJob::Binary {
        session: scope.session.clone(),
        request,
    })
}
fn prepare(
    grant: &Grant,
    entry: &Entry,
    operation: &Operation,
    scope: &MediaScope,
    worker: &StorageWorker,
    staging: &Path,
    resources: &Path,
) -> Result<Prepared> {
    operation.check()?;
    grant.check_entry(entry)?;
    // Hash and execute one app-owned copy so the resource path cannot be swapped
    // between verification and process creation. Dropped after the decode.
    let mut tool = OwnedDirectory::create(staging)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tool.root, fs::Permissions::from_mode(0o700))?;
    }
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut copy = tool.file(name)?;
    let bytes = crate::media_decoder::verified_decoder(resources, &mut copy)?;
    copy.sync_all()?;
    drop(copy);
    let executable = tool.root.join(name);
    let _sealed = crate::media_decoder::seal_copy(&executable, bytes)?;
    operation.check()?;
    prepare_with_decoder(
        grant,
        entry,
        operation,
        scope,
        worker,
        staging,
        |input, directory, cancel| {
            crate::desktop_media_process::thumbnail(&executable, input, directory, cancel)
        },
    )
}
fn prepare_with_decoder(
    grant: &Grant,
    entry: &Entry,
    operation: &Operation,
    scope: &MediaScope,
    worker: &StorageWorker,
    staging: &Path,
    decode: impl FnOnce(&Path, &Path, &AtomicBool) -> Result<Vec<u8>>,
) -> Result<Prepared> {
    operation.check()?;
    let source = grant.check_entry(entry)?;
    let mut directory = OwnedDirectory::create(staging)?;
    #[cfg(windows)]
    let _pins = paths::pin_ancestors(
        source
            .parent()
            .ok_or_else(|| Error::new("containment", "Missing source parent"))?,
    )?;
    let mut input = File::open(&source)?;
    if paths::stat_file(&input)?.identity() != entry.version.identity {
        return Err(Error::new(
            "changed",
            "Selected video changed while opening",
        ));
    }
    let mut snapshot = directory.file("source.bin")?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0; 262144];
    loop {
        operation.check()?;
        grant.check_entry(entry)?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > entry.version.bytes {
            return Err(Error::new("changed", "Selected video grew"));
        }
        hash.update(&buffer[..count]);
        snapshot.write_all(&buffer[..count])?;
    }
    snapshot.sync_all()?;
    drop(snapshot);
    if bytes != entry.version.bytes {
        return Err(Error::new("changed", "Selected video length changed"));
    }
    grant.check_entry(entry)?;
    operation.check()?;
    let source_hash = paths::hex_digest(hash.finalize());
    if source_hash != entry.content_hash {
        return Err(Error::new(
            "changed",
            "Video content changed since directory scan",
        ));
    }
    let snapshot_path = directory.root.join("source.bin");
    *lock(&operation.result)? =
        json!({"status":"running","operationId":operation.id,"phase":"decoding"});
    let png_result = decode(&snapshot_path, &directory.root, &operation.cancel);
    let png = match png_result {
        Ok(png) => png,
        Err(error) => {
            if error.code == "decoderStopUnknown" {
                directory.preserve = true;
            }
            return Err(error);
        }
    };
    let (width, height) = crate::desktop_media_process::png_dimensions(&png)?;
    operation.check()?;
    grant.check_entry(entry)?;
    // Every stage is prepared through ProductJob::Binary, never another DB owner.
    let mut claims = Vec::new();
    let result = (|| {
        let source = prepare_reader(
            worker,
            scope,
            File::open(&snapshot_path)?,
            bytes,
            &entry.summary.mime_type,
            &source_hash,
            || {
                operation.check()?;
                grant.check_entry(entry)?;
                Ok(())
            },
        )?;
        claims.push(source.clone());
        let png_hash = paths::hex_digest(Sha256::digest(&png));
        let thumbnail = prepare_reader(
            worker,
            scope,
            std::io::Cursor::new(&png),
            png.len() as u64,
            "image/png",
            &png_hash,
            || {
                operation.check()?;
                grant.check_entry(entry)?;
                Ok(())
            },
        )?;
        claims.push(thumbnail.clone());
        operation.check()?;
        grant.check_entry(entry)?;
        Ok(Prepared {
            source,
            thumbnail,
            width,
            height,
        })
    })();
    if result.is_err() {
        for claim in claims {
            let _ = binary(
                worker,
                scope,
                BinaryRequest::Abort {
                    stage_id: claim.stage_id,
                },
            );
        }
    }
    result
}
fn prepare_reader(
    worker: &StorageWorker,
    scope: &MediaScope,
    mut input: impl Read,
    bytes: u64,
    mime: &str,
    hash: &str,
    mut check: impl FnMut() -> Result<()>,
) -> Result<BinaryClaim> {
    check()?;
    let prepared = binary(
        worker,
        scope,
        BinaryRequest::Prepare {
            byte_length: bytes,
            mime_type: mime.into(),
        },
    )?;
    let stage = prepared["stageId"]
        .as_str()
        .ok_or_else(|| Error::new("wire", "Invalid binary prepare response"))?
        .to_owned();
    let result = (|| {
        let mut offset = 0;
        let mut buffer = vec![0; 262144];
        loop {
            check()?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            binary(
                worker,
                scope,
                BinaryRequest::Write {
                    stage_id: stage.clone(),
                    offset,
                    bytes: buffer[..count].to_vec(),
                },
            )?;
            offset += count as u64;
        }
        if offset != bytes {
            return Err(Error::new("changed", "Prepared file length changed"));
        }
        check()?;
        let sealed = binary(
            worker,
            scope,
            BinaryRequest::Seal {
                stage_id: stage.clone(),
                content_hash: hash.into(),
            },
        )?;
        Ok(serde_json::from_value(sealed["claim"].clone())?)
    })();
    if result.is_err() {
        let _ = binary(worker, scope, BinaryRequest::Abort { stage_id: stage });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn desktop_lifecycle_media_shutdown_awaits_original_finish_not_stop_flag() {
        let owner = Arc::new(DesktopMedia::default());
        let scope = scope();
        let operation_id = id();
        let original = owner
            .reserve(&scope, &operation_id, None, "copying")
            .unwrap();
        let completion = owner.shutdown();
        tokio::pin!(completion);
        assert!(original.cancel.load(Ordering::SeqCst));
        assert!(owner.reserve(&scope, &id(), None, "copying").is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), completion.as_mut())
                .await
                .is_err()
        );
        assert!(original.active.load(Ordering::SeqCst));
        owner
            .finish(
                &original,
                &operation_id,
                Err(Error::new("canceled", "stopped")),
            )
            .unwrap();
        completion.await;
        assert_eq!(lock(&original.result).unwrap()["status"], "stopped");
        assert!(!original.active.load(Ordering::SeqCst));
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("momoki-desktop-media-{}", id()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scope() -> MediaScope {
        MediaScope {
            session: Session {
                version: 1,
                session: id(),
                workspace_id: id(),
                generation: 1,
            },
            project_id: "project".into(),
        }
    }
    fn grant(owner: &DesktopMedia, scope: &MediaScope, root: &Path) -> String {
        owner.pick(scope, &id(), || Ok(Some(root.into()))).unwrap()["grantId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn worker(fixture: &Fixture) -> (StorageWorker, MediaScope) {
        use crate::full_product_store::protocol::{Empty, Request};
        let worker =
            StorageWorker::product(fixture.0.join("product"), true, crate::Hooks::default())
                .unwrap();
        let opened = worker
            .run_product(ProductJob::Store(Request::Open(Empty {})))
            .unwrap();
        let session=serde_json::from_value(json!({"version":opened["version"],"session":opened["session"],"workspaceId":opened["workspaceId"],"generation":opened["generation"]})).unwrap();
        (
            worker,
            MediaScope {
                session,
                project_id: "project".into(),
            },
        )
    }
    #[test]
    fn scan_pages_survive_operation_release_and_duplicate_ids_stay_consumed() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("clip.mp4"), b"fixture").unwrap();
        let (worker, scope) = worker(&fixture);
        let owner = DesktopMedia::default();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let operation_id = id();
        let resources = fixture.0.join("resources");
        let staging = fixture.0.join("staging");
        let scanned = owner
            .request(
                &scope,
                MediaAction::Scan {
                    operation_id: operation_id.clone(),
                    grant_id: grant_id.clone(),
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        assert_eq!(scanned["status"], "scanned");
        assert_eq!(scanned["count"], 1);
        let scan_id = scanned["scanId"].as_str().unwrap().to_owned();
        let release = owner
            .request(
                &scope,
                MediaAction::ReleaseOperation {
                    operation_id: operation_id.clone(),
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        assert_eq!(release["status"], "released");
        assert_eq!(
            owner
                .reserve(&scope, &operation_id, Some(&grant_id), "scanning")
                .err()
                .unwrap()
                .code,
            "duplicate"
        );
        let page = owner
            .request(
                &scope,
                MediaAction::ReadScanPage {
                    grant_id: grant_id.clone(),
                    scan_id: scan_id.clone(),
                    offset: 0,
                    limit: 1,
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        assert_eq!(page["entries"][0]["displayName"], "clip.mp4");
        assert_eq!(page["nextOffset"], Value::Null);
        assert!(
            owner
                .request(
                    &scope,
                    MediaAction::ReadScanPage {
                        grant_id: grant_id.clone(),
                        scan_id,
                        offset: 0,
                        limit: MAX_PAGE + 1
                    },
                    &worker,
                    &staging,
                    &resources
                )
                .is_err()
        );
        owner
            .request(
                &scope,
                MediaAction::RevokeDirectory {
                    grant_id: grant_id.clone(),
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        assert!(owner.grant(&scope, &grant_id).is_err());
        worker.close().unwrap();
    }
    #[test]
    fn completed_pick_is_released_for_repeated_normal_operations() {
        let fixture = Fixture::new();
        let (worker, scope) = worker(&fixture);
        let owner = DesktopMedia::default();
        for _ in 0..(MAX_OPERATIONS + 1) {
            let operation_id = id();
            assert_eq!(
                owner.pick(&scope, &operation_id, || Ok(None)).unwrap()["status"],
                "canceled"
            );
            owner
                .request(
                    &scope,
                    MediaAction::ReleaseOperation { operation_id },
                    &worker,
                    &fixture.0,
                    &fixture.0,
                )
                .unwrap();
        }
        assert!(lock(&owner.owner).unwrap().operations.is_empty());
        worker.close().unwrap();
    }
    #[test]
    #[ignore = "Requires the explicit verified decoder resource root; run the fixture command with MOMOKI_MEDIA_TEST_RESOURCES"]
    fn real_fixture_prepares_two_native_claims_and_cleans_snapshot() {
        let resources = PathBuf::from(
            std::env::var_os("MOMOKI_MEDIA_TEST_RESOURCES")
                .expect("explicit decoder resource root"),
        );
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        fs::create_dir(&source).unwrap();
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/media/movie.mp4"),
            source.join("movie.mp4"),
        )
        .unwrap();
        let (worker, scope) = worker(&fixture);
        let owner = DesktopMedia::default();
        let grant_id = grant(&owner, &scope, &source);
        let staging = fixture.0.join("staging");
        let scanned = owner
            .request(
                &scope,
                MediaAction::Scan {
                    operation_id: id(),
                    grant_id: grant_id.clone(),
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        let scan_id = scanned["scanId"].as_str().unwrap().to_owned();
        let page = owner
            .request(
                &scope,
                MediaAction::ReadScanPage {
                    grant_id: grant_id.clone(),
                    scan_id: scan_id.clone(),
                    offset: 0,
                    limit: 1,
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        let entry = &page["entries"][0];
        let operation_id = id();
        let result = owner
            .request(
                &scope,
                MediaAction::PrepareVideo {
                    operation_id: operation_id.clone(),
                    grant_id,
                    scan_id,
                    entry_id: entry["entryId"].as_str().unwrap().into(),
                    expected_revision: entry["revision"].as_str().unwrap().into(),
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        assert_eq!(result["status"], "prepared", "{result}");
        assert_eq!(result["sourceClaim"]["reference"]["byteLength"], 11940);
        assert_eq!(
            result["sourceClaim"]["reference"]["contentHash"],
            "91f3d0a1a72de8355add6814fa4ed8b47bc3cac5ebb02c62dcd8b5b7a5a32341"
        );
        assert_eq!(
            result["thumbnailClaim"]["reference"]["mimeType"],
            "image/png"
        );
        assert!(result["thumbnail"]["width"].as_u64().unwrap() <= 640);
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
        assert!(
            owner
                .request(
                    &scope,
                    MediaAction::ReleaseOperation {
                        operation_id: operation_id.clone()
                    },
                    &worker,
                    &staging,
                    &resources
                )
                .is_err(),
            "Uncommitted prepared claims must be retained"
        );
        let discarded = owner
            .request(
                &scope,
                MediaAction::DiscardPrepared {
                    operation_id: operation_id.clone(),
                },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        assert_eq!(discarded["status"], "discarded");
        owner
            .request(
                &scope,
                MediaAction::ReleaseOperation { operation_id },
                &worker,
                &staging,
                &resources,
            )
            .unwrap();
        worker.close().unwrap();
    }
    #[test]
    fn closed_wire_rejects_paths_unknown_fields_and_wrong_actions() {
        for value in [
            json!({"type":"scan","grantId":id(),"operationId":id(),"path":"/tmp"}),
            json!({"type":"shell","command":"anything"}),
            json!({"type":"prepareVideo","operationId":id(),"grantId":id(),"scanId":id(),"entryId":id(),"expectedRevision":"x","argv":[]}),
        ] {
            assert!(serde_json::from_value::<MediaAction>(value).is_err());
        }
    }
    #[test]
    fn grant_scope_revoke_and_changed_source_fail_closed() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("clip.mp4"), b"video").unwrap();
        let owner = DesktopMedia::default();
        let scope = scope();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let mut foreign = scope.clone();
        foreign.project_id = "foreign".into();
        assert_eq!(
            owner.grant(&foreign, &grant_id).err().unwrap().code,
            "ownership"
        );
        let native = owner.grant(&scope, &grant_id).unwrap();
        let op = owner
            .reserve(&scope, &id(), Some(&grant_id), "scanning")
            .unwrap();
        let manifest = scan(&native, &op).unwrap();
        let entry = &manifest.entries[0];
        fs::remove_file(fixture.0.join("clip.mp4")).unwrap();
        fs::write(fixture.0.join("clip.mp4"), b"other").unwrap();
        assert_eq!(native.check_entry(entry).unwrap_err().code, "changed");
        native.revoked.store(true, Ordering::SeqCst);
        assert_eq!(native.check().unwrap_err().code, "grantRevoked");
    }
    #[test]
    fn expired_directory_grant_can_be_revoked_and_replaced() {
        let fixture = Fixture::new();
        let (worker, scope) = worker(&fixture);
        let owner = DesktopMedia::default();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let native = owner.grant(&scope, &grant_id).unwrap();
        let operation = owner
            .reserve(&scope, &id(), Some(&grant_id), "scanning")
            .unwrap();
        *lock(&native.touched).unwrap() = Instant::now() - GRANT_IDLE - Duration::from_secs(1);
        assert_eq!(
            owner.grant(&scope, &grant_id).err().unwrap().code,
            "grantRevoked"
        );
        let result = owner
            .request(
                &scope,
                MediaAction::RevokeDirectory {
                    grant_id: grant_id.clone(),
                },
                &worker,
                &fixture.0,
                &fixture.0,
            )
            .unwrap();
        assert_eq!(result["status"], "revoked");
        assert!(native.revoked.load(Ordering::SeqCst));
        assert!(operation.cancel.load(Ordering::SeqCst));
        assert!(!lock(&owner.owner).unwrap().grants.contains_key(&grant_id));
        let replacement = grant(&owner, &scope, &fixture.0);
        assert_ne!(replacement, grant_id);
        assert!(owner.grant(&scope, &replacement).is_ok());
        worker.close().unwrap();
    }
    #[test]
    fn repeated_directory_revocation_is_idempotent_without_other_effects() {
        let fixture = Fixture::new();
        let (worker, scope) = worker(&fixture);
        let owner = DesktopMedia::default();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let unrelated = owner.reserve(&scope, &id(), None, "picking").unwrap();
        for _ in 0..2 {
            let result = owner
                .request(
                    &scope,
                    MediaAction::RevokeDirectory {
                        grant_id: grant_id.clone(),
                    },
                    &worker,
                    &fixture.0,
                    &fixture.0,
                )
                .unwrap();
            assert_eq!(result["status"], "revoked");
            assert_eq!(result["grantId"], grant_id);
            assert!(!unrelated.cancel.load(Ordering::SeqCst));
        }
        assert!(lock(&owner.owner).unwrap().grants.is_empty());
        worker.close().unwrap();
    }
    #[test]
    fn foreign_scope_cannot_revoke_existing_directory_grant() {
        let fixture = Fixture::new();
        let (worker, scope) = worker(&fixture);
        let owner = DesktopMedia::default();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let native = owner.grant(&scope, &grant_id).unwrap();
        let operation = owner
            .reserve(&scope, &id(), Some(&grant_id), "scanning")
            .unwrap();
        let mut foreign = scope.clone();
        foreign.project_id = "foreign".into();
        let result = owner.request(
            &foreign,
            MediaAction::RevokeDirectory {
                grant_id: grant_id.clone(),
            },
            &worker,
            &fixture.0,
            &fixture.0,
        );
        assert_eq!(result.err().unwrap().code, "ownership");
        assert!(!native.revoked.load(Ordering::SeqCst));
        assert!(!operation.cancel.load(Ordering::SeqCst));
        assert!(owner.grant(&scope, &grant_id).is_ok());
        worker.close().unwrap();
    }
    #[test]
    fn native_filesystem_failure_has_the_scoped_volume_message() {
        assert_eq!(safe_message("nativeFilesystem"), safe_message("platform"));
        assert!(safe_message("nativeFilesystem").contains("NTFS"));
    }
    #[test]
    fn scan_is_ordered_bounded_and_does_not_follow_aliases() {
        let fixture = Fixture::new();
        for name in ["b.mp4", "a.mov", "ignored.txt"] {
            fs::write(fixture.0.join(name), b"video").unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(fixture.0.join("a.mov"), fixture.0.join("alias.mov")).unwrap();
        let owner = DesktopMedia::default();
        let scope = scope();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let native = owner.grant(&scope, &grant_id).unwrap();
        let operation = owner.reserve(&scope, &id(), None, "scanning").unwrap();
        let manifest = scan(&native, &operation).unwrap();
        assert_eq!(
            manifest
                .entries
                .iter()
                .map(|e| e.summary.relative_name.as_str())
                .collect::<Vec<_>>(),
            vec!["a.mov", "b.mp4"]
        );
        #[cfg(unix)]
        assert_eq!(manifest.skipped, 1);
        operation.cancel.store(true, Ordering::SeqCst);
        assert_eq!(scan(&native, &operation).err().unwrap().code, "canceled");
        operation.cancel.store(false, Ordering::SeqCst);
        for index in 0..MAX_VIDEOS {
            fs::write(fixture.0.join(format!("video-{index}.mp4")), b"v").unwrap();
        }
        assert_eq!(scan(&native, &operation).err().unwrap().code, "mediaLimit");
    }
    #[test]
    fn teardown_revokes_authority_and_marks_actual_operation_cancel_flag() {
        let fixture = Fixture::new();
        let owner = DesktopMedia::default();
        let scope = scope();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let native = owner.grant(&scope, &grant_id).unwrap();
        let operation = owner
            .reserve(&scope, &id(), Some(&grant_id), "decoding")
            .unwrap();
        owner.stop_all();
        assert_eq!(operation.check().unwrap_err().code, "canceled");
        assert_eq!(native.check().unwrap_err().code, "grantRevoked");
        assert!(
            operation.active.load(Ordering::SeqCst),
            "Stop is not a fabricated terminal acknowledgement"
        );
    }
    #[cfg(unix)]
    #[test]
    fn scan_rejects_replaced_ancestor_before_first_hashed_chunk() {
        let fixture = Fixture::new();
        let child = fixture.0.join("selected");
        fs::create_dir(&child).unwrap();
        let video = child.join("clip.mp4");
        fs::write(&video, vec![7_u8; 512 * 1024]).unwrap();
        let original_file = Version::read(&video).unwrap();
        let owner = DesktopMedia::default();
        let scope = scope();
        let grant_id = grant(&owner, &scope, &fixture.0);
        let native = owner.grant(&scope, &grant_id).unwrap();
        let operation = owner
            .reserve(&scope, &id(), Some(&grant_id), "scanning")
            .unwrap();
        let mut read_checks = 0;
        let result = scan_with_read_check(&native, &operation, |path| {
            read_checks += 1;
            if read_checks == 1 {
                assert_eq!(fs::canonicalize(path)?, fs::canonicalize(&video)?);
                let moved = fixture.0.join("moved");
                fs::rename(&child, &moved)?;
                fs::create_dir(&child)?;
                // Preserve file identity, size and mtime. A file-only post-read
                // check cannot detect substitution of the granted ancestor.
                fs::rename(moved.join("clip.mp4"), &video)?;
                original_file.check(&video)?;
            }
            Ok(())
        });
        assert_eq!(result.err().unwrap().code, "changed");
        assert_eq!(
            read_checks, 1,
            "Replacement must reject before reading a content chunk"
        );
    }
    #[cfg(unix)]
    #[test]
    fn uncertain_process_exit_retains_frozen_input_and_cannot_be_stopped_or_released() {
        let fixture = Fixture::new();
        let selected = fixture.0.join("selected");
        fs::create_dir(&selected).unwrap();
        fs::write(selected.join("clip.mp4"), b"frozen selected source").unwrap();
        let (worker, scope) = worker(&fixture);
        let owner = DesktopMedia::default();
        let grant_id = grant(&owner, &scope, &selected);
        let grant = owner.grant(&scope, &grant_id).unwrap();
        let operation_id = id();
        let operation = owner
            .reserve(&scope, &operation_id, Some(&grant_id), "copying")
            .unwrap();
        let manifest = scan(&grant, &operation).unwrap();
        let entry = &manifest.entries[0];
        let staging = fixture.0.join("staging");
        let mut frozen = None;
        let result = prepare_with_decoder(
            &grant,
            entry,
            &operation,
            &scope,
            &worker,
            &staging,
            |input, _, cancel| {
                assert_eq!(fs::read(input).unwrap(), b"frozen selected source");
                frozen = Some(input.to_owned());
                crate::desktop_media_process::wait_failure_fixture(cancel)
            },
        );
        let failure = result
            .err()
            .expect("Injected exit acknowledgement should fail");
        assert_eq!(failure.code, "decoderStopUnknown");
        let finished = owner
            .finish(&operation, &operation_id, Err(failure))
            .unwrap();
        assert_eq!(finished["status"], "unknown");
        let input = frozen.expect("Actual frozen input was supplied to the decoder");
        assert_eq!(fs::read(&input).unwrap(), b"frozen selected source");
        assert_eq!(
            owner
                .request(
                    &scope,
                    MediaAction::CancelOperation {
                        operation_id: operation_id.clone()
                    },
                    &worker,
                    &staging,
                    &fixture.0
                )
                .unwrap()["status"],
            "unknown"
        );
        assert_eq!(
            owner
                .request(
                    &scope,
                    MediaAction::ReleaseOperation {
                        operation_id: operation_id.clone()
                    },
                    &worker,
                    &staging,
                    &fixture.0
                )
                .unwrap_err()
                .code,
            "unknown"
        );
        owner.stop_all();
        assert!(
            input.exists(),
            "Lifecycle stop must preserve uncertain process inputs"
        );
        worker.close().unwrap();
    }
    #[test]
    fn owned_cleanup_preserves_replaced_or_unknown_files() {
        let fixture = Fixture::new();
        let mut directory = OwnedDirectory::create(&fixture.0).unwrap();
        let root = directory.root.clone();
        let mut file = directory.file("source.bin").unwrap();
        file.write_all(b"owned").unwrap();
        drop(file);
        fs::rename(root.join("source.bin"), fixture.0.join("moved.bin")).unwrap();
        fs::write(root.join("source.bin"), b"foreign").unwrap();
        drop(directory);
        assert_eq!(fs::read(root.join("source.bin")).unwrap(), b"foreign");
    }
}
