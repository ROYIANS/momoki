use crate::{
    Error, Result, WorkspaceRef,
    contracts::{CHUNK, MAX_ASSET_BYTES, MAX_MANIFEST_BYTES, identity},
};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

pub fn derive_ref(workspace: &str, project: &str, asset: &str) -> Result<WorkspaceRef> {
    if workspace.is_empty()
        || !workspace
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(Error::new("identity", "Invalid workspace ID"));
    }
    let encode = |id: &str| -> Result<String> {
        identity(id, 4096)?;
        let mut out = String::from("id-");
        for b in id.bytes() {
            out.push_str(&format!("{b:02x}"));
        }
        Ok(out)
    };
    let owner = if project == "studio" {
        "studio".to_owned()
    } else {
        format!("projects/{}", encode(project)?)
    };
    identity(project, 4096)?;
    Ok(WorkspaceRef {
        workspace_id: workspace.into(),
        project_id: project.into(),
        relative_path: format!("{owner}/assets/{}", encode(asset)?),
    })
}

pub(crate) fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn validate_ref(reference: &WorkspaceRef, workspace: &str, asset: &str) -> Result<()> {
    let expected = derive_ref(workspace, &reference.project_id, asset)?;
    if *reference != expected {
        return Err(Error::new("reference", "Noncanonical or foreign reference"));
    }
    for component in reference.relative_path.split('/') {
        if component.len() > 240 {
            return Err(Error::new(
                "length",
                "Portable path component exceeds 240 bytes",
            ));
        }
    }
    if reference.relative_path.len() > 1024 {
        return Err(Error::new("length", "Portable relative path is too long"));
    }
    Ok(())
}

// A snapshot has actual object identity. A Metadata-only Windows seam cannot
// provide stable volume/index/link information on the pinned stable toolchain.
#[derive(Clone, Debug)]
pub(crate) struct NativeStat {
    identity: (u64, u64, u64),
    byte_length: u64,
    modified: SystemTime,
    file: bool,
    directory: bool,
    alias: bool,
}
impl NativeStat {
    pub(crate) fn identity(&self) -> (u64, u64, u64) {
        self.identity
    }
    pub(crate) fn len(&self) -> u64 {
        self.byte_length
    }
    pub(crate) fn modified(&self) -> Result<SystemTime> {
        Ok(self.modified)
    }
    pub(crate) fn is_file(&self) -> bool {
        self.file
    }
    pub(crate) fn is_dir(&self) -> bool {
        self.directory
    }
    pub(crate) fn is_alias(&self) -> bool {
        self.alias
    }
}
#[cfg(unix)]
fn unix_stat(metadata: std::fs::Metadata) -> Result<NativeStat> {
    Ok(NativeStat {
        identity: (metadata.dev(), metadata.ino(), metadata.nlink()),
        byte_length: metadata.len(),
        modified: metadata.modified()?,
        file: metadata.is_file(),
        directory: metadata.is_dir(),
        alias: metadata.file_type().is_symlink(),
    })
}
#[cfg(windows)]
mod windows;

/// Platform-neutral Win32 attribute classification (unit-tested on every host).
/// Reparse points (symlink, junction, mount point) and cloud placeholders or
/// offline files are aliases: they are never followed or hydrated. Returns
/// `(alias, file, directory)`; an alias is neither file nor directory, like a
/// Unix symlink from `symlink_metadata`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn classify_win32_attributes(attributes: u32) -> (bool, bool, bool) {
    const DIRECTORY: u32 = 0x10;
    const OFFLINE: u32 = 0x1000;
    const REPARSE_POINT: u32 = 0x400;
    const RECALL_ON_OPEN: u32 = 0x4_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
    let alias = attributes & (REPARSE_POINT | OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0;
    let directory = !alias && attributes & DIRECTORY != 0;
    (alias, !alias && !directory, directory)
}

