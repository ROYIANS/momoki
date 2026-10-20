//! Full shared-product record engine. TypeScript owns all business recipes;
//! this owner enforces durable closed records, guarded atomic commits and files.
pub mod protocol;
mod query;
mod registry;
mod registry_migrations;
use crate::{Error, Hooks, Result, database, paths, product_binary, workspace::Boundary};
use protocol::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

const SCHEMA: u32 = 1;
const REGISTRY_SCHEMA: &str = "CREATE TABLE product_registry (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_json TEXT NOT NULL)";
const TTL: Duration = Duration::from_secs(120);
const TABLES: &[(&str, &str)] = &[
    (
        "product_workspace",
        "CREATE TABLE product_workspace (id TEXT PRIMARY KEY NOT NULL, schema INTEGER NOT NULL, registry_hash TEXT NOT NULL, change_sequence INTEGER NOT NULL)",
    ),
    (
        "product_tables",
        "CREATE TABLE product_tables (name TEXT PRIMARY KEY NOT NULL, epoch INTEGER NOT NULL)",
    ),
    (
        "product_records",
        "CREATE TABLE product_records (table_name TEXT NOT NULL REFERENCES product_tables(name), row_key TEXT NOT NULL, primary_sort BLOB NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(table_name,row_key))",
    ),
    (
        "product_revisions",
        "CREATE TABLE product_revisions (table_name TEXT NOT NULL REFERENCES product_tables(name), row_key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(table_name,row_key))",
    ),
    (
        "product_indexes",
        "CREATE TABLE product_indexes (table_name TEXT NOT NULL, index_name TEXT NOT NULL, row_key TEXT NOT NULL, sort_key BLOB NOT NULL, PRIMARY KEY(table_name,index_name,sort_key,row_key), FOREIGN KEY(table_name,row_key) REFERENCES product_records(table_name,row_key) ON DELETE CASCADE)",
    ),
    (
        "product_unique_indexes",
        "CREATE TABLE product_unique_indexes (table_name TEXT NOT NULL, index_name TEXT NOT NULL, sort_key BLOB NOT NULL, row_key TEXT NOT NULL, PRIMARY KEY(table_name,index_name,sort_key), FOREIGN KEY(table_name,row_key) REFERENCES product_records(table_name,row_key) ON DELETE CASCADE)",
    ),
    (
        "product_operations",
        "CREATE TABLE product_operations (operation_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT, status TEXT NOT NULL, receipt TEXT)",
    ),
    (
        "product_prepared",
        "CREATE TABLE product_prepared (handle TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(handle,ordinal))",
    ),
    (
        "product_changes",
        "CREATE TABLE product_changes (change_sequence INTEGER NOT NULL, ordinal INTEGER NOT NULL, table_name TEXT NOT NULL, row_key TEXT NOT NULL, before_indexes TEXT NOT NULL, after_indexes TEXT NOT NULL, PRIMARY KEY(change_sequence,ordinal))",
    ),
];
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Ready {
    format: String,
    schema: u32,
    workspace_id: String,
}
struct Cursor {
    query: String,
    sort: Vec<u8>,
    primary: Vec<u8>,
    emitted: usize,
}
struct IncomingRead {
    transfer_id: String,
    purpose: ReadPurpose,
    payload: String,
}
struct Context {
    operation: String,
    mode: String,
    scope: BTreeSet<String>,
    points: BTreeMap<(String, String), u64>,
    tables: BTreeMap<String, u64>,
    cursors: HashMap<String, Cursor>,
    touched: Instant,
    chunk: usize,
    ordinal: usize,
    residual: String,
    digest: Sha256,
    capability: Option<String>,
    fingerprint: Option<String>,
    transfers: HashMap<String, String>,
    incoming: Option<IncomingRead>,
}
pub struct FullProductStore {
    pub root: PathBuf,
    pub workspace_id: String,
    db: Connection,
    writer: Connection,
    boundary: Boundary,
    hooks: Hooks,
    session: String,
    generation: u64,
    contexts: HashMap<String, Context>,
    change_cursors: HashMap<String, (u64, i64)>,
    change_transfers: HashMap<String, String>,
    pub binaries: product_binary::BinaryStore,
}
fn digest(bytes: &[u8]) -> String {
    paths::hex_digest(Sha256::digest(bytes))
}
fn epoch(db: &Connection, table: &str) -> Result<u64> {
    Ok(db.query_row(
        "SELECT epoch FROM product_tables WHERE name=?",
        [table],
        |r| r.get::<_, i64>(0),
    )? as u64)
}
fn revision(db: &Connection, table: &str, key: &str) -> Result<u64> {
    Ok(db
        .query_row(
            "SELECT revision FROM product_revisions WHERE table_name=? AND row_key=?",
            params![table, key],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0) as u64)
}
fn guard(db: &Connection, context: &Context) -> Result<()> {
    for (table, expected) in &context.tables {
        if epoch(db, table)? != *expected {
            return Err(Error::new(
                "conflict",
                "A queried table changed during the operation",
            ));
        }
    }
    for ((table, key), expected) in &context.points {
        if revision(db, table, key)? != *expected {
            return Err(Error::new(
                "conflict",
                "A read row or its absence changed during the operation",
            ));
        }
    }
    Ok(())
}
fn scope(context: &Context, table: &str) -> Result<()> {
    registry::table(table)?;
    if !context.scope.contains(table) {
        return Err(Error::new(
            "invalid",
            "Table is outside declared transaction scope",
        ));
    }
    Ok(())
}
impl FullProductStore {
    pub fn open(root: PathBuf, create: bool, hooks: Hooks) -> Result<Self> {
        let root = if create {
            paths::reserve(&root)?
        } else {
            paths::canonical_root(&root)?
        };
        #[cfg(windows)]
        let _startup_directory_guards = paths::pin_ancestors(&root)?;
        let marker = if create {
            None
        } else {
            Some(paths::read_json::<Ready>(
                &root.join("workspace.ready.json"),
            )?)
        };
        if create {
            for name in [".local", ".staging", "assets"] {
                fs::create_dir(root.join(name))?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                for path in [&root, &root.join(".local"), &root.join(".staging")] {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
                }
            }
            paths::namespace_checkpoint(&root)?;
        }
        let db_path = paths::managed(&root, ".local/state.sqlite", false)?;
        let writer_path = paths::managed(&root, ".local/writer.sqlite", false)?;
        // Existing roots must already have a lock file. Never initialize over a partial root.
        let writer = database::connect(&writer_path, create, false)?;
        writer.execute_batch("BEGIN EXCLUSIVE")?;
        let db = database::connect(&db_path, create, false)?;
        #[cfg(unix)]
        if create {
            use std::os::unix::fs::PermissionsExt;
            for path in [&db_path, &writer_path] {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            }
        }
        if create {
            let id = uuid::Uuid::new_v4().to_string();
            db.execute_batch("BEGIN IMMEDIATE")?;
            for (_, sql) in TABLES {
                db.execute_batch(sql)?;
            }
            db.execute_batch(product_binary::BINARY_SCHEMA)?;
            db.execute_batch(REGISTRY_SCHEMA)?;
            db.execute(
                "INSERT INTO product_registry VALUES (1,?)",
                [registry::REGISTRY_JSON],
            )?;
            db.execute(
                "INSERT INTO product_workspace VALUES (?,?,?,0)",
                params![id, SCHEMA, digest(registry::REGISTRY_JSON.as_bytes())],
            )?;
            for table in registry::tables().keys() {
                db.execute("INSERT INTO product_tables VALUES (?,0)", [table])?;
            }
            db.pragma_update(None, "user_version", SCHEMA)?;
            db.execute_batch("COMMIT")?;
            paths::namespace_checkpoint(&root.join(".local"))?;
        }
        let (id, schema, registry_hash): (String, u32, String) = db.query_row(
            "SELECT id,schema,registry_hash FROM product_workspace",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        registry::uuid(&id)?;
        if schema != SCHEMA
            || db.pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))? != SCHEMA
        {
            return Err(Error::new(
                "schema",
                "Unsupported full-product workspace format",
            ));
        }
        if marker.is_some_and(|m| {
            m.format != "momoki.product.workspace.ready.v1"
                || m.schema != SCHEMA
                || m.workspace_id != id
        }) {
            return Err(Error::new(
                "incomplete",
                "Product workspace completion marker mismatch",
            ));
        }
        registry_migrations::migrate_registry(&db, &registry_hash, &hooks)?;
        validate_open(&db)?;
        let boundary = Boundary::capture_paths(&root, &db_path, &writer_path)?;
        product_binary::recover(&root, &db, &id)?;
        // Prepared row chunks are not authoritative product state. Dead session handles
        // cannot be revived; durable operation status intentionally remains uncertain.
        db.execute("DELETE FROM product_prepared", [])?;
        let binaries = product_binary::BinaryStore::new(&root, &id)?;
        let store = Self {
            root,
            workspace_id: id,
            db,
            writer,
            boundary,
            hooks,
            session: uuid::Uuid::new_v4().to_string(),
            generation: 1,
            contexts: HashMap::new(),
            change_cursors: HashMap::new(),
            change_transfers: HashMap::new(),
            binaries,
        };
        if create {
            paths::publish_json(
                &store.root,
                "workspace.ready.json",
                &Ready {
                    format: "momoki.product.workspace.ready.v1".into(),
                    schema: SCHEMA,
                    workspace_id: store.workspace_id.clone(),
                },
            )?;
        }
        Ok(store)
    }
    fn sequence(&self) -> Result<u64> {
        Ok(self
            .db
            .query_row("SELECT change_sequence FROM product_workspace", [], |r| {
                r.get::<_, i64>(0)
            })? as u64)
    }
    fn token(&self) -> Value {
        json!({"version":1,"session":self.session,"workspaceId":self.workspace_id,"generation":self.generation})
    }
    fn session(&self, version: u32, session: &str, workspace: &str, generation: u64) -> Result<()> {
        if version != 1
            || session != self.session
            || workspace != self.workspace_id
            || generation != self.generation
        {
            return Err(Error::new("closed", "Product storage session changed"));
        }
        Ok(())
    }
    pub fn validate_session(&self, s: &Session) -> Result<()> {
        self.boundary.validate()?;
        self.session(s.version, &s.session, &s.workspace_id, s.generation)
    }
    fn take(&mut self, handle: &str, operation: &str) -> Result<Context> {
        registry::uuid(handle)?;
        registry::uuid(operation)?;
        let mut context = self
            .contexts
            .remove(handle)
            .ok_or_else(|| Error::new("closed", "Unknown or closed transaction handle"))?;
        if context.operation != operation {
            self.contexts.insert(handle.into(), context);
            return Err(Error::new(
                "invalid",
                "Transaction operation identity mismatch",
            ));
        }
        if context.touched.elapsed() > TTL {
            self.db
                .execute("DELETE FROM product_prepared WHERE handle=?", [handle])?;
            return Err(Error::new("closed", "Transaction context expired"));
        }
        context.touched = Instant::now();
        Ok(context)
    }
    pub fn reset_session(&mut self) -> Result<Value> {
        self.contexts.clear();
        self.change_cursors.clear();
        self.change_transfers.clear();
        self.db.execute("DELETE FROM product_prepared", [])?;
        self.binaries.close(&self.db)?;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| Error::new("closed", "Generation exhausted"))?;
        self.session = uuid::Uuid::new_v4().to_string();
        let mut token = self.token();
        token["changeSequence"] = json!(self.sequence()?);
        Ok(token)
    }
    pub fn run(&mut self, request: Request, check: impl Fn() -> Result<()>) -> Result<Value> {
        check()?;
        self.boundary.validate()?;
        match request {
            Request::Open(_) => self.reset_session(),
            Request::Begin(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                registry::uuid(&r.operation_id)?;
                if !matches!(r.mode.as_str(), "r" | "rw") || r.tables.is_empty() {
                    return Err(Error::new("invalid", "Invalid transaction mode/scope"));
                }
                let scope: BTreeSet<_> = r.tables.iter().cloned().collect();
                if scope.len() != r.tables.len() {
                    return Err(Error::new("invalid", "Repeated transaction table"));
                }
                for name in &scope {
                    registry::table(name)?;
                }
                let expired = self
                    .contexts
                    .iter()
                    .filter(|(_, v)| v.touched.elapsed() > TTL)
                    .map(|(h, _)| h.clone())
                    .collect::<Vec<_>>();
                for handle in expired {
                    self.contexts.remove(&handle);
                    self.db
                        .execute("DELETE FROM product_prepared WHERE handle=?", [handle])?;
                }
                if self.contexts.len() >= 64 {
                    return Err(Error::new(
                        "unavailable",
                        "Too many concurrent storage contexts",
                    ));
                }
                if self
                    .contexts
                    .values()
                    .any(|c| c.operation == r.operation_id)
                {
                    return Err(Error::new(
                        "invalid",
                        "Operation already has a live context",
                    ));
                }
                if r.mode == "rw" {
                    let exists: bool = self.db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM product_operations WHERE operation_id=?)",
                        [&r.operation_id],
                        |row| row.get(0),
                    )?;
                    if exists {
                        return Err(Error::new(
                            "invalid",
                            "Operation identity already has durable status; reconcile instead of replaying",
                        ));
                    }
                    self.db.execute(
                        "INSERT INTO product_operations VALUES (?,NULL,'pending',NULL)",
                        [&r.operation_id],
                    )?;
                }
                let handle = uuid::Uuid::new_v4().to_string();
                let mut sha = Sha256::new();
                sha.update(b"momoki-batch-v1\n");
                self.contexts.insert(
                    handle.clone(),
                    Context {
                        operation: r.operation_id.clone(),
                        mode: r.mode,
                        scope,
                        points: BTreeMap::new(),
                        tables: BTreeMap::new(),
                        cursors: HashMap::new(),
                        touched: Instant::now(),
                        chunk: 0,
                        ordinal: 0,
                        residual: String::new(),
                        digest: sha,
                        capability: None,
                        fingerprint: None,
                        transfers: HashMap::new(),
                        incoming: None,
                    },
                );
                let mut token = self.token();
                token["handle"] = json!(handle);
                token["operationId"] = json!(r.operation_id);
                Ok(token)
            }
            Request::Get(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                if r.keys.len() > 256 {
                    return Err(Error::new("invalid", "Point-read page is too large"));
                }
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    scope(&c, &r.table)?;
                    guard(&self.db, &c)?;
                    let tx = self.db.unchecked_transaction()?;
                    let mut rows = Vec::new();
                    let mut budget = 0;
                    for key in &r.keys {
                        registry::key_text(key)?;
                        let rev = revision(&tx, &r.table, key)?;
                        c.points
                            .entry((r.table.clone(), key.to_string()))
                            .or_insert(rev);
                        let payload:Option<String>=tx.query_row("SELECT payload FROM product_records WHERE table_name=? AND row_key=?",params![r.table,key],|r|r.get(0)).optional()?;
                        rows.push(match payload {
                            Some(p) => transfer_row(
                                &mut c,
                                json!({"key":key,"value":serde_json::from_str::<Value>(&p)?}),
                                &mut budget,
                            )?,
                            None => Value::Null,
                        });
                    }
                    guard(&tx, &c)?;
                    tx.commit()?;
                    Ok(json!({"rows":rows}))
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::Query(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                query::validate(&r.query)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    scope(&c, &r.query.table)?;
                    guard(&self.db, &c)?;
                    let tx = self.db.unchecked_transaction()?;
                    let current = epoch(&tx, &r.query.table)?;
                    c.tables.entry(r.query.table.clone()).or_insert(current);
                    let mut identity = r.query.clone();
                    identity.cursor = None;
                    let identity = serde_json::to_string(&identity)?;
                    let (after, emitted) = if let Some(cursor) = &r.query.cursor {
                        let cursor = c
                            .cursors
                            .get(cursor)
                            .ok_or_else(|| Error::new("invalid", "Unknown query cursor"))?;
                        if cursor.query != identity {
                            return Err(Error::new("invalid", "Cursor query changed"));
                        }
                        (
                            Some((cursor.sort.as_slice(), cursor.primary.as_slice())),
                            cursor.emitted,
                        )
                    } else {
                        (None, 0)
                    };
                    let remaining = r.query.limit.map(|limit| limit.saturating_sub(emitted));
                    let mut bounded = r.query.clone();
                    if let Some(remaining) = remaining {
                        bounded.page_size = bounded.page_size.min(remaining);
                    }
                    let page = if remaining == Some(0) {
                        query::Page {
                            rows: Vec::new(),
                            more: false,
                        }
                    } else {
                        query::page(&tx, &bounded, after)?
                    };
                    let rows = page.rows;
                    let emitted = emitted + rows.len();
                    let more = page.more && r.query.limit.is_none_or(|limit| emitted < limit);
                    guard(&tx, &c)?;
                    tx.commit()?;
                    let cursor = if more {
                        let last = rows.last().expect("nonempty page");
                        let id = uuid::Uuid::new_v4().to_string();
                        c.cursors.insert(
                            id.clone(),
                            Cursor {
                                query: identity,
                                sort: last.sort.clone(),
                                primary: last.primary_sort.clone(),
                                emitted,
                            },
                        );
                        Some(id)
                    } else {
                        None
                    };
                    if let Some(old) = &r.query.cursor {
                        c.cursors.remove(old);
                    }
                    let mut budget = 0;
                    let rows = rows
                        .into_iter()
                        .map(|r| {
                            transfer_row(
                                &mut c,
                                json!({"key":WireText::from_internal(&r.key)?,"value":r.value}),
                                &mut budget,
                            )
                        })
                        .collect::<Result<Vec<_>>>()?;
                    Ok(json!({"rows":rows,"cursor":cursor,"epoch":current}))
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::Count(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                query::validate(&r.query)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    scope(&c, &r.query.table)?;
                    guard(&self.db, &c)?;
                    let tx = self.db.unchecked_transaction()?;
                    let current = epoch(&tx, &r.query.table)?;
                    c.tables.entry(r.query.table.clone()).or_insert(current);
                    let count = query::count(&tx, &r.query)?;
                    guard(&tx, &c)?;
                    tx.commit()?;
                    if count > 9_007_199_254_740_991 {
                        return Err(Error::new(
                            "unavailable",
                            "Count exceeds the JavaScript integer range",
                        ));
                    }
                    Ok(json!({"count":count}))
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::RequestStart(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    guard(&self.db, &c)?;
                    if c.incoming.is_some() {
                        return Err(Error::new(
                            "invalid",
                            "A read request is already being prepared",
                        ));
                    }
                    let transfer_id = uuid::Uuid::new_v4().to_string();
                    c.incoming = Some(IncomingRead {
                        transfer_id: transfer_id.clone(),
                        purpose: r.purpose,
                        payload: String::new(),
                    });
                    Ok(json!({"transferId": transfer_id}))
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::RequestChunk(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                registry::uuid(&r.transfer_id)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    guard(&self.db, &c)?;
                    let incoming = c
                        .incoming
                        .as_mut()
                        .ok_or_else(|| Error::new("closed", "Unknown prepared read request"))?;
                    if incoming.transfer_id != r.transfer_id
                        || incoming.payload.len() != r.offset
                        || r.payload.is_empty()
                        || r.payload.len() > 32768
                    {
                        return Err(Error::new("invalid", "Invalid prepared read request chunk"));
                    }
                    incoming.payload.push_str(&r.payload);
                    Ok(json!({"nextOffset": incoming.payload.len()}))
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::RequestFinish(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                registry::uuid(&r.transfer_id)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let incoming = c.incoming.take();
                let result = (|| {
                    guard(&self.db, &c)?;
                    let incoming = incoming
                        .ok_or_else(|| Error::new("closed", "Unknown prepared read request"))?;
                    if incoming.transfer_id != r.transfer_id || incoming.payload.is_empty() {
                        return Err(Error::new(
                            "invalid",
                            "Invalid prepared read request capability",
                        ));
                    }
                    match incoming.purpose {
                        ReadPurpose::Get => {
                            let payload: GetPayload = serde_json::from_str(&incoming.payload)?;
                            Ok(Request::Get(Get {
                                version: r.version,
                                session: r.session,
                                workspace_id: r.workspace_id,
                                generation: r.generation,
                                handle: r.handle.clone(),
                                operation_id: r.operation_id,
                                table: payload.table,
                                keys: payload.keys,
                            }))
                        }
                        ReadPurpose::Query | ReadPurpose::Count => {
                            let count = matches!(incoming.purpose, ReadPurpose::Count);
                            let payload: QueryPayload = serde_json::from_str(&incoming.payload)?;
                            let read = ReadQuery {
                                version: r.version,
                                session: r.session,
                                workspace_id: r.workspace_id,
                                generation: r.generation,
                                handle: r.handle.clone(),
                                operation_id: r.operation_id,
                                query: payload.query,
                            };
                            Ok(if count {
                                Request::Count(read)
                            } else {
                                Request::Query(read)
                            })
                        }
                    }
                })();
                self.contexts.insert(r.handle, c);
                // The consumed capability cannot be replayed even when JSON is malformed.
                self.run(result?, check)
            }
            Request::Prepare(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    if c.mode != "rw"
                        || c.capability.is_some()
                        || r.chunk_index != c.chunk
                        || r.payload.is_empty()
                        || r.payload.len() > 32768
                    {
                        return Err(Error::new("invalid", "Invalid prepared mutation chunk"));
                    }
                    let combined = format!("{}{}", c.residual, r.payload);
                    let split = combined.rfind('\n');
                    let (complete, residual) = split.map_or(("", combined.as_str()), |i| {
                        (&combined[..=i], &combined[i + 1..])
                    });
                    let tx = self.db.unchecked_transaction()?;
                    let mut ordinal = c.ordinal;
                    for line in complete.lines() {
                        let entry: BatchEntry = serde_json::from_str(line)?;
                        match &entry {
                            BatchEntry::Mutation { mutation } => {
                                scope(&c, mutation.table())?;
                                registry::key_text(mutation.key())?;
                                if let Some(value) = mutation.value()
                                    && registry::primary(value, mutation.table())? != mutation.key()
                                {
                                    return Err(Error::new(
                                        "invalid",
                                        "Mutation primary key mismatch",
                                    ));
                                }
                            }
                            BatchEntry::Claim { claim } => {
                                claim.reference.validate()?;
                                registry::uuid(&claim.stage_id)?;
                                if claim.reference.workspace_id != self.workspace_id {
                                    return Err(Error::new("invalid", "Foreign binary claim"));
                                }
                            }
                        }
                        tx.execute(
                            "INSERT INTO product_prepared VALUES (?,?,?)",
                            params![r.handle, ordinal as i64, line],
                        )?;
                        ordinal += 1;
                    }
                    tx.commit()?;
                    c.ordinal = ordinal;
                    c.residual = residual.into();
                    c.digest.update(r.payload.as_bytes());
                    c.chunk += 1;
                    Ok(json!({"nextChunk":c.chunk}))
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::Seal(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                registry::hash(&r.fingerprint)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    if c.mode != "rw"
                        || c.chunk != r.chunk_count
                        || !c.residual.is_empty()
                        || paths::hex_digest(c.digest.clone().finalize()) != r.fingerprint
                    {
                        return Err(Error::new(
                            "invalid",
                            "Prepared batch fingerprint or framing mismatch",
                        ));
                    }
                    let existing: Option<String> = self.db.query_row(
                        "SELECT fingerprint FROM product_operations WHERE operation_id=?",
                        [&r.operation_id],
                        |r| r.get(0),
                    )?;
                    if existing.as_ref().is_some_and(|fp| fp != &r.fingerprint) {
                        return Err(Error::new(
                            "invalid",
                            "Operation ID belongs to another payload",
                        ));
                    }
                    self.db.execute("UPDATE product_operations SET fingerprint=? WHERE operation_id=? AND fingerprint IS NULL",params![r.fingerprint,r.operation_id])?;
                    let capability = c
                        .capability
                        .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
                        .clone();
                    c.fingerprint = Some(r.fingerprint.clone());
                    Ok(json!({"capability":capability,"fingerprint":r.fingerprint}))
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::Commit(r) => self.commit(r, check),
            Request::Validate(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                let c = self.take(&r.handle, &r.operation_id)?;
                let result = guard(&self.db, &c);
                self.db
                    .execute("DELETE FROM product_prepared WHERE handle=?", [r.handle])?;
                result.map(|()| Value::Null)
            }
            Request::Abort(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                let c = self.take(&r.handle, &r.operation_id)?;
                self.db
                    .execute("DELETE FROM product_prepared WHERE handle=?", [r.handle])?;
                if c.fingerprint.is_some() {
                    self.db.execute("UPDATE product_operations SET status='rolledBack' WHERE operation_id=? AND status='pending'",[r.operation_id])?;
                }
                Ok(Value::Null)
            }
            Request::Status(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                registry::uuid(&r.operation_id)?;
                registry::hash(&r.fingerprint)?;
                self.status(&r.operation_id, &r.fingerprint)
            }
            Request::ReadTransfer(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                let mut c = self.take(&r.handle, &r.operation_id)?;
                let result = (|| {
                    guard(&self.db, &c)?;
                    if r.byte_length == 0 || r.byte_length > 262144 {
                        return Err(Error::new("invalid", "Metadata transfer chunk boundary"));
                    }
                    let text = c
                        .transfers
                        .get(&r.transfer_id)
                        .ok_or_else(|| Error::new("closed", "Unknown metadata read transfer"))?;
                    if r.offset > text.len() || !text.is_char_boundary(r.offset) {
                        return Err(Error::new("invalid", "Invalid metadata transfer offset"));
                    }
                    let mut end = r
                        .offset
                        .saturating_add(r.byte_length.min(32768))
                        .min(text.len());
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    if end == r.offset && end < text.len() {
                        return Err(Error::new(
                            "invalid",
                            "Chunk cannot hold one UTF-8 codepoint",
                        ));
                    }
                    let result =
                        json!({"payload":&text[r.offset..end],"offset":end,"end":end==text.len()});
                    if end == text.len() {
                        c.transfers.remove(&r.transfer_id);
                    }
                    Ok(result)
                })();
                self.contexts.insert(r.handle, c);
                result
            }
            Request::Changes(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                if r.page_size == 0 || r.page_size > 256 || r.change_sequence > self.sequence()? {
                    return Err(Error::new("invalid", "Change query boundary"));
                }
                let offset = if let Some(cursor) = &r.cursor {
                    let (seq, ordinal) = self
                        .change_cursors
                        .remove(cursor)
                        .ok_or_else(|| Error::new("invalid", "Unknown changes cursor"))?;
                    if seq != r.change_sequence {
                        return Err(Error::new("invalid", "Change cursor sequence mismatch"));
                    }
                    ordinal
                } else {
                    -1
                };
                let mut statement=self.db.prepare("SELECT ordinal,table_name,row_key,before_indexes,after_indexes FROM product_changes WHERE change_sequence=? AND ordinal>? ORDER BY ordinal LIMIT ?")?;
                let mut raw = statement.query(params![
                    r.change_sequence as i64,
                    offset,
                    r.page_size as i64 + 1
                ])?;
                let mut changes = Vec::new();
                let mut bytes = 0;
                let mut last = offset;
                let mut more = false;
                while let Some(row) = raw.next()? {
                    let before = row
                        .get_ref(3)?
                        .as_str()
                        .map_err(|_| Error::new("corrupt", "Invalid change indexes"))?;
                    let after = row
                        .get_ref(4)?
                        .as_str()
                        .map_err(|_| Error::new("corrupt", "Invalid change indexes"))?;
                    if changes.len() == r.page_size
                        || !changes.is_empty() && bytes + before.len() + after.len() > 65536
                    {
                        more = true;
                        break;
                    }
                    let ordinal: i64 = row.get(0)?;
                    let table: String = row.get(1)?;
                    let key: String = row.get(2)?;
                    let change = json!({"table":table,"key":WireText::from_internal(&key)?,"before":serde_json::from_str::<Value>(before)?,"after":serde_json::from_str::<Value>(after)?});
                    let serialized = serde_json::to_string(&change)?;
                    let size = serialized.len();
                    if !changes.is_empty() && bytes + size > 65536 {
                        more = true;
                        break;
                    }
                    bytes += size;
                    last = ordinal;
                    if size > 65536 {
                        let id = uuid::Uuid::new_v4().to_string();
                        self.change_transfers.insert(id.clone(), serialized);
                        changes.push(json!({"kind":"transfer","transferId":id}));
                    } else {
                        changes.push(change);
                    }
                }
                drop(raw);
                drop(statement);
                let cursor = if more {
                    let id = uuid::Uuid::new_v4().to_string();
                    self.change_cursors
                        .insert(id.clone(), (r.change_sequence, last));
                    Some(id)
                } else {
                    None
                };
                Ok(json!({"changes":changes,"cursor":cursor}))
            }
            Request::ReadChangeTransfer(r) => {
                self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
                let text = self
                    .change_transfers
                    .get(&r.transfer_id)
                    .ok_or_else(|| Error::new("closed", "Unknown change metadata transfer"))?;
                let result = string_chunk(text, r.offset, r.byte_length)?;
                if result["end"] == true {
                    self.change_transfers.remove(&r.transfer_id);
                }
                Ok(result)
            }
        }
    }
    pub(crate) fn mcp_catalogue(&self, session: &Session) -> Result<Value> {
        self.validate_session(session)?;
        let key = WireText::from("agentMcp.catalog.v1");
        let payload:Option<String> = self.db.query_row("SELECT payload FROM product_records WHERE table_name='deviceSettings' AND row_key=?", [key], |row| row.get(0)).optional()?;
        match payload {
            None => Ok(Value::Null),
            Some(payload) if payload.len() <= 4 * 1024 * 1024 => {
                let encoded: Value = serde_json::from_str(&payload)?;
                let value = registry::field(&encoded, "value")
                    .ok_or_else(|| Error::new("corrupt", "MCP catalogue record missing value"))?;
                fn decode(value: &Value, depth: usize) -> Result<Value> {
                    if depth > 48 {
                        return Err(Error::new("corrupt", "MCP catalogue depth"));
                    }
                    let array = value
                        .as_array()
                        .ok_or_else(|| Error::new("corrupt", "MCP catalogue encoding"))?;
                    let bad = || Error::new("corrupt", "MCP catalogue encoding");
                    Ok(match array.first().and_then(Value::as_str) {
                        Some("null") => Value::Null,
                        Some("str" | "bool" | "num") => array
                            .get(1)
                            .filter(|v| !v.is_array() && !v.is_object())
                            .ok_or_else(bad)?
                            .clone(),
                        Some("arr") => Value::Array(
                            array
                                .get(1)
                                .and_then(Value::as_array)
                                .ok_or_else(bad)?
                                .iter()
                                .map(|v| decode(v, depth + 1))
                                .collect::<Result<_>>()?,
                        ),
                        Some("obj") => {
                            let mut out = serde_json::Map::new();
                            for item in array.get(1).and_then(Value::as_array).ok_or_else(bad)? {
                                let entry = item.as_array().ok_or_else(bad)?;
                                let name = entry.first().and_then(Value::as_str).ok_or_else(bad)?;
                                if out
                                    .insert(
                                        name.into(),
                                        decode(entry.get(1).ok_or_else(bad)?, depth + 1)?,
                                    )
                                    .is_some()
                                {
                                    return Err(bad());
                                }
                            }
                            Value::Object(out)
                        }
                        _ => return Err(bad()),
                    })
                }
                let decoded = decode(value, 0)?;
                if decoded.is_null() {
                    return Err(Error::new("corrupt", "MCP catalogue cannot be null"));
                }
                Ok(decoded)
            }
            Some(_) => Err(Error::new("corrupt", "MCP catalogue too large")),
        }
    }
    fn status(&self, operation: &str, fingerprint: &str) -> Result<Value> {
        let outcome: Option<(Option<String>, String, Option<String>)> = self
            .db
            .query_row(
                "SELECT fingerprint,status,receipt FROM product_operations WHERE operation_id=?",
                [operation],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        match outcome {
            None => Ok(json!({"status":"notFound","operationId":operation})),
            Some((Some(fp), _, _)) if fp != fingerprint => Err(Error::new(
                "invalid",
                "Operation payload fingerprint mismatch",
            )),
            Some((_, status, receipt)) => {
                if status == "committed" {
                    Ok(serde_json::from_str(&receipt.ok_or_else(|| {
                        Error::new("corrupt", "Missing committed receipt")
                    })?)?)
                } else {
                    Ok(json!({"status":status,"operationId":operation}))
                }
            }
        }
    }
    fn commit(&mut self, r: Commit, check: impl Fn() -> Result<()>) -> Result<Value> {
        self.session(r.version, &r.session, &r.workspace_id, r.generation)?;
        registry::uuid(&r.capability)?;
        registry::hash(&r.fingerprint)?;
        // A duplicate confirmed command is read-only. No old handle is revived.
        let status = self.status(&r.operation_id, &r.fingerprint)?;
        if status["status"] == "committed" {
            return Ok(status);
        }
        let c = self.take(&r.handle, &r.operation_id)?;
        if c.mode != "rw"
            || c.capability.as_ref() != Some(&r.capability)
            || c.fingerprint.as_ref() != Some(&r.fingerprint)
        {
            self.contexts.insert(r.handle, c);
            return Err(Error::new(
                "invalid",
                "Unsealed or mismatched commit capability",
            ));
        }
        let result = (|| {
            check()?;
            guard(&self.db, &c)?;
            let claims = self
                .db
                .prepare("SELECT payload FROM product_prepared WHERE handle=? ORDER BY ordinal")?
                .query_map([&r.handle], |r| r.get::<_, String>(0))?
                .filter_map(|p| match p {
                    Ok(payload) => match serde_json::from_str::<BatchEntry>(&payload) {
                        Ok(BatchEntry::Claim { claim }) => Some(
                            serde_json::from_value::<product_binary::BinaryClaim>(
                                serde_json::to_value(claim).expect("claim serializes"),
                            )
                            .map_err(Error::from),
                        ),
                        Ok(_) => None,
                        Err(e) => Some(Err(e.into())),
                    },
                    Err(e) => Some(Err(e.into())),
                })
                .collect::<Result<Vec<_>>>()?;
            let mut check_files = || {
                check()?;
                self.boundary.validate()
            };
            let verified = self
                .binaries
                .verify_claims(&self.db, &claims, &mut check_files)?;
            let claimed: BTreeMap<_, _> = claims
                .iter()
                .map(|c| (c.reference.binary_id.clone(), c.reference.clone()))
                .collect();
            let mut used = BTreeSet::new();
            // Validate every declared carrier before the short writer. Unknown JSON
            // extension properties cannot turn into file capabilities.
            let mut prepared = self
                .db
                .prepare("SELECT payload FROM product_prepared WHERE handle=? ORDER BY ordinal")?;
            for payload in prepared.query_map([&r.handle], |r| r.get::<_, String>(0))? {
                if let BatchEntry::Mutation { mutation } = serde_json::from_str(&payload?)?
                    && let Some(value) = mutation.value()
                {
                    for reference in carrier_references(mutation.table(), value)? {
                        product_binary::validate_reference(&reference, &self.workspace_id)?;
                        if let Some(claim) = claimed.get(&reference.binary_id) {
                            if claim != &reference {
                                return Err(Error::new(
                                    "invalid",
                                    "Binary reference differs from prepared claim",
                                ));
                            }
                            used.insert(reference.binary_id);
                        } else {
                            self.binaries.validate_committed(&self.db, &reference)?;
                        }
                    }
                }
            }
            drop(prepared);
            if used.len() != claimed.len() {
                return Err(Error::new(
                    "invalid",
                    "Binary claim has no declared row carrier",
                ));
            }
            let sequence = self
                .sequence()?
                .checked_add(1)
                .ok_or_else(|| Error::new("unavailable", "Storage revision exhausted"))?;
            if sequence > 9_007_199_254_740_991 {
                return Err(Error::new(
                    "unavailable",
                    "Storage revision exceeds safe wire precision",
                ));
            }
            let tx = self.db.transaction()?;
            guard(&tx, &c)?;
            product_binary::claim_prepared(&tx, &r.operation_id, &verified)?;
            let mut changed: BTreeSet<String> = BTreeSet::new();
            let mut before: BTreeMap<(String, String), Option<Value>> = BTreeMap::new();
            let mut prepared =
                tx.prepare("SELECT payload FROM product_prepared WHERE handle=? ORDER BY ordinal")?;
            for payload in prepared.query_map([&r.handle], |r| r.get::<_, String>(0))? {
                let entry: BatchEntry = serde_json::from_str(&payload?)?;
                let BatchEntry::Mutation { mutation } = entry else {
                    continue;
                };
                let table = mutation.table();
                let key = mutation.key();
                scope(&c, table)?;
                let previous: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM product_records WHERE table_name=? AND row_key=?",
                        params![table, key],
                        |r| r.get(0),
                    )
                    .optional()?;
                before.entry((table.into(), key.into())).or_insert(
                    previous
                        .as_ref()
                        .map(|s| serde_json::from_str::<Value>(s))
                        .transpose()?,
                );
                if matches!(mutation, Mutation::Add { .. }) && previous.is_some() {
                    return Err(Error::new("constraint", "Duplicate product primary key"));
                }
                if mutation.value().is_none() && previous.is_none() {
                    continue;
                }
                tx.execute(
                    "DELETE FROM product_records WHERE table_name=? AND row_key=?",
                    params![table, key],
                )?;
                if let Some(value) = mutation.value() {
                    if registry::primary(value, table)? != key {
                        return Err(Error::new("invalid", "Mutation key mismatch"));
                    }
                    let primary = query::ordered(&Key::String {
                        value: WireText::from_internal(key)?,
                    })?;
                    tx.execute(
                        "INSERT INTO product_records VALUES (?,?,?,?,?)",
                        params![
                            table,
                            key,
                            primary,
                            serde_json::to_string(value)?,
                            sequence as i64
                        ],
                    )?;
                    for projection in query::projections(table, key, value)? {
                        tx.execute(
                            "INSERT INTO product_indexes VALUES (?,?,?,?)",
                            params![table, projection.index, key, projection.ordered],
                        )?;
                        if projection.unique {
                            tx.execute(
                                "INSERT INTO product_unique_indexes VALUES (?,?,?,?)",
                                params![table, projection.index, projection.ordered, key],
                            )
                            .map_err(|e| match e {
                                rusqlite::Error::SqliteFailure(ref failure, _)
                                    if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
                                {
                                    Error::new("constraint", "Duplicate registered unique index")
                                }
                                _ => e.into(),
                            })?;
                        }
                    }
                }
                tx.execute("INSERT INTO product_revisions VALUES (?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET revision=excluded.revision",params![table,key,sequence as i64])?;
                changed.insert(table.into());
            }
            drop(prepared);
            for table in &changed {
                tx.execute(
                    "UPDATE product_tables SET epoch=? WHERE name=?",
                    params![sequence as i64, table],
                )?;
            }
            for (ordinal, ((table, key), previous)) in before.into_iter().enumerate() {
                if !changed.contains(&table) {
                    continue;
                }
                let current: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM product_records WHERE table_name=? AND row_key=?",
                        params![table, key],
                        |r| r.get(0),
                    )
                    .optional()?;
                let current = current
                    .as_ref()
                    .map(|s| serde_json::from_str::<Value>(s))
                    .transpose()?;
                tx.execute(
                    "INSERT INTO product_changes VALUES (?,?,?,?,?,?)",
                    params![
                        sequence as i64,
                        ordinal as i64,
                        table,
                        key,
                        serde_json::to_string(&query::index_values(
                            &table,
                            &key,
                            previous.as_ref()
                        )?)?,
                        serde_json::to_string(&query::index_values(
                            &table,
                            &key,
                            current.as_ref()
                        )?)?
                    ],
                )?;
            }
            tx.execute(
                "UPDATE product_workspace SET change_sequence=?",
                [sequence as i64],
            )?;
            let receipt = Receipt {
                status: "committed".into(),
                operation_id: r.operation_id.clone(),
                fingerprint: r.fingerprint.clone(),
                change_sequence: sequence,
                tables: changed.into_iter().collect(),
            };
            tx.execute("UPDATE product_operations SET status='committed',receipt=? WHERE operation_id=? AND fingerprint=?",params![serde_json::to_string(&receipt)?,r.operation_id,r.fingerprint])?;
            tx.execute("DELETE FROM product_prepared WHERE handle=?", [&r.handle])?;
            self.hooks.hit("product-precommit")?;
            self.boundary.validate()?;
            product_binary::validate_claim_files(&verified)?;
            check()?;
            tx.commit()?;
            // Past this point caller cancellation or reply loss cannot mean rollback.
            self.hooks.hit("product-committed")?;
            Ok(serde_json::to_value(receipt)?)
        })();
        if result.is_err() {
            // Read the durable state before classifying failure: a hook/IPC failure
            // after COMMIT is deliberately left committed for status reconciliation.
            let committed: bool = self.db.query_row(
                "SELECT status='committed' FROM product_operations WHERE operation_id=?",
                [&r.operation_id],
                |r| r.get(0),
            )?;
            if !committed {
                self.db.execute("UPDATE product_operations SET status='rolledBack' WHERE operation_id=? AND status='pending'",[&r.operation_id])?;
                self.db
                    .execute("DELETE FROM product_prepared WHERE handle=?", [&r.handle])?;
            }
        }
        result
    }
    pub fn run_binary(
        &mut self,
        request: product_binary::BinaryRequest,
        mut check: impl FnMut() -> Result<()>,
    ) -> Result<product_binary::BinaryReply> {
        self.boundary.validate()?;
        check()?;
        self.binaries.run_checked(&self.db, request, &mut check)
    }
    pub fn playback(
        &self,
        reference: &product_binary::ManagedBinaryRef,
        mut check: impl FnMut() -> Result<()>,
    ) -> Result<product_binary::PlaybackFile> {
        self.boundary.validate()?;
        check()?;
        self.binaries.playback(&self.db, reference, &mut check)
    }
    pub fn close(&mut self) -> Result<()> {
        self.contexts.clear();
        self.binaries.close(&self.db)?;
        self.writer.execute_batch("ROLLBACK")?;
        Ok(())
    }
}
fn carrier_references(table: &str, value: &Value) -> Result<Vec<product_binary::ManagedBinaryRef>> {
    fn walk(
        value: &Value,
        path: &mut Vec<String>,
        table: &str,
        refs: &mut Vec<product_binary::ManagedBinaryRef>,
    ) -> Result<()> {
        let node = value
            .as_array()
            .ok_or_else(|| Error::new("invalid", "Bad encoded carrier"))?;
        match node.first().and_then(Value::as_str) {
            Some("binary") => {
                let valid = table == "media" && path.as_slice() == ["blob"]
                    || table == "materialVersions"
                        && (path.as_slice() == ["payload", "blob"]
                            || (path.len() == 4
                                && path[0] == "payload"
                                && path[1] == "media"
                                && path[3] == "blob"));
                if !valid {
                    return Err(Error::new(
                        "invalid",
                        "Binary token outside a declared durable carrier",
                    ));
                }
                refs.push(serde_json::from_value(node[1].clone())?);
            }
            Some("obj" | "obj16") => {
                for item in node[1].as_array().expect("validated object") {
                    let pair = item.as_array().expect("validated property");
                    let name = if node[0] == "obj" {
                        pair[0].as_str().expect("validated name").into()
                    } else {
                        String::from_utf16(
                            &pair[0]
                                .as_array()
                                .expect("name")
                                .iter()
                                .map(|n| n.as_u64().expect("unit") as u16)
                                .collect::<Vec<_>>(),
                        )
                        .unwrap_or_else(|_| "$noncarrier".into())
                    };
                    path.push(name);
                    walk(&pair[1], path, table, refs)?;
                    path.pop();
                }
            }
            Some("arr") => {
                for (i, item) in node[1]
                    .as_array()
                    .expect("validated array")
                    .iter()
                    .enumerate()
                {
                    path.push(i.to_string());
                    walk(item, path, table, refs)?;
                    path.pop();
                }
            }
            _ => (),
        }
        Ok(())
    }
    let mut refs = Vec::new();
    walk(value, &mut Vec::new(), table, &mut refs)?;
    Ok(refs)
}
fn transfer_row(c: &mut Context, row: Value, budget: &mut usize) -> Result<Value> {
    let text = serde_json::to_string(&row)?;
    if text.len() + *budget <= 65536 {
        *budget += text.len();
        Ok(json!({"kind":"inline","row":row}))
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        c.transfers.insert(id.clone(), text);
        Ok(json!({"kind":"transfer","transferId":id}))
    }
}
fn string_chunk(text: &str, offset: usize, length: usize) -> Result<Value> {
    if length == 0 || length > 262144 || offset > text.len() || !text.is_char_boundary(offset) {
        return Err(Error::new("invalid", "Metadata transfer boundary"));
    }
    let mut end = offset.saturating_add(length.min(32768)).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == offset && end < text.len() {
        return Err(Error::new("invalid", "Chunk cannot hold UTF-8 codepoint"));
    }
    Ok(json!({"payload":&text[offset..end],"offset":end,"end":end==text.len()}))
}
fn validate_open(db: &Connection) -> Result<()> {
    validate_open_for_registry(db, registry::REGISTRY_JSON, true)
}
fn validate_open_for_registry(db: &Connection, raw: &str, has_snapshot: bool) -> Result<()> {
    let registry = registry::parse(raw)?;
    let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(Error::new("corrupt", "Product SQLite integrity failed"));
    }
    let count: i64 = db.query_row("SELECT count(*) FROM product_workspace", [], |r| r.get(0))?;
    if count != 1 {
        return Err(Error::new("schema", "Ambiguous product identity"));
    }
    let actual: BTreeSet<String> = db
        .prepare("SELECT name FROM product_tables")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    if actual != registry.tables.keys().cloned().collect() {
        return Err(Error::new("schema", "Product table registry mismatch"));
    }
    let expected = Connection::open_in_memory()?;
    for (_, sql) in TABLES {
        expected.execute_batch(sql)?;
    }
    expected.execute_batch(product_binary::BINARY_SCHEMA)?;
    if has_snapshot {
        expected.execute_batch(REGISTRY_SCHEMA)?;
        if registry_migrations::stored_snapshot(db)? != raw {
            return Err(Error::new(
                "corrupt",
                "Persisted registry snapshot mismatch",
            ));
        }
    }
    let schema = |db: &Connection| -> Result<BTreeSet<(String, String, String)>> {
        Ok(db
            .prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?)
    };
    if schema(db)? != schema(&expected)? {
        return Err(Error::new("schema", "Unexpected product SQLite schema"));
    }
    let (workspace, schema_version, stored): (String, u32, String) = db.query_row(
        "SELECT id,schema,registry_hash FROM product_workspace",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    registry::uuid(&workspace)?;
    if schema_version != SCHEMA
        || db.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))? != SCHEMA
        || stored != digest(raw.as_bytes())
    {
        return Err(Error::new("schema", "Product registry identity mismatch"));
    }
    let sequence: i64 = db.query_row("SELECT change_sequence FROM product_workspace", [], |r| {
        r.get(0)
    })?;
    if !(0..=9_007_199_254_740_991).contains(&sequence) {
        return Err(Error::new("corrupt", "Invalid storage sequence"));
    }
    let bad_epoch: i64 = db.query_row(
        "SELECT count(*) FROM product_tables WHERE epoch<0 OR epoch>?",
        [sequence],
        |r| r.get(0),
    )?;
    let bad_revision: i64 = db.query_row(
        "SELECT count(*) FROM product_revisions WHERE revision<=0 OR revision>?",
        [sequence],
        |r| r.get(0),
    )?;
    if bad_epoch != 0 || bad_revision != 0 {
        return Err(Error::new("corrupt", "Invalid native revision guard state"));
    }
    let mut statement =
        db.prepare("SELECT table_name,row_key,payload,primary_sort,revision FROM product_records")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Vec<u8>>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    for row in rows {
        let (table, key, payload, primary_sort, record_revision) = row?;
        let value: Value = serde_json::from_str(&payload)?;
        let definition = registry
            .tables
            .get(&table)
            .ok_or_else(|| Error::new("corrupt", "Unknown persisted product table"))?;
        if registry::primary_for_table(&value, definition)? != key {
            return Err(Error::new("corrupt", "Persisted product key mismatch"));
        }
        if primary_sort
            != query::ordered(&Key::String {
                value: WireText::from_internal(&key)?,
            })?
            || record_revision as u64 != revision(db, &table, &key)?
            || record_revision <= 0
            || record_revision > sequence
        {
            return Err(Error::new(
                "corrupt",
                "Persisted primary/revision projection mismatch",
            ));
        }
        let expected = query::projections_for_table(definition, &key, &value)?;
        let actual: BTreeSet<(String, Vec<u8>)> = db
            .prepare(
                "SELECT index_name,sort_key FROM product_indexes WHERE table_name=? AND row_key=?",
            )?
            .query_map(params![table, key], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        if actual
            != expected
                .iter()
                .map(|p| (p.index.clone(), p.ordered.clone()))
                .collect()
        {
            return Err(Error::new("corrupt", "Persisted product index mismatch"));
        }
        let unique:BTreeSet<(String,Vec<u8>)>=db.prepare("SELECT index_name,sort_key FROM product_unique_indexes WHERE table_name=? AND row_key=?")?.query_map(params![table,key],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<std::result::Result<_,_>>()?;
        if unique
            != expected
                .iter()
                .filter(|p| p.unique)
                .map(|p| (p.index.clone(), p.ordered.clone()))
                .collect()
        {
            return Err(Error::new("corrupt", "Persisted unique index mismatch"));
        }
        for reference in carrier_references(&table, &value)? {
            product_binary::validate_reference(&reference, &workspace)?;
            let stored:Option<(i64,String,String)>=db.query_row("SELECT byte_length,mime_type,content_hash FROM product_binaries WHERE binary_id=?",[reference.binary_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if stored
                != Some((
                    reference.byte_length as i64,
                    reference.mime_type,
                    reference.content_hash,
                ))
            {
                return Err(Error::new(
                    "corrupt",
                    "Persisted managed binary closure mismatch",
                ));
            }
        }
    }
    let mut statements =
        db.prepare("SELECT operation_id,fingerprint,status,receipt FROM product_operations")?;
    for row in statements.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })? {
        let (operation, fingerprint, status, receipt) = row?;
        registry::uuid(&operation)?;
        if let Some(fp) = &fingerprint {
            registry::hash(fp)?;
        }
        match status.as_str() {
            "pending" | "rolledBack" if receipt.is_none() => (),
            "committed" => {
                let receipt: Receipt =
                    serde_json::from_str(&receipt.ok_or_else(|| {
                        Error::new("corrupt", "Missing durable operation receipt")
                    })?)?;
                if receipt.status != "committed"
                    || receipt.operation_id != operation
                    || Some(receipt.fingerprint) != fingerprint
                    || receipt.change_sequence > sequence as u64
                    || receipt.change_sequence == 0
                    || receipt
                        .tables
                        .iter()
                        .any(|t| !registry.tables.contains_key(t))
                {
                    return Err(Error::new("corrupt", "Invalid committed operation receipt"));
                }
            }
            _ => return Err(Error::new("corrupt", "Invalid durable operation status")),
        }
    }
    let mut changes = db.prepare("SELECT DISTINCT table_name FROM product_changes")?;
    for table in changes.query_map([], |row| row.get::<_, String>(0))? {
        if !registry.tables.contains_key(&table?) {
            return Err(Error::new("corrupt", "Unknown persisted change table"));
        }
    }
    let errors: i64 = db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if errors != 0 {
        return Err(Error::new("corrupt", "Product record closure failed"));
    }
    Ok(())
}
#[cfg(all(test, feature = "test-hooks"))]
mod tests;
