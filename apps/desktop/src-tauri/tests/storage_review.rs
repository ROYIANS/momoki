mod support;
use momoki_native_storage::{Hooks, Job, Outcome, Project, StorageWorker};
use std::fs;
use support::{Fixture, request, state};

#[cfg(feature = "test-hooks")]
#[test]
fn backup_rejects_destination_bytes_changed_before_completion() {
    let f = Fixture::new();
    let backup = f.path("backup");
    let modified = backup.clone();
    let hooks = Hooks::new(move |point| {
        if point == "backup-before-completion" {
            let db = rusqlite::Connection::open(modified.join("metadata.sqlite"))?;
            let relative: String =
                db.query_row("SELECT relative_path FROM assets", [], |r| r.get(0))?;
            fs::write(modified.join(relative), b"changed after copying")?;
        }
        Ok(())
    });
    let w = StorageWorker::create(f.path("workspace"), hooks).unwrap();
    w.run(Job::SaveProject(Project {
        id: "project".into(),
        title: "Fixture".into(),
    }))
    .unwrap();
    w.run(Job::Import(request(f.source(), "asset", "project")))
        .unwrap();
    assert!(
        w.run(Job::Backup(backup.clone())).is_err(),
        "corrupt destination cannot report a complete backup"
    );
    assert!(!backup.join("backup.complete.json").exists());
    w.close().unwrap();
}

#[cfg(feature = "test-hooks")]
#[test]
fn retained_import_preserves_changed_stage_after_publication() {
    use std::sync::{Arc, Mutex};
    for alias in [false, true] {
        let fixture = Fixture::new();
        let workspace = fixture.path("workspace");
        let workspace_for_hook = workspace.clone();
        let foreign = fixture.path("foreign-link");
        let foreign_for_hook = foreign.clone();
        let reached = Arc::new(Mutex::new(None));
        let observed = Arc::clone(&reached);
        let hooks = Hooks::new(move |point| {
            if point == "link-before-unlink" {
                let stage = fs::read_dir(workspace_for_hook.join("staging"))?
                    .next()
                    .expect("one staged import")?
                    .path();
                if alias {
                    fs::hard_link(&stage, &foreign_for_hook)?;
                } else {
                    fs::remove_file(&stage)?;
                    fs::write(&stage, b"foreign stage bytes")?;
                }
                *observed.lock().unwrap() = Some(stage);
            }
            Ok(())
        });
        let worker = StorageWorker::create(workspace.clone(), hooks).unwrap();
        worker
            .run(Job::SaveProject(Project {
                id: "project".into(),
                title: "Fixture".into(),
            }))
            .unwrap();
        let source = fixture.source();
        let bytes = fs::read(&source).unwrap();
        assert!(
            worker
                .run(Job::Import(request(source, "asset", "project")))
                .is_err()
        );
        let stage = reached
            .lock()
            .unwrap()
            .clone()
            .expect("cleanup boundary reached");
        let expected = if alias {
            &bytes[..]
        } else {
            &b"foreign stage bytes"[..]
        };
        assert_eq!(fs::read(&stage).unwrap(), expected);
        assert!(
            state(&worker).assets.is_empty(),
            "unverified import became ready"
        );
        worker.close().unwrap();
        assert!(
            StorageWorker::open(workspace, Hooks::default()).is_err(),
            "ambiguous intent was silently recovered"
        );
        assert_eq!(fs::read(&stage).unwrap(), expected);
        if alias {
            assert_eq!(fs::read(foreign).unwrap(), bytes);
        }
    }
}

