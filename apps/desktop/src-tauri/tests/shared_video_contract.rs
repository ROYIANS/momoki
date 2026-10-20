mod support;

use momoki_native_storage::{
    Baseline, Beat, BeatPatch, EpisodePatch, Hooks, Job, Outcome, Project, ScriptRange, Shot,
    ShotPatch, StorageWorker, UndoReceipt, VideoProjectPatch,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use support::{Fixture, request, state};

fn wire<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn open() -> (Fixture, StorageWorker, String) {
    let fixture = Fixture::new();
    let worker = StorageWorker::create(fixture.path("workspace"), Hooks::default()).unwrap();
    worker
        .run(Job::SaveProject(Project {
            id: "shared-video".into(),
            title: "Shared video".into(),
        }))
        .unwrap();
    let episode = state(&worker).episodes[0].id.clone();
    (fixture, worker, episode)
}

fn add(worker: &StorageWorker, episode: &str, count: u32, beat: Option<&str>) -> Vec<Shot> {
    match worker
        .run(Job::AddShots {
            project_id: "shared-video".into(),
            episode_id: episode.into(),
            count,
            at_order: None,
            beat_id: beat.map(str::to_owned),
        })
        .unwrap()
    {
        Outcome::Shots(shots) => shots,
        _ => panic!("expected committed shots"),
    }
}

fn inverse(outcome: Outcome) -> UndoReceipt {
    match outcome {
        Outcome::Undo(receipt) => receipt,
        _ => panic!("expected committed inverse receipt"),
    }
}

fn baseline(field: &str, value: &str) -> Option<Baseline> {
    Some(wire(json!({"fields": [{"field": field, "value": value}]})))
}

#[test]
fn serialized_null_is_a_clear_and_missing_is_unchanged() {
    let absent: ShotPatch = wire(json!({}));
    let clear: ShotPatch = wire(json!({"beatId": null, "sceneId": null, "styleId": null}));
    assert_eq!(absent.beat_id, None);
    assert_eq!(clear.beat_id, Some(None));
    assert_eq!(clear.scene_id, Some(None));
    assert_eq!(clear.style_id, Some(None));
    let beat: BeatPatch = wire(json!({"sceneId": null, "scriptRange": null}));
    assert_eq!(beat.scene_id, Some(None));
    assert_eq!(beat.script_range, Some(None));
    let archive: VideoProjectPatch = wire(json!({"archivedAt": null}));
    assert_eq!(archive.archived_at, Some(None));
    assert!(serde_json::from_value::<Beat>(json!({"id":"b","episodeId":"e","order":0,"title":"t","content":"","timeOfDay":"","characterIds":[],"sceneId":null,"scriptRange":null,"scriptStart":0,"scriptEnd":1})).is_err());
    assert!(serde_json::from_value::<ShotPatch>(json!({"sql": "DELETE FROM shots"})).is_err());
}

#[test]
fn scalar_baselines_conflict_merge_converge_and_reject_invalid_fields() {
    let (_fixture, worker, episode) = open();
    let shot = add(&worker, &episode, 1, None).remove(0);
    worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"content":"new"})),
            baseline: baseline("content", ""),
        })
        .unwrap();
    worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"notes":"separate edit"})),
            baseline: baseline("notes", ""),
        })
        .unwrap();
    worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"content":"new"})),
            baseline: baseline("content", "stale"),
        })
        .unwrap();
    let error = worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"content":"overwrite"})),
            baseline: baseline("content", ""),
        })
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    for fields in [
        json!([{"field":"unknown","value":""}]),
        json!([{"field":"notes","value":"separate edit"}]),
        json!([{"field":"content","value":"new"},{"field":"content","value":"new"}]),
    ] {
        let error = worker
            .run(Job::PatchShot {
                shot_id: shot.id.clone(),
                patch: wire(json!({"content":"another"})),
                baseline: Some(wire(json!({"fields":fields}))),
            })
            .unwrap_err();
        assert_ne!(
            error.code, "conflict",
            "invalid baseline must be a validation error"
        );
    }
    let latest = state(&worker).shots.remove(0);
    assert_eq!(latest.content, "new");
    assert_eq!(latest.notes, "separate edit");
    worker.close().unwrap();
}

