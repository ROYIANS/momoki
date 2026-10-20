//! Immutable, bounded native credential revisions; no plaintext fallback.
//! Chunk writes precede the manifest. Receipt readback reconciles lost native
//! acknowledgements; publishing its reference in ProductStore is separate.
use super::{McpError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
const PAYLOAD: usize = 32 * 1024;
const RAW_CHUNK: usize = 1536;
const STORED: usize = 2048;
const CHUNKS: usize = 32;

pub(crate) trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn put(&self, key: &str, value: &[u8]) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}
pub(crate) struct NativeSecretStore {
    store: Arc<keyring_core::api::CredentialStore>,
}
impl NativeSecretStore {
    pub(crate) fn open() -> Result<Self> {
        #[cfg(target_os = "macos")]
        let store: Arc<keyring_core::api::CredentialStore> =
            apple_native_keyring_store::keychain::Store::new()
                .map_err(|_| McpError::VaultUnavailable)?;
        #[cfg(windows)]
        let store: Arc<keyring_core::api::CredentialStore> =
            windows_native_keyring_store::Store::new().map_err(|_| McpError::VaultUnavailable)?;
        #[cfg(not(any(target_os = "macos", windows)))]
        return Err(McpError::VaultUnavailable);
        #[cfg(any(target_os = "macos", windows))]
        Ok(Self { store })
    }
    fn entry(&self, key: &str) -> Result<keyring_core::Entry> {
        #[cfg(windows)]
        let modifiers = Some(HashMap::from([("persistence", "Local")]));
        #[cfg(not(windows))]
        let modifiers: Option<HashMap<&str, &str>> = None;
        self.store
            .build("dev.momoki.mcp.v1", key, modifiers.as_ref())
            .map_err(|_| McpError::VaultUnavailable)
    }
}
impl SecretStore for NativeSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self.entry(key)?.get_secret() {
            Ok(value) if value.len() <= STORED => Ok(Some(value)),
            Ok(_) => Err(McpError::VaultCorrupt),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(McpError::VaultUnavailable),
        }
    }
    fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        if value.len() > STORED {
            return Err(McpError::Limit);
        }
        self.entry(key)?
            .set_secret(value)
            .map_err(|_| McpError::VaultUnknown)
    }
    fn delete(&self, key: &str) -> Result<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(McpError::VaultUnknown),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RevisionReceipt {
    pub(crate) operation_id: String,
    pub(crate) revision_id: String,
    digest: String,
    byte_length: usize,
    chunks: usize,
}