#[test]
fn strict_snapshot_rejects_unknown_index_and_duplicate_manifest_keys() {
    let f = Fixture::new();
    let w = StorageWorker::create(f.path("workspace"), Hooks::default()).unwrap();
    w.run(Job::SaveProject(Project {
        id: "project".into(),
        title: "Fixture".into(),
    }))
    .unwrap();
    w.run(Job::Import(request(f.source(), "asset", "project")))
        .unwrap();
    let before = state(&w);
    assert!(matches!(
        w.run(Job::Backup(f.path("backup"))).unwrap(),
        Outcome::Backup(_)
    ));
    w.close().unwrap();
    let path = f.path("backup/backup.complete.json");
    let original = fs::read_to_string(&path).unwrap();
    let duplicated = original.replacen("{", "{\"schema\":1,", 1);
    fs::write(&path, duplicated).unwrap();
    assert!(
        StorageWorker::restore(f.path("backup"), f.path("bad-duplicate"), Hooks::default())
            .is_err()
    );
    assert!(!f.path("bad-duplicate").exists());
    fs::write(&path, original).unwrap();
    let db = rusqlite::Connection::open(f.path("workspace/metadata.sqlite")).unwrap();
    db.execute(
        "CREATE UNIQUE INDEX unexpected_title ON projects(title)",
        [],
    )
    .unwrap();
    drop(db);
    assert!(
        StorageWorker::open(f.path("workspace"), Hooks::default()).is_err(),
        "an unknown index changes the versioned schema"
    );
    assert_eq!(before.projects.len(), 1);
}

#[test]
fn journal_alias_added_after_open_cannot_modify_external_file() {
    let f = Fixture::new();
    let w = StorageWorker::create(f.path("workspace"), Hooks::default()).unwrap();
    let original = vec![0x5a; 8192];
    fs::write(f.path("external"), &original).unwrap();
    fs::hard_link(
        f.path("external"),
        f.path("workspace/metadata.sqlite-journal"),
    )
    .unwrap();
    let result = w.run(Job::SaveProject(Project {
        id: "new".into(),
        title: "Fixture".into(),
    }));
    let preserved = fs::read(f.path("external")).unwrap() == original;
    w.close().unwrap();
    assert!(
        preserved,
        "SQLite operation modified an external journal hard-link target"
    );
    assert!(
        result.is_err(),
        "managed journal alias must reject before a transaction"
    );
}

#[cfg(feature = "test-hooks")]
#[test]
fn every_close_caller_waits_until_writer_is_released() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant};
    let f = Fixture::new();
    let reached = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&reached);
    let gate = Arc::clone(&release);
    let hooks = Hooks::new(move |point| {
        if point == "postcommit" {
            flag.store(true, Ordering::SeqCst);
            while !gate.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        Ok(())
    });
    let w = StorageWorker::create(f.path("workspace"), hooks).unwrap();
    w.run(Job::SaveProject(Project {
        id: "project".into(),
        title: "Fixture".into(),
    }))
    .unwrap();
    let import = w
        .submit(Job::Import(request(f.source(), "asset", "project")))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !reached.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    let first = w.clone();
    let first_close = std::thread::spawn(move || first.close());
    while w.submit(Job::State).is_ok() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    let second = w.clone();
    let (tx, rx) = mpsc::channel();
    let second_close = std::thread::spawn(move || tx.send(second.close()).unwrap());
    let returned_early = rx.recv_timeout(Duration::from_millis(50)).is_ok();
    release.store(true, Ordering::SeqCst);
    import.wait().unwrap();
    first_close.join().unwrap().unwrap();
    second_close.join().unwrap();
    let reopened = StorageWorker::open(f.path("workspace"), Hooks::default()).unwrap();
    reopened.close().unwrap();
    assert!(
        !returned_early,
        "a successful second close returned while the worker still held the writer lock"
    );
}

#[cfg(feature = "test-hooks")]
#[test]
fn restore_rechecks_copied_target_before_ready_marker() {
    let f = Fixture::new();
    let w = StorageWorker::create(f.path("workspace"), Hooks::default()).unwrap();
    w.run(Job::SaveProject(Project {
        id: "project".into(),
        title: "Fixture".into(),
    }))
    .unwrap();
    w.run(Job::Import(request(f.source(), "asset", "project")))
        .unwrap();
    let original = state(&w);
    w.run(Job::Backup(f.path("backup"))).unwrap();
    w.close().unwrap();
    let restored_root = f.path("restored");
    let mutated_root = restored_root.clone();
    let relative = original.assets[0].reference.relative_path.clone();
    let hooks = Hooks::new(move |point| {
        if point == "restore-before-completion" {
            fs::write(mutated_root.join(&relative), b"changed after restoring")?;
        }
        Ok(())
    });
    let result = StorageWorker::restore(f.path("backup"), &restored_root, hooks);
    if let Ok(worker) = &result {
        worker.close().unwrap();
    }
    assert!(
        result.is_err(),
        "corrupt restored target cannot report ready"
    );
    assert!(!restored_root.join("workspace.ready.json").exists());
    assert!(StorageWorker::open(&restored_root, Hooks::default()).is_err());
}

