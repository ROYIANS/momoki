//! One-shot user-selected text capture. No source grant, disk installer or path IPC.
use crate::{Error, Result, full_product_store::protocol::Session, paths};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

const MAX_ENTRIES: usize = 1_024;
const MAX_FILES: usize = 32;
const MAX_DEPTH: usize = 4;
const MAX_TEXT_BYTES: usize = 512 * 1_024;
const MAX_RESOURCE_BYTES: usize = 128 * 1_024;
const MAX_DOCUMENT_BYTES: usize = 40_976;
const MAX_RESPONSE_BYTES: usize = 2 * 1_024 * 1_024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SkillImportEnvelope {
    pub version: u32,
    pub session: String,
    pub workspace_id: String,
    pub generation: u64,
    pub operation_id: String,
}
impl SkillImportEnvelope {
    pub(crate) fn scope(&self) -> Result<Session> {
        if self.version != 1
            || self.operation_id.is_empty()
            || self.operation_id.len() > 128
            || !self
                .operation_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || self.session.len() != 36
            || uuid::Uuid::parse_str(&self.session).is_err()
            || self.workspace_id.len() != 36
            || uuid::Uuid::parse_str(&self.workspace_id).is_err()
        {
            return Err(Error::new("invalid", "Invalid skill directory request"));
        }
        Ok(Session {
            version: self.version,
            session: self.session.clone(),
            workspace_id: self.workspace_id.clone(),
            generation: self.generation,
        })
    }
}

#[derive(Default)]
pub(crate) struct SkillDirectoryImport {
    busy: AtomicBool,
    closing: AtomicBool,
    epoch: AtomicU64,
    done: tokio::sync::Notify,
    gate: Option<Arc<AtomicBool>>,
}
struct Selection<'a>(&'a SkillDirectoryImport);
impl Drop for Selection<'_> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
        self.0.done.notify_waiters();
    }
}
impl SkillDirectoryImport {
    pub(crate) fn with_gate(gate: Arc<AtomicBool>) -> Self {
        Self {
            gate: Some(gate),
            ..Self::default()
        }
    }
    // Invalidating never pretends the system dialog has closed. Its busy slot
    // remains held until the real picker/capture returns, including on reload.
    pub(crate) fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
    pub(crate) fn quiesce(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.invalidate();
    }
    pub(crate) async fn drain(&self) {
        loop {
            let done = self.done.notified();
            tokio::pin!(done);
            done.as_mut().enable();
            if !self.busy.load(Ordering::SeqCst) {
                break;
            }
            done.await;
        }
    }
    pub(crate) fn pick(
        &self,
        operation_id: &str,
        picker: impl FnOnce() -> Result<Option<PathBuf>>,
        mut validate_session: impl FnMut() -> Result<()>,
    ) -> Result<Value> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Error::new(
                "busy",
                "A skill directory selection is already active",
            ));
        }
        let _selection = Selection(self);
        if self.closing.load(Ordering::SeqCst)
            || self
                .gate
                .as_ref()
                .is_some_and(|gate| !gate.load(Ordering::SeqCst))
        {
            return Err(Error::new("closing", "Application is shutting down"));
        }
        let epoch = self.epoch.load(Ordering::SeqCst);
        let mut check = || -> Result<()> {
            if self.epoch.load(Ordering::SeqCst) != epoch {
                return Err(Error::new("changed", "The skill selection owner changed"));
            }
            validate_session()
        };
        check()?;
        let chosen = picker()?;
        check()?;
        let Some(root) = chosen else {
            return Ok(json!({"status":"canceled", "operationId":operation_id}));
        };
        let snapshot = Capture::read(&root, &mut check)?;
        check()?;
        let result = json!({"status":"captured", "operationId":operation_id,
            "directoryName":snapshot.directory_name, "files":snapshot.files,
            "exclusions":{"count":snapshot.excluded, "paths":snapshot.excluded_paths}});
        if serde_json::to_vec(&result)?.len() > MAX_RESPONSE_BYTES {
            return Err(limit("The escaped skill snapshot exceeds its IPC boundary"));
        }
        Ok(result)
    }
}