pub(crate) fn stat_path(path: &Path) -> Result<NativeStat> {
    #[cfg(unix)]
    {
        unix_stat(fs::symlink_metadata(path)?)
    }
    #[cfg(windows)]
    {
        windows::stat_path(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(Error::new(
            "platform",
            "Native file identity is unsupported",
        ))
    }
}
pub(crate) fn stat_file(file: &File) -> Result<NativeStat> {
    #[cfg(unix)]
    {
        unix_stat(file.metadata()?)
    }
    #[cfg(windows)]
    {
        windows::stat_file(file)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err(Error::new(
            "platform",
            "Native file identity is unsupported",
        ))
    }
}
pub(crate) fn ordinary(path: &Path, allowed_links: u64) -> Result<NativeStat> {
    let m = stat_path(path)?;
    if !m.is_file() || m.is_alias() || m.identity().2 != allowed_links {
        return Err(Error::new(
            "containment",
            "Managed file must be ordinary and have only owned links",
        ));
    }
    Ok(m)
}
pub(crate) fn ordinary_directory(path: &Path) -> Result<NativeStat> {
    let m = stat_path(path)?;
    if !m.is_dir() || m.is_alias() {
        return Err(Error::new(
            "containment",
            "Managed directory must be ordinary",
        ));
    }
    Ok(m)
}
// Holds ordinary Windows directories without FILE_SHARE_DELETE while an active
// boundary/lease uses their names. Unix keeps its existing repeated-stat model.
#[cfg(windows)]
pub(crate) use windows::DirectoryGuard;
#[cfg(windows)]
pub(crate) fn pin_directory(path: &Path) -> Result<DirectoryGuard> {
    windows::pin_directory(path)
}
#[cfg(windows)]
pub(crate) fn pin_ancestors(path: &Path) -> Result<Vec<DirectoryGuard>> {
    let mut guards = Vec::new();
    // Acquire outer ancestors first. Held handles omit FILE_SHARE_DELETE;
    // changing an active name then fails instead of redirecting a later open.
    let ancestors: Vec<_> = path.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        if !ancestor.as_os_str().is_empty() {
            guards.push(pin_directory(ancestor)?);
        }
    }
    Ok(guards)
}
#[cfg(windows)]
fn windows_ancestors(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if !ancestor.as_os_str().is_empty() {
            ordinary_directory(ancestor)?;
        }
    }
    Ok(())
}

pub(crate) fn check_optional_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            ordinary(path, 1)?;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn canonical_root(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err(Error::new(
            "containment",
            "Expected absolute native root without traversal",
        ));
    }
    let m = ordinary_directory(path)?;
    if !m.is_dir() || m.is_alias() {
        return Err(Error::new(
            "containment",
            "Workspace root must be a real directory",
        ));
    }
    #[cfg(windows)]
    windows_ancestors(path)?;
    // OS parent aliases (e.g. /var -> /private/var) are deliberately canonicalized.
    Ok(fs::canonicalize(path)?)
}

