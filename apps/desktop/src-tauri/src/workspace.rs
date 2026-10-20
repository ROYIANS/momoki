use crate::{
    AssetAvailability, Availability, Baseline, Beat, BeatPatch, Episode, EpisodePatch, Error,
    Hooks, Job, Outcome, ReadyMarker, Result, SCHEMA, Shot, ShotPatch, State, database, paths,
};
use rusqlite::{Connection, params};
use std::{collections::BTreeSet, fs, io::Read, path::PathBuf};

pub(crate) struct Workspace {
    pub root: PathBuf,
    pub db: Connection,
    pub writer: Connection,
    pub id: String,
    pub hooks: Hooks,
    pub boundary: Boundary,
}

fn stamp() -> Result<String> {
    Ok(Connection::open_in_memory()?.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
        |row| row.get(0),
    )?)
}

fn numeric_shot_prefix(value: &str) -> Option<f64> {
    let value = value.trim_start();
    let sign = usize::from(value.starts_with(['+', '-']));
    let digits = value[sign..].bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0)
        .then(|| value[..sign + digits].parse::<f64>().ok())
        .flatten()
}

fn shot_number(value: f64) -> Result<String> {
    // Match the application's numeric-prefix numbering while retaining arbitrary
    // user-entered shot numbers. Large prefixes must never overflow an integer.
    if value < 1e21 {
        Ok(format!("{value:.0}"))
    } else {
        Ok(serde_json::to_string(&value)?)
    }
}

fn touch_project(db: &Connection, project_id: &str) -> Result<()> {
    db.execute(
        "UPDATE video_projects SET updated_at=? WHERE project_id=?",
        params![stamp()?, project_id],
    )?;
    Ok(())
}

fn project_contents(state: &State, id: &str) -> Result<serde_json::Value> {
    let episodes: Vec<_> = state
        .episodes
        .iter()
        .filter(|e| e.project_id == id)
        .collect();
    let episode_ids: BTreeSet<_> = episodes.iter().map(|e| e.id.as_str()).collect();
    Ok(serde_json::to_value((
        state.projects.iter().find(|p| p.id == id),
        state.video_projects.iter().find(|p| p.project_id == id),
        &episodes,
        state
            .beats
            .iter()
            .filter(|b| episode_ids.contains(b.episode_id.as_str()))
            .collect::<Vec<_>>(),
        state
            .shots
            .iter()
            .filter(|s| s.project_id == id)
            .collect::<Vec<_>>(),
    ))?)
}

fn touch_video_changes(before: &State, after: &mut State) -> Result<()> {
    let mut changed = Vec::new();
    for video in &after.video_projects {
        if project_contents(before, &video.project_id)?
            != project_contents(after, &video.project_id)?
        {
            changed.push(video.project_id.clone());
        }
    }
    if !changed.is_empty() {
        let updated = stamp()?;
        for video in &mut after.video_projects {
            if changed.contains(&video.project_id) {
                video.updated_at = updated.clone();
            }
        }
    }
    Ok(())
}

fn sort_state(state: &mut State) {
    state.projects.sort_by(|a, b| a.id.cmp(&b.id));
    state
        .video_projects
        .sort_by(|a, b| a.project_id.cmp(&b.project_id));
    state
        .episodes
        .sort_by(|a, b| (&a.project_id, a.order, &a.id).cmp(&(&b.project_id, b.order, &b.id)));
    state
        .beats
        .sort_by(|a, b| (&a.episode_id, a.order, &a.id).cmp(&(&b.episode_id, b.order, &b.id)));
    state
        .shots
        .sort_by(|a, b| (&a.episode_id, a.order, &a.id).cmp(&(&b.episode_id, b.order, &b.id)));
}

fn validate_selection(state: &State, episode_id: &str, ids: &[String]) -> Result<()> {
    if ids.is_empty()
        || ids.len() > crate::contracts::MAX_RECORDS
        || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
    {
        return Err(Error::new(
            "invalid",
            "Selection must be unique and nonempty",
        ));
    }
    if !state.episodes.iter().any(|e| e.id == episode_id) {
        return Err(Error::new("missing", "Episode missing"));
    }
    if ids.iter().any(|id| {
        !state
            .shots
            .iter()
            .any(|s| s.id == *id && s.episode_id == episode_id)
    }) {
        return Err(Error::new("ownership", "Shot does not belong to episode"));
    }
    Ok(())
}

fn inverse_rows<T>(
    current: &[T],
    before: &[T],
    after: &[T],
    key: impl Fn(&T) -> &str,
) -> Result<Vec<T>>
where
    T: serde::Serialize + serde::de::DeserializeOwned + Clone,
{
    let mut result = current.to_vec();
    let keys: BTreeSet<_> = before
        .iter()
        .chain(after)
        .map(|row| key(row).to_owned())
        .collect();
    for id in keys {
        let original = before.iter().find(|row| key(row) == id);
        let committed = after.iter().find(|row| key(row) == id);
        let current_index = result.iter().position(|row| key(row) == id);
        match (original, committed, current_index) {
            (None, Some(committed), Some(index)) => {
                if serde_json::to_value(&result[index])? != serde_json::to_value(committed)? {
                    return Err(Error::new(
                        "conflict",
                        "Created record changed after command",
                    ));
                }
                result.remove(index);
            }
            (None, Some(_), None) => {}
            (Some(original), None, None) => result.push(original.clone()),
            (Some(original), None, Some(index)) => {
                if serde_json::to_value(&result[index])? != serde_json::to_value(original)? {
                    return Err(Error::new("conflict", "Deleted identity was reused"));
                }
            }
            (Some(original), Some(committed), Some(index)) => {
                let old = serde_json::to_value(original)?;
                let committed = serde_json::to_value(committed)?;
                let mut live = serde_json::to_value(&result[index])?;
                let old = old
                    .as_object()
                    .ok_or_else(|| Error::new("undo", "Invalid undo row"))?;
                let committed = committed
                    .as_object()
                    .ok_or_else(|| Error::new("undo", "Invalid undo row"))?;
                let live = live
                    .as_object_mut()
                    .ok_or_else(|| Error::new("undo", "Invalid undo row"))?;
                for (field, value) in old {
                    // Modification times are derived bookkeeping. Undo touches the
                    // owning project again instead of restoring an obsolete time.
                    if field != "updatedAt" && committed.get(field) != Some(value) {
                        if live.get(field) != committed.get(field) && live.get(field) != Some(value)
                        {
                            return Err(Error::new(
                                "conflict",
                                format!("Undo field {field} changed"),
                            ));
                        }
                        live.insert(field.clone(), value.clone());
                    }
                }
                result[index] = serde_json::from_value(serde_json::Value::Object(live.clone()))?;
            }
            (Some(original), Some(committed), None)
                if serde_json::to_value(original)? != serde_json::to_value(committed)? =>
            {
                return Err(Error::new("conflict", "Undo target missing"));
            }
            _ => {}
        }
    }
    Ok(result)
}

fn validate_episode_input(state: &State, episode: &Episode) -> Result<()> {
    let mut episodes: Vec<_> = state
        .episodes
        .iter()
        .filter(|e| e.id != episode.id)
        .cloned()
        .collect();
    episodes.push(episode.clone());
    database::validate_video_rows(
        &state.projects,
        &state.video_projects,
        &episodes,
        &state.beats,
        &state.shots,
        false,
    )
}
fn validate_beat_input(state: &State, beat: &Beat) -> Result<()> {
    let mut beats: Vec<_> = state
        .beats
        .iter()
        .filter(|b| b.id != beat.id)
        .cloned()
        .collect();
    beats.push(beat.clone());
    database::validate_video_rows(
        &state.projects,
        &state.video_projects,
        &state.episodes,
        &beats,
        &state.shots,
        false,
    )
}
fn validate_shot_input(state: &State, shot: &Shot) -> Result<()> {
    let mut shots: Vec<_> = state
        .shots
        .iter()
        .filter(|s| s.id != shot.id)
        .cloned()
        .collect();
    shots.push(shot.clone());
    database::validate_video_rows(
        &state.projects,
        &state.video_projects,
        &state.episodes,
        &state.beats,
        &shots,
        false,
    )
}

fn typed_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| typed_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|b| typed_equal(value, b)))
        }
        _ => left == right,
    }
}

