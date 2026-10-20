use momoki_native_storage::{
    AssetKind, Error, Hooks, ImportRequest, Job, Operation, Project, StorageWorker, TimingRef,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    time::Duration,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    State,
    SaveProject {
        project: Project,
    },
    Import {
        source: PathBuf,
        asset_id: String,
        project_id: String,
        kind: AssetKind,
        display_name: String,
        mime_type: String,
        timing: Option<TimingRef>,
    },
    SubmitImport {
        source: PathBuf,
        asset_id: String,
        project_id: String,
        kind: AssetKind,
        display_name: String,
        mime_type: String,
        timing: Option<TimingRef>,
    },
    Availability,
    Backup {
        destination: PathBuf,
    },
    Wait {
        operation_id: String,
    },
    Cancel {
        operation_id: String,
    },
    Close,
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("Expected create/open/restore")?;
    let root = PathBuf::from(args.next().ok_or("Expected absolute root")?);
    let restore_source = if mode == "restore" {
        Some(PathBuf::from(args.next().ok_or("Expected backup source")?))
    } else {
        None
    };
    let remaining: Vec<_> = args.collect();
    let hooks = if remaining.is_empty() {
        Hooks::default()
    } else {
        if remaining.len() != 6
            || remaining[0] != "--pause"
            || remaining[2] != "--marker"
            || remaining[4] != "--release"
        {
            return Err("Expected --pause POINT --marker FILE --release FILE".into());
        }
        let point = remaining[1].clone();
        let marker = PathBuf::from(&remaining[3]);
        let release = PathBuf::from(&remaining[5]);
        let once = std::sync::atomic::AtomicBool::new(false);
        Hooks::new(move |name| {
            if name != point || once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Ok(());
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)?;
            file.write_all(name.as_bytes())?;
            file.sync_all()?;
            while !release.exists() {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(())
        })
    };
    let worker = match mode.as_str() {
        "create" => StorageWorker::create(&root, hooks)?,
        "open" => StorageWorker::open(&root, hooks)?,
        "restore" => StorageWorker::restore(restore_source.expect("restore source"), &root, hooks)?,
        _ => return Err("Unknown mode".into()),
    };
    println!("{}", serde_json::json!({"ok":true,"ready":true}));
    io::stdout().flush()?;
    let mut stdin = io::stdin().lock();
    let mut operations: HashMap<String, Operation> = HashMap::new();
    loop {
        let mut line = Vec::new();
        let n = stdin
            .by_ref()
            .take(256 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if n > 256 * 1024 {
            return Err("Request exceeded 256 KiB".into());
        }
        let parsed = serde_json::from_slice::<Request>(&line);
        let result: Result<serde_json::Value, Error> =
            parsed
                .map_err(Error::from)
                .and_then(|request| match request {
                    Request::State => Ok(serde_json::to_value(worker.run(Job::State)?)?),
                    Request::SaveProject { project } => Ok(serde_json::to_value(
                        worker.run(Job::SaveProject(project))?,
                    )?),
                    Request::Import {
                        source,
                        asset_id,
                        project_id,
                        kind,
                        display_name,
                        mime_type,
                        timing,
                    } => Ok(serde_json::to_value(worker.run(Job::Import(
                        ImportRequest {
                            source,
                            asset_id,
                            project_id,
                            kind,
                            display_name,
                            mime_type,
                            timing,
                        },
                    ))?)?),
                    Request::SubmitImport {
                        source,
                        asset_id,
                        project_id,
                        kind,
                        display_name,
                        mime_type,
                        timing,
                    } => {
                        let operation = worker.submit(Job::Import(ImportRequest {
                            source,
                            asset_id,
                            project_id,
                            kind,
                            display_name,
                            mime_type,
                            timing,
                        }))?;
                        let id = operation.id.clone();
                        operations.insert(id.clone(), operation);
                        Ok(serde_json::json!({"operationId":id}))
                    }
                    Request::Availability => {
                        Ok(serde_json::to_value(worker.run(Job::Availability)?)?)
                    }
                    Request::Backup { destination } => {
                        Ok(serde_json::to_value(worker.run(Job::Backup(destination))?)?)
                    }
                    Request::Cancel { operation_id } => {
                        Ok(serde_json::json!({"canceled":worker.cancel(&operation_id)?}))
                    }
                    Request::Wait { operation_id } => Ok(serde_json::to_value(
                        operations
                            .remove(&operation_id)
                            .ok_or_else(|| Error {
                                code: "missing",
                                message: "Unknown operation".into(),
                            })?
                            .wait()?,
                    )?),
                    Request::Close => {
                        worker.close()?;
                        Ok(serde_json::json!({"closed":true}))
                    }
                });
        match result {
            Ok(value) => println!("{}", serde_json::json!({"ok":true,"value":value})),
            Err(error) => println!("{}", serde_json::json!({"ok":false,"error":error})),
        }
        io::stdout().flush()?;
    }
    worker.close()?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