#[test]
fn duration_baselines_compare_numbers_across_javascript_and_rust_serialization() {
    let (_fixture, worker, episode) = open();
    let shot = add(&worker, &episode, 1, None).remove(0);
    worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"durationSec":3})),
            baseline: None,
        })
        .unwrap();
    for (expected, requested) in [("3", 3.5), ("3.5", 0.0), ("0", 0.001), ("0.001", 86400.0)] {
        worker
            .run(Job::PatchShot {
                shot_id: shot.id.clone(),
                patch: wire(json!({"durationSec":requested})),
                baseline: baseline("durationSec", expected),
            })
            .unwrap();
        assert_eq!(state(&worker).shots[0].duration_sec, requested);
    }
    worker
        .run(Job::PatchShot {
            shot_id: shot.id,
            patch: wire(json!({"durationSec":86400})),
            baseline: baseline("durationSec", "0"),
        })
        .unwrap();
    worker.close().unwrap();
}

#[test]
fn nullable_string_baselines_conflict_and_converge_after_unassignment() {
    let (_fixture, worker, episode) = open();
    let shot = add(&worker, &episode, 1, None).remove(0);
    let beat = Beat {
        id: "baseline-beat".into(),
        episode_id: episode,
        order: 0,
        title: "Opening".into(),
        content: "".into(),
        time_of_day: "".into(),
        character_ids: vec![],
        scene_id: None,
        script_range: None,
    };
    worker.run(Job::SaveBeat(beat.clone())).unwrap();
    // It already has the requested null value, so a stale string baseline converges.
    worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"beatId":null})),
            baseline: baseline("beatId", "previous-beat"),
        })
        .unwrap();
    let error = worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"beatId":beat.id})),
            baseline: baseline("beatId", "previous-beat"),
        })
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(state(&worker).shots[0].beat_id, None);
    worker
        .run(Job::PatchShot {
            shot_id: shot.id,
            patch: wire(json!({"beatId":beat.id})),
            baseline: baseline("beatId", ""),
        })
        .unwrap();
    worker.close().unwrap();
}

#[test]
fn invalid_multi_add_and_bulk_leave_every_row_unchanged() {
    let (_fixture, worker, episode) = open();
    let shots = add(&worker, &episode, 2, None);
    let before = state(&worker).shots;
    for (owner, beat, order) in [
        ("other-project", None, None),
        ("shared-video", Some("missing-beat"), None),
        ("shared-video", None, Some(99)),
    ] {
        assert!(
            worker
                .run(Job::AddShots {
                    project_id: owner.into(),
                    episode_id: episode.clone(),
                    count: 2,
                    at_order: order,
                    beat_id: beat.map(str::to_owned)
                })
                .is_err(),
            "invalid add was accepted: owner={owner}, beat={beat:?}, order={order:?}"
        );
        assert_eq!(state(&worker).shots, before);
    }
    assert!(
        worker
            .run(Job::BulkShots {
                episode_id: episode.clone(),
                shot_ids: vec![shots[0].id.clone(), "missing-shot".into()],
                patch: wire(json!({"status":"approved"}))
            })
            .is_err()
    );
    assert!(
        worker
            .run(Job::BulkShots {
                episode_id: episode,
                shot_ids: shots.iter().map(|shot| shot.id.clone()).collect(),
                patch: wire(json!({"durationSec":-1}))
            })
            .is_err()
    );
    assert_eq!(state(&worker).shots, before);
    worker.close().unwrap();
}