fn baseline_conflicts<T: serde::Serialize, P: serde::Serialize>(
    resource: &str,
    id: &str,
    baseline: Option<&Baseline>,
    current: &T,
    patch: &P,
) -> Result<Option<crate::ConflictOutcome>> {
    let Some(baseline) = baseline else {
        return Ok(None);
    };
    if baseline.fields.len() > 64 {
        return Err(Error::new("wire", "Baseline field boundary"));
    }
    let current = serde_json::to_value(current)?;
    let patch = serde_json::to_value(patch)?;
    let current = current
        .as_object()
        .ok_or_else(|| Error::new("wire", "Invalid baseline owner"))?;
    let patch = patch
        .as_object()
        .ok_or_else(|| Error::new("wire", "Invalid patch"))?;
    let mut seen = BTreeSet::new();
    let mut conflicts = Vec::new();
    for field in &baseline.fields {
        if !seen.insert(&field.field)
            || !patch.contains_key(&field.field)
            || !current.contains_key(&field.field)
        {
            return Err(Error::new(
                "wire",
                "Baseline contains duplicate, unknown or unpatched field",
            ));
        }
        if field.value.len() > 2_000_000 {
            return Err(Error::new("size", "Baseline value boundary"));
        }
        let live = &current[&field.field];
        let requested = &patch[&field.field];
        let nullable_string = matches!(
            field.field.as_str(),
            "beatId" | "sceneId" | "styleId" | "archivedAt"
        );
        let expected =
            if (nullable_string || field.field == "scriptRange") && field.value.is_empty() {
                serde_json::Value::Null
            } else if nullable_string || matches!(live, serde_json::Value::String(_)) {
                serde_json::Value::String(field.value.clone())
            } else if live.is_null() && field.value.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(&field.value)
                    .map_err(|_| Error::new("wire", "Invalid typed baseline value"))?
            };
        if !typed_equal(live, &expected) && !typed_equal(live, requested) {
            conflicts.push(crate::ConflictField {
                field: field.field.clone(),
                current: wire_baseline_value(live),
                expected: field.value.clone(),
                requested: wire_baseline_value(requested),
            });
        }
    }
    Ok((!conflicts.is_empty()).then(|| crate::ConflictOutcome {
        resource: resource.into(),
        id: id.into(),
        fields: conflicts,
    }))
}

fn wire_baseline_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value
            .as_f64()
            .map(|v| v.to_string())
            .unwrap_or_else(|| value.to_string()),
        other => other.to_string(),
    }
}

fn baseline_check<T: serde::Serialize, P: serde::Serialize>(
    resource: &str,
    id: &str,
    baseline: Option<&Baseline>,
    current: &T,
    patch: &P,
) -> Result<()> {
    if let Some(conflict) = baseline_conflicts(resource, id, baseline, current, patch)? {
        return Err(Error::new(
            "conflict",
            format!("{resource} {id} field {} changed", conflict.fields[0].field),
        ));
    }
    Ok(())
}

// Diagnostic only: the failed command has not written anything. The bridge
// obtains the worker's latest closed state before constructing this outcome.
#[cfg(feature = "desktop")]
pub(crate) fn conflict_for_job(state: &State, job: &Job) -> Result<Option<crate::ConflictOutcome>> {
    match job {
        Job::PatchVideoProject { video, baseline } => {
            let current = state
                .video_projects
                .iter()
                .find(|v| v.project_id == video.project_id)
                .ok_or_else(|| Error::new("missing", "Video project missing"))?;
            baseline_conflicts(
                "videoProject",
                &video.project_id,
                baseline.as_ref(),
                current,
                video,
            )
        }
        Job::UpdateVideoProject {
            project_id,
            patch,
            baseline,
        } => {
            let current = state
                .video_projects
                .iter()
                .find(|v| &v.project_id == project_id)
                .ok_or_else(|| Error::new("missing", "Video project missing"))?;
            let project = state
                .projects
                .iter()
                .find(|p| &p.id == project_id)
                .ok_or_else(|| Error::new("missing", "Project missing"))?;
            let mut current = serde_json::to_value(current)?;
            current["title"] = serde_json::Value::String(project.title.clone());
            baseline_conflicts("project", project_id, baseline.as_ref(), &current, patch)
        }
        Job::PatchEpisode {
            episode_id,
            patch,
            baseline,
        } => {
            let current = state
                .episodes
                .iter()
                .find(|e| &e.id == episode_id)
                .ok_or_else(|| Error::new("missing", "Episode missing"))?;
            baseline_conflicts("episode", episode_id, baseline.as_ref(), current, patch)
        }
        Job::PatchBeat {
            beat_id,
            patch,
            baseline,
            ..
        } => {
            let current = state
                .beats
                .iter()
                .find(|b| &b.id == beat_id)
                .ok_or_else(|| Error::new("missing", "Beat missing"))?;
            baseline_conflicts("beat", beat_id, baseline.as_ref(), current, patch)
        }
        Job::PatchShot {
            shot_id,
            patch,
            baseline,
        } => {
            let current = state
                .shots
                .iter()
                .find(|s| &s.id == shot_id)
                .ok_or_else(|| Error::new("missing", "Shot missing"))?;
            baseline_conflicts("shot", shot_id, baseline.as_ref(), current, patch)
        }
        _ => Ok(None),
    }
}

fn patch_episode(
    state: &State,
    episode_id: &str,
    patch: &EpisodePatch,
    baseline: Option<&Baseline>,
) -> Result<Episode> {
    let current = state
        .episodes
        .iter()
        .find(|e| e.id == episode_id)
        .cloned()
        .ok_or_else(|| Error::new("missing", "Episode missing"))?;
    baseline_check("episode", episode_id, baseline, &current, patch)?;
    let mut next = current.clone();
    if let Some(v) = &patch.title {
        next.title = v.clone();
    }
    if let Some(v) = &patch.logline {
        next.logline = v.clone();
    }
    if let Some(v) = &patch.script {
        next.script = v.clone();
    }
    if let Some(v) = &patch.shot_filters {
        next.shot_filters = v.clone();
    }
    next.updated_at = stamp()?;
    let mut episodes = state.episodes.clone();
    if let Some(slot) = episodes.iter_mut().find(|e| e.id == episode_id) {
        *slot = next.clone();
    }
    let mut beats = state.beats.clone();
    if patch.script.is_some() {
        for beat in beats.iter_mut().filter(|b| b.episode_id == episode_id) {
            if beat
                .script_range
                .as_ref()
                .is_some_and(|range| !database::valid_script_range(&next.script, range))
            {
                beat.script_range = None;
            }
        }
    }
    database::validate_video_rows(
        &state.projects,
        &state.video_projects,
        &episodes,
        &beats,
        &state.shots,
        false,
    )?;
    Ok(next)
}

fn patch_beat(
    state: &State,
    beat_id: &str,
    patch: &BeatPatch,
    baseline: Option<&Baseline>,
) -> Result<Beat> {
    let current = state
        .beats
        .iter()
        .find(|b| b.id == beat_id)
        .cloned()
        .ok_or_else(|| Error::new("missing", "Beat missing"))?;
    baseline_check("beat", beat_id, baseline, &current, patch)?;
    let mut next = current.clone();
    if let Some(v) = &patch.title {
        next.title = v.clone();
    }
    if let Some(v) = &patch.content {
        next.content = v.clone();
    }
    if let Some(v) = &patch.time_of_day {
        next.time_of_day = v.clone();
    }
    if let Some(v) = &patch.character_ids {
        next.character_ids = v.clone();
    }
    if let Some(v) = &patch.scene_id {
        next.scene_id = v.clone();
    }
    if let Some(v) = &patch.script_range {
        next.script_range = v.clone();
    }
    let mut beats = state.beats.clone();
    if let Some(slot) = beats.iter_mut().find(|b| b.id == beat_id) {
        *slot = next.clone();
    }
    database::validate_video_rows(
        &state.projects,
        &state.video_projects,
        &state.episodes,
        &beats,
        &state.shots,
        false,
    )?;
    Ok(next)
}