fn limit(message: &'static str) -> Error {
    Error::new("skillLimit", message)
}
fn changed() -> Error {
    Error::new(
        "changed",
        "The selected skill directory changed during capture",
    )
}
fn path_error() -> Error {
    Error::new("skillPath", "The skill package contains a nonportable name")
}

#[derive(Clone)]
struct DirectoryIdentity {
    path: PathBuf,
    stat: paths::NativeStat,
    // Ancestors outside the package are checked for identity only. Their
    // unrelated directory entries may legitimately change while a picker runs.
    contents: bool,
}
impl DirectoryIdentity {
    fn check(&self) -> Result<()> {
        let now = paths::ordinary_directory(&self.path)?;
        let before = self.stat.identity();
        let after = now.identity();
        if (before.0, before.1) != (after.0, after.1)
            || self.contents && self.stat.modified()? != now.modified()?
        {
            return Err(changed());
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct TextFile {
    path: String,
    text: String,
}
struct FileIdentity {
    path: PathBuf,
    stat: paths::NativeStat,
}
struct Capture {
    directory_name: String,
    root_device: u64,
    directories: Vec<DirectoryIdentity>,
    files: Vec<TextFile>,
    accepted_files: Vec<FileIdentity>,
    seen: HashSet<String>,
    examined: usize,
    total_bytes: usize,
    excluded: usize,
    excluded_paths: Vec<String>,
    #[cfg(windows)]
    _pins: Vec<paths::DirectoryGuard>,
}
impl Capture {
    fn read(selected: &Path, check: &mut impl FnMut() -> Result<()>) -> Result<Self> {
        check()?;
        let selected_stat = paths::ordinary_directory(selected)?;
        let root = paths::canonical_root(selected)?;
        let root_stat = paths::ordinary_directory(&root)?;
        if selected_stat.identity() != root_stat.identity() {
            return Err(changed());
        }
        let directory_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(path_error)?
            .to_owned();
        if directory_name.is_empty()
            || directory_name.len() > 64
            || !directory_name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || directory_name.starts_with('-')
            || directory_name.ends_with('-')
            || directory_name.contains("--")
        {
            return Err(path_error());
        }
        #[cfg(windows)]
        let pins = paths::pin_ancestors(&root)?;
        let mut capture = Self {
            directory_name,
            root_device: root_stat.identity().0,
            directories: Vec::new(),
            files: Vec::new(),
            accepted_files: Vec::new(),
            seen: HashSet::new(),
            examined: 0,
            total_bytes: 0,
            excluded: 0,
            excluded_paths: Vec::new(),
            #[cfg(windows)]
            _pins: pins,
        };
        for ancestor in root.ancestors().skip(1) {
            if !ancestor.as_os_str().is_empty() {
                capture.directories.push(DirectoryIdentity {
                    path: ancestor.into(),
                    stat: paths::ordinary_directory(ancestor)?,
                    contents: false,
                });
            }
        }
        capture.directories.push(DirectoryIdentity {
            path: selected.into(),
            stat: selected_stat,
            contents: true,
        });
        capture.walk(&root, "", check)?;
        capture.check_files(check)?;
        capture.check_directories()?;
        check()?;
        if !capture.files.iter().any(|file| file.path == "SKILL.md") {
            return Err(Error::new(
                "skillRoot",
                "A skill directory requires root SKILL.md",
            ));
        }
        capture
            .files
            .sort_by(|left, right| left.path.cmp(&right.path));
        Ok(capture)
    }
    fn check_directories(&self) -> Result<()> {
        for directory in &self.directories {
            directory.check()?;
        }
        Ok(())
    }
    fn check_files(&self, check: &mut impl FnMut() -> Result<()>) -> Result<()> {
        for accepted in &self.accepted_files {
            check()?;
            self.check_directories()?;
            verify_file(&accepted.stat, &paths::ordinary(&accepted.path, 1)?)?;
            let file = open_text(&accepted.path)?;
            verify_file(&accepted.stat, &paths::stat_file(&file)?)?;
            verify_file(&accepted.stat, &paths::ordinary(&accepted.path, 1)?)?;
        }
        Ok(())
    }
    fn exclude(&mut self, path: &str) {
        self.excluded += 1;
        if self.excluded_paths.len() < 20 {
            self.excluded_paths.push(path.to_owned());
        }
    }
    fn walk(
        &mut self,
        directory: &Path,
        relative: &str,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        check()?;
        self.check_directories()?;
        let stat = paths::ordinary_directory(directory)?;
        if stat.identity().0 != self.root_device {
            return Err(Error::new(
                "containment",
                "Skill resources must stay on the selected volume",
            ));
        }
        #[cfg(windows)]
        self._pins.push(paths::pin_directory(directory)?);
        self.directories.push(DirectoryIdentity {
            path: directory.into(),
            stat,
            contents: true,
        });
        // Bound enumeration while collecting, before sorting or descending. An
        // excluded subtree counts as one visible entry and is never traversed.
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory)? {
            check()?;
            self.examined += 1;
            if self.examined > MAX_ENTRIES {
                return Err(limit("Too many skill directory entries"));
            }
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| path_error())?;
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            portable_path(&path)?;
            if !self.seen.insert(path.to_uppercase().to_lowercase()) {
                return Err(path_error());
            }
            entries.push((entry.path(), path));
        }
        if !relative.is_empty()
            && entries.iter().any(|(_, path)| {
                path.rsplit('/')
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
            })
        {
            self.exclude(relative);
            return Ok(());
        }
        entries.sort_by(|left, right| left.1.cmp(&right.1));
        for (path, logical) in entries {
            check()?;
            self.check_directories()?;
            let name = logical.rsplit('/').next().ok_or_else(path_error)?;
            if name.starts_with('.') {
                self.exclude(&logical);
                continue;
            }
            // Read only inside the two documented resource directories. Unknown
            // root directories (including scripts) are pruned without scanning.
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                if supported_file(&logical)
                    || relative.is_empty() && matches!(logical.as_str(), "references" | "assets")
                {
                    return Err(Error::new(
                        "containment",
                        "Supported skill text and resource directories cannot be symbolic links",
                    ));
                }
                self.exclude(&logical);
                continue;
            }
            if metadata.is_dir() {
                if relative.is_empty() && logical != "references" && logical != "assets" {
                    self.exclude(&logical);
                } else if logical.split('/').count() >= MAX_DEPTH {
                    return Err(limit("Skill directory nesting exceeds the boundary"));
                } else {
                    self.walk(&path, &logical, check)?;
                }
            } else if supported_file(&logical) {
                // A cloud placeholder or other reparse file cannot be read without
                // recalling it or following an alias; count it instead of aborting.
                if is_offline_placeholder(&metadata) {
                    self.exclude(&logical);
                    continue;
                }
                self.read_file(&path, &logical, check)?;
            } else {
                self.exclude(&logical);
            }
        }
        self.check_directories()?;
        Ok(())
    }
    fn read_file(
        &mut self,
        path: &Path,
        logical: &str,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        if self.files.len() >= MAX_FILES {
            return Err(limit("Too many supported skill text files"));
        }
        let before = paths::ordinary(path, 1)?;
        if before.identity().0 != self.root_device {
            return Err(Error::new(
                "containment",
                "Skill files must stay on the selected volume",
            ));
        }
        let max = if logical == "SKILL.md" {
            MAX_DOCUMENT_BYTES
        } else {
            MAX_RESOURCE_BYTES
        };
        if before.len() > max as u64 {
            return Err(limit("A skill text file exceeds its byte boundary"));
        }
        check()?;
        self.check_directories()?;
        let mut file = open_text(path)?;
        verify_file(&before, &paths::stat_file(&file)?)?;
        self.check_directories()?;
        let mut bytes = Vec::with_capacity(before.len() as usize);
        let mut buffer = [0_u8; 8_192];
        loop {
            check()?;
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if bytes.len() + count > max {
                return Err(limit("A skill text file grew beyond its boundary"));
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        check()?;
        verify_file(&before, &paths::stat_file(&file)?)?;
        verify_file(&before, &paths::ordinary(path, 1)?)?;
        if bytes.len() as u64 != before.len() {
            return Err(changed());
        }
        self.check_directories()?;
        self.total_bytes += bytes.len();
        if self.total_bytes > MAX_TEXT_BYTES {
            return Err(limit("Skill text total exceeds its byte boundary"));
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| Error::new("skillText", "Skill text must be UTF-8"))?;
        if text.contains('\0') {
            return Err(Error::new(
                "skillText",
                "Skill text cannot contain binary NUL bytes",
            ));
        }
        self.accepted_files.push(FileIdentity {
            path: path.into(),
            stat: before,
        });
        self.files.push(TextFile {
            path: logical.to_owned(),
            text,
        });
        Ok(())
    }
}

/// Windows cloud placeholders (OneDrive and similar) and non-symlink reparse
/// files. Always false elsewhere.
#[cfg(any(windows, test))]
fn placeholder_attributes(attributes: u32) -> bool {
    const REPARSE_POINT: u32 = 0x0000_0400;
    const OFFLINE: u32 = 0x0000_1000;
    const RECALL_ON_OPEN: u32 = 0x0004_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    attributes & (REPARSE_POINT | OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}
#[cfg(windows)]
fn is_offline_placeholder(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    placeholder_attributes(metadata.file_attributes())
}
#[cfg(not(windows))]
fn is_offline_placeholder(_metadata: &fs::Metadata) -> bool {
    false
}

fn verify_file(before: &paths::NativeStat, now: &paths::NativeStat) -> Result<()> {
    if !now.is_file()
        || now.is_alias()
        || now.identity().2 != 1
        || now.identity() != before.identity()
        || now.len() != before.len()
        || now.modified()? != before.modified()?
    {
        return Err(changed());
    }
    Ok(())
}
fn open_text(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        // No write/delete sharing: bytes and the final name remain pinned while
        // this ordinary file is read. Actual handle identity still gets checked.
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    Ok(options.open(path)?)
}
fn portable_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 512
        || path.split('/').count() > MAX_DEPTH
        || path
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(path_error());
    }
    for segment in path.split('/') {
        let base = segment.split('.').next().unwrap_or("").to_uppercase();
        let device = matches!(
            base.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.chars().count() == 1
                    && suffix
                        .chars()
                        .all(|c| c.is_ascii_digit() || matches!(c, '¹' | '²' | '³'))
            })
        });
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.len() > 255
            || segment.ends_with(' ')
            || segment.ends_with('.')
            || device
        {
            return Err(path_error());
        }
    }
    Ok(())
}
fn supported_file(path: &str) -> bool {
    if matches!(path, "SKILL.md" | "LICENSE" | "LICENSE.txt") {
        return true;
    }
    let lower = path.to_ascii_lowercase();
    (lower.starts_with("references/") || lower.starts_with("assets/"))
        && !lower.ends_with("/skill.md")
        && lower.rsplit('.').next().is_some_and(|extension| {
            matches!(extension, "md" | "txt" | "json" | "yaml" | "yml" | "csv")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Barrier},
        thread,
    };
    #[tokio::test]
    async fn desktop_lifecycle_skill_shutdown_waits_original_picker_return() {
        let owner = Arc::new(SkillDirectoryImport::default());
        let held = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let native = owner.clone();
        let entered = held.clone();
        let finish = release.clone();
        let original = thread::spawn(move || {
            native.pick(
                "original",
                || {
                    entered.wait();
                    finish.wait();
                    Ok(None)
                },
                || Ok(()),
            )
        });
        held.wait();
        owner.quiesce();
        assert!(owner.busy.load(Ordering::SeqCst));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), owner.drain())
                .await
                .is_err()
        );
        release.wait();
        assert!(original.join().unwrap().is_err());
        owner.drain().await;
        assert!(!owner.busy.load(Ordering::SeqCst));
        let called = AtomicBool::new(false);
        assert!(
            owner
                .pick(
                    "late",
                    || {
                        called.store(true, Ordering::SeqCst);
                        Ok(None)
                    },
                    || Ok(())
                )
                .is_err()
        );
        assert!(!called.load(Ordering::SeqCst));
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir()
                .join(format!("momoki-skill-import-{}", uuid::Uuid::new_v4()));
            let root = base.join("creative-flow");
            fs::create_dir_all(root.join("references")).unwrap();
            fs::write(
                root.join("SKILL.md"),
                "\u{feff}---\r\nname: creative-flow\r\ndescription: 描述\r\n---\r\n正文\r\n",
            )
            .unwrap();
            Self(root)
        }
        fn capture(&self) -> Result<Value> {
            SkillDirectoryImport::default().pick(
                "skillimport_test",
                || Ok(Some(self.0.clone())),
                || Ok(()),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[test]
    fn skill_import_preserves_exact_text_prunes_scripts_hidden_and_nested_packages() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("references/guide.md"), "参考\r\n").unwrap();
        fs::create_dir_all(fixture.0.join("scripts/deep/tree")).unwrap();
        fs::write(fixture.0.join("scripts/deep/tree/run.sh"), "never read").unwrap();
        fs::create_dir_all(fixture.0.join(".hidden/deep")).unwrap();
        fs::create_dir_all(fixture.0.join("references/nested")).unwrap();
        fs::write(fixture.0.join("references/nested/SKILL.md"), "other skill").unwrap();
        fs::write(fixture.0.join("references/nested/other.md"), "other body").unwrap();
        fs::write(fixture.0.join("references/picture.png"), [0, 255, 2]).unwrap();
        let result = fixture.capture().unwrap();
        assert_eq!(result["directoryName"], "creative-flow");
        assert_eq!(result["files"].as_array().unwrap().len(), 2);
        assert_eq!(
            result["files"][0]["text"],
            fs::read_to_string(fixture.0.join("SKILL.md")).unwrap()
        );
        assert_eq!(result["files"][1]["text"], "参考\r\n");
        assert_eq!(result["exclusions"]["count"], 4);
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("never read")
        );
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains(&fixture.0.to_string_lossy().to_string())
        );
    }
    #[test]
    fn skill_import_closed_request_and_quiet_cancel() {
        let request = json!({"version":1,"session":uuid::Uuid::new_v4(),"workspaceId":uuid::Uuid::new_v4(),"generation":1,"operationId":"skillimport_1"});
        assert!(
            serde_json::from_value::<SkillImportEnvelope>(request.clone())
                .unwrap()
                .scope()
                .is_ok()
        );
        let mut foreign = request.clone();
        foreign["path"] = json!("/tmp/foreign");
        assert!(serde_json::from_value::<SkillImportEnvelope>(foreign).is_err());
        let mut invalid = request;
        invalid["operationId"] = json!("../outside");
        assert!(
            serde_json::from_value::<SkillImportEnvelope>(invalid)
                .unwrap()
                .scope()
                .is_err()
        );
        assert_eq!(
            SkillDirectoryImport::default()
                .pick("pick_1", || Ok(None), || Ok(()))
                .unwrap(),
            json!({"status":"canceled","operationId":"pick_1"})
        );
    }
    #[test]
    fn skill_import_cloud_placeholder_attributes_are_excluded_not_fatal() {
        // Windows-only attribute classification; the walk consults it per file.
        assert!(placeholder_attributes(0x0040_0000 | 0x20)); // recall on data access
        assert!(placeholder_attributes(0x0004_0000)); // recall on open
        assert!(placeholder_attributes(0x1000)); // offline
        assert!(placeholder_attributes(0x400)); // non-symlink reparse file
        assert!(!placeholder_attributes(0x20)); // archive: ordinary file
        assert!(!placeholder_attributes(0x80)); // normal
        // On this host ordinary files are never classified as placeholders.
        let fixture = Fixture::new();
        fs::write(fixture.0.join("references/guide.md"), "参考").unwrap();
        let metadata = fs::symlink_metadata(fixture.0.join("references/guide.md")).unwrap();
        assert!(!is_offline_placeholder(&metadata) || cfg!(windows));
        assert_eq!(fixture.capture().unwrap()["files"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn skill_import_requires_root_document() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.0.join("SKILL.md")).unwrap();
        assert_eq!(fixture.capture().unwrap_err().code, "skillRoot");
    }
    #[test]
    fn skill_import_blocks_duplicate_picker_until_real_return_and_releases_errors() {
        let owner = Arc::new(SkillDirectoryImport::default());
        let opened = Arc::new(Barrier::new(2));
        let close = Arc::new(Barrier::new(2));
        let picker = {
            let owner = Arc::clone(&owner);
            let opened = Arc::clone(&opened);
            let close = Arc::clone(&close);
            thread::spawn(move || {
                owner.pick(
                    "old",
                    || {
                        opened.wait();
                        close.wait();
                        Ok(None)
                    },
                    || Ok(()),
                )
            })
        };
        opened.wait();
        owner.invalidate();
        assert_eq!(
            owner
                .pick("new", || panic!("duplicate chooser"), || Ok(()))
                .unwrap_err()
                .code,
            "busy"
        );
        close.wait();
        assert_eq!(picker.join().unwrap().unwrap_err().code, "changed");
        assert_eq!(
            owner.pick("new", || Ok(None), || Ok(())).unwrap()["status"],
            "canceled"
        );
        assert!(
            owner
                .pick(
                    "error",
                    || Err(Error::new("io", "picker failed")),
                    || Ok(())
                )
                .is_err()
        );
        assert!(owner.pick("again", || Ok(None), || Ok(())).is_ok());
    }
    #[test]
    fn skill_import_checks_session_after_picker_and_while_reading() {
        let fixture = Fixture::new();
        let mut count = 0;
        let result = SkillDirectoryImport::default().pick(
            "session",
            || Ok(Some(fixture.0.clone())),
            || {
                count += 1;
                if count >= 2 {
                    Err(Error::new("session", "stale"))
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.unwrap_err().code, "session");
        let mut count = 0;
        let result = SkillDirectoryImport::default().pick(
            "session",
            || Ok(Some(fixture.0.clone())),
            || {
                count += 1;
                if count >= 9 {
                    Err(Error::new("session", "stale during capture"))
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.unwrap_err().code, "session");
        assert!(count >= 9);
    }
    #[test]
    fn skill_import_rejects_invalid_utf8_binary_and_resource_file_count_limits() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("references/guide.md"), [0xff, 0xfe]).unwrap();
        assert_eq!(fixture.capture().unwrap_err().code, "skillText");
        fs::write(fixture.0.join("references/guide.md"), [0, 2]).unwrap();
        assert_eq!(fixture.capture().unwrap_err().code, "skillText");
        fs::write(
            fixture.0.join("references/guide.md"),
            vec![b'a'; MAX_RESOURCE_BYTES + 1],
        )
        .unwrap();
        assert_eq!(fixture.capture().unwrap_err().code, "skillLimit");
        fs::remove_file(fixture.0.join("references/guide.md")).unwrap();
        for index in 0..32 {
            fs::write(fixture.0.join(format!("references/{index}.txt")), "a").unwrap();
        }
        assert_eq!(fixture.capture().unwrap_err().code, "skillLimit");
    }
    #[test]
    fn skill_import_rejects_entry_depth_raw_and_escaped_response_limits() {
        let fixture = Fixture::new();
        for index in 0..1_024 {
            fs::write(fixture.0.join(format!("references/{index}.bin")), "").unwrap();
        }
        assert_eq!(fixture.capture().unwrap_err().code, "skillLimit");
        fs::remove_dir_all(fixture.0.join("references")).unwrap();
        fs::create_dir_all(fixture.0.join("references/one/two/three")).unwrap();
        assert_eq!(fixture.capture().unwrap_err().code, "skillLimit");
        fs::remove_dir_all(fixture.0.join("references")).unwrap();
        fs::create_dir(fixture.0.join("references")).unwrap();
        for index in 0..4 {
            fs::write(
                fixture.0.join(format!("references/{index}.txt")),
                vec![b'a'; MAX_RESOURCE_BYTES],
            )
            .unwrap();
        }
        assert_eq!(fixture.capture().unwrap_err().code, "skillLimit");
        for index in 0..4 {
            fs::write(
                fixture.0.join(format!("references/{index}.txt")),
                vec![1; 120_000],
            )
            .unwrap();
        }
        assert_eq!(fixture.capture().unwrap_err().code, "skillLimit");
    }
    #[test]
    fn skill_import_rejects_portable_collisions_and_device_names() {
        for path in [
            "/file.md",
            "../file.md",
            "references/a\\b.txt",
            "references/a:ads.txt",
            "references/CON.txt",
            "references/COM¹.txt",
            "references/a. ",
            "references/a\n.md",
        ] {
            assert!(portable_path(path).is_err(), "{path}");
        }
        let fixture = Fixture::new();
        fs::write(fixture.0.join("references/Guide.md"), "one").unwrap();
        fs::write(fixture.0.join("references/guide.md"), "two").unwrap();
        // Case-insensitive native volumes cannot create both names. The pure
        // transport test separately exercises the hostile duplicate DTO.
        if fs::read_dir(fixture.0.join("references")).unwrap().count() == 2 {
            assert_eq!(fixture.capture().unwrap_err().code, "skillPath");
        }
    }
    #[cfg(unix)]
    #[test]
    fn skill_import_rejects_symlink_hardlink_and_replaced_file_or_ancestor() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture.0.parent().unwrap().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, fixture.0.join("references/link.md")).unwrap();
        assert_eq!(fixture.capture().unwrap_err().code, "containment");
        fs::remove_file(fixture.0.join("references/link.md")).unwrap();
        fs::hard_link(&outside, fixture.0.join("references/link.md")).unwrap();
        assert_eq!(fixture.capture().unwrap_err().code, "containment");
        fs::remove_file(fixture.0.join("references/link.md")).unwrap();
        let original = paths::ordinary(&fixture.0.join("SKILL.md"), 1).unwrap();
        fs::rename(fixture.0.join("SKILL.md"), fixture.0.join("old.md")).unwrap();
        fs::write(fixture.0.join("SKILL.md"), "replacement").unwrap();
        assert!(
            verify_file(
                &original,
                &paths::ordinary(&fixture.0.join("SKILL.md"), 1).unwrap()
            )
            .is_err()
        );
        let before = DirectoryIdentity {
            path: fixture.0.join("references"),
            stat: paths::ordinary_directory(&fixture.0.join("references")).unwrap(),
            contents: true,
        };
        fs::rename(
            fixture.0.join("references"),
            fixture.0.join("old-references"),
        )
        .unwrap();
        fs::create_dir(fixture.0.join("references")).unwrap();
        assert_eq!(before.check().unwrap_err().code, "changed");
    }
    #[test]
    fn skill_import_rejects_root_replacement_during_capture() {
        let fixture = Fixture::new();
        let mut replaced = false;
        let root = fs::canonicalize(&fixture.0).unwrap();
        let mut check = || -> Result<()> {
            // Capture has recorded the selected root before entering walk. This
            // seam changes the actual namespace during traversal, not a copy of
            // its validation predicate.
            if !replaced && paths::ordinary_directory(&root).is_ok() {
                replaced = true;
                let old = root.with_file_name("old-root");
                fs::rename(&root, &old)?;
                fs::create_dir(&root)?;
                fs::write(root.join("SKILL.md"), "foreign")?;
            }
            Ok(())
        };
        // Capture directly calls check before recording identity; hold until the
        // second callback to make replacement occur after its boundary snapshot.
        let mut calls = 0;
        let result = Capture::read(&fixture.0, &mut || {
            calls += 1;
            if calls > 1 {
                check()?;
            }
            Ok(())
        });
        assert!(result.is_err());
        assert!(replaced);
    }
    #[test]
    fn skill_import_rechecks_previously_read_file_before_returning_snapshot() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("references/z-guide.md"), "second text").unwrap();
        let root_document = fixture.0.join("SKILL.md");
        let original_modified = paths::ordinary(&root_document, 1)
            .unwrap()
            .modified()
            .unwrap();
        let root_directory_modified = paths::ordinary_directory(&fixture.0)
            .unwrap()
            .modified()
            .unwrap();
        let mut calls = 0;
        let mut changed_first = false;
        // Once Capture has pushed the root document, walking references invokes
        // the session hook before reading its sibling. The real accepted file
        // is overwritten in place, which does not change directory mtime.
        let result = Capture::read(&fixture.0, &mut || {
            calls += 1;
            if calls == 11 {
                let file = OpenOptions::new().write(true).open(&root_document)?;
                file.set_times(
                    std::fs::FileTimes::new()
                        .set_modified(original_modified + std::time::Duration::from_secs(2)),
                )?;
                changed_first = true;
                assert_eq!(
                    paths::ordinary_directory(&fixture.0)?.modified()?,
                    root_directory_modified
                );
            }
            Ok(())
        });
        assert!(
            changed_first,
            "mutation seam must be reached; calls={calls}"
        );
        assert_eq!(result.err().unwrap().code, "changed");
    }
}