#[test]
fn committed_bulk_inverse_survives_reopen_and_preserves_unrelated_edits() {
    let (fixture, worker, episode) = open();
    let shot = add(&worker, &episode, 1, None).remove(0);
    let receipt = inverse(
        worker
            .run(Job::BulkShots {
                episode_id: episode.clone(),
                shot_ids: vec![shot.id.clone()],
                patch: wire(json!({"status":"approved","durationSec":7.5})),
            })
            .unwrap(),
    );
    let second = inverse(
        worker
            .run(Job::BulkShots {
                episode_id: episode,
                shot_ids: vec![shot.id.clone()],
                patch: wire(json!({"category":"detail"})),
            })
            .unwrap(),
    );
    assert_ne!(receipt.token, second.token);
    worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"notes":"later unrelated edit"})),
            baseline: baseline("notes", ""),
        })
        .unwrap();
    worker.close().unwrap();
    let reopened = StorageWorker::open(fixture.path("workspace"), Hooks::default()).unwrap();
    reopened
        .run(Job::VideoUndo {
            receipt: receipt.clone(),
        })
        .unwrap();
    let latest = state(&reopened).shots.remove(0);
    assert_eq!(latest.status, "draft");
    assert_eq!(latest.duration_sec, shot.duration_sec);
    assert_eq!(latest.category, "detail");
    assert_eq!(latest.notes, "later unrelated edit");
    assert!(reopened.run(Job::VideoUndo { receipt }).is_err());
    reopened.run(Job::VideoUndo { receipt: second }).unwrap();
    assert_eq!(state(&reopened).shots[0].category, "");
    reopened.close().unwrap();
}

#[test]
fn duplicate_scene_returns_its_rows_and_inverse_preserves_source_edits() {
    let (_fixture, worker, episode) = open();
    worker
        .run(Job::PatchEpisode {
            episode_id: episode.clone(),
            patch: wire::<EpisodePatch>(json!({"script":"A😀B"})),
            baseline: None,
        })
        .unwrap();
    let beat = Beat {
        id: "shared-beat".into(),
        episode_id: episode.clone(),
        order: 0,
        title: "Opening".into(),
        content: "😀".into(),
        time_of_day: "day".into(),
        character_ids: vec![],
        scene_id: None,
        script_range: Some(ScriptRange {
            start: 1,
            end: 3,
            excerpt: "😀".into(),
        }),
    };
    worker.run(Job::SaveBeat(beat.clone())).unwrap();
    let source = add(&worker, &episode, 1, Some(&beat.id)).remove(0);
    let duplicated = match worker
        .run(Job::DuplicateBeat {
            episode_id: episode,
            beat_id: beat.id.clone(),
            include_shots: true,
        })
        .unwrap()
    {
        Outcome::DuplicateBeat(result) => result,
        _ => panic!("duplicate result must contain committed IDs and receipt"),
    };
    assert_ne!(duplicated.beat.id, beat.id);
    assert_eq!(duplicated.shots.len(), 1);
    assert_eq!(
        duplicated.shots[0].beat_id.as_deref(),
        Some(duplicated.beat.id.as_str())
    );
    worker
        .run(Job::PatchShot {
            shot_id: source.id.clone(),
            patch: wire(json!({"notes":"source changed after copying"})),
            baseline: None,
        })
        .unwrap();
    worker
        .run(Job::VideoUndo {
            receipt: duplicated.receipt,
        })
        .unwrap();
    let current = state(&worker);
    assert_eq!(current.beats, vec![beat]);
    assert_eq!(current.shots.len(), 1);
    assert_eq!(current.shots[0].id, source.id);
    assert_eq!(current.shots[0].notes, "source changed after copying");
    worker.close().unwrap();
}