fn patch_shot(
    state: &State,
    shot_id: &str,
    patch: &ShotPatch,
    baseline: Option<&Baseline>,
) -> Result<Shot> {
    let current = state
        .shots
        .iter()
        .find(|s| s.id == shot_id)
        .cloned()
        .ok_or_else(|| Error::new("missing", "Shot missing"))?;
    baseline_check("shot", shot_id, baseline, &current, patch)?;
    let mut next = current.clone();
    if let Some(v) = &patch.status {
        next.status = v.clone();
    }
    if let Some(v) = patch.duration_sec {
        next.duration_sec = v;
    }
    if let Some(v) = &patch.beat_id {
        next.beat_id = v.clone();
    }
    if let Some(v) = &patch.content {
        next.content = v.clone();
    }
    if let Some(v) = &patch.notes {
        next.notes = v.clone();
    }
    if let Some(v) = &patch.category {
        next.category = v.clone();
    }
    if let Some(v) = &patch.scene_id {
        next.scene_id = v.clone();
    }
    if let Some(v) = &patch.character_ids {
        next.character_ids = v.clone();
    }
    if let Some(v) = &patch.prop_ids {
        next.prop_ids = v.clone();
    }
    if let Some(v) = &patch.style_id {
        next.style_id = v.clone();
    }
    if let Some(v) = &patch.scene_closeup {
        next.scene_closeup = v.clone();
    }
    if let Some(v) = &patch.sound {
        next.sound = v.clone();
    }
    if let Some(v) = &patch.emotion {
        next.emotion = v.clone();
    }
    if let Some(v) = &patch.camera_angle {
        next.camera_angle = v.clone();
    }
    if let Some(v) = &patch.camera_gear {
        next.camera_gear = v.clone();
    }
    if let Some(v) = &patch.focal_length {
        next.focal_length = v.clone();
    }
    if let Some(v) = &patch.shot_number {
        next.shot_number = v.clone();
    }
    let mut shots = state.shots.clone();
    if let Some(slot) = shots.iter_mut().find(|s| s.id == shot_id) {
        *slot = next.clone();
    }
    database::validate_video_rows(
        &state.projects,
        &state.video_projects,
        &state.episodes,
        &state.beats,
        &shots,
        false,
    )?;
    Ok(next)
}

fn video_state(state: &State, project_id: &str) -> Result<crate::VideoWorkspaceState> {
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .cloned()
        .ok_or_else(|| Error::new("missing", "Project missing"))?;
    let video = state
        .video_projects
        .iter()
        .find(|p| p.project_id == project_id)
        .cloned()
        .ok_or_else(|| Error::new("missing", "Video project missing"))?;
    let episodes: Vec<_> = state
        .episodes
        .iter()
        .filter(|e| e.project_id == project_id)
        .cloned()
        .collect();
    let episode_ids: BTreeSet<_> = episodes.iter().map(|e| e.id.as_str()).collect();
    let beats: Vec<_> = state
        .beats
        .iter()
        .filter(|b| episode_ids.contains(b.episode_id.as_str()))
        .cloned()
        .collect();
    let shots: Vec<_> = state
        .shots
        .iter()
        .filter(|s| s.project_id == project_id)
        .cloned()
        .collect();
    let mut referenced_asset_ids: Vec<_> = state
        .references
        .iter()
        .filter(|r| r.project_id == project_id)
        .map(|r| r.asset_id.clone())
        .collect();
    referenced_asset_ids.sort();
    referenced_asset_ids.dedup();
    Ok(crate::VideoWorkspaceState {
        project,
        video,
        episodes,
        beats,
        shots,
        referenced_asset_ids,
    })
}

fn complete_order(existing: impl Iterator<Item = String>, ordered: &[String]) -> Result<()> {
    let expected: Vec<_> = existing.collect();
    if ordered.len() != expected.len()
        || ordered.iter().collect::<BTreeSet<_>>().len() != ordered.len()
        || ordered.iter().collect::<BTreeSet<_>>() != expected.iter().collect::<BTreeSet<_>>()
    {
        return Err(Error::new(
            "order",
            "Order list must contain every owned row exactly once",
        ));
    }
    Ok(())
}