pub(crate) struct CredentialVault {
    store: Arc<dyn SecretStore>,
    namespace: String,
    // The runtime owns one vault per app/profile/store/server. Every read/write/
    // refresh/cleanup goes through this same serialization boundary.
    serial: Mutex<()>,
    refresh: Arc<tokio::sync::Mutex<()>>,
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}
impl CredentialVault {
    pub(crate) fn new(
        store: Arc<dyn SecretStore>,
        app: &str,
        profile: &str,
        store_id: &str,
        server: &str,
    ) -> Result<Self> {
        if [app, profile, store_id, server]
            .iter()
            .any(|s| !valid_id(s))
        {
            return Err(McpError::VaultConflict);
        }
        let namespace = digest(
            &serde_json::to_vec(&[app, profile, store_id, server])
                .map_err(|_| McpError::VaultCorrupt)?,
        );
        Ok(Self {
            store,
            namespace,
            serial: Mutex::new(()),
            refresh: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
    /// Pass this guard to rmcp CredentialRefreshGuard::new in the Stage 2
    /// CredentialStore bridge. load/save must not reacquire this same guard.
    pub(crate) async fn acquire_refresh_guard(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.refresh.clone().lock_owned().await
    }
    fn key(&self, revision: &str, suffix: &str) -> String {
        format!("{}:{revision}:{suffix}", self.namespace)
    }
    fn manifest(&self, revision: &str) -> Result<Option<RevisionReceipt>> {
        if !valid_id(revision) {
            return Err(McpError::VaultConflict);
        }
        self.store
            .get(&self.key(revision, "manifest"))?
            .map(|bytes| {
                if bytes.len() > STORED {
                    return Err(McpError::VaultCorrupt);
                }
                let r: RevisionReceipt =
                    serde_json::from_slice(&bytes).map_err(|_| McpError::VaultCorrupt)?;
                if r.revision_id != revision
                    || !valid_id(&r.operation_id)
                    || r.byte_length > PAYLOAD
                    || r.chunks > CHUNKS
                    || r.chunks != r.byte_length.div_ceil(RAW_CHUNK)
                {
                    return Err(McpError::VaultCorrupt);
                }
                Ok(r)
            })
            .transpose()
    }
    fn read_unlocked(&self, revision: &str) -> Result<Option<(RevisionReceipt, Vec<u8>)>> {
        let Some(receipt) = self.manifest(revision)? else {
            return Ok(None);
        };
        let mut payload = Vec::with_capacity(receipt.byte_length);
        for i in 0..receipt.chunks {
            let encoded = self
                .store
                .get(&self.key(revision, &i.to_string()))?
                .ok_or(McpError::VaultCorrupt)?;
            if encoded.len() > STORED {
                return Err(McpError::VaultCorrupt);
            }
            let chunk = STANDARD
                .decode(encoded)
                .map_err(|_| McpError::VaultCorrupt)?;
            if chunk.len() > RAW_CHUNK || payload.len() + chunk.len() > receipt.byte_length {
                return Err(McpError::VaultCorrupt);
            }
            payload.extend_from_slice(&chunk);
        }
        if payload.len() != receipt.byte_length || digest(&payload) != receipt.digest {
            return Err(McpError::VaultCorrupt);
        }
        Ok(Some((receipt, payload)))
    }
    pub(crate) fn read(&self, revision: &str) -> Result<Option<(RevisionReceipt, Vec<u8>)>> {
        let _guard = self.serial.lock().map_err(|_| McpError::VaultUnavailable)?;
        self.read_unlocked(revision)
    }
    pub(crate) fn prepare(
        &self,
        operation: &str,
        revision: &str,
        payload: &[u8],
    ) -> Result<RevisionReceipt> {
        let _guard = self.serial.lock().map_err(|_| McpError::VaultUnavailable)?;
        if !valid_id(operation) || !valid_id(revision) || payload.len() > PAYLOAD {
            return Err(McpError::Limit);
        }
        let receipt = RevisionReceipt {
            operation_id: operation.to_owned(),
            revision_id: revision.to_owned(),
            digest: digest(payload),
            byte_length: payload.len(),
            chunks: payload.len().div_ceil(RAW_CHUNK),
        };
        if let Some((found, _)) = self.read_unlocked(revision)? {
            return if found == receipt {
                Ok(found)
            } else {
                Err(McpError::VaultConflict)
            };
        }
        let intent_key = self.key(revision, "intent");
        let intent = serde_json::to_vec(&receipt).map_err(|_| McpError::VaultCorrupt)?;
        if let Some(existing) = self.store.get(&intent_key)? {
            if existing != intent {
                return Err(McpError::VaultConflict);
            }
        } else {
            self.store.put(&intent_key, &intent)?;
        }
        for (index, chunk) in payload.chunks(RAW_CHUNK).enumerate() {
            let key = self.key(revision, &index.to_string());
            let bytes = STANDARD.encode(chunk).into_bytes();
            // A retry may finish its exact original candidate, never overwrite
            // different candidate bytes under an immutable revision.
            if let Some(existing) = self.store.get(&key)? {
                if existing != bytes {
                    return Err(McpError::VaultConflict);
                }
            } else {
                self.store.put(&key, &bytes)?;
            }
        }
        let bytes = serde_json::to_vec(&receipt).map_err(|_| McpError::VaultCorrupt)?;
        if bytes.len() > STORED {
            return Err(McpError::Limit);
        }
        self.store.put(&self.key(revision, "manifest"), &bytes)?;
        let Some((found, _)) = self.read_unlocked(revision)? else {
            return Err(McpError::VaultUnknown);
        };
        if found != receipt {
            return Err(McpError::VaultUnknown);
        }
        Ok(receipt)
    }
    /// Only after ProductStore confirms this exact revision is unreferenced.
    /// Unknown CAS outcomes never call this method.
    pub(crate) fn collect_unreferenced(
        &self,
        revision: &str,
        expected: &RevisionReceipt,
    ) -> Result<()> {
        let _guard = self.serial.lock().map_err(|_| McpError::VaultUnavailable)?;
        if expected.revision_id != revision || !valid_id(revision) || expected.chunks > CHUNKS {
            return Err(McpError::VaultConflict);
        }
        match self.manifest(revision)? {
            Some(found) if &found == expected => {}
            None => {
                // Manifest deletion is last. An absent manifest and absent
                // owned keys reconcile an already completed cleanup receipt.
                if self.store.get(&self.key(revision, "intent"))?.is_some() {
                    return Err(McpError::VaultConflict);
                }
                for i in 0..expected.chunks {
                    if self
                        .store
                        .get(&self.key(revision, &i.to_string()))?
                        .is_some()
                    {
                        return Err(McpError::VaultConflict);
                    }
                }
                return Ok(());
            }
            _ => return Err(McpError::VaultConflict),
        }
        for i in 0..expected.chunks {
            self.store.delete(&self.key(revision, &i.to_string()))?;
        }
        self.store.delete(&self.key(revision, "intent"))?;
        self.store.delete(&self.key(revision, "manifest"))?;
        Ok(())
    }
}

impl CredentialVault {
    /// Small native-vault pointer for OAuth rotation, scoped to one immutable
    /// private configuration. Token bytes remain in immutable vault chunks.
    pub(crate) fn read_slot_payload(&self, slot: &str) -> Result<Option<Vec<u8>>> {
        if !valid_id(slot) {
            return Err(McpError::VaultConflict);
        }
        let _guard = self.serial.lock().map_err(|_| McpError::VaultUnavailable)?;
        let Some(head) = self.store.get(&self.key(slot, "oauth-head"))? else {
            return Ok(None);
        };
        let revision = String::from_utf8(head).map_err(|_| McpError::VaultCorrupt)?;
        Ok(Some(
            self.read_unlocked(&revision)?
                .ok_or(McpError::VaultCorrupt)?
                .1,
        ))
    }
    pub(crate) fn read_slot(&self, slot: &str) -> Result<Option<String>> {
        if !valid_id(slot) {
            return Err(McpError::VaultConflict);
        }
        let _guard = self.serial.lock().map_err(|_| McpError::VaultUnavailable)?;
        self.store
            .get(&self.key(slot, "oauth-head"))?
            .map(|v| String::from_utf8(v).map_err(|_| McpError::VaultCorrupt))
            .transpose()
    }
    fn slot_garbage(&self, slot: &str) -> Result<Vec<String>> {
        let Some(bytes) = self.store.get(&self.key(slot, "oauth-garbage"))? else {
            return Ok(Vec::new());
        };
        let values: Vec<String> =
            serde_json::from_slice(&bytes).map_err(|_| McpError::VaultCorrupt)?;
        if values.len() > 32 || values.iter().any(|v| !valid_id(v)) {
            return Err(McpError::VaultCorrupt);
        }
        Ok(values)
    }
    fn write_garbage(&self, slot: &str, garbage: &[String]) -> Result<()> {
        let bytes = serde_json::to_vec(garbage).map_err(|_| McpError::VaultCorrupt)?;
        if bytes.len() > STORED {
            return Err(McpError::Limit);
        }
        let result = self.store.put(&self.key(slot, "oauth-garbage"), &bytes);
        if self.store.get(&self.key(slot, "oauth-garbage"))?.as_deref() != Some(bytes.as_slice()) {
            return result.and(Err(McpError::VaultUnknown));
        }
        Ok(())
    }
    fn collect_slot_garbage(
        &self,
        slot: &str,
        current: Option<&str>,
        garbage: &[String],
    ) -> Result<()> {
        for revision in garbage {
            if Some(revision.as_str()) == current {
                return Err(McpError::VaultConflict);
            }
            if let Some(receipt) = self.manifest(revision)? {
                for i in 0..receipt.chunks {
                    self.store.delete(&self.key(revision, &i.to_string()))?;
                }
                self.store.delete(&self.key(revision, "intent"))?;
                self.store.delete(&self.key(revision, "manifest"))?;
            }
        }
        self.write_garbage(slot, &[])
    }
    pub(crate) fn publish_slot(&self, slot: &str, revision: &str) -> Result<()> {
        if !valid_id(slot) || !valid_id(revision) {
            return Err(McpError::VaultConflict);
        }
        let _guard = self.serial.lock().map_err(|_| McpError::VaultUnavailable)?;
        self.read_unlocked(revision)?
            .ok_or(McpError::VaultUnknown)?;
        let old = self
            .store
            .get(&self.key(slot, "oauth-head"))?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| McpError::VaultCorrupt)?;
        let mut garbage = self.slot_garbage(slot)?;
        if let Some(old) = old.filter(|v| v != revision) {
            if !garbage.contains(&old) {
                if garbage.len() >= 32 {
                    return Err(McpError::Limit);
                }
                garbage.push(old)
            }
        }
        self.write_garbage(slot, &garbage)?;
        let write = self
            .store
            .put(&self.key(slot, "oauth-head"), revision.as_bytes());
        if self.store.get(&self.key(slot, "oauth-head"))?.as_deref() != Some(revision.as_bytes()) {
            return write.and(Err(McpError::VaultUnknown));
        }
        self.collect_slot_garbage(slot, Some(revision), &garbage)
    }
    pub(crate) fn clear_slot(&self, slot: &str) -> Result<()> {
        if !valid_id(slot) {
            return Err(McpError::VaultConflict);
        }
        let _guard = self.serial.lock().map_err(|_| McpError::VaultUnavailable)?;
        let mut garbage = self.slot_garbage(slot)?;
        if let Some(bytes) = self.store.get(&self.key(slot, "oauth-head"))? {
            let old = String::from_utf8(bytes).map_err(|_| McpError::VaultCorrupt)?;
            if !garbage.contains(&old) {
                if garbage.len() >= 32 {
                    return Err(McpError::Limit);
                }
                garbage.push(old)
            }
        }
        self.write_garbage(slot, &garbage)?;
        let delete = self.store.delete(&self.key(slot, "oauth-head"));
        if self.store.get(&self.key(slot, "oauth-head"))?.is_some() {
            return delete.and(Err(McpError::VaultUnknown));
        }
        self.collect_slot_garbage(slot, None, &garbage)?;
        self.store.delete(&self.key(slot, "oauth-garbage"))
    }
}
