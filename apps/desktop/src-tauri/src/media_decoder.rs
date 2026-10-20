//! The resource directory is supplied by Tauri, never by renderer DTOs. The
//! executable identity comes from the compiled reviewed lock, not its neighbor.
use crate::{Error, Result, paths};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    path::Path,
};

const LOCK: &str = include_str!("../../media/decoder-lock.json");
const MAX_MANIFEST: u64 = 8192;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Executable {
    file: String,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    backend: String,
    version: String,
    release: String,
    target: String,
    executables: BTreeMap<String, Executable>,
}

fn unsupported() -> Error {
    Error::new(
        "mediaUnavailable",
        "Local media decoding is unavailable on this platform",
    )
}
fn integrity() -> Error {
    Error::new(
        "mediaDecoderIntegrity",
        "Bundled media decoder verification failed",
    )
}
fn target() -> Result<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("macos-arm64")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Ok("macos-x64")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("windows-x64")
    } else {
        Err(unsupported())
    }
}
fn expected(target: &str) -> Result<Manifest> {
    let lock: serde_json::Value = serde_json::from_str(LOCK).map_err(|_| integrity())?;
    let executables = lock["targets"][target]["executables"].clone();
    if executables.is_null() {
        return Err(unsupported());
    }
    serde_json::from_value(serde_json::json!({
        "schema": lock["schema"], "backend": lock["backend"],
        "version": lock["version"], "release": lock["release"],
        "target": target, "executables": executables,
    }))
    .map_err(|_| integrity())
}

fn read_verified(
    path: &Path,
    expected: &Executable,
    mut copy: Option<&mut File>,
) -> Result<()> {
    let named = paths::ordinary(path, 1).map_err(|_| integrity())?;
    if named.len() != expected.bytes {
        return Err(integrity());
    }
    let mut file = File::open(path).map_err(|_| integrity())?;
    let opened = paths::stat_file(&file).map_err(|_| integrity())?;
    if opened.identity() != named.identity() || opened.len() != named.len() {
        return Err(integrity());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file
            .metadata()
            .map_err(|_| integrity())?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err(integrity());
        }
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    let mut bytes = 0;
    loop {
        let count = file.read(&mut buffer).map_err(|_| integrity())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > expected.bytes {
            return Err(integrity());
        }
        digest.update(&buffer[..count]);
        // The bytes hashed are exactly the bytes written to the app-owned copy.
        if let Some(out) = copy.as_mut() {
            out.write_all(&buffer[..count]).map_err(|_| integrity())?;
        }
    }
    let after = paths::ordinary(path, 1).map_err(|_| integrity())?;
    let handle = paths::stat_file(&file).map_err(|_| integrity())?;
    if bytes != expected.bytes
        || paths::hex_digest(digest.finalize()) != expected.sha256
        || after.identity() != named.identity()
        || handle.identity() != named.identity()
        || after.len() != expected.bytes
        || handle.len() != expected.bytes
        || after.modified()? != named.modified()?
        || handle.modified()? != named.modified()?
    {
        return Err(integrity());
    }
    Ok(())
}

/// Verifies the bundled decoder and streams the verified `ffmpeg` bytes into
/// `copy`, an app-owned empty file. The caller executes that copy (see
/// `seal_copy`), never the resource path, so hash and exec share one object.
pub(crate) fn verified_decoder(resource_root: &Path, copy: &mut File) -> Result<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        copy.set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|_| integrity())?;
    }
    verify(resource_root, &expected(target()?)?, Some(copy))
}

/// Closes the write side of the owned copy. On Windows the returned handle
/// denies write/delete sharing until dropped, so the image cannot be replaced
/// between verification and process creation.
pub(crate) struct SealedCopy {
    _hold: Option<File>,
}
pub(crate) fn seal_copy(path: &Path, expected_bytes: u64) -> Result<SealedCopy> {
    #[cfg(windows)]
    let hold = {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ only: deny FILE_SHARE_WRITE and FILE_SHARE_DELETE.
        Some(
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(path)
                .map_err(|_| integrity())?,
        )
    };
    #[cfg(not(windows))]
    let hold: Option<File> = None;
    let named = paths::ordinary(path, 1).map_err(|_| integrity())?;
    if named.len() != expected_bytes {
        return Err(integrity());
    }
    Ok(SealedCopy { _hold: hold })
}