pub(crate) fn reserve(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err(Error::new("containment", "Expected an absolute fresh root"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("containment", "Missing parent"))?;
    #[cfg(windows)]
    let _directory_guards = pin_ancestors(parent)?;
    let parent = fs::canonicalize(parent)?;
    let name = path
        .file_name()
        .ok_or_else(|| Error::new("containment", "Missing directory name"))?;
    let root = parent.join(name);
    fs::create_dir(&root)?; // Existing empty targets reject, never create_dir_all(root).
    namespace_checkpoint(&parent)?;
    Ok(root)
}

pub(crate) fn managed(root: &Path, relative: &str, create_parents: bool) -> Result<PathBuf> {
    if relative.is_empty() || relative.len() > 1024 {
        return Err(Error::new("containment", "Invalid relative path"));
    }
    canonical_root(root)?;
    let segments: Vec<_> = relative.split('/').collect();
    let mut path = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        if segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.len() > 240
            || !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        {
            return Err(Error::new("containment", "Invalid managed path component"));
        }
        path.push(segment);
        if index + 1 == segments.len() {
            break;
        }
        if create_parents {
            match fs::create_dir(&path) {
                Ok(()) => {
                    namespace_checkpoint(path.parent().expect("managed parent"))?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
        }
        let m = ordinary_directory(&path)?;
        if !m.is_dir() || m.is_alias() {
            return Err(Error::new(
                "containment",
                "Managed ancestor is not an ordinary directory",
            ));
        }
    }
    Ok(path)
}

/// Explicit platform strength: Unix flushes the directory namespace; the
/// approved Windows test contract validates process-recovery authority only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NamespaceCheckpoint {
    #[cfg(unix)]
    DirectorySynced,
    #[cfg(windows)]
    ProcessRecoveryOnly,
}
pub(crate) fn namespace_checkpoint(path: &Path) -> Result<NamespaceCheckpoint> {
    #[cfg(unix)]
    {
        namespace_checkpoint_with_open(path, |path| Ok(File::open(path)?))
    }
    #[cfg(windows)]
    {
        windows::process_namespace_checkpoint(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(Error::new(
            "platform",
            "Native directory persistence is unsupported",
        ))
    }
}
#[cfg(unix)]
fn namespace_checkpoint_with_open(
    path: &Path,
    open: impl FnOnce(&Path) -> Result<File>,
) -> Result<NamespaceCheckpoint> {
    let named = ordinary_directory(path)?.identity();
    let file = open(path)?;
    let opened = stat_file(&file)?;
    let opened_identity = opened.identity();
    // Directory nlink changes when an ordinary child directory is created.
    // The device/inode pair binds the directory object; file publication keeps
    // its separate strict owned-link count checks.
    if !opened.is_dir()
        || opened.is_alias()
        || (opened_identity.0, opened_identity.1) != (named.0, named.1)
    {
        return Err(Error::new(
            "changed",
            "Namespace directory changed while opening",
        ));
    }
    file.sync_all()?;
    Ok(NamespaceCheckpoint::DirectorySynced)
}
/// Flush a published ordinary file through a real descriptor after proving
/// both names still refer to the stage object. Failure never reverses a link.
pub(crate) fn flush_published_file(
    path: &Path,
    identity: (u64, u64),
    byte_length: u64,
    owned_links: u64,
) -> Result<()> {
    flush_published_file_with(path, identity, byte_length, owned_links, |file| {
        file.sync_all()?;
        Ok(())
    })
}
fn flush_published_file_with(
    path: &Path,
    identity: (u64, u64),
    byte_length: u64,
    owned_links: u64,
    flush: impl FnOnce(&File) -> Result<()>,
) -> Result<()> {
    #[cfg(windows)]
    let _directory_guards = pin_ancestors(
        path.parent()
            .ok_or_else(|| Error::new("containment", "Missing published-file parent"))?,
    )?;
    let verify = |stat: NativeStat| -> Result<()> {
        let actual = stat.identity();
        if !stat.is_file()
            || stat.is_alias()
            || actual != (identity.0, identity.1, owned_links)
            || stat.len() != byte_length
        {
            return Err(Error::new(
                "changed",
                "Published file identity, link count or size changed",
            ));
        }
        Ok(())
    };
    let named_before = ordinary(path, owned_links)?;
    let modified = named_before.modified()?;
    verify(named_before)?;
    #[cfg(windows)]
    let file = windows::open_flush_file(path)?;
    #[cfg(not(windows))]
    let file = File::open(path)?;
    let opened = stat_file(&file)?;
    if opened.modified()? != modified {
        return Err(Error::new(
            "changed",
            "Published file changed while opening its flush handle",
        ));
    }
    verify(opened)?;
    flush(&file)?;
    let opened_after = stat_file(&file)?;
    let named_after = stat_path(path)?;
    if opened_after.modified()? != modified || named_after.modified()? != modified {
        return Err(Error::new(
            "changed",
            "Published file changed during flushing",
        ));
    }
    verify(opened_after)?;
    verify(named_after)
}

pub(crate) fn exclusive(path: &Path) -> Result<File> {
    Ok(OpenOptions::new().write(true).create_new(true).open(path)?)
}

pub(crate) fn hash_file(
    path: &Path,
    max: u64,
    mut check: impl FnMut() -> Result<()>,
) -> Result<(u64, String)> {
    let before = ordinary(path, 1)?;
    if before.len() == 0 || before.len() > max {
        return Err(Error::new("size", "File size is outside its boundary"));
    }
    let mut file = File::open(path)?;
    let opened = stat_file(&file)?;
    if before.identity() != opened.identity() {
        return Err(Error::new("changed", "File changed while opening"));
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0; CHUNK];
    let mut size = 0_u64;
    loop {
        check()?;
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > max {
            return Err(Error::new("size", "Observed bytes exceeded boundary"));
        }
        hash.update(&buffer[..n]);
    }
    let after = ordinary(path, 1)?;
    if size != before.len()
        || before.identity() != after.identity()
        || before.modified()? != after.modified()?
    {
        return Err(Error::new("changed", "File changed during reading"));
    }
    Ok((size, hex_digest(hash.finalize())))
}

pub(crate) fn copy_verified(
    source: &Path,
    target: &Path,
    expected_size: u64,
    expected_hash: &str,
    mut check: impl FnMut() -> Result<()>,
) -> Result<()> {
    let before = ordinary(source, 1)?;
    if expected_size == 0 || expected_size > MAX_ASSET_BYTES || before.len() != expected_size {
        return Err(Error::new("corrupt", "Source size mismatch"));
    }
    let mut input = File::open(source)?;
    if before.identity() != stat_file(&input)?.identity() {
        return Err(Error::new("changed", "Copy source changed while opening"));
    }
    let mut output = exclusive(target)?;
    let mut buffer = vec![0; CHUNK];
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    loop {
        check()?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > expected_size {
            return Err(Error::new("changed", "Copy source grew"));
        }
        output.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
    }
    output.sync_all()?;
    let after = ordinary(source, 1)?;
    if size != expected_size
        || hex_digest(hash.finalize()) != expected_hash
        || before.identity() != after.identity()
        || before.modified()? != after.modified()?
    {
        return Err(Error::new(
            "corrupt",
            "Copied file did not match frozen size/hash",
        ));
    }
    namespace_checkpoint(target.parent().expect("copy parent"))?;
    Ok(())
}

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata = ordinary(path, 1)?;
    if metadata.len() == 0 || metadata.len() > MAX_MANIFEST_BYTES {
        return Err(Error::new("size", "Manifest byte boundary"));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(Error::new("size", "Manifest grew beyond boundary"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

struct ManifestWriter<'a> {
    file: &'a mut File,
    remaining: u64,
    exceeded: bool,
}
impl Write for ManifestWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            self.exceeded = true;
            return Err(std::io::Error::other("Manifest exceeds byte boundary"));
        }
        let written = self.file.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

pub(crate) fn publish_json<T: serde::Serialize>(root: &Path, name: &str, value: &T) -> Result<()> {
    publish_json_with_checkpoint(root, name, value, namespace_checkpoint)
}
fn publish_json_with_checkpoint<T: serde::Serialize>(
    root: &Path,
    name: &str,
    value: &T,
    checkpoint: impl Fn(&Path) -> Result<NamespaceCheckpoint>,
) -> Result<()> {
    #[cfg(windows)]
    let _directory_guards = pin_ancestors(root)?;
    let temporary = managed(root, &format!("{}.tmp", uuid::Uuid::new_v4()), false)?;
    let final_path = managed(root, name, false)?;
    let mut output = exclusive(&temporary)?;
    {
        let mut writer = ManifestWriter {
            file: &mut output,
            remaining: MAX_MANIFEST_BYTES,
            exceeded: false,
        };
        let result = serde_json::to_writer(&mut writer, value);
        if writer.exceeded {
            return Err(Error::new("size", "Manifest exceeds byte boundary"));
        }
        result?;
    }
    output.sync_all()?;
    let stage = stat_file(&output)?;
    let identity = stage.identity();
    if ordinary(&temporary, 1)?.identity() != identity {
        return Err(Error::new("changed", "Manifest stage identity changed"));
    }
    fs::hard_link(&temporary, &final_path)?;
    flush_published_file(&final_path, (identity.0, identity.1), stage.len(), 2)?;
    checkpoint(root)?;
    // A confirmed directory does not prove these names still refer to the
    // published object. Preserve an unproven stage rather than unlinking it.
    for current in [
        ordinary(&temporary, 2)?,
        ordinary(&final_path, 2)?,
        stat_file(&output)?,
    ] {
        if current.identity() != (identity.0, identity.1, 2) || current.len() != stage.len() {
            return Err(Error::new("changed", "Manifest cleanup identity changed"));
        }
    }
    fs::remove_file(&temporary)?;
    checkpoint(root)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn win32_attributes_classify_reparse_and_cloud_entries_as_aliases() {
        assert_eq!(classify_win32_attributes(0x20), (false, true, false));
        assert_eq!(classify_win32_attributes(0x10), (false, false, true));
        // Junction/symlink: reparse point, usually also a directory.
        assert_eq!(classify_win32_attributes(0x410), (true, false, false));
        assert_eq!(classify_win32_attributes(0x420), (true, false, false));
        // Cloud placeholders and offline files must not be hydrated by a scan.
        assert_eq!(classify_win32_attributes(0x40_0020), (true, false, false));
        assert_eq!(classify_win32_attributes(0x4_0020), (true, false, false));
        assert_eq!(classify_win32_attributes(0x1020), (true, false, false));
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("momoki-native-stat-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn namespace_checkpoint_reports_its_actual_platform_strength() {
        let fixture = Fixture::new();
        #[cfg(unix)]
        assert_eq!(
            namespace_checkpoint(&fixture.0).unwrap(),
            NamespaceCheckpoint::DirectorySynced
        );
        #[cfg(windows)]
        assert_eq!(
            namespace_checkpoint(&fixture.0).unwrap(),
            NamespaceCheckpoint::ProcessRecoveryOnly
        );
        assert!(namespace_checkpoint(&fixture.0.join("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_checkpoint_allows_child_creation_but_rejects_object_replacement() {
        let fixture = Fixture::new();
        let directory = fixture.0.join("directory");
        fs::create_dir(&directory).unwrap();
        let before = ordinary_directory(&directory).unwrap().identity();
        let checkpoint = namespace_checkpoint_with_open(&directory, |path| {
            fs::create_dir(path.join("child"))?;
            Ok(File::open(path)?)
        })
        .unwrap();
        assert_eq!(checkpoint, NamespaceCheckpoint::DirectorySynced);
        let after = ordinary_directory(&directory).unwrap().identity();
        assert_eq!((before.0, before.1), (after.0, after.1));
        assert_ne!(before.2, after.2, "fixture did not change directory links");
        let error = namespace_checkpoint_with_open(&directory, |path| {
            fs::rename(path, fixture.0.join("original"))?;
            fs::create_dir(path)?;
            Ok(File::open(path)?)
        })
        .unwrap_err();
        assert_eq!(error.code, "changed");
        assert!(fixture.0.join("original/child").is_dir());
    }

    #[test]
    fn published_regular_file_flush_uses_real_bound_file_and_preserves_failure_names() {
        let fixture = Fixture::new();
        let stage = fixture.0.join("stage");
        let final_path = fixture.0.join("final");
        let mut output = exclusive(&stage).unwrap();
        output.write_all(b"verified bytes").unwrap();
        output.sync_all().unwrap();
        let identity = stat_file(&output).unwrap().identity();
        fs::hard_link(&stage, &final_path).unwrap();
        let reached = std::cell::Cell::new(false);
        let error =
            flush_published_file_with(&final_path, (identity.0, identity.1), 14, 2, |file| {
                reached.set(true);
                // Exercise the actual ordinary-file OS flush before injecting a
                // later failure, proving the test reaches the real owned handle.
                file.sync_all()?;
                Err(Error::new(
                    "fixtureFlush",
                    "injected final file flush failure",
                ))
            })
            .unwrap_err();
        assert!(reached.get());
        assert_eq!(error.code, "fixtureFlush");
        assert_eq!(fs::read(&stage).unwrap(), b"verified bytes");
        assert_eq!(fs::read(&final_path).unwrap(), b"verified bytes");
        assert_eq!(
            ordinary(&final_path, 2).unwrap().identity(),
            (identity.0, identity.1, 2)
        );
        flush_published_file(&final_path, (identity.0, identity.1), 14, 2).unwrap();
    }

    #[test]
    fn wrong_or_replaced_published_identity_cannot_be_reported_flushed() {
        let fixture = Fixture::new();
        let stage = fixture.0.join("stage");
        let final_path = fixture.0.join("final");
        fs::write(&stage, b"owned").unwrap();
        let identity = ordinary(&stage, 1).unwrap().identity();
        fs::hard_link(&stage, &final_path).unwrap();
        let reached = std::cell::Cell::new(false);
        assert_eq!(
            flush_published_file_with(
                &final_path,
                (identity.0, identity.1.wrapping_add(1)),
                5,
                2,
                |_| {
                    reached.set(true);
                    Ok(())
                }
            )
            .unwrap_err()
            .code,
            "changed"
        );
        assert!(!reached.get(), "wrong identity reached flushing");
        assert_eq!(
            flush_published_file_with(&final_path, (identity.0, identity.1), 5, 2, |file| {
                file.sync_all()?;
                fs::remove_file(&final_path)?;
                fs::write(&final_path, b"other")?;
                Ok(())
            })
            .unwrap_err()
            .code,
            "changed"
        );
        assert_eq!(fs::read(&stage).unwrap(), b"owned");
        assert_eq!(fs::read(&final_path).unwrap(), b"other");
    }

    #[test]
    fn same_identity_and_size_mutation_during_flush_is_rejected() {
        let fixture = Fixture::new();
        let stage = fixture.0.join("stage");
        let final_path = fixture.0.join("final");
        fs::write(&stage, b"owned").unwrap();
        let identity = ordinary(&stage, 1).unwrap().identity();
        fs::hard_link(&stage, &final_path).unwrap();
        let error =
            flush_published_file_with(&final_path, (identity.0, identity.1), 5, 2, |file| {
                file.sync_all()?;
                let mut writer = OpenOptions::new().write(true).open(&final_path)?;
                writer.write_all(b"other")?;
                writer.set_times(fs::FileTimes::new().set_modified(
                    SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000),
                ))?;
                writer.sync_all()?;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, "changed");
        assert_eq!(
            ordinary(&final_path, 2).unwrap().identity(),
            (identity.0, identity.1, 2)
        );
        assert_eq!(fs::read(&stage).unwrap(), b"other");
        assert_eq!(fs::read(&final_path).unwrap(), b"other");
    }

    #[test]
    fn native_snapshot_distinguishes_same_size_and_mtime_and_preserves_open_identity() {
        let fixture = Fixture::new();
        let first = fixture.0.join("first.bin");
        let second = fixture.0.join("second.bin");
        fs::write(&first, b"same").unwrap();
        fs::write(&second, b"same").unwrap();
        let timestamp = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let times = fs::FileTimes::new().set_modified(timestamp);
        for path in [&first, &second] {
            OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(times)
                .unwrap();
        }
        let before = ordinary(&first, 1).unwrap();
        let other = ordinary(&second, 1).unwrap();
        let opened = File::open(&first).unwrap();
        assert_eq!(before.len(), other.len());
        assert_eq!(before.modified().unwrap(), other.modified().unwrap());
        assert_ne!(before.identity(), other.identity());
        assert_eq!(stat_file(&opened).unwrap().identity(), before.identity());
        fs::rename(&second, fixture.0.join("replacement.bin")).unwrap();
        assert_ne!(
            ordinary(&fixture.0.join("replacement.bin"), 1)
                .unwrap()
                .identity(),
            before.identity()
        );
    }

    #[test]
    fn native_link_snapshot_distinguishes_two_owned_names_from_ready_single_name() {
        let fixture = Fixture::new();
        let source = fixture.0.join("stage.bin");
        let target = fixture.0.join("final.bin");
        fs::write(&source, b"owned bytes").unwrap();
        let id = ordinary(&source, 1).unwrap().identity();
        fs::hard_link(&source, &target).unwrap();
        assert_eq!(ordinary(&source, 1).unwrap_err().code, "containment");
        assert_eq!(ordinary(&target, 1).unwrap_err().code, "containment");
        let linked = ordinary(&target, 2).unwrap().identity();
        assert_eq!((linked.0, linked.1), (id.0, id.1));
        fs::remove_file(&source).unwrap();
        assert_eq!(ordinary(&target, 1).unwrap().identity(), id);
        assert_eq!(fs::read(&target).unwrap(), b"owned bytes");
    }

    #[cfg(windows)]
    #[test]
    fn ntfs_junction_root_and_ancestor_are_rejected_without_foreign_access() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("target")).unwrap();
        fs::write(fixture.0.join("target/external.bin"), b"external bytes").unwrap();
        // Closed literal relative names, with cwd supplied through the process
        // API. No authored path/string is interpolated into cmd syntax.
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J", "junction", "target"])
            .current_dir(&fixture.0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction setup failed: {:?}",
            output
        );
        let junction = fixture.0.join("junction");
        assert_eq!(
            ordinary_directory(&junction).unwrap_err().code,
            "containment"
        );
        assert_eq!(canonical_root(&junction).unwrap_err().code, "containment");
        assert_eq!(
            managed(&fixture.0, "junction/external.bin", false)
                .unwrap_err()
                .code,
            "containment"
        );
        assert_eq!(
            fs::read(fixture.0.join("target/external.bin")).unwrap(),
            b"external bytes"
        );
        fs::remove_dir(&junction).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn active_directory_guard_blocks_ancestor_replacement_until_released() {
        let fixture = Fixture::new();
        let parent = fixture.0.join("managed");
        let moved = fixture.0.join("moved");
        fs::create_dir(&parent).unwrap();
        let expected = ordinary_directory(&parent).unwrap().identity();
        let guards = pin_ancestors(&parent).unwrap();
        assert!(
            fs::rename(&parent, &moved).is_err(),
            "active ancestor was moved"
        );
        assert_eq!(ordinary_directory(&parent).unwrap().identity(), expected);
        drop(guards);
        fs::rename(&parent, &moved).unwrap();
        assert_eq!(ordinary_directory(&moved).unwrap().identity(), expected);
    }

    #[cfg(windows)]
    #[test]
    fn empty_directory_guard_denies_delete_access_until_released() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let fixture = Fixture::new();
        let directory = fixture.0.join("empty");
        fs::create_dir(&directory).unwrap();
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        let expected = ordinary_directory(&directory).unwrap().identity();
        let open_for_delete = || {
            OpenOptions::new()
                .access_mode(DELETE)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&directory)
        };
        let guard = pin_directory(&directory).unwrap();
        let denied = open_for_delete().expect_err("Pinned directory accepted DELETE authority");
        assert_eq!(
            denied.raw_os_error(),
            Some(32),
            "Expected Win32 sharing violation"
        );
        assert_eq!(ordinary_directory(&directory).unwrap().identity(), expected);
        drop(guard);
        drop(open_for_delete().expect("Released directory retained a DELETE conflict"));
        fs::remove_dir(&directory).unwrap();
        assert!(!directory.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_directory_flush_spike_records_real_access_and_result_without_claiming_a_barrier() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::{
            Foundation::GENERIC_WRITE,
            Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
                FILE_SHARE_READ, FILE_SHARE_WRITE,
            },
        };
        let fixture = Fixture::new();
        for access in [0, GENERIC_WRITE] {
            let opened = OpenOptions::new()
                .access_mode(access)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&fixture.0);
            match opened {
                Ok(file) => eprintln!(
                    "Windows directory spike access={access:#x} opened=true flush={:?}",
                    file.sync_all()
                        .map_err(|e| (e.raw_os_error(), e.to_string()))
                ),
                Err(error) => eprintln!(
                    "Windows directory spike access={access:#x} opened=false error={:?}",
                    (error.raw_os_error(), error.to_string())
                ),
            }
        }
        assert_eq!(
            namespace_checkpoint(&fixture.0).unwrap(),
            NamespaceCheckpoint::ProcessRecoveryOnly
        );
    }

    #[test]
    fn manifest_cleanup_preserves_changed_stage_after_real_namespace_checkpoint() {
        for alias in [false, true] {
            let fixture = Fixture::new();
            let observed = std::cell::RefCell::new(None);
            let error =
                publish_json_with_checkpoint(&fixture.0, "complete.json", &"owned", |root| {
                    let checkpoint = namespace_checkpoint(root)?;
                    assert_eq!(fs::read(root.join("complete.json")).unwrap(), b"\"owned\"");
                    let stage = fs::read_dir(root)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .find(|path| path.extension().is_some_and(|extension| extension == "tmp"))
                        .expect("published manifest stage");
                    if alias {
                        fs::hard_link(&stage, root.join("foreign-link"))?;
                    } else {
                        fs::remove_file(&stage)?;
                        fs::write(&stage, b"foreign stage bytes")?;
                    }
                    *observed.borrow_mut() = Some(stage);
                    Ok(checkpoint)
                })
                .expect_err("unproven manifest stage must not be erased");
            assert!(matches!(error.code, "containment" | "changed"));
            let stage = observed
                .into_inner()
                .expect("real namespace checkpoint reached");
            assert_eq!(
                fs::read(&stage).unwrap(),
                if alias {
                    &b"\"owned\""[..]
                } else {
                    &b"foreign stage bytes"[..]
                }
            );
            assert_eq!(
                fs::read(fixture.0.join("complete.json")).unwrap(),
                b"\"owned\""
            );
            if alias {
                assert_eq!(
                    fs::read(fixture.0.join("foreign-link")).unwrap(),
                    b"\"owned\""
                );
            }
        }
    }

    #[test]
    fn completion_publication_cannot_exceed_its_reader_boundary() {
        let root =
            std::env::temp_dir().join(format!("momoki-manifest-review-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        // Ordinary reviewed text fields can collectively exceed the fixed reader
        // boundary even though each individual value is within its own limit.
        let payload = vec!["x".repeat(4096); 4096];
        let result = publish_json(&root, "backup.complete.json", &payload);
        let completed = root.join("backup.complete.json").exists();
        let exact = "x".repeat(MAX_MANIFEST_BYTES as usize - 2);
        publish_json(&root, "workspace.ready.json", &exact).unwrap();
        assert_eq!(
            fs::metadata(root.join("workspace.ready.json"))
                .unwrap()
                .len(),
            MAX_MANIFEST_BYTES
        );
        assert_eq!(
            read_json::<String>(&root.join("workspace.ready.json")).unwrap(),
            exact
        );
        fs::remove_dir_all(&root).unwrap();
        assert!(
            result.is_err(),
            "publisher accepted a manifest its own reader rejects"
        );
        assert!(
            !completed,
            "over-budget manifest must never become complete"
        );
    }
}
