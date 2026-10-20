//! Small trusted system seams; product records remain in the renderer's one store.
use crate::{
    Error, Result,
    desktop::trusted,
    file_transfer::{SAVE_CHUNK, SaveBegin, SaveReceipt, Saves},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tauri::{Manager, WebviewWindow, ipc::CapabilityBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// The native owner chooses this directory; no renderer value selects a path.
#[cfg(any(not(target_os = "macos"), test))]
pub(crate) fn webview_profile_directory(
    app_data: &std::path::Path,
    store: [u8; 16],
) -> Result<std::path::PathBuf> {
    std::fs::create_dir_all(app_data)?;
    let root = crate::paths::canonical_root(app_data)?;
    let profiles = root.join("webview-profiles-v1");
    let selected = profiles.join(crate::paths::hex_digest(store));
    for directory in [&profiles, &selected] {
        match std::fs::create_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        crate::paths::ordinary_directory(directory)?;
    }
    Ok(selected)
}

#[derive(Default)]
pub(crate) struct RuntimeServices {
    origins: Mutex<HashSet<String>>,
    pub saves: Saves,
}
impl RuntimeServices {
    pub(crate) fn with_gate(gate: Arc<std::sync::atomic::AtomicBool>) -> Self {
        Self {
            origins: Mutex::new(HashSet::new()),
            saves: Saves::with_gate(gate),
        }
    }
}
#[derive(Serialize)]
pub(crate) struct AuthorizedOrigin {
    origin: String,
}

pub(crate) fn validated_origin(origin: &str, allow_http: bool) -> Result<String> {
    let url = tauri::Url::parse(origin).map_err(|_| Error::new("origin", "Invalid HTTP origin"))?;
    if origin.len() > 2048
        || !matches!(url.scheme(), "http" | "https")
        || (url.scheme() == "http" && !allow_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.host_str().is_some_and(|host| {
            !host.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'[' | b']' | b':')
            })
        })
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
        || origin.chars().any(char::is_control)
    {
        return Err(Error::new(
            "origin",
            "Expected a configured exact HTTP origin",
        ));
    }
    let normalized = url.origin().ascii_serialization();
    // Only canonical URL.origin values are accepted. No authored scope/glob syntax.
    if origin != normalized {
        return Err(Error::new("origin", "Origin must be canonical"));
    }
    Ok(normalized)
}

// HTTP scopes use URLPattern syntax. IPv6 brackets/colon and host punctuation
// are escaped as literal components rather than interpolated patterns.
fn escaped_component(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| {
            if matches!(ch, '*' | '+' | '?' | ':' | '(' | ')' | '{' | '}' | '\\') {
                vec!['\\', ch]
            } else {
                vec![ch]
            }
        })
        .collect()
}
pub(crate) fn origin_scope(origin: &str) -> Result<String> {
    let url = tauri::Url::parse(origin).map_err(|_| Error::new("origin", "Invalid origin"))?;
    let host = escaped_component(
        url.host_str()
            .ok_or_else(|| Error::new("origin", "Missing host"))?,
    );
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(format!("{}://{host}{port}/*", url.scheme()))
}