#[cfg(feature = "test-hooks")]
#[test]
fn submit_close_race_never_leaves_completed_operations_cancelable() {
    use std::sync::{Arc, Barrier};
    for _ in 0..32 {
        let f = Fixture::new();
        let w = StorageWorker::create(f.path("workspace"), Hooks::default()).unwrap();
        let start = Arc::new(Barrier::new(17));
        let submissions: Vec<_> = (0..16)
            .map(|_| {
                let caller = w.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    caller.submit(Job::State)
                })
            })
            .collect();
        let closer = w.clone();
        let close_start = Arc::clone(&start);
        let close = std::thread::spawn(move || {
            close_start.wait();
            closer.close()
        });
        let operations: Vec<_> = submissions
            .into_iter()
            .filter_map(|t| t.join().unwrap().ok())
            .collect();
        close.join().unwrap().unwrap();
        for operation in operations {
            let id = operation.id.clone();
            let _ = operation.wait();
            assert!(
                !w.cancel(&id).unwrap(),
                "a completed lifecycle retains a nonexistent live operation"
            );
        }
    }
}

#[test]
fn bounded_managed_read_verifies_complete_bytes_and_retains_corrupt_refs() {
    let f = Fixture::new();
    let source = f.source();
    let expected = fs::read(&source).unwrap();
    let w = StorageWorker::create(f.path("workspace"), Hooks::default()).unwrap();
    w.run(Job::SaveProject(Project {
        id: "project".into(),
        title: "Fixture".into(),
    }))
    .unwrap();
    w.run(Job::Import(request(source, "asset", "project")))
        .unwrap();
    let before = state(&w);
    match w
        .run(Job::ReadAsset {
            asset_id: "asset".into(),
            max_bytes: expected.len(),
        })
        .unwrap()
    {
        Outcome::Bytes(bytes) => assert_eq!(bytes, expected),
        _ => panic!("managed read"),
    }
    assert!(
        w.run(Job::ReadAsset {
            asset_id: "asset".into(),
            max_bytes: 0
        })
        .is_err()
    );
    assert!(
        w.run(Job::ReadAsset {
            asset_id: "asset".into(),
            max_bytes: 32 * 1024 * 1024 + 1
        })
        .is_err()
    );
    assert!(
        w.run(Job::ReadAsset {
            asset_id: "../external".into(),
            max_bytes: expected.len()
        })
        .is_err()
    );
    let path = f
        .path("workspace")
        .join(&before.assets[0].reference.relative_path);
    let mut corrupt = expected.clone();
    corrupt[0] ^= 1;
    fs::write(&path, &corrupt).unwrap();
    assert_eq!(
        w.run(Job::ReadAsset {
            asset_id: "asset".into(),
            max_bytes: expected.len()
        })
        .unwrap_err()
        .code,
        "corrupt"
    );
    assert_eq!(state(&w), before);
    fs::remove_file(&path).unwrap();
    assert!(
        w.run(Job::ReadAsset {
            asset_id: "asset".into(),
            max_bytes: expected.len()
        })
        .is_err()
    );
    assert_eq!(state(&w), before);
    w.close().unwrap();
}

#[test]
fn wrong_ready_fields_and_corrupt_database_are_not_initialized_over() {
    let f = Fixture::new();
    let w = StorageWorker::create(f.path("workspace"), Hooks::default()).unwrap();
    w.close().unwrap();
    let marker = f.path("workspace/workspace.ready.json");
    let original = fs::read(&marker).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    value["unknown"] = serde_json::json!(true);
    fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(StorageWorker::open(f.path("workspace"), Hooks::default()).is_err());
    fs::write(&marker, original).unwrap();
    fs::write(f.path("workspace/metadata.sqlite"), b"corrupt database").unwrap();
    assert!(StorageWorker::open(f.path("workspace"), Hooks::default()).is_err());
    assert_eq!(
        fs::read(f.path("workspace/metadata.sqlite")).unwrap(),
        b"corrupt database"
    );
    assert!(StorageWorker::create(f.path("workspace"), Hooks::default()).is_err());
    assert_eq!(
        fs::read(f.path("workspace/metadata.sqlite")).unwrap(),
        b"corrupt database"
    );
}
