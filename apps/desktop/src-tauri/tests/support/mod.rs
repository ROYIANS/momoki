use momoki_native_storage::{AssetKind, ImportRequest, Job, Outcome, State, StorageWorker};
use std::{fs, path::PathBuf};

pub struct Fixture {
    pub base: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let base =
            std::env::temp_dir().join(format!("momoki-native-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        Self { base }
    }
    pub fn path(&self, name: &str) -> PathBuf {
        self.base.join(name)
    }
    pub fn source(&self) -> PathBuf {
        let source = self.path("source.bin");
        fs::write(
            &source,
            (0..(momoki_native_storage::CHUNK * 2 + 7))
                .map(|i| (i % 251) as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        source
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}
pub fn request(source: PathBuf, id: &str, owner: &str) -> ImportRequest {
    ImportRequest {
        source,
        asset_id: id.into(),
        project_id: owner.into(),
        kind: AssetKind::Media,
        display_name: "same.bin".into(),
        mime_type: "application/octet-stream".into(),
        timing: None,
    }
}
pub fn state(worker: &StorageWorker) -> State {
    match worker.run(Job::State).unwrap() {
        Outcome::State(s) => s,
        _ => panic!("state"),
    }
}