#[tauri::command]
pub(crate) fn authorize_http_origin(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<RuntimeServices>>,
    origin: String,
    allow_http: bool,
) -> Result<AuthorizedOrigin> {
    trusted(&window)?;
    let origin = validated_origin(&origin, allow_http)?;
    let mut origins = state
        .origins
        .lock()
        .map_err(|_| Error::new("origin", "Origin state poisoned"))?;
    if !origins.contains(&origin) {
        if origins.len() >= 128 {
            return Err(Error::new(
                "origin",
                "Restart the app before registering more HTTP origins",
            ));
        }
        let scope = serde_json::json!({"url": origin_scope(&origin)?});
        let capability = CapabilityBuilder::new(format!("product-http-origin-{}", origins.len()))
            .window("main")
            .permission_scoped("http:default", vec![scope], Vec::<serde_json::Value>::new());
        window
            .add_capability(capability)
            .map_err(|_| Error::new("origin", "Could not grant HTTP origin"))?;
        origins.insert(origin.clone());
    }
    Ok(AuthorizedOrigin { origin })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SaveChunk {
    version: u32,
    session: String,
    offset: u64,
    bytes: ChunkBytes,
}
struct ChunkBytes(Vec<u8>);
impl<'de> Deserialize<'de> for ChunkBytes {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = ChunkBytes;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("at most 262144 export bytes")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(SAVE_CHUNK));
                while let Some(byte) = seq.next_element::<u8>()? {
                    if bytes.len() >= SAVE_CHUNK {
                        return Err(serde::de::Error::custom("Export chunk boundary"));
                    }
                    bytes.push(byte);
                }
                Ok(ChunkBytes(bytes))
            }
        }
        deserializer.deserialize_seq(Visitor)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SaveFinish {
    version: u32,
    session: String,
    content_hash: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SaveCancel {
    version: u32,
    session: String,
}
fn envelope(version: u32, session: &str) -> Result<()> {
    if version != 1 || uuid::Uuid::parse_str(session).is_err() {
        return Err(Error::new("save", "Invalid export envelope"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn product_save_begin(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<RuntimeServices>>,
    request: SaveBegin,
) -> Result<SaveReceipt> {
    trusted(&window)?;
    let transfer = state.saves.reserve(&request)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = window
            .dialog()
            .file()
            .set_title("保存文件")
            .set_file_name(&request.file_name)
            .blocking_save_file();
        let path = selected
            .map(|selection| selection.into_path())
            .transpose()
            .map_err(|_| Error::new("dialog", "Save dialog returned an invalid path"));
        match path {
            Ok(path) => state.saves.select(&request, &transfer, path.as_deref()),
            Err(error) => {
                state.saves.cancel(&request.operation_id);
                Err(error)
            }
        }
    })
    .await
    .map_err(|_| Error::new("save", "Save dialog failed"))?
}
#[tauri::command]
pub(crate) async fn product_save_chunk(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<RuntimeServices>>,
    request: SaveChunk,
) -> Result<u64> {
    trusted(&window)?;
    envelope(request.version, &request.session)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .saves
            .chunk(&request.session, request.offset, &request.bytes.0)
    })
    .await
    .map_err(|_| Error::new("save", "Export write failed"))?
}
#[tauri::command]
pub(crate) async fn product_save_finish(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<RuntimeServices>>,
    request: SaveFinish,
) -> Result<SaveReceipt> {
    trusted(&window)?;
    envelope(request.version, &request.session)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.saves.finish(&request.session, &request.content_hash)
    })
    .await
    .map_err(|_| Error::new("save", "Export finish failed"))?
}
#[tauri::command]
pub(crate) fn product_save_cancel(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<RuntimeServices>>,
    request: SaveCancel,
) -> Result<bool> {
    trusted(&window)?;
    envelope(request.version, &request.session)?;
    Ok(state.saves.cancel(&request.session))
}

#[tauri::command]
pub(crate) async fn product_print_storyboard(window: WebviewWindow) -> Result<()> {
    trusted(&window)?;
    window
        .state::<Arc<crate::desktop_lifecycle::Lifecycle>>()
        .admit_effect()?;
    crate::native_print::open_storyboard(window).await
}

#[tauri::command]
pub(crate) fn product_open_external(window: WebviewWindow, url: String) -> Result<()> {
    trusted(&window)?;
    window
        .state::<Arc<crate::desktop_lifecycle::Lifecycle>>()
        .admit_effect()?;
    let parsed =
        tauri::Url::parse(&url).map_err(|_| Error::new("external", "Invalid external URL"))?;
    if url.len() > 8192
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.chars().any(char::is_control)
    {
        return Err(Error::new(
            "external",
            "Only HTTP(S) external URLs can be opened",
        ));
    }
    window
        .opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| Error::new("external", "System browser could not open the link"))
}

/// Presentation-only startup state. Never combine chrome with persistence identity.
pub(crate) fn window_chrome_script() -> String {
    let kind = if cfg!(target_os = "macos") {
        "macos-overlay"
    } else {
        "native"
    };
    let config = serde_json::json!({"version": 1, "kind": kind});
    format!(
        "Object.defineProperty(window,'__MOMOKI_WINDOW_CHROME__',{{value:Object.freeze({config}),writable:false,configurable:false}});"
    )
}