pub(crate) struct Boundary {
    root: PathBuf,
    root_inode: (u64, u64),
    database_inode: (u64, u64),
    writer_inode: (u64, u64),
    database_path: PathBuf,
    writer_path: PathBuf,
    #[cfg(windows)]
    _directory_guards: Vec<paths::DirectoryGuard>,
}
impl Boundary {
    fn capture(root: &std::path::Path) -> Result<Self> {
        Self::capture_paths(
            root,
            &root.join("metadata.sqlite"),
            &root.join("writer.sqlite"),
        )
    }
    pub(crate) fn capture_paths(
        root: &std::path::Path,
        database: &std::path::Path,
        writer: &std::path::Path,
    ) -> Result<Self> {
        let identity = |metadata: paths::NativeStat| -> Result<(u64, u64)> {
            let (dev, ino, _) = metadata.identity();
            Ok((dev, ino))
        };
        #[cfg(windows)]
        let directory_guards = {
            let mut guards = paths::pin_ancestors(root)?;
            for parent in [database.parent(), writer.parent()].into_iter().flatten() {
                guards.extend(paths::pin_ancestors(parent)?);
            }
            guards
        };
        Ok(Self {
            #[cfg(windows)]
            _directory_guards: directory_guards,
            root: root.to_path_buf(),
            root_inode: identity(paths::ordinary_directory(root)?)?,
            database_inode: identity(paths::ordinary(database, 1)?)?,
            writer_inode: identity(paths::ordinary(writer, 1)?)?,
            database_path: database.to_owned(),
            writer_path: writer.to_owned(),
        })
    }
    pub fn validate(&self) -> Result<()> {
        paths::canonical_root(&self.root)?;
        database::check_files(&self.database_path)?;
        database::check_files(&self.writer_path)?;
        for (metadata, expected) in [
            (paths::ordinary_directory(&self.root)?, self.root_inode),
            (
                paths::ordinary(&self.database_path, 1)?,
                self.database_inode,
            ),
            (paths::ordinary(&self.writer_path, 1)?, self.writer_inode),
        ] {
            let (dev, ino, _) = metadata.identity();
            if (dev, ino) != expected {
                return Err(Error::new(
                    "containment",
                    "Opened workspace or database was replaced",
                ));
            }
        }
        Ok(())
    }
}
impl Workspace {
    fn commit_video(
        &mut self,
        resource: &str,
        ids: Vec<String>,
        before: &State,
        mut after: State,
        check: impl Fn() -> Result<()>,
    ) -> Result<crate::UndoReceipt> {
        touch_video_changes(before, &mut after)?;
        sort_state(&mut after);
        database::validate_state_closure(&after)?;
        let receipt = crate::UndoReceipt {
            token: uuid::Uuid::new_v4().to_string(),
            resource: resource.into(),
            ids,
        };
        let tx = self.db.transaction()?;
        database::write_video_state(&tx, &after)?;
        let before_json = serde_json::to_string(before)?;
        let after_json = serde_json::to_string(&after)?;
        if before_json.len() > 64 * 1024 * 1024 || after_json.len() > 64 * 1024 * 1024 {
            return Err(Error::new("size", "Undo snapshot boundary"));
        }
        let count: i64 = tx.query_row("SELECT count(*) FROM video_undo", [], |r| r.get(0))?;
        if count >= 1000 {
            return Err(Error::new("size", "Undo receipt boundary"));
        }
        tx.execute(
            "INSERT INTO video_undo VALUES (?,?,?,?,?)",
            params![
                receipt.token,
                receipt.resource,
                serde_json::to_string(&receipt.ids)?,
                before_json,
                after_json
            ],
        )?;
        self.hooks.hit("video-precommit")?;
        self.boundary.validate()?;
        check()?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn open(root: PathBuf, create: bool, hooks: Hooks) -> Result<Self> {
        let root = if create {
            paths::reserve(&root)?
        } else {
            paths::canonical_root(&root)?
        };
        #[cfg(windows)]
        let _startup_directory_guards = paths::pin_ancestors(&root)?;
        let ready = if create {
            None
        } else {
            Some(paths::read_json::<ReadyMarker>(
                &root.join("workspace.ready.json"),
            )?)
        };
        let writer_path = root.join("writer.sqlite");
        let create_writer = match fs::symlink_metadata(&writer_path) {
            Ok(_) => false,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(e) => return Err(e.into()),
        };
        let writer = database::connect(&writer_path, create_writer, false)?;
        writer.execute_batch("BEGIN EXCLUSIVE")?;
        let db = database::connect(&root.join("metadata.sqlite"), create, false)?;
        if create {
            database::initialize(&db, &uuid::Uuid::new_v4().to_string())?;
            paths::namespace_checkpoint(&root)?;
        }
        let state = database::validate(&db)?;
        database::validate_state_closure(&state)?;
        database::validate_receipts(&db, &state.workspace_id)?;
        if let Some(marker) = ready
            && (marker.format != "momoki.workspace.ready.v1"
                || marker.schema != SCHEMA
                || marker.workspace_id != state.workspace_id)
        {
            return Err(Error::new(
                "incomplete",
                "Workspace completion marker mismatch",
            ));
        }
        let boundary = Boundary::capture(&root)?;
        let mut workspace = Self {
            root,
            db,
            writer,
            id: state.workspace_id,
            hooks,
            boundary,
        };
        workspace.recover()?;
        if create {
            paths::publish_json(
                &workspace.root,
                "workspace.ready.json",
                &ReadyMarker {
                    format: "momoki.workspace.ready.v1".into(),
                    schema: SCHEMA,
                    workspace_id: workspace.id.clone(),
                },
            )?;
        }
        Ok(workspace)
    }
    pub fn state(&self) -> Result<State> {
        database::validate(&self.db)
    }
    pub fn run(&mut self, job: Job, check: impl Fn() -> Result<()>) -> Result<Outcome> {
        check()?;
        // Revalidate managed DB files before every operation. Hostile replacement between
        // these checks and OS opens is outside this prototype's proven protection.
        self.boundary.validate()?;
        match job {
            Job::State => Ok(Outcome::State(self.state()?)),
            Job::SaveProject(project) => {
                database::validate_project(&project)?;
                let count: i64 = self
                    .db
                    .query_row("SELECT count(*) FROM projects", [], |r| r.get(0))?;
                let existing: bool = self.db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
                    [&project.id],
                    |r| r.get(0),
                )?;
                if !existing && count >= crate::contracts::MAX_RECORDS as i64 {
                    return Err(Error::new("size", "Project boundary"));
                }
                let transaction = self.db.transaction()?;
                transaction.execute("INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title",params![project.id,project.title])?;
                let created = stamp()?;
                transaction.execute("INSERT INTO video_projects (project_id,mode,kind,aspect_preset,output_width,output_height,archived_at,created_at,brief,genre,audience,tone,logline,updated_at,column_visible,shot_default_duration,shot_auto_increment,shot_workspace_view,shot_filter_statuses,shot_filter_beats,shot_filter_gaps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO NOTHING", params![project.id, "film", "video", "16:9", 1920_i64, 1080_i64, Option::<String>::None, created, "", "", "", "", "", stamp()?, "category\u{1f}durationSec\u{1f}content\u{1f}notes", 3.0_f64, 1_i64, "design", "", "", ""])?;
                let has_episode: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM episodes WHERE project_id=?)",
                    [&project.id],
                    |r| r.get(0),
                )?;
                if !has_episode {
                    transaction.execute("INSERT INTO episodes (id,project_id,item_order,title,logline,script,created_at,updated_at,shot_filter_statuses,shot_filter_beats,shot_filter_gaps) VALUES (?,?,?,?,?,?,?,?,?,?,?)", params![uuid::Uuid::new_v4().to_string(), project.id, 0_i64, "第一集", "", "", stamp()?, stamp()?, "", "", ""])?;
                }
                touch_project(&transaction, &project.id)?;
                self.hooks.hit("project-precommit")?;
                self.boundary.validate()?;
                check()?;
                transaction.commit()?;
                Ok(Outcome::Project(project))
            }
            Job::CreateVideoProject { project, video } => {
                database::validate_project(&project)?;
                let mut projects = self.state()?.projects;
                projects.push(project.clone());
                database::validate_video_project(&video, &projects)?;
                if video.project_id != project.id {
                    return Err(Error::new("ownership", "Video project owner mismatch"));
                }
                let tx = self.db.transaction()?;
                tx.execute(
                    "INSERT INTO projects VALUES (?,?)",
                    params![project.id, project.title],
                )?;
                tx.execute("INSERT INTO video_projects (project_id,mode,kind,aspect_preset,output_width,output_height,archived_at,created_at,brief,genre,audience,tone,logline,updated_at,column_visible,shot_default_duration,shot_auto_increment,shot_workspace_view,shot_filter_statuses,shot_filter_beats,shot_filter_gaps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params![video.project_id, video.mode, video.kind, video.aspect_preset, video.output_width as i64, video.output_height as i64, video.archived_at, video.created_at, video.brief, video.genre, video.audience, video.tone, video.logline, video.updated_at, video.column_settings.visible.join("\u{1f}"), video.shot_settings.default_duration_sec, i64::from(video.shot_settings.auto_increment_shot_number), video.shot_settings.workspace_view, video.shot_settings.filters.statuses.join("\u{1f}"), video.shot_settings.filters.beat_ids.join("\u{1f}"), video.shot_settings.filters.gaps.join("\u{1f}")])?;
                tx.execute("INSERT INTO episodes (id,project_id,item_order,title,logline,script,created_at,updated_at,shot_filter_statuses,shot_filter_beats,shot_filter_gaps) VALUES (?,?,?,?,?,?,?,?,?,?,?)", params![uuid::Uuid::new_v4().to_string(), project.id, 0_i64, "第一集", "", "", stamp()?, stamp()?, "", "", ""])?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Project(project))
            }
            Job::DeleteProject { project_id } => {
                let state = self.state()?;
                if !state.projects.iter().any(|p| p.id == project_id) {
                    return Err(Error::new("missing", "Project missing"));
                }
                let tx = self.db.transaction()?;
                tx.execute("DELETE FROM refs WHERE project_id=?", [&project_id])?;
                tx.execute("DELETE FROM assets WHERE project_id=?", [&project_id])?;
                tx.execute("DELETE FROM shots WHERE project_id=?", [&project_id])?;
                tx.execute("DELETE FROM beats WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=?)", [&project_id])?;
                tx.execute("DELETE FROM episodes WHERE project_id=?", [&project_id])?;
                tx.execute(
                    "DELETE FROM video_projects WHERE project_id=?",
                    [&project_id],
                )?;
                tx.execute("DELETE FROM projects WHERE id=?", [&project_id])?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::State(self.state()?))
            }
            Job::SaveVideoProject(video) => {
                let state = self.state()?;
                database::validate_video_project(&video, &state.projects)?;
                let tx = self.db.transaction()?;
                tx.execute("INSERT INTO video_projects (project_id,mode,kind,aspect_preset,output_width,output_height,archived_at,created_at,brief,genre,audience,tone,logline,updated_at,column_visible,shot_default_duration,shot_auto_increment,shot_workspace_view,shot_filter_statuses,shot_filter_beats,shot_filter_gaps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode,kind=excluded.kind,aspect_preset=excluded.aspect_preset,output_width=excluded.output_width,output_height=excluded.output_height,archived_at=excluded.archived_at,created_at=excluded.created_at,brief=excluded.brief,genre=excluded.genre,audience=excluded.audience,tone=excluded.tone,logline=excluded.logline,updated_at=excluded.updated_at,column_visible=excluded.column_visible,shot_default_duration=excluded.shot_default_duration,shot_auto_increment=excluded.shot_auto_increment,shot_workspace_view=excluded.shot_workspace_view,shot_filter_statuses=excluded.shot_filter_statuses,shot_filter_beats=excluded.shot_filter_beats,shot_filter_gaps=excluded.shot_filter_gaps", params![video.project_id, video.mode, video.kind, video.aspect_preset, video.output_width as i64, video.output_height as i64, video.archived_at, video.created_at, video.brief, video.genre, video.audience, video.tone, video.logline, video.updated_at, video.column_settings.visible.join("\u{1f}"), video.shot_settings.default_duration_sec, i64::from(video.shot_settings.auto_increment_shot_number), video.shot_settings.workspace_view, video.shot_settings.filters.statuses.join("\u{1f}"), video.shot_settings.filters.beat_ids.join("\u{1f}"), video.shot_settings.filters.gaps.join("\u{1f}")])?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::VideoProject(video))
            }
            Job::PatchVideoProject {
                mut video,
                baseline,
            } => {
                let state = self.state()?;
                let current = state
                    .video_projects
                    .iter()
                    .find(|v| v.project_id == video.project_id)
                    .ok_or_else(|| Error::new("missing", "Video project missing"))?;
                baseline_check(
                    "videoProject",
                    &video.project_id,
                    baseline.as_ref(),
                    current,
                    &video,
                )?;
                if let Some(baseline) = &baseline {
                    let requested = serde_json::to_value(&video)?;
                    let mut merged = serde_json::to_value(current)?;
                    for field in &baseline.fields {
                        merged[&field.field] = requested[&field.field].clone();
                    }
                    video = serde_json::from_value(merged)?;
                }
                video.updated_at = stamp()?;
                database::validate_video_project(&video, &state.projects)?;
                let tx = self.db.transaction()?;
                tx.execute("UPDATE video_projects SET mode=?,kind=?,aspect_preset=?,output_width=?,output_height=?,archived_at=?,created_at=?,brief=?,genre=?,audience=?,tone=?,logline=?,updated_at=?,column_visible=?,shot_default_duration=?,shot_auto_increment=?,shot_workspace_view=?,shot_filter_statuses=?,shot_filter_beats=?,shot_filter_gaps=? WHERE project_id=?", params![video.mode, video.kind, video.aspect_preset, video.output_width as i64, video.output_height as i64, video.archived_at, video.created_at, video.brief, video.genre, video.audience, video.tone, video.logline, video.updated_at, video.column_settings.visible.join("\u{1f}"), video.shot_settings.default_duration_sec, i64::from(video.shot_settings.auto_increment_shot_number), video.shot_settings.workspace_view, video.shot_settings.filters.statuses.join("\u{1f}"), video.shot_settings.filters.beat_ids.join("\u{1f}"), video.shot_settings.filters.gaps.join("\u{1f}"), video.project_id])?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::VideoProject(video))
            }
            Job::UpdateVideoProject {
                project_id,
                patch,
                baseline,
            } => {
                let state = self.state()?;
                let current = state
                    .video_projects
                    .iter()
                    .find(|v| v.project_id == project_id)
                    .cloned()
                    .ok_or_else(|| Error::new("missing", "Video project missing"))?;
                let project = state
                    .projects
                    .iter()
                    .find(|p| p.id == project_id)
                    .ok_or_else(|| Error::new("missing", "Project missing"))?;
                let mut baseline_owner = serde_json::to_value(&current)?;
                baseline_owner
                    .as_object_mut()
                    .expect("video object")
                    .insert(
                        "title".into(),
                        serde_json::Value::String(project.title.clone()),
                    );
                baseline_check(
                    "project",
                    &project_id,
                    baseline.as_ref(),
                    &baseline_owner,
                    &patch,
                )?;
                let mut next = current.clone();
                if let Some(v) = patch.mode {
                    next.mode = v;
                }
                if let Some(v) = patch.aspect_preset {
                    next.aspect_preset = v;
                }
                if let Some(v) = patch.output_width {
                    next.output_width = v;
                }
                if let Some(v) = patch.output_height {
                    next.output_height = v;
                }
                if let Some(v) = patch.archived_at {
                    next.archived_at = v;
                }
                if let Some(v) = patch.brief {
                    next.brief = v;
                }
                if let Some(v) = patch.genre {
                    next.genre = v;
                }
                if let Some(v) = patch.audience {
                    next.audience = v;
                }
                if let Some(v) = patch.tone {
                    next.tone = v;
                }
                if let Some(v) = patch.logline {
                    next.logline = v;
                }
                if let Some(v) = patch.column_settings {
                    next.column_settings = v;
                }
                if let Some(v) = patch.shot_settings {
                    next.shot_settings = v;
                }
                next.updated_at = stamp()?;
                database::validate_video_project(&next, &state.projects)?;
                let tx = self.db.transaction()?;
                if let Some(title) = patch.title {
                    crate::contracts::text(&title, "project title", 16384)?;
                    tx.execute(
                        "UPDATE projects SET title=? WHERE id=?",
                        params![title, project_id],
                    )?;
                }
                tx.execute("UPDATE video_projects SET mode=?,aspect_preset=?,output_width=?,output_height=?,archived_at=?,brief=?,genre=?,audience=?,tone=?,logline=?,updated_at=?,column_visible=?,shot_default_duration=?,shot_auto_increment=?,shot_workspace_view=?,shot_filter_statuses=?,shot_filter_beats=?,shot_filter_gaps=? WHERE project_id=?",params![next.mode,next.aspect_preset,next.output_width as i64,next.output_height as i64,next.archived_at,next.brief,next.genre,next.audience,next.tone,next.logline,next.updated_at,next.column_settings.visible.join("\u{1f}"),next.shot_settings.default_duration_sec,i64::from(next.shot_settings.auto_increment_shot_number),next.shot_settings.workspace_view,next.shot_settings.filters.statuses.join("\u{1f}"),next.shot_settings.filters.beat_ids.join("\u{1f}"),next.shot_settings.filters.gaps.join("\u{1f}"),next.project_id])?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::VideoProject(next))
            }
            Job::DeleteEpisode { episode_id } => {
                let before = self.state()?;
                let episode = before
                    .episodes
                    .iter()
                    .find(|e| e.id == episode_id)
                    .ok_or_else(|| Error::new("missing", "Episode missing"))?;
                if before
                    .episodes
                    .iter()
                    .filter(|e| e.project_id == episode.project_id)
                    .count()
                    <= 1
                {
                    return Err(Error::new("invalid", "Cannot delete last episode"));
                }
                let mut next = before.clone();
                let removed_beats: BTreeSet<_> = before
                    .beats
                    .iter()
                    .filter(|b| b.episode_id == episode_id)
                    .map(|b| b.id.as_str())
                    .collect();
                if let Some(video) = next
                    .video_projects
                    .iter_mut()
                    .find(|v| v.project_id == episode.project_id)
                {
                    video
                        .shot_settings
                        .filters
                        .beat_ids
                        .retain(|id| !removed_beats.contains(id.as_str()));
                }
                next.shots.retain(|s| s.episode_id != episode_id);
                next.beats.retain(|b| b.episode_id != episode_id);
                next.episodes.retain(|e| e.id != episode_id);
                for (index, row) in next
                    .episodes
                    .iter_mut()
                    .filter(|e| e.project_id == episode.project_id)
                    .enumerate()
                {
                    row.order = index as u32;
                }
                let receipt =
                    self.commit_video("episode", vec![episode_id], &before, next, check)?;
                Ok(Outcome::Undo(receipt))
            }
            Job::DuplicateBeat {
                episode_id,
                beat_id,
                include_shots,
            } => {
                let before = self.state()?;
                let source = before
                    .beats
                    .iter()
                    .find(|b| b.id == beat_id && b.episode_id == episode_id)
                    .cloned()
                    .ok_or_else(|| Error::new("missing", "Beat missing"))?;
                let mut next = before.clone();
                let mut copy = source.clone();
                copy.id = uuid::Uuid::new_v4().to_string();
                copy.title = format!("{} 副本", copy.title);
                copy.order += 1;
                for row in next
                    .beats
                    .iter_mut()
                    .filter(|b| b.episode_id == episode_id && b.order >= copy.order)
                {
                    row.order += 1;
                }
                next.beats.push(copy.clone());
                let mut copies = Vec::new();
                if include_shots {
                    let sources: Vec<_> = before
                        .shots
                        .iter()
                        .filter(|s| {
                            s.episode_id == episode_id && s.beat_id.as_deref() == Some(&beat_id)
                        })
                        .cloned()
                        .collect();
                    let insert = sources.last().map(|s| s.order + 1).unwrap_or_else(|| {
                        before
                            .shots
                            .iter()
                            .filter(|s| s.episode_id == episode_id)
                            .count() as u32
                    });
                    for row in next
                        .shots
                        .iter_mut()
                        .filter(|s| s.episode_id == episode_id && s.order >= insert)
                    {
                        row.order += sources.len() as u32;
                    }
                    for (index, source) in sources.into_iter().enumerate() {
                        let mut row = source;
                        row.id = uuid::Uuid::new_v4().to_string();
                        row.beat_id = Some(copy.id.clone());
                        row.order = insert + index as u32;
                        copies.push(row.clone());
                        next.shots.push(row);
                    }
                }
                let mut ids = vec![copy.id.clone()];
                ids.extend(copies.iter().map(|s| s.id.clone()));
                let receipt = self.commit_video("duplicateBeat", ids, &before, next, check)?;
                Ok(Outcome::DuplicateBeat(crate::DuplicateBeatResult {
                    beat: copy,
                    shots: copies,
                    receipt,
                }))
            }
            Job::DeleteBeat {
                episode_id,
                beat_id,
            } => {
                let before = self.state()?;
                if !before
                    .beats
                    .iter()
                    .any(|b| b.id == beat_id && b.episode_id == episode_id)
                {
                    return Err(Error::new("missing", "Beat missing"));
                }
                let mut next = before.clone();
                next.beats.retain(|b| b.id != beat_id);
                for video in &mut next.video_projects {
                    video
                        .shot_settings
                        .filters
                        .beat_ids
                        .retain(|id| id != &beat_id);
                }
                for (index, row) in next
                    .beats
                    .iter_mut()
                    .filter(|b| b.episode_id == episode_id)
                    .enumerate()
                {
                    row.order = index as u32;
                }
                for shot in next.shots.iter_mut().filter(|s| {
                    s.episode_id == episode_id && s.beat_id.as_deref() == Some(&beat_id)
                }) {
                    shot.beat_id = None;
                }
                if let Some(ep) = next.episodes.iter_mut().find(|e| e.id == episode_id) {
                    ep.shot_filters.beat_ids.retain(|id| id != &beat_id);
                }
                let receipt = self.commit_video("beat", vec![beat_id], &before, next, check)?;
                Ok(Outcome::Undo(receipt))
            }
            Job::DuplicateShot {
                episode_id,
                shot_id,
            } => {
                let before = self.state()?;
                let source = before
                    .shots
                    .iter()
                    .find(|s| s.id == shot_id && s.episode_id == episode_id)
                    .cloned()
                    .ok_or_else(|| Error::new("missing", "Shot missing"))?;
                let mut next = before.clone();
                let mut copy = source.clone();
                copy.id = uuid::Uuid::new_v4().to_string();
                copy.order += 1;
                for row in next
                    .shots
                    .iter_mut()
                    .filter(|s| s.episode_id == episode_id && s.order >= copy.order)
                {
                    row.order += 1;
                }
                next.shots.push(copy.clone());
                let receipt = self.commit_video(
                    "duplicateShot",
                    vec![copy.id.clone()],
                    &before,
                    next,
                    check,
                )?;
                Ok(Outcome::DuplicateShot(crate::DuplicateShotResult {
                    shot: copy,
                    receipt,
                }))
            }
            Job::DeleteShots {
                episode_id,
                shot_ids,
            } => {
                let before = self.state()?;
                if !before.episodes.iter().any(|e| e.id == episode_id) {
                    return Err(Error::new("missing", "Episode missing"));
                }
                validate_selection(&before, &episode_id, &shot_ids)?;
                let mut next = before.clone();
                next.shots.retain(|s| !shot_ids.contains(&s.id));
                for (index, row) in next
                    .shots
                    .iter_mut()
                    .filter(|s| s.episode_id == episode_id)
                    .enumerate()
                {
                    row.order = index as u32;
                }
                let receipt = self.commit_video("shot", shot_ids, &before, next, check)?;
                Ok(Outcome::Undo(receipt))
            }
            Job::BulkShots {
                episode_id,
                shot_ids,
                patch,
            } => {
                let before = self.state()?;
                validate_selection(&before, &episode_id, &shot_ids)?;
                let mut next = before.clone();
                for id in &shot_ids {
                    let row = patch_shot(&before, id, &patch, None)?;
                    if let Some(slot) = next.shots.iter_mut().find(|s| s.id == *id) {
                        *slot = row;
                    }
                }
                let receipt = self.commit_video("shotBulk", shot_ids, &before, next, check)?;
                Ok(Outcome::Undo(receipt))
            }
            Job::VideoUndo { receipt } => {
                let (resource,ids,before_json,after_json):(String,String,String,String)=self.db.query_row("SELECT resource,ids,before_state,after_state FROM video_undo WHERE token=?",[&receipt.token],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|Error::new("undo","Undo receipt missing"))?;
                if resource != receipt.resource || ids != serde_json::to_string(&receipt.ids)? {
                    return Err(Error::new("undo", "Undo receipt identity mismatch"));
                }
                let before: State = serde_json::from_str(&before_json)?;
                let after: State = serde_json::from_str(&after_json)?;
                if before.schema != SCHEMA
                    || after.schema != SCHEMA
                    || before.workspace_id != self.id
                    || after.workspace_id != self.id
                {
                    return Err(Error::new("undo", "Undo receipt workspace mismatch"));
                }
                database::validate_state_closure(&before)?;
                database::validate_state_closure(&after)?;
                let current = self.state()?;
                let mut next = current.clone();
                next.projects =
                    inverse_rows(&next.projects, &before.projects, &after.projects, |r| &r.id)?;
                next.video_projects = inverse_rows(
                    &next.video_projects,
                    &before.video_projects,
                    &after.video_projects,
                    |r| &r.project_id,
                )?;
                next.episodes =
                    inverse_rows(&next.episodes, &before.episodes, &after.episodes, |r| &r.id)?;
                next.beats = inverse_rows(&next.beats, &before.beats, &after.beats, |r| &r.id)?;
                next.shots = inverse_rows(&next.shots, &before.shots, &after.shots, |r| &r.id)?;
                touch_video_changes(&current, &mut next)?;
                sort_state(&mut next);
                database::validate_state_closure(&next)?;
                let tx = self.db.transaction()?;
                database::write_video_state(&tx, &next)?;
                tx.execute("DELETE FROM video_undo WHERE token=?", [receipt.token])?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::State(next))
            }
            Job::VideoState(project_id) => Ok(Outcome::VideoState(video_state(
                &self.state()?,
                &project_id,
            )?)),
            Job::SaveEpisode(episode) => {
                let state = self.state()?;
                validate_episode_input(&state, &episode)?;
                let tx = self.db.transaction()?;
                tx.execute("INSERT INTO episodes (id,project_id,item_order,title,logline,script,created_at,updated_at,shot_filter_statuses,shot_filter_beats,shot_filter_gaps) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,item_order=excluded.item_order,title=excluded.title,logline=excluded.logline,script=excluded.script,created_at=excluded.created_at,updated_at=excluded.updated_at,shot_filter_statuses=excluded.shot_filter_statuses,shot_filter_beats=excluded.shot_filter_beats,shot_filter_gaps=excluded.shot_filter_gaps", params![episode.id,episode.project_id,episode.order as i64,episode.title,episode.logline,episode.script,episode.created_at,episode.updated_at,episode.shot_filters.statuses.join("\u{1f}"),episode.shot_filters.beat_ids.join("\u{1f}"),episode.shot_filters.gaps.join("\u{1f}")])?;
                touch_project(&tx, &episode.project_id)?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Episode(episode))
            }
            Job::PatchEpisode {
                episode_id,
                patch,
                baseline,
            } => {
                let state = self.state()?;
                let next = patch_episode(&state, &episode_id, &patch, baseline.as_ref())?;
                let tx = self.db.transaction()?;
                tx.execute("UPDATE episodes SET title=?,logline=?,script=?,updated_at=?,shot_filter_statuses=?,shot_filter_beats=?,shot_filter_gaps=? WHERE id=?", params![next.title, next.logline, next.script, next.updated_at, next.shot_filters.statuses.join("\u{1f}"), next.shot_filters.beat_ids.join("\u{1f}"), next.shot_filters.gaps.join("\u{1f}"), next.id])?;
                if patch.script.is_some() {
                    for beat in state.beats.iter().filter(|b| b.episode_id == episode_id) {
                        if beat
                            .script_range
                            .as_ref()
                            .is_some_and(|range| !database::valid_script_range(&next.script, range))
                        {
                            tx.execute("UPDATE beats SET script_start=NULL,script_end=NULL,script_excerpt='' WHERE id=?",[&beat.id])?;
                        }
                    }
                }
                touch_project(&tx, &next.project_id)?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Episode(next))
            }
            Job::ReorderEpisodes {
                project_id,
                ordered_ids,
            } => {
                let before = self.state()?;
                if !before.projects.iter().any(|p| p.id == project_id) {
                    return Err(Error::new("missing", "Project missing"));
                }
                complete_order(
                    before
                        .episodes
                        .iter()
                        .filter(|e| e.project_id == project_id)
                        .map(|e| e.id.clone()),
                    &ordered_ids,
                )?;
                let mut next = before.clone();
                for row in next
                    .episodes
                    .iter_mut()
                    .filter(|e| e.project_id == project_id)
                {
                    row.order = ordered_ids
                        .iter()
                        .position(|id| id == &row.id)
                        .expect("complete order") as u32;
                }
                let receipt =
                    self.commit_video("episodeOrder", ordered_ids, &before, next, check)?;
                Ok(Outcome::Undo(receipt))
            }
            Job::SaveBeat(beat) => {
                let state = self.state()?;
                validate_beat_input(&state, &beat)?;
                let tx = self.db.transaction()?;
                tx.execute("INSERT INTO beats (id,episode_id,item_order,title,content,time_of_day,script_start,script_end,character_ids,scene_id,script_excerpt) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET episode_id=excluded.episode_id,item_order=excluded.item_order,title=excluded.title,content=excluded.content,time_of_day=excluded.time_of_day,script_start=excluded.script_start,script_end=excluded.script_end,character_ids=excluded.character_ids,scene_id=excluded.scene_id,script_excerpt=excluded.script_excerpt", params![beat.id,beat.episode_id,beat.order as i64,beat.title,beat.content,beat.time_of_day,beat.script_range.as_ref().map(|r|i64::from(r.start)),beat.script_range.as_ref().map(|r|i64::from(r.end)),beat.character_ids.join("\u{1f}"),beat.scene_id,beat.script_range.as_ref().map(|r| r.excerpt.clone()).unwrap_or_default()])?;
                let project_id = state
                    .episodes
                    .iter()
                    .find(|e| e.id == beat.episode_id)
                    .ok_or_else(|| Error::new("ownership", "Beat episode missing"))?
                    .project_id
                    .clone();
                touch_project(&tx, &project_id)?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Beat(beat))
            }
            Job::PatchBeat {
                episode_id,
                beat_id,
                patch,
                baseline,
            } => {
                let state = self.state()?;
                if !state
                    .beats
                    .iter()
                    .any(|b| b.id == beat_id && b.episode_id == episode_id)
                {
                    return Err(Error::new("ownership", "Beat episode mismatch"));
                }
                let next = patch_beat(&state, &beat_id, &patch, baseline.as_ref())?;
                let tx = self.db.transaction()?;
                tx.execute("UPDATE beats SET title=?,content=?,time_of_day=?,character_ids=?,scene_id=?,script_start=?,script_end=?,script_excerpt=? WHERE id=? AND episode_id=?", params![next.title, next.content, next.time_of_day, next.character_ids.join("\u{1f}"), next.scene_id, next.script_range.as_ref().map(|r|i64::from(r.start)), next.script_range.as_ref().map(|r|i64::from(r.end)), next.script_range.as_ref().map(|r| r.excerpt.clone()).unwrap_or_default(), next.id, next.episode_id])?;
                let project_id = state
                    .episodes
                    .iter()
                    .find(|e| e.id == next.episode_id)
                    .ok_or_else(|| Error::new("ownership", "Beat episode missing"))?
                    .project_id
                    .clone();
                touch_project(&tx, &project_id)?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Beat(next))
            }
            Job::ReorderBeats {
                episode_id,
                ordered_ids,
            } => {
                let before = self.state()?;
                if !before.episodes.iter().any(|e| e.id == episode_id) {
                    return Err(Error::new("missing", "Episode missing"));
                }
                complete_order(
                    before
                        .beats
                        .iter()
                        .filter(|e| e.episode_id == episode_id)
                        .map(|e| e.id.clone()),
                    &ordered_ids,
                )?;
                let mut next = before.clone();
                for row in next.beats.iter_mut().filter(|e| e.episode_id == episode_id) {
                    row.order = ordered_ids
                        .iter()
                        .position(|id| id == &row.id)
                        .expect("complete order") as u32;
                }
                let mut shots: Vec<_> = next
                    .shots
                    .iter()
                    .filter(|s| s.episode_id == episode_id)
                    .cloned()
                    .collect();
                shots.sort_by_key(|s| {
                    (
                        ordered_ids
                            .iter()
                            .position(|id| s.beat_id.as_deref() == Some(id))
                            .unwrap_or(usize::MAX),
                        s.order,
                    )
                });
                for (order, shot) in shots.into_iter().enumerate() {
                    next.shots
                        .iter_mut()
                        .find(|s| s.id == shot.id)
                        .expect("existing shot")
                        .order = order as u32;
                }
                let receipt = self.commit_video("beatOrder", ordered_ids, &before, next, check)?;
                Ok(Outcome::Undo(receipt))
            }
            Job::SaveShot(shot) => {
                let state = self.state()?;
                validate_shot_input(&state, &shot)?;
                let tx = self.db.transaction()?;
                tx.execute("INSERT INTO shots (id,project_id,episode_id,item_order,shot_number,beat_id,status,duration_sec,content,notes,scene_closeup,sound,emotion,camera_angle,camera_gear,focal_length,category,character_ids,scene_id,prop_ids,style_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,episode_id=excluded.episode_id,item_order=excluded.item_order,shot_number=excluded.shot_number,beat_id=excluded.beat_id,status=excluded.status,duration_sec=excluded.duration_sec,content=excluded.content,notes=excluded.notes,scene_closeup=excluded.scene_closeup,sound=excluded.sound,emotion=excluded.emotion,camera_angle=excluded.camera_angle,camera_gear=excluded.camera_gear,focal_length=excluded.focal_length,category=excluded.category,character_ids=excluded.character_ids,scene_id=excluded.scene_id,prop_ids=excluded.prop_ids,style_id=excluded.style_id", params![shot.id,shot.project_id,shot.episode_id,shot.order as i64,shot.shot_number,shot.beat_id,shot.status,shot.duration_sec,shot.content,shot.notes,shot.scene_closeup,shot.sound,shot.emotion,shot.camera_angle,shot.camera_gear,shot.focal_length,shot.category,shot.character_ids.join("\u{1f}"),shot.scene_id,shot.prop_ids.join("\u{1f}"),shot.style_id])?;
                touch_project(&tx, &shot.project_id)?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Shot(shot))
            }
            Job::PatchShot {
                shot_id,
                patch,
                baseline,
            } => {
                let state = self.state()?;
                let next = patch_shot(&state, &shot_id, &patch, baseline.as_ref())?;
                let tx = self.db.transaction()?;
                tx.execute("UPDATE shots SET shot_number=?,beat_id=?,status=?,duration_sec=?,content=?,notes=?,scene_closeup=?,sound=?,emotion=?,camera_angle=?,camera_gear=?,focal_length=?,category=?,character_ids=?,scene_id=?,prop_ids=?,style_id=? WHERE id=?", params![next.shot_number, next.beat_id, next.status, next.duration_sec, next.content, next.notes, next.scene_closeup, next.sound, next.emotion, next.camera_angle, next.camera_gear, next.focal_length, next.category, next.character_ids.join("\u{1f}"), next.scene_id, next.prop_ids.join("\u{1f}"), next.style_id, next.id])?;
                touch_project(&tx, &next.project_id)?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Shot(next))
            }
            Job::AddShots {
                project_id,
                episode_id,
                count,
                at_order,
                beat_id,
            } => {
                if count == 0 || count > 20 {
                    return Err(Error::new("size", "Add between 1 and 20 shots"));
                }
                let state = self.state()?;
                let _episode = state
                    .episodes
                    .iter()
                    .find(|e| e.id == episode_id && e.project_id == project_id)
                    .ok_or_else(|| Error::new("ownership", "Episode project mismatch"))?;
                let project_video = state
                    .video_projects
                    .iter()
                    .find(|v| v.project_id == project_id)
                    .ok_or_else(|| Error::new("missing", "Video project missing"))?;
                let beats: Vec<_> = state
                    .beats
                    .iter()
                    .filter(|b| b.episode_id == episode_id)
                    .collect();
                let selected_beat = beat_id
                    .as_ref()
                    .map(|id| {
                        beats.iter().find(|b| b.id == *id).copied().ok_or_else(|| {
                            Error::new("ownership", "Beat does not belong to episode")
                        })
                    })
                    .transpose()?;
                let siblings: Vec<_> = state
                    .shots
                    .iter()
                    .filter(|s| s.episode_id == episode_id)
                    .cloned()
                    .collect();
                let rank = |id: Option<&str>| {
                    beats
                        .iter()
                        .position(|b| Some(b.id.as_str()) == id)
                        .unwrap_or(usize::MAX)
                };
                let target = rank(beat_id.as_deref());
                let insertion = siblings
                    .iter()
                    .filter(|s| rank(s.beat_id.as_deref()) <= target)
                    .map(|s| s.order + 1)
                    .max()
                    .unwrap_or(0);
                let start = at_order.unwrap_or(insertion);
                if start > siblings.len() as u32 {
                    return Err(Error::new("order", "Invalid shot insertion order"));
                }
                let number = if project_video.shot_settings.auto_increment_shot_number {
                    siblings
                        .iter()
                        .filter_map(|s| numeric_shot_prefix(&s.shot_number))
                        .fold(0.0_f64, f64::max)
                        + 1.0
                } else {
                    f64::from(start + 1)
                };
                let duration = project_video.shot_settings.default_duration_sec;
                let mut created = Vec::new();
                for index in 0..count {
                    let order = start + index;
                    created.push(Shot {
                        id: uuid::Uuid::new_v4().to_string(),
                        project_id: project_id.clone(),
                        episode_id: episode_id.clone(),
                        order,
                        shot_number: shot_number(number + f64::from(index))?,
                        beat_id: beat_id.clone(),
                        status: "draft".into(),
                        duration_sec: duration,
                        content: String::new(),
                        notes: String::new(),
                        scene_closeup: String::new(),
                        sound: String::new(),
                        emotion: String::new(),
                        camera_angle: String::new(),
                        camera_gear: String::new(),
                        focal_length: String::new(),
                        category: String::new(),
                        character_ids: selected_beat
                            .map(|b| b.character_ids.clone())
                            .unwrap_or_default(),
                        scene_id: selected_beat.and_then(|b| b.scene_id.clone()),
                        prop_ids: Vec::new(),
                        style_id: None,
                    });
                }
                let mut next = state.clone();
                for item in next.shots.iter_mut().filter(|s| s.episode_id == episode_id) {
                    if item.order >= start {
                        item.order += count;
                    }
                }
                next.shots.extend(created.iter().cloned());
                touch_video_changes(&state, &mut next)?;
                sort_state(&mut next);
                database::validate_state_closure(&next)?;
                let tx = self.db.transaction()?;
                database::write_video_state(&tx, &next)?;
                self.hooks.hit("video-precommit")?;
                self.boundary.validate()?;
                check()?;
                database::validate_state_closure(&database::validate(&tx)?)?;
                tx.commit()?;
                Ok(Outcome::Shots(created))
            }
            Job::ReorderShots {
                episode_id,
                ordered_ids,
            } => {
                let before = self.state()?;
                if !before.episodes.iter().any(|e| e.id == episode_id) {
                    return Err(Error::new("missing", "Episode missing"));
                }
                complete_order(
                    before
                        .shots
                        .iter()
                        .filter(|e| e.episode_id == episode_id)
                        .map(|e| e.id.clone()),
                    &ordered_ids,
                )?;
                let mut next = before.clone();
                for row in next.shots.iter_mut().filter(|e| e.episode_id == episode_id) {
                    row.order = ordered_ids
                        .iter()
                        .position(|id| id == &row.id)
                        .expect("complete order") as u32;
                }
                let receipt = self.commit_video("shotOrder", ordered_ids, &before, next, check)?;
                Ok(Outcome::Undo(receipt))
            }
            Job::Import(request) => Ok(Outcome::Asset(self.import(request, check)?)),
            Job::Availability => {
                let state = self.state()?;
                let mut result = Vec::new();
                for asset in state.assets {
                    check()?;
                    let path = paths::managed(&self.root, &asset.reference.relative_path, false);
                    let status = match path.and_then(|p| {
                        paths::hash_file(&p, crate::contracts::MAX_ASSET_BYTES, &check)
                    }) {
                        Ok((size, hash))
                            if size == asset.byte_length && hash == asset.content_hash =>
                        {
                            Availability::Present
                        }
                        Err(e)
                            if e.code == "io"
                                && !self.root.join(&asset.reference.relative_path).exists() =>
                        {
                            Availability::Missing
                        }
                        Err(e) if e.code == "canceled" || e.code == "closed" => return Err(e),
                        _ => Availability::Corrupt,
                    };
                    result.push(AssetAvailability {
                        asset_id: asset.id,
                        status,
                    });
                }
                Ok(Outcome::Availability(result))
            }
            Job::Backup(destination) => Ok(Outcome::Backup(self.backup(&destination, check)?)),
            Job::ReadAsset {
                asset_id,
                max_bytes,
            } => {
                if max_bytes > 32 * 1024 * 1024 {
                    return Err(Error::new("size", "Bounded fixture read is at most 32 MiB"));
                }
                let asset = self
                    .state()?
                    .assets
                    .into_iter()
                    .find(|a| a.id == asset_id)
                    .ok_or_else(|| Error::new("missing", "Asset ID missing"))?;
                if asset.byte_length > max_bytes as u64 {
                    return Err(Error::new("size", "Asset exceeds requested read boundary"));
                }
                let path = paths::managed(&self.root, &asset.reference.relative_path, false)?;
                let mut file = fs::File::open(&path)?;
                paths::ordinary(&path, 1)?;
                let mut bytes = Vec::with_capacity(asset.byte_length as usize);
                let mut buffer = vec![0; crate::CHUNK];
                let mut hash = <sha2::Sha256 as sha2::Digest>::new();
                loop {
                    check()?;
                    let n = file.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    if bytes.len() + n > max_bytes {
                        return Err(Error::new("size", "Observed read boundary exceeded"));
                    }
                    sha2::Digest::update(&mut hash, &buffer[..n]);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                if bytes.len() as u64 != asset.byte_length
                    || paths::hex_digest(sha2::Digest::finalize(hash)) != asset.content_hash
                {
                    return Err(Error::new("corrupt", "Managed bytes failed verification"));
                }
                check()?;
                Ok(Outcome::Bytes(bytes))
            }
        }
    }
    pub fn close(&mut self) -> Result<()> {
        self.writer.execute_batch("ROLLBACK")?;
        Ok(())
    }
}

