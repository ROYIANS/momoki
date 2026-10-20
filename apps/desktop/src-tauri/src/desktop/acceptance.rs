//! Acceptance-only fixed native fixtures and report sink. This module and ACL are absent in normal builds.
use super::*;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AcceptanceEnvelope {
    version: u32,
    action: AcceptanceAction,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum AcceptanceAction {
    Setup {},
    Report { json: String },
    Ready {},
    OpenDeniedProbe {},
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceReply {
    version: u32,
    generation: u64,
    state: Option<State>,
    report_saved: bool,
}

fn acceptance_root() -> Result<PathBuf> {
    let root = std::env::var_os("MOMOKI_ACCEPTANCE_ROOT")
        .ok_or_else(|| Error::new("acceptance", "Launch the finite packaged runner first"))?;
    let root = PathBuf::from(root);
    let canonical = paths::canonical_root(&root)?;
    if canonical
        .file_name()
        .is_none_or(|name| !name.to_string_lossy().starts_with("run-"))
    {
        return Err(Error::new("acceptance", "Expected isolated run directory"));
    }
    Ok(canonical)
}
const FIXTURES: &[(&str, &str, &[u8])] = &[
    (
        "image.png",
        "image/png",
        include_bytes!("../../../fixtures/media/image.png"),
    ),
    (
        "tone.wav",
        "audio/wav",
        include_bytes!("../../../fixtures/media/tone.wav"),
    ),
    (
        "tone.mp3",
        "audio/mpeg",
        include_bytes!("../../../fixtures/media/tone.mp3"),
    ),
    (
        "tone.aac",
        "audio/aac",
        include_bytes!("../../../fixtures/media/tone.aac"),
    ),
    (
        "tone.m4a",
        "audio/mp4",
        include_bytes!("../../../fixtures/media/tone.m4a"),
    ),
    (
        "movie.mp4",
        "video/mp4",
        include_bytes!("../../../fixtures/media/movie.mp4"),
    ),
    (
        "document.pdf",
        "application/pdf",
        include_bytes!("../../../fixtures/media/document.pdf"),
    ),
    (
        "document.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        include_bytes!("../../../fixtures/media/document.docx"),
    ),
];

#[tauri::command]
pub async fn acceptance_request(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<Bridge>>,
    request: AcceptanceEnvelope,
) -> Result<AcceptanceReply> {
    trusted(&window)?;
    if request.version != 1 {
        return Err(Error::new("wire", "Acceptance version"));
    }
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let root=acceptance_root()?;
        let mut report_saved=false;
        match request.action {
            AcceptanceAction::OpenDeniedProbe {}=>{
                if window.app_handle().get_webview_window("denied-probe").is_some(){return Err(Error::new("acceptance","Close the existing denial probe first"));}
                tauri::WebviewWindowBuilder::new(window.app_handle(),"denied-probe",tauri::WebviewUrl::App("index.html".into()))
                    .title("拒绝权限验收 · 非主窗口").inner_size(720.0,480.0).incognito(true)
                    .on_navigation(crate::bundled_origin::accepts)
                    .build().map_err(|e|Error::new("acceptance",e.to_string()))?;
            }
            AcceptanceAction::Setup {}=>{
                let generation=lock(&bridge)?.generation;
                let canceled=AtomicBool::new(false);
                let workspace=root.join("workspace");
                transition(&bridge,generation,&canceled,||Ok((StorageWorker::create(&workspace,Hooks::default())?,workspace)))?;
                let opened_generation=lock(&bridge)?.generation;
                let worker=worker(&bridge,opened_generation)?;
                worker.run(Job::SaveProject(Project{id:"原型/项目 Case-é-e\u{301}".into(),title:"原生兼容性验收".into()}))?;
                let sources=root.join("sources");fs::create_dir(&sources)?;
                for (name,mime,bytes) in FIXTURES {
                    let source=sources.join(name);let mut file=paths::exclusive(&source)?;file.write_all(bytes)?;file.sync_all()?;drop(file);
                    worker.run(Job::Import(ImportRequest{source,asset_id:(*name).into(),project_id:"原型/项目 Case-é-e\u{301}".into(),kind:AssetKind::Media,display_name:(*name).into(),mime_type:(*mime).into(),timing:None}))?;
                }
                // Exact byte transfer remains valid after source removal; fixture sources are native-owned disposable files.
                fs::remove_file(sources.join("image.png"))?;
                worker.run(Job::Backup(root.join("snapshot")))?;
            }
            AcceptanceAction::Report{json}=>{
                if json.is_empty()||json.len()>4*1024*1024{return Err(Error::new("size","Finite report boundary"));}
                let value:serde_json::Value=serde_json::from_str(&json)?;
                let object=value.as_object().ok_or_else(||Error::new("wire","Report must be object"))?;
                if object.keys().any(|k|!matches!(k.as_str(),"version"|"environment"|"events"|"finishedAt"))||object.get("version")!=Some(&serde_json::json!(1))||!object.get("events").is_some_and(serde_json::Value::is_array){return Err(Error::new("wire","Closed acceptance report schema"));}
                // Own fixed sink may be replaced by later milestones; renderer cannot supply a destination.
                let stage=root.join(format!("{}.report",uuid::Uuid::new_v4()));let mut file=paths::exclusive(&stage)?;file.write_all(json.as_bytes())?;file.sync_all()?;drop(file);
                fs::rename(stage,root.join("report.json"))?;paths::namespace_checkpoint(&root)?;report_saved=true;
            }
            AcceptanceAction::Ready {}=>{fs::write(root.join("ready.json"),serde_json::to_vec(&serde_json::json!({"version":1,"atMillis":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|Error::new("clock",e.to_string()))?.as_millis()}))?)?;}
        }
        let inner=lock(&bridge)?;
        Ok(AcceptanceReply{version:1,generation:inner.generation,state:inner.worker.as_ref().map(|w|state_of(w)).transpose()?,report_saved})
    }).await.map_err(|e|Error::new("bridge",e.to_string()))?
}