fn verify(
    resource_root: &Path,
    expected: &Manifest,
    mut copy: Option<&mut File>,
) -> Result<u64> {
    let root = paths::canonical_root(resource_root).map_err(|_| integrity())?;
    let root_identity = paths::ordinary_directory(&root).map_err(|_| integrity())?;
    let media = root.join("media");
    #[cfg(windows)]
    let _guards = paths::pin_ancestors(&media).map_err(|_| integrity())?;
    let identity = paths::ordinary_directory(&media).map_err(|_| integrity())?;
    let manifest_path = media.join("manifest.json");
    let stat = paths::ordinary(&manifest_path, 1).map_err(|_| integrity())?;
    if stat.len() > MAX_MANIFEST {
        return Err(integrity());
    }
    let mut file = File::open(&manifest_path).map_err(|_| integrity())?;
    if paths::stat_file(&file).map_err(|_| integrity())?.identity() != stat.identity() {
        return Err(integrity());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| integrity())?;
    if bytes.len() as u64 != stat.len()
        || paths::ordinary(&manifest_path, 1)
            .map_err(|_| integrity())?
            .identity()
            != stat.identity()
    {
        return Err(integrity());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| integrity())?;
    if &manifest != expected || manifest.executables.len() != 2 {
        return Err(integrity());
    }
    for (name, executable) in &manifest.executables {
        let suffix = if manifest.target == "windows-x64" {
            ".exe"
        } else {
            ""
        };
        if !["ffmpeg", "ffprobe"].contains(&name.as_str())
            || executable.file != format!("{name}{suffix}")
        {
            return Err(integrity());
        }
        let destination = if name == "ffmpeg" { copy.as_deref_mut() } else { None };
        read_verified(&media.join(&executable.file), executable, destination)?;
    }
    if paths::ordinary_directory(&root)
        .map_err(|_| integrity())?
        .identity()
        != root_identity.identity()
        || paths::ordinary_directory(&media)
            .map_err(|_| integrity())?
            .identity()
            != identity.identity()
    {
        return Err(integrity());
    }
    Ok(manifest.executables["ffmpeg"].bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn fixture() -> (PathBuf, Manifest) {
        let root = std::env::temp_dir().join(format!("momoki-decoder-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("media")).unwrap();
        let mut manifest = expected("macos-arm64").unwrap();
        for executable in manifest.executables.values_mut() {
            let bytes = format!("fixture-{}", executable.file);
            executable.bytes = bytes.len() as u64;
            executable.sha256 = paths::hex_digest(Sha256::digest(bytes.as_bytes()));
            fs::write(root.join("media").join(&executable.file), bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    root.join("media").join(&executable.file),
                    fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
        }
        let value = serde_json::json!({"schema":manifest.schema,"backend":manifest.backend,"version":manifest.version,
            "release":manifest.release,"target":manifest.target,"executables":manifest.executables.iter().map(|(name,exe)|
                (name.clone(), serde_json::json!({"file":exe.file,"bytes":exe.bytes,"sha256":exe.sha256}))).collect::<BTreeMap<_,_>>()});
        fs::write(
            root.join("media/manifest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        (root, manifest)
    }
    fn tempfile_in(root: &Path) -> File {
        paths::exclusive(&root.join("copy.bin")).unwrap()
    }
    #[test]
    fn fixed_resource_identity_rejects_corruption_and_foreign_manifest() {
        let (root, manifest) = fixture();
        assert_eq!(
            verify(&root, &manifest, None).unwrap(),
            manifest.executables["ffmpeg"].bytes
        );
        let mut copy = tempfile_in(&root);
        verify(&root, &manifest, Some(&mut copy)).unwrap();
        drop(copy);
        assert_eq!(
            fs::read(root.join("copy.bin")).unwrap(),
            fs::read(root.join("media/ffmpeg")).unwrap()
        );
        fs::write(root.join("media/ffmpeg"), "corrupted").unwrap();
        assert_eq!(
            verify(&root, &manifest, None).unwrap_err().code,
            "mediaDecoderIntegrity"
        );
        let _ = fs::remove_dir_all(root);
        let (root, manifest) = fixture();
        let path = root.join("media/manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["target"] = "windows-x64".into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(verify(&root, &manifest, None).is_err());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn compiled_lock_has_only_reviewed_targets_and_closed_executable_names() {
        for target in ["macos-arm64", "macos-x64", "windows-x64"] {
            let manifest = expected(target).unwrap();
            assert_eq!(manifest.version, "8.0.3");
            assert_eq!(manifest.executables.len(), 2);
            assert!(
                manifest
                    .executables
                    .values()
                    .all(|file| file.bytes > 30_000_000
                        && file.bytes < 50_000_000
                        && file.sha256.len() == 64)
            );
        }
        assert!(expected("linux-x64").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn aliases_and_hard_links_are_not_decoder_resources() {
        use std::os::unix::fs::symlink;
        let (root, manifest) = fixture();
        fs::rename(root.join("media/ffmpeg"), root.join("original")).unwrap();
        symlink(root.join("original"), root.join("media/ffmpeg")).unwrap();
        assert!(verify(&root, &manifest, None).is_err());
        fs::remove_file(root.join("media/ffmpeg")).unwrap();
        fs::hard_link(root.join("original"), root.join("media/ffmpeg")).unwrap();
        assert!(verify(&root, &manifest, None).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