#[cfg(test)]
mod native_boundary_tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("momoki-boundary-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("database.sqlite"), b"ordinary database bytes").unwrap();
            fs::write(path.join("writer.sqlite"), b"ordinary writer bytes").unwrap();
            Self(path)
        }
        fn capture(&self) -> Boundary {
            Boundary::capture_paths(
                &self.0,
                &self.0.join("database.sqlite"),
                &self.0.join("writer.sqlite"),
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn named_database_and_writer_replacements_do_not_reuse_superficial_metadata() {
        for name in ["database.sqlite", "writer.sqlite"] {
            let fixture = Fixture::new();
            let path = fixture.0.join(name);
            let before = fs::read(&path).unwrap();
            let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
            let times = fs::FileTimes::new().set_modified(modified);
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(times)
                .unwrap();
            let boundary = fixture.capture();
            let replacement = fixture.0.join("replacement.sqlite");
            fs::write(&replacement, &before).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&replacement)
                .unwrap()
                .set_times(times)
                .unwrap();
            fs::remove_file(&path).unwrap();
            fs::rename(&replacement, &path).unwrap();
            assert_eq!(boundary.validate().unwrap_err().code, "containment");
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn database_sidecar_alias_is_rejected_without_changing_external_bytes() {
        let fixture = Fixture::new();
        let boundary = fixture.capture();
        let external = fixture.0.join("external.bin");
        fs::write(&external, b"external journal bytes").unwrap();
        fs::hard_link(&external, fixture.0.join("database.sqlite-journal")).unwrap();
        assert_eq!(boundary.validate().unwrap_err().code, "containment");
        assert_eq!(fs::read(&external).unwrap(), b"external journal bytes");
    }

    #[cfg(windows)]
    #[test]
    fn active_workspace_boundary_blocks_root_replacement_and_releases_at_drop() {
        let fixture = Fixture::new();
        let moved = fixture.0.with_extension("moved");
        let boundary = fixture.capture();
        assert!(
            fs::rename(&fixture.0, &moved).is_err(),
            "active root was moved"
        );
        boundary.validate().unwrap();
        drop(boundary);
        fs::rename(&fixture.0, &moved).unwrap();
        fs::rename(&moved, &fixture.0).unwrap();
    }
}
