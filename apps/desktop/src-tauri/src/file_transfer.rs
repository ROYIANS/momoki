//! Independent product exports. The only path comes from a native Save dialog.
use crate::{Error, Result, paths};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(crate) const SAVE_CHUNK: usize = 262_144;
const MAX_TRANSFERS: usize = 2;
const IDLE: Duration = Duration::from_secs(120);
const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SaveBegin {
    pub version: u32,
    pub operation_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub content_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SaveReceipt {
    Canceled,
    Ready {
        session: String,
        chunk_bytes: usize,
    },
    Saved {
        byte_length: u64,
        content_hash: String,
    },
    // Publication is irrevocable even if directory sync/temporary unlink fails.
    PublishedWithError {
        byte_length: u64,
        content_hash: String,
        code: &'static str,
    },
}

struct Staged {
    file: Option<File>,
    stage: PathBuf,
    destination: PathBuf,
    parent: PathBuf,
    parent_identity: (u64, u64),
    stage_identity: (u64, u64),
    published: bool,
    #[cfg(windows)]
    _directory_guards: Vec<paths::DirectoryGuard>,
    declared_length: u64,
    declared_hash: Option<String>,
    written: u64,
    hash: Sha256,
    progressed: Instant,
}
impl Staged {
    fn check_identity(&self, links: u64) -> Result<()> {
        let parent = paths::ordinary_directory(&self.parent)?.identity();
        let named = paths::ordinary(&self.stage, links)?;
        let identity = named.identity();
        if (parent.0, parent.1) != self.parent_identity
            || (identity.0, identity.1) != self.stage_identity
            || named.len() != self.written
        {
            return Err(Error::new(
                "changed",
                "Export stage or directory identity changed",
            ));
        }
        if let Some(file) = &self.file {
            let opened = paths::stat_file(file)?;
            if opened.identity() != identity || opened.len() != self.written {
                return Err(Error::new(
                    "changed",
                    "Export stage handle identity changed",
                ));
            }
        }
        Ok(())
    }
}
impl Drop for Staged {
    fn drop(&mut self) {
        // A replaced stage/parent or unowned hard link is not ours to erase.
        let proven = if self.published {
            self.check_identity(2).is_ok()
                && paths::ordinary(&self.destination, 2)
                    .is_ok_and(|stat| (stat.identity().0, stat.identity().1) == self.stage_identity)
        } else {
            self.check_identity(1).is_ok()
        };
        self.file.take();
        if proven {
            let _ = fs::remove_file(&self.stage);
        }
    }
}
enum Phase {
    Dialog,
    Staged(Box<Staged>),
    Closed,
}
pub(crate) struct Transfer {
    canceled: AtomicBool,
    phase: Mutex<Phase>,
}
#[derive(Default)]
pub(crate) struct Saves {
    transfers: Mutex<HashMap<String, Arc<Transfer>>>,
    gate: Option<Arc<AtomicBool>>,
}

fn invalid(message: &'static str) -> Error {
    Error::new("save", message)
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn validate_begin(request: &SaveBegin) -> Result<()> {
    if request.version != 1
        || uuid::Uuid::parse_str(&request.operation_id).is_err()
        || request.byte_length > JS_SAFE_INTEGER
        || request.file_name.is_empty()
        || request.file_name.len() > 240
        || request
            .file_name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        || matches!(request.file_name.as_str(), "." | "..")
        || request.mime_type.len() > 256
        || request.mime_type.chars().any(char::is_control)
        || request
            .content_hash
            .as_deref()
            .is_some_and(|hash| !valid_hash(hash))
    {
        return Err(invalid("Invalid export metadata"));
    }
    Ok(())
}
impl Saves {
    pub(crate) fn with_gate(gate: Arc<AtomicBool>) -> Self {
        Self {
            transfers: Mutex::new(HashMap::new()),
            gate: Some(gate),
        }
    }
    pub(crate) fn reserve(&self, request: &SaveBegin) -> Result<Arc<Transfer>> {
        validate_begin(request)?;
        self.reap();
        let mut entries = self
            .transfers
            .lock()
            .map_err(|_| invalid("Export state poisoned"))?;
        if self
            .gate
            .as_ref()
            .is_some_and(|gate| !gate.load(Ordering::SeqCst))
        {
            return Err(Error::new("closing", "Application is shutting down"));
        }
        if entries.len() >= MAX_TRANSFERS || entries.contains_key(&request.operation_id) {
            return Err(invalid("Duplicate or excessive active exports"));
        }
        let transfer = Arc::new(Transfer {
            canceled: AtomicBool::new(false),
            phase: Mutex::new(Phase::Dialog),
        });
        entries.insert(request.operation_id.clone(), transfer.clone());
        Ok(transfer)
    }
    pub(crate) fn select(
        &self,
        request: &SaveBegin,
        transfer: &Transfer,
        path: Option<&Path>,
    ) -> Result<SaveReceipt> {
        let mut phase = transfer
            .phase
            .lock()
            .map_err(|_| invalid("Export phase poisoned"))?;
        if !matches!(*phase, Phase::Dialog)
            || transfer.canceled.load(Ordering::Acquire)
            || path.is_none()
        {
            *phase = Phase::Closed;
            self.remove(&request.operation_id);
            return Ok(SaveReceipt::Canceled);
        }
        let staged = stage(path.expect("selected path"), request);
        match staged {
            Ok(staged) => {
                *phase = Phase::Staged(Box::new(staged));
                Ok(SaveReceipt::Ready {
                    session: request.operation_id.clone(),
                    chunk_bytes: SAVE_CHUNK,
                })
            }
            Err(error) => {
                *phase = Phase::Closed;
                self.remove(&request.operation_id);
                Err(error)
            }
        }
    }
    fn get(&self, session: &str) -> Result<Arc<Transfer>> {
        self.reap();
        self.transfers
            .lock()
            .map_err(|_| invalid("Export state poisoned"))?
            .get(session)
            .cloned()
            .ok_or_else(|| invalid("Export is closed or expired"))
    }
    fn remove(&self, session: &str) {
        if let Ok(mut entries) = self.transfers.lock() {
            entries.remove(session);
        }
    }
    pub(crate) fn chunk(&self, session: &str, offset: u64, bytes: &[u8]) -> Result<u64> {
        if bytes.is_empty() || bytes.len() > SAVE_CHUNK {
            return Err(invalid("Export chunk boundary"));
        }
        let transfer = self.get(session)?;
        let mut phase = transfer
            .phase
            .lock()
            .map_err(|_| invalid("Export phase poisoned"))?;
        let Phase::Staged(staged) = &mut *phase else {
            return Err(invalid("Export is not writable"));
        };
        if transfer.canceled.load(Ordering::Acquire) {
            return Err(invalid("Export canceled"));
        }
        if offset != staged.written
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > staged.declared_length)
        {
            return Err(invalid("Export chunk order or length mismatch"));
        }
        // No retries: failed writes close this transfer; a partially written chunk cannot be reissued.
        let result = (|| -> Result<()> {
            staged.check_identity(1)?;
            staged
                .file
                .as_mut()
                .expect("staged file")
                .write_all(bytes)?;
            staged.written += bytes.len() as u64;
            staged.check_identity(1)
        })();
        if let Err(error) = result {
            *phase = Phase::Closed;
            self.remove(session);
            return Err(error);
        }
        staged.hash.update(bytes);
        staged.progressed = Instant::now();
        Ok(staged.written)
    }
    pub(crate) fn finish(&self, session: &str, expected_hash: &str) -> Result<SaveReceipt> {
        self.finish_with(session, expected_hash, |parent| {
            paths::namespace_checkpoint(parent)?;
            Ok(())
        })
    }
    fn finish_with(
        &self,
        session: &str,
        expected_hash: &str,
        sync: impl Fn(&Path) -> Result<()>,
    ) -> Result<SaveReceipt> {
        self.finish_with_flush(session, expected_hash, sync, paths::flush_published_file)
    }
    fn finish_with_flush(
        &self,
        session: &str,
        expected_hash: &str,
        sync: impl Fn(&Path) -> Result<()>,
        flush_file: impl Fn(&Path, (u64, u64), u64, u64) -> Result<()>,
    ) -> Result<SaveReceipt> {
        if !valid_hash(expected_hash) {
            return Err(invalid("Export checksum boundary"));
        }
        let transfer = self.get(session)?;
        let mut phase = transfer
            .phase
            .lock()
            .map_err(|_| invalid("Export phase poisoned"))?;
        let previous = std::mem::replace(&mut *phase, Phase::Closed);
        let Phase::Staged(mut staged) = previous else {
            return Err(invalid("Export is not finishable"));
        };
        let result = (|| {
            if transfer.canceled.load(Ordering::Acquire) {
                return Ok(SaveReceipt::Canceled);
            }
            let hash = paths::hex_digest(staged.hash.clone().finalize());
            if staged.written != staged.declared_length
                || hash != expected_hash
                || staged
                    .declared_hash
                    .as_ref()
                    .is_some_and(|declared| *declared != hash)
            {
                return Err(invalid("Export length or checksum mismatch"));
            }
            staged.check_identity(1)?;
            staged.file.as_mut().expect("staged file").sync_all()?;
            if transfer.canceled.load(Ordering::Acquire) {
                return Ok(SaveReceipt::Canceled);
            }
            fs::hard_link(&staged.stage, &staged.destination)?;
            staged.published = true;
            // The destination now exists. No later abort/error may report rollback.
            let receipt = |code| SaveReceipt::PublishedWithError {
                byte_length: staged.written,
                content_hash: hash.clone(),
                code,
            };
            if flush_file(
                &staged.destination,
                staged.stage_identity,
                staged.written,
                2,
            )
            .is_err()
            {
                return Ok(receipt("fileSync"));
            }
            if sync(&staged.parent).is_err() {
                return Ok(receipt("directorySync"));
            }
            // Namespace confirmation may yield while another process changes
            // a name. Never erase a replacement or an additionally linked stage.
            let cleanup_authority = (|| -> Result<()> {
                staged.check_identity(2)?;
                let destination = paths::ordinary(&staged.destination, 2)?;
                let identity = destination.identity();
                if (identity.0, identity.1) != staged.stage_identity
                    || destination.len() != staged.written
                {
                    return Err(Error::new("changed", "Published export identity changed"));
                }
                Ok(())
            })();
            if cleanup_authority.is_err() {
                return Ok(receipt("stageCleanup"));
            }
            staged.file.take();
            if fs::remove_file(&staged.stage).is_err() {
                return Ok(receipt("stageCleanup"));
            }
            if sync(&staged.parent).is_err() {
                return Ok(receipt("directorySync"));
            }
            Ok(SaveReceipt::Saved {
                byte_length: staged.written,
                content_hash: hash,
            })
        })();
        self.remove(session);
        result
    }
    pub(crate) fn cancel(&self, session: &str) -> bool {
        let transfer = self
            .transfers
            .lock()
            .ok()
            .and_then(|entries| entries.get(session).cloned());
        let Some(transfer) = transfer else {
            return false;
        };
        // Bypass active I/O locks to make cancellation observable before publication.
        transfer.canceled.store(true, Ordering::Release);
        if let Ok(mut phase) = transfer.phase.lock() {
            *phase = Phase::Closed;
        }
        self.remove(session);
        true
    }
    pub(crate) fn close(&self) {
        let entries = self
            .transfers
            .lock()
            .map(|entries| entries.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for session in entries {
            self.cancel(&session);
        }
    }
    pub(crate) fn reap(&self) {
        let entries = self
            .transfers
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .map(|(id, transfer)| (id.clone(), transfer.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (id, transfer) in entries {
            let expired = transfer.phase.try_lock().is_ok_and(|phase| matches!(&*phase, Phase::Staged(staged) if staged.progressed.elapsed() >= IDLE));
            if expired {
                self.cancel(&id);
            }
        }
    }
}
fn stage(path: &Path, request: &SaveBegin) -> Result<Staged> {
    if !path.is_absolute() || fs::symlink_metadata(path).is_ok() {
        return Err(Error::new("exists", "Export requires a fresh destination"));
    }
    let parent = paths::canonical_root(
        path.parent()
            .ok_or_else(|| invalid("Missing export directory"))?,
    )?;
    let destination = parent.join(
        path.file_name()
            .ok_or_else(|| invalid("Missing export name"))?,
    );
    #[cfg(windows)]
    let directory_guards = paths::pin_ancestors(&parent)?;
    let parent_stat = paths::ordinary_directory(&parent)?.identity();
    let stage = parent.join(format!(".momoki-export-{}.tmp", uuid::Uuid::new_v4()));
    let file = paths::exclusive(&stage)?;
    let stage_stat = paths::stat_file(&file)?.identity();
    Ok(Staged {
        file: Some(file),
        stage,
        destination,
        parent,
        parent_identity: (parent_stat.0, parent_stat.1),
        stage_identity: (stage_stat.0, stage_stat.1),
        published: false,
        #[cfg(windows)]
        _directory_guards: directory_guards,
        declared_length: request.byte_length,
        declared_hash: request.content_hash.clone(),
        written: 0,
        hash: Sha256::new(),
        progressed: Instant::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(length: u64) -> (Saves, SaveBegin, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("momoki-product-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let request = SaveBegin {
            version: 1,
            operation_id: uuid::Uuid::new_v4().to_string(),
            file_name: "product.zip".into(),
            mime_type: "application/zip".into(),
            byte_length: length,
            content_hash: None,
        };
        (Saves::default(), request, root)
    }
    fn start(saves: &Saves, request: &SaveBegin, path: &Path) {
        let transfer = saves.reserve(request).unwrap();
        assert!(matches!(
            saves.select(request, &transfer, Some(path)).unwrap(),
            SaveReceipt::Ready { .. }
        ));
    }
    #[test]
    fn replaced_or_aliased_stage_is_never_written_published_or_unlinked() {
        for alias in [false, true] {
            let (saves, request, root) = setup(1);
            let destination = root.join("out");
            start(&saves, &request, &destination);
            let transfer = saves.get(&request.operation_id).unwrap();
            let stage = match &*transfer.phase.lock().unwrap() {
                Phase::Staged(staged) => staged.stage.clone(),
                _ => panic!("staged export"),
            };
            if alias {
                fs::hard_link(&stage, root.join("external.bin")).unwrap();
            } else {
                fs::remove_file(&stage).unwrap();
                fs::write(&stage, b"external bytes").unwrap();
            }
            let before = fs::read(&stage).unwrap();
            assert!(saves.chunk(&request.operation_id, 0, b"a").is_err());
            assert!(!destination.exists());
            assert_eq!(
                fs::read(&stage).unwrap(),
                before,
                "unproven stage was modified or erased"
            );
            assert!(!saves.cancel(&request.operation_id));
            drop(transfer);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn active_export_directory_cannot_move_until_transfer_is_closed() {
        let (saves, request, root) = setup(1);
        let moved = root.with_extension("moved");
        start(&saves, &request, &root.join("out"));
        assert!(
            fs::rename(&root, &moved).is_err(),
            "active export directory was moved"
        );
        saves.cancel(&request.operation_id);
        fs::rename(&root, &moved).unwrap();
        fs::remove_dir_all(moved).unwrap();
    }

    #[test]
    fn zero_and_large_exports_keep_byte_identity_without_sqlite() {
        for length in [0, 33 * 1024 * 1024 + 1] {
            let (saves, request, root) = setup(length);
            let path = root.join("product.zip");
            start(&saves, &request, &path);
            let chunk = vec![71; SAVE_CHUNK];
            let mut offset = 0;
            let mut hash = Sha256::new();
            while offset < length {
                let n = SAVE_CHUNK.min((length - offset) as usize);
                saves
                    .chunk(&request.operation_id, offset, &chunk[..n])
                    .unwrap();
                hash.update(&chunk[..n]);
                offset += n as u64;
            }
            let hash = paths::hex_digest(hash.finalize());
            assert_eq!(
                saves.finish(&request.operation_id, &hash).unwrap(),
                SaveReceipt::Saved {
                    byte_length: length,
                    content_hash: hash.clone()
                }
            );
            assert_eq!(fs::metadata(&path).unwrap().len(), length);
            assert_eq!(
                paths::hex_digest(Sha256::digest(fs::read(&path).unwrap())),
                hash
            );
            assert!(!saves.cancel(&request.operation_id));
            assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn cancel_bounds_order_and_failed_hash_never_publish() {
        let (saves, request, root) = setup(3);
        start(&saves, &request, &root.join("out"));
        assert!(saves.chunk(&request.operation_id, 1, b"abc").is_err());
        assert!(
            saves
                .chunk(&request.operation_id, 0, &vec![0; SAVE_CHUNK + 1])
                .is_err()
        );
        saves.chunk(&request.operation_id, 0, b"abc").unwrap();
        assert!(
            saves
                .finish(&request.operation_id, &"0".repeat(64))
                .is_err()
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        start(&saves, &request, &root.join("out"));
        saves.chunk(&request.operation_id, 0, b"a").unwrap();
        assert!(saves.cancel(&request.operation_id));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn dialogs_are_bounded_and_do_not_idle_expire() {
        let (saves, request, root) = setup(1);
        let transfer = saves.reserve(&request).unwrap();
        let (_, mut request2, root2) = setup(0);
        saves.reserve(&request2).unwrap();
        request2.operation_id = uuid::Uuid::new_v4().to_string();
        assert!(saves.reserve(&request2).is_err());
        saves.reap();
        assert_eq!(saves.transfers.lock().unwrap().len(), 2);
        assert_eq!(
            saves.select(&request, &transfer, None).unwrap(),
            SaveReceipt::Canceled
        );
        assert_eq!(saves.transfers.lock().unwrap().len(), 1);
        saves.close();
        assert!(saves.transfers.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(root2).unwrap();
    }
    #[test]
    fn existing_or_raced_destinations_are_preserved() {
        for bytes in [b"".as_slice(), b"keep".as_slice()] {
            let (saves, request, root) = setup(1);
            let destination = root.join("out");
            fs::write(&destination, bytes).unwrap();
            let transfer = saves.reserve(&request).unwrap();
            assert!(
                saves
                    .select(&request, &transfer, Some(&destination))
                    .is_err()
            );
            assert_eq!(fs::read(&destination).unwrap(), bytes);
            fs::remove_file(&destination).unwrap();
            start(&saves, &request, &destination);
            saves.chunk(&request.operation_id, 0, b"a").unwrap();
            fs::write(&destination, bytes).unwrap();
            assert!(
                saves
                    .finish(
                        &request.operation_id,
                        &paths::hex_digest(Sha256::digest(b"a"))
                    )
                    .is_err()
            );
            assert_eq!(fs::read(&destination).unwrap(), bytes);
            assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn changed_stage_after_publication_is_preserved_as_a_saved_file_warning() {
        for alias in [false, true] {
            let (saves, request, root) = setup(1);
            let destination = root.join("out");
            start(&saves, &request, &destination);
            saves.chunk(&request.operation_id, 0, b"a").unwrap();
            let transfer = saves.get(&request.operation_id).unwrap();
            let stage = match &*transfer.phase.lock().unwrap() {
                Phase::Staged(staged) => staged.stage.clone(),
                _ => panic!("staged export"),
            };
            let reached = std::cell::Cell::new(false);
            let receipt = saves
                .finish_with(
                    &request.operation_id,
                    &paths::hex_digest(Sha256::digest(b"a")),
                    |_| {
                        if !reached.replace(true) {
                            assert_eq!(fs::read(&destination).unwrap(), b"a");
                            if alias {
                                fs::hard_link(&stage, root.join("external.bin"))?;
                            } else {
                                fs::remove_file(&stage)?;
                                fs::write(&stage, b"foreign stage bytes")?;
                            }
                        }
                        Ok(())
                    },
                )
                .unwrap();
            assert!(reached.get());
            assert!(matches!(
                receipt,
                SaveReceipt::PublishedWithError {
                    code: "stageCleanup",
                    ..
                }
            ));
            assert_eq!(fs::read(&destination).unwrap(), b"a");
            assert_eq!(
                fs::read(&stage).unwrap(),
                if alias {
                    &b"a"[..]
                } else {
                    &b"foreign stage bytes"[..]
                }
            );
            if alias {
                assert_eq!(fs::read(root.join("external.bin")).unwrap(), b"a");
            }
            assert!(!saves.cancel(&request.operation_id));
            drop(transfer);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn final_file_flush_failure_is_reached_after_publication_and_never_retried() {
        let (saves, request, root) = setup(1);
        let destination = root.join("out");
        start(&saves, &request, &destination);
        saves.chunk(&request.operation_id, 0, b"a").unwrap();
        let reached = std::cell::Cell::new(false);
        let receipt = saves
            .finish_with_flush(
                &request.operation_id,
                &paths::hex_digest(Sha256::digest(b"a")),
                |_| Ok(()),
                |path, identity, length, links| {
                    assert!(path.exists(), "failure hook ran before actual publication");
                    assert_eq!(path, fs::canonicalize(&destination).unwrap());
                    assert_eq!(links, 2);
                    paths::flush_published_file(path, identity, length, links)?;
                    reached.set(true);
                    Err(invalid("injected final file flush failure"))
                },
            )
            .unwrap();
        assert!(reached.get());
        assert!(matches!(
            receipt,
            SaveReceipt::PublishedWithError {
                code: "fileSync",
                byte_length: 1,
                ..
            }
        ));
        assert_eq!(fs::read(&destination).unwrap(), b"a");
        assert!(!saves.cancel(&request.operation_id));
        assert!(
            saves
                .finish(
                    &request.operation_id,
                    &paths::hex_digest(Sha256::digest(b"a"))
                )
                .is_err()
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_failure_is_truthful_and_abandonment_cleans_stages() {
        let (saves, request, root) = setup(1);
        let path = root.join("out");
        start(&saves, &request, &path);
        saves.chunk(&request.operation_id, 0, b"a").unwrap();
        let receipt = saves
            .finish_with(
                &request.operation_id,
                &paths::hex_digest(Sha256::digest(b"a")),
                |_| Err(invalid("injected fsync failure")),
            )
            .unwrap();
        assert!(matches!(
            receipt,
            SaveReceipt::PublishedWithError {
                code: "directorySync",
                ..
            }
        ));
        assert_eq!(fs::read(&path).unwrap(), b"a");
        assert!(!saves.cancel(&request.operation_id));
        let (_, request2, root2) = setup(1);
        start(&saves, &request2, &root.join("next"));
        let transfer = saves.get(&request2.operation_id).unwrap();
        if let Phase::Staged(staged) = &mut *transfer.phase.lock().unwrap() {
            staged.progressed = Instant::now() - IDLE;
        }
        saves.reap();
        assert!(saves.chunk(&request2.operation_id, 0, b"a").is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(root2).unwrap();
    }
}