pub(crate) fn profile(identifier: &str, sqlite: bool) -> Result<(String, [u8; 16])> {
    if identifier.is_empty()
        || identifier.len() > 160
        || !identifier.as_bytes()[0].is_ascii_alphanumeric()
        || !identifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(Error::new("profile", "Invalid product profile identifier"));
    }
    let storage = if sqlite { "sqlite" } else { "indexeddb" };
    let digest = Sha256::digest(format!(
        "momoki-product-profile-v1:{identifier}:{storage}"
    ));
    let mut store = [0; 16];
    store.copy_from_slice(&digest[..16]);
    let config = serde_json::json!({"version": 1, "id": identifier, "storage": storage});
    let script = format!(
        "Object.defineProperty(window,'__MOMOKI_PRODUCT_PROFILE__',{{value:Object.freeze({config}),writable:false,configurable:false}});"
    );
    Ok((script, store))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_origins_reject_scope_injection_and_unconfigured_http() {
        for origin in [
            "https://api.example.test",
            "https://api.example.test:8443",
            "http://127.0.0.1:3333",
            "http://[::1]:3333",
        ] {
            assert_eq!(validated_origin(origin, true).unwrap(), origin);
        }
        for origin in [
            "https://*.test",
            "https://host/path",
            "https://host?key=secret",
            "https://user:pass@host",
            "file:///tmp/x",
            "https://host#x",
            "https://host/",
            "https://{host}",
            "http://localhost",
        ] {
            assert!(validated_origin(origin, false).is_err(), "{origin}");
        }
        assert_eq!(
            origin_scope("https://api.example.test:8443").unwrap(),
            "https://api.example.test:8443/*"
        );
        assert_eq!(
            origin_scope("http://[::1]:3333").unwrap(),
            "http://[\\:\\:1]:3333/*"
        );
    }
    #[test]
    fn profiles_are_stable_isolated_and_explicit() {
        let normal = profile("design.tulai.momoki", false).unwrap();
        assert_eq!(
            normal,
            profile("design.tulai.momoki", false).unwrap()
        );
        assert_ne!(
            normal.1,
            profile("dev.momoki.prototype.review", false).unwrap().1
        );
        assert_ne!(
            normal.1,
            profile("design.tulai.momoki", true).unwrap().1
        );
        assert!(normal.0.contains("indexeddb"));
        assert!(normal.0.contains("Object.freeze"));
        assert!(profile("evil';global()", false).is_err());
    }
    #[test]
    fn webview_directories_are_fixed_isolated_and_ordinary() {
        let root = std::env::temp_dir().join(format!("momoki-webview-{}", uuid::Uuid::new_v4()));
        let normal = profile("design.tulai.momoki", true).unwrap().1;
        let review = profile("dev.momoki.review.smoke", true).unwrap().1;
        let path = webview_profile_directory(&root, normal).unwrap();
        assert_eq!(path, webview_profile_directory(&root, normal).unwrap());
        assert_ne!(path, webview_profile_directory(&root, review).unwrap());
        assert_ne!(
            path,
            webview_profile_directory(
                &root,
                profile("design.tulai.momoki", false).unwrap().1
            )
            .unwrap()
        );
        assert!(path.starts_with(std::fs::canonicalize(&root).unwrap()));
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, b"not a directory").unwrap();
        assert!(webview_profile_directory(&root, normal).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn webview_directory_rejects_symlink_namespace() {
        let root =
            std::env::temp_dir().join(format!("momoki-webview-link-{}", uuid::Uuid::new_v4()));
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("webview-profiles-v1")).unwrap();
        assert!(webview_profile_directory(&root, [1; 16]).is_err());
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn export_envelopes_are_closed_and_bounded_before_io() {
        assert!(serde_json::from_value::<SaveChunk>(serde_json::json!({"version":1,"session":uuid::Uuid::new_v4(),"offset":0,"bytes":[1,2],"path":"/tmp/x"})).is_err());
        assert!(serde_json::from_value::<SaveChunk>(serde_json::json!({"version":1,"session":uuid::Uuid::new_v4(),"offset":0,"bytes":vec![1; SAVE_CHUNK + 1]})).is_err());
        assert!(serde_json::from_value::<SaveChunk>(serde_json::json!({"version":1,"session":uuid::Uuid::new_v4(),"offset":0,"bytes":[256]})).is_err());
    }
}