#[test]
fn editing_script_clears_stale_utf16_associations_without_losing_scene_text() {
    let (_fixture, worker, episode) = open();
    worker
        .run(Job::PatchEpisode {
            episode_id: episode.clone(),
            patch: wire(json!({"script":"A😀B"})),
            baseline: None,
        })
        .unwrap();
    let beat = Beat {
        id: "range-beat".into(),
        episode_id: episode.clone(),
        order: 0,
        title: "Opening".into(),
        content: "Scene prose remains".into(),
        time_of_day: "".into(),
        character_ids: vec![],
        scene_id: None,
        script_range: Some(ScriptRange {
            start: 1,
            end: 3,
            excerpt: "😀".into(),
        }),
    };
    let mut invalid = beat.clone();
    invalid.script_range.as_mut().unwrap().end = 2;
    assert!(
        worker.run(Job::SaveBeat(invalid)).is_err(),
        "partial surrogate/excerpt range must be rejected"
    );
    assert!(state(&worker).beats.is_empty());
    worker.run(Job::SaveBeat(beat)).unwrap();
    worker
        .run(Job::PatchEpisode {
            episode_id: episode,
            patch: wire(json!({"script":""})),
            baseline: baseline("script", "A😀B"),
        })
        .unwrap();
    let current = state(&worker);
    assert_eq!(current.episodes[0].script, "");
    assert_eq!(current.beats[0].content, "Scene prose remains");
    assert_eq!(current.beats[0].script_range, None);
    worker.close().unwrap();
}

#[test]
fn child_edits_and_inverse_touch_iso_project_time_without_reverting_later_metadata() {
    let (_fixture, worker, episode) = open();
    let initial = state(&worker);
    assert!(initial.video_projects[0].created_at.contains('T'));
    assert!(initial.video_projects[0].created_at.ends_with('Z'));
    assert!(initial.episodes[0].updated_at.contains('T'));
    let shot = add(&worker, &episode, 1, None).remove(0);
    let mut video = state(&worker).video_projects.remove(0);
    video.updated_at = "2000-01-01T00:00:00.000Z".into();
    worker.run(Job::SaveVideoProject(video)).unwrap();
    worker
        .run(Job::PatchShot {
            shot_id: shot.id.clone(),
            patch: wire(json!({"content":"new shot prose"})),
            baseline: None,
        })
        .unwrap();
    let touched = state(&worker).video_projects.remove(0).updated_at;
    assert!(touched.as_str() > "2000-01-01T00:00:00.000Z");
    assert!(touched.contains('T') && touched.ends_with('Z'));

    let receipt = inverse(
        worker
            .run(Job::BulkShots {
                episode_id: episode,
                shot_ids: vec![shot.id],
                patch: wire(json!({"status":"approved"})),
            })
            .unwrap(),
    );
    // Distinct clock ticks prove the inverse ignores automatic timestamp fields.
    std::thread::sleep(std::time::Duration::from_millis(3));
    worker
        .run(Job::UpdateVideoProject {
            project_id: "shared-video".into(),
            patch: wire(json!({"brief":"later unrelated project brief"})),
            baseline: None,
        })
        .unwrap();
    let later = state(&worker).video_projects.remove(0).updated_at;
    worker.run(Job::VideoUndo { receipt }).unwrap();
    let current = state(&worker);
    assert_eq!(current.shots[0].status, "draft");
    assert_eq!(current.shots[0].content, "new shot prose");
    assert_eq!(
        current.video_projects[0].brief,
        "later unrelated project brief"
    );
    assert!(current.video_projects[0].updated_at >= later);
    worker.close().unwrap();
}

#[test]
fn project_delete_removes_logical_assets_and_reopens_while_retaining_owned_bytes() {
    let (fixture, worker, _) = open();
    let asset = match worker
        .run(Job::Import(request(
            fixture.source(),
            "delete-asset",
            "shared-video",
        )))
        .unwrap()
    {
        Outcome::Asset(asset) => asset,
        _ => panic!("managed import"),
    };
    let owned = fixture
        .path("workspace")
        .join(&asset.reference.relative_path);
    worker
        .run(Job::DeleteProject {
            project_id: "shared-video".into(),
        })
        .unwrap();
    let current = state(&worker);
    assert!(current.projects.is_empty());
    assert!(current.assets.is_empty());
    assert!(current.episodes.is_empty());
    assert!(owned.is_file());
    worker.close().unwrap();
    let reopened = StorageWorker::open(fixture.path("workspace"), Hooks::default()).unwrap();
    assert!(state(&reopened).projects.is_empty());
    assert!(owned.is_file());
    reopened.close().unwrap();
}
