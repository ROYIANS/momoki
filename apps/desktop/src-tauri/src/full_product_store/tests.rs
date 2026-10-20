use super::*;
fn fixture(hooks: Hooks) -> FullProductStore {
    let root = std::env::temp_dir().join(format!("momoki-product-test-{}", uuid::Uuid::new_v4()));
    FullProductStore::open(root, true, hooks).unwrap()
}
fn call(store: &mut FullProductStore, kind: &str, mut dto: Value) -> Result<Value> {
    if kind != "open" {
        let token = store.token();
        for key in ["version", "session", "workspaceId", "generation"] {
            dto[key] = token[key].clone();
        }
    }
    let request: Request = serde_json::from_value(json!({"type":kind,"request":dto}))?;
    request.validate_wire()?;
    store.run(request, || Ok(()))
}
fn begin(store: &mut FullProductStore, tables: &[&str]) -> Value {
    call(
        store,
        "begin",
        json!({"operationId":uuid::Uuid::new_v4().to_string(),"mode":"rw","tables":tables}),
    )
    .unwrap()
}
fn encoded(properties: Vec<(&str, Value)>) -> Value {
    json!([
        "obj",
        properties
            .into_iter()
            .map(|(key, value)| json!([key, value]))
            .collect::<Vec<_>>()
    ])
}
fn row(id: &str, properties: Vec<(&str, Value)>) -> Value {
    let mut p = vec![("id", json!(["str", id]))];
    p.extend(properties);
    encoded(p)
}
fn finish(store: &mut FullProductStore, handle: &Value, mutations: Vec<Value>) -> Result<Value> {
    finish_entries(
        store,
        handle,
        mutations
            .into_iter()
            .map(|mutation| json!({"kind":"mutation","mutation":mutation}))
            .collect(),
    )
}
fn finish_entries(
    store: &mut FullProductStore,
    handle: &Value,
    entries: Vec<Value>,
) -> Result<Value> {
    let payload = entries
        .into_iter()
        .map(|entry| serde_json::to_string(&entry).unwrap() + "\n")
        .collect::<String>();
    let mut sha = Sha256::new();
    sha.update(b"momoki-batch-v1\n");
    sha.update(payload.as_bytes());
    let fingerprint = paths::hex_digest(sha.finalize());
    let mut offset = 0;
    let mut chunk = 0;
    while offset < payload.len() {
        let mut end = (offset + 32768).min(payload.len());
        while !payload.is_char_boundary(end) {
            end -= 1;
        }
        let mut dto = handle.clone();
        dto["chunkIndex"] = json!(chunk);
        dto["payload"] = json!(&payload[offset..end]);
        call(store, "prepare", dto)?;
        offset = end;
        chunk += 1;
    }
    let mut dto = handle.clone();
    dto["chunkCount"] = json!(chunk);
    dto["fingerprint"] = json!(fingerprint);
    let sealed = call(store, "seal", dto)?;
    let mut dto = handle.clone();
    dto["capability"] = sealed["capability"].clone();
    dto["fingerprint"] = json!(fingerprint);
    call(store, "commit", dto)
}
fn put(table: &str, key: &str, value: Value) -> Value {
    json!({"kind":"put","table":table,"key":key,"value":value})
}
fn get(store: &mut FullProductStore, h: &Value, table: &str, key: &str) -> Value {
    let mut dto = h.clone();
    dto["table"] = json!(table);
    dto["keys"] = json!([key]);
    call(store, "get", dto).unwrap()["rows"][0].clone()
}
fn scan(
    store: &mut FullProductStore,
    h: &Value,
    table: &str,
    index: Option<&str>,
) -> Result<Value> {
    let mut dto = h.clone();
    dto["query"] = json!({"table":table,"index":index,"selector":{"kind":"all"},"reverse":false,"cursor":null,"pageSize":256});
    call(store, "query", dto)
}
fn dispose(mut store: FullProductStore) {
    let root = store.root.clone();
    store.close().unwrap();
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn all_current_tables_keys_and_own_undefined_reopen_losslessly() {
    let mut store = fixture(Hooks::default());
    let names = registry::tables()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let h = begin(&mut store, &names);
    let mutations = names
        .iter()
        .map(|name| {
            let def = registry::table(name).unwrap();
            put(
                name,
                "one",
                encoded(vec![
                    (def.key_path.as_str(), json!(["str", "one"])),
                    ("clear", json!(["undef"])),
                    ("rawToolArguments", json!(["str", "{\"exact\": true}\n"])),
                    ("unknownLone", json!(["utf16", [0xd800]])),
                ]),
            )
        })
        .collect();
    let receipt = finish(&mut store, &h, mutations).unwrap();
    assert_eq!(receipt["tables"].as_array().unwrap().len(), names.len());
    let root = store.root.clone();
    let workspace = store.workspace_id.clone();
    store.close().unwrap();
    drop(store);
    let mut store = FullProductStore::open(root, false, Hooks::default()).unwrap();
    assert_eq!(store.workspace_id, workspace);
    for name in names {
        let h = begin(&mut store, &[name]);
        let value = get(&mut store, &h, name, "one");
        assert_eq!(
            registry::field(&value["row"]["value"], "clear"),
            Some(&json!(["undef"]))
        );
        call(&mut store, "abort", h).unwrap();
    }
    dispose(store);
}
#[test]
fn failed_final_ledger_rolls_back_all_business_rows_and_receipt() {
    let hooks = Hooks::new(|point| {
        if point == "product-precommit" {
            Err(Error::new("test", "Injected final ledger failure"))
        } else {
            Ok(())
        }
    });
    let mut store = fixture(hooks);
    let h = begin(&mut store, &["projects", "agentToolCalls"]);
    assert_eq!(
        finish(
            &mut store,
            &h,
            vec![
                put("projects", "p", row("p", vec![])),
                put(
                    "agentToolCalls",
                    "call",
                    row("call", vec![("status", json!(["str", "completed"]))])
                )
            ]
        )
        .unwrap_err()
        .code,
        "test"
    );
    let h = begin(&mut store, &["projects", "agentToolCalls"]);
    assert!(get(&mut store, &h, "projects", "p").is_null());
    assert!(get(&mut store, &h, "agentToolCalls", "call").is_null());
    assert_eq!(store.sequence().unwrap(), 0);
    dispose(store);
}
#[test]
fn optional_compound_unique_constraints_and_index_tie_order_are_real_sqlite() {
    let mut store = fixture(Hooks::default());
    let h = begin(&mut store, &["shots", "agentGenerationJobs"]);
    finish(
        &mut store,
        &h,
        vec![
            put("shots", "z", row("z", vec![("order", json!(["num", 1]))])),
            put("shots", "a", row("a", vec![("order", json!(["num", 1]))])),
            put("agentGenerationJobs", "a", row("a", vec![])),
            put(
                "agentGenerationJobs",
                "b",
                row("b", vec![("batchItemId", json!(["undef"]))]),
            ),
        ],
    )
    .unwrap();
    let h = begin(&mut store, &["shots"]);
    let page = scan(&mut store, &h, "shots", Some("order")).unwrap();
    assert_eq!(page["rows"][0]["row"]["key"], "a");
    assert_eq!(page["rows"][1]["row"]["key"], "z");
    let h = begin(&mut store, &["agentToolCalls"]);
    let entries = vec![
        put(
            "agentToolCalls",
            "a",
            row(
                "a",
                vec![
                    ("runId", json!(["str", "run"])),
                    ("providerCallId", json!(["str", "call"])),
                ],
            ),
        ),
        put(
            "agentToolCalls",
            "b",
            row(
                "b",
                vec![
                    ("runId", json!(["str", "run"])),
                    ("providerCallId", json!(["str", "call"])),
                ],
            ),
        ),
    ];
    assert_eq!(
        finish(&mut store, &h, entries).unwrap_err().code,
        "constraint"
    );
    let h = begin(&mut store, &["agentToolCalls"]);
    assert_eq!(
        scan(&mut store, &h, "agentToolCalls", None).unwrap()["rows"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    dispose(store);
}
#[test]
fn point_absence_phantom_and_delete_recreate_aba_all_conflict() {
    let mut store = fixture(Hooks::default());
    let absent = begin(&mut store, &["projects"]);
    assert!(get(&mut store, &absent, "projects", "p").is_null());
    let writer = begin(&mut store, &["projects"]);
    finish(
        &mut store,
        &writer,
        vec![put("projects", "p", row("p", vec![]))],
    )
    .unwrap();
    assert_eq!(
        finish(
            &mut store,
            &absent,
            vec![put("projects", "other", row("other", vec![]))]
        )
        .unwrap_err()
        .code,
        "conflict"
    );
    let phantom = begin(&mut store, &["media"]);
    assert!(
        scan(&mut store, &phantom, "media", Some("projectId")).unwrap()["rows"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let writer = begin(&mut store, &["media"]);
    finish(
        &mut store,
        &writer,
        vec![put(
            "media",
            "m",
            row("m", vec![("projectId", json!(["str", "p"]))]),
        )],
    )
    .unwrap();
    assert_eq!(
        call(&mut store, "validate", phantom).unwrap_err().code,
        "conflict"
    );
    let aba = begin(&mut store, &["projects"]);
    get(&mut store, &aba, "projects", "p");
    let writer = begin(&mut store, &["projects"]);
    finish(
        &mut store,
        &writer,
        vec![
            json!({"kind":"delete","table":"projects","key":"p"}),
            put("projects", "p", row("p", vec![])),
        ],
    )
    .unwrap();
    assert_eq!(
        call(&mut store, "validate", aba).unwrap_err().code,
        "conflict"
    );
    dispose(store);
}
#[test]
fn lost_commit_reply_durable_lookup_reopen_and_changed_payload_id_reject() {
    let hooks = Hooks::new(|point| {
        if point == "product-committed" {
            Err(Error::new("test", "Lost acknowledgement"))
        } else {
            Ok(())
        }
    });
    let mut store = fixture(hooks);
    let h = begin(&mut store, &["projects"]);
    assert_eq!(
        finish(&mut store, &h, vec![put("projects", "p", row("p", vec![]))])
            .unwrap_err()
            .code,
        "test"
    );
    let fp: String = store
        .db
        .query_row(
            "SELECT fingerprint FROM product_operations WHERE operation_id=?",
            [h["operationId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    let root = store.root.clone();
    store.close().unwrap();
    drop(store);
    let mut store = FullProductStore::open(root, false, Hooks::default()).unwrap();
    let reply = call(
        &mut store,
        "status",
        json!({"operationId":h["operationId"],"fingerprint":fp}),
    )
    .unwrap();
    assert_eq!(reply["status"], "committed");
    let r = begin(&mut store, &["projects"]);
    assert!(!get(&mut store, &r, "projects", "p").is_null());
    assert_eq!(
        call(
            &mut store,
            "status",
            json!({"operationId":h["operationId"],"fingerprint":"a".repeat(64)})
        )
        .unwrap_err()
        .code,
        "invalid"
    );
    assert_eq!(call(&mut store, "validate", h).unwrap_err().code, "closed");
    dispose(store);
}
#[test]
fn chunked_large_row_and_paged_epoch_no_whole_database_preload() {
    let mut store = fixture(Hooks::default());
    let h = begin(&mut store, &["chatMessages"]);
    let raw = "🌹".repeat(100000);
    let mutation = put(
        "chatMessages",
        "message",
        row("message", vec![("body", json!(["str", raw]))]),
    );
    let payload =
        serde_json::to_string(&json!({"kind":"mutation","mutation":mutation})).unwrap() + "\n";
    let mut sha = Sha256::new();
    sha.update(b"momoki-batch-v1\n");
    sha.update(payload.as_bytes());
    let fp = paths::hex_digest(sha.finalize());
    let mut offset = 0;
    let mut chunks = 0;
    while offset < payload.len() {
        let mut end = (offset + 32768).min(payload.len());
        while !payload.is_char_boundary(end) {
            end -= 1;
        }
        let mut d = h.clone();
        d["chunkIndex"] = json!(chunks);
        d["payload"] = json!(&payload[offset..end]);
        call(&mut store, "prepare", d).unwrap();
        chunks += 1;
        offset = end;
    }
    let mut d = h.clone();
    d["chunkCount"] = json!(chunks);
    d["fingerprint"] = json!(fp);
    let seal = call(&mut store, "seal", d).unwrap();
    let mut d = h.clone();
    d["capability"] = seal["capability"].clone();
    d["fingerprint"] = json!(fp);
    call(&mut store, "commit", d).unwrap();
    let h = begin(&mut store, &["chatMessages"]);
    let value = get(&mut store, &h, "chatMessages", "message");
    assert_eq!(value["kind"], "transfer");
    let mut offset = 0;
    let mut bytes = String::new();
    loop {
        let mut d = h.clone();
        d["transferId"] = value["transferId"].clone();
        d["offset"] = json!(offset);
        d["byteLength"] = json!(262144);
        let page = call(&mut store, "readTransfer", d).unwrap();
        assert!(page["payload"].as_str().unwrap().len() <= 32768);
        assert!(serde_json::to_vec(&page).unwrap().len() <= 262144);
        bytes.push_str(page["payload"].as_str().unwrap());
        offset = page["offset"].as_u64().unwrap();
        if page["end"] == true {
            break;
        }
    }
    let result: Value = serde_json::from_str(&bytes).unwrap();
    assert_eq!(registry::field(&result["value"], "body").unwrap()[1], raw);
    dispose(store);
}
#[test]
fn closed_dtos_readonly_scope_unknown_indexes_and_binary_bags_reject() {
    assert!(
        serde_json::from_value::<Request>(json!({"type":"open","request":{"path":"/tmp"}}))
            .is_err()
    );
    let mut store = fixture(Hooks::default());
    let h = begin(&mut store, &["projects"]);
    assert_eq!(
        scan(&mut store, &h, "shots", None).unwrap_err().code,
        "invalid"
    );
    assert_eq!(
        scan(&mut store, &h, "projects", Some("sql"))
            .unwrap_err()
            .code,
        "invalid"
    );
    let fake = json!(["binary",{"version":1,"workspaceId":store.workspace_id,"binaryId":uuid::Uuid::new_v4().to_string(),"byteLength":1,"mimeType":"image/png","contentHash":"a".repeat(64)}]);
    let h = begin(&mut store, &["projects"]);
    assert_eq!(
        finish(
            &mut store,
            &h,
            vec![put("projects", "p", row("p", vec![("extra", fake)]))]
        )
        .unwrap_err()
        .code,
        "invalid"
    );
    dispose(store);
}
#[test]
fn committed_changes_contain_indexes_only_and_indexed_table_epoch_is_monotonic() {
    let mut store = fixture(Hooks::default());
    let h = begin(&mut store, &["connectors"]);
    finish(
        &mut store,
        &h,
        vec![put(
            "connectors",
            "c",
            row(
                "c",
                vec![
                    ("apiKey", json!(["str", "secret-never-in-change"])),
                    ("definitionId", json!(["str", "supplier"])),
                ],
            ),
        )],
    )
    .unwrap();
    let reply = call(
        &mut store,
        "changes",
        json!({"changeSequence":1,"cursor":null,"pageSize":256}),
    )
    .unwrap();
    assert!(!reply.to_string().contains("secret-never-in-change"));
    assert_eq!(
        reply["changes"][0]["after"]["definitionId"]["value"],
        "supplier"
    );
    dispose(store);
}

#[test]
fn utf16_primary_identity_and_indexes_have_no_new_user_cap() {
    let mut store = fixture(Hooks::default());
    let cases = vec![
        json!(""),
        json!("nul\0identity"),
        json!("x".repeat(20_000)),
        json!({"utf16":[0xd800,0,0xdc00]}),
    ];
    for key in cases {
        let h = begin(&mut store, &["projects"]);
        let encodedkey = if key.is_string() {
            json!(["str", key])
        } else {
            json!(["utf16", key["utf16"]])
        };
        finish(&mut store,&h,vec![json!({"kind":"put","table":"projects","key":key,"value":encoded(vec![("id",encodedkey)])})]).unwrap();
        let read = begin(&mut store, &["projects"]);
        let mut dto = read.clone();
        dto["table"] = json!("projects");
        dto["keys"] = json!([key]);
        let reply = call(&mut store, "get", dto).unwrap();
        assert_eq!(reply["rows"][0]["row"]["key"], key);
    }
    let h = begin(&mut store, &["projects"]);
    let mut dto = h.clone();
    dto["query"] = json!({"table":"projects","index":"id","selector":{"kind":"equals","keys":[{"kind":"string","value":{"utf16":[0xd800,0,0xdc00]}}]},"reverse":false,"cursor":null,"pageSize":256});
    let rows = call(&mut store, "query", dto).unwrap();
    assert_eq!(rows["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        rows["rows"][0]["row"]["key"],
        json!({"utf16":[0xd800,0,0xdc00]})
    );
    let root = store.root.clone();
    store.close().unwrap();
    drop(store);
    dispose(FullProductStore::open(root, false, Hooks::default()).unwrap());
}
#[test]
fn durable_operation_identity_never_replays_a_known_or_pending_result() {
    let mut store = fixture(Hooks::default());
    let h = begin(&mut store, &["projects"]);
    call(&mut store, "abort", h.clone()).unwrap();
    assert!(
        call(
            &mut store,
            "begin",
            json!({"operationId":h["operationId"],"mode":"rw","tables":["projects"]})
        )
        .is_err()
    );
    let h = begin(&mut store, &["projects"]);
    let root = store.root.clone();
    store.close().unwrap();
    drop(store);
    let mut store = FullProductStore::open(root, false, Hooks::default()).unwrap();
    assert!(
        call(
            &mut store,
            "begin",
            json!({"operationId":h["operationId"],"mode":"rw","tables":["projects"]})
        )
        .is_err()
    );
    dispose(store);
}

fn read_request(
    store: &mut FullProductStore,
    handle: &Value,
    purpose: &str,
    payload: &str,
) -> Result<Value> {
    let mut dto = handle.clone();
    dto["purpose"] = json!(purpose);
    let transfer = call(store, "requestStart", dto)?;
    let mut offset = 0;
    while offset < payload.len() {
        let mut end = (offset + 32768).min(payload.len());
        while !payload.is_char_boundary(end) {
            end -= 1;
        }
        let mut dto = handle.clone();
        dto["transferId"] = transfer["transferId"].clone();
        dto["offset"] = json!(offset);
        dto["payload"] = json!(&payload[offset..end]);
        let reply = call(store, "requestChunk", dto)?;
        assert_eq!(reply["nextOffset"], end);
        offset = end;
    }
    let mut dto = handle.clone();
    dto["transferId"] = transfer["transferId"].clone();
    call(store, "requestFinish", dto)
}
#[test]
fn oversized_read_request_is_closed_bound_consumed_and_lossless() {
    let mut store = fixture(Hooks::default());
    let identity = "界\0".repeat(100_000);
    let h = begin(&mut store, &["projects"]);
    finish(
        &mut store,
        &h,
        vec![put("projects", &identity, row(&identity, vec![]))],
    )
    .unwrap();
    let h = begin(&mut store, &["projects"]);
    let payload = serde_json::to_string(&json!({"table":"projects", "keys":[identity]})).unwrap();
    assert!(payload.len() > 262144);
    let mut direct = h.clone();
    direct["table"] = json!("projects");
    direct["keys"] = json!([identity]);
    assert_eq!(call(&mut store, "get", direct).unwrap_err().code, "invalid");
    let result = read_request(&mut store, &h, "get", &payload).unwrap();
    assert_eq!(result["rows"][0]["kind"], "transfer");
    let transfer = result["rows"][0]["transferId"].clone();
    let mut offset = 0;
    let mut row_payload = String::new();
    loop {
        let mut dto = h.clone();
        dto["transferId"] = transfer.clone();
        dto["offset"] = json!(offset);
        dto["byteLength"] = json!(32768);
        let reply = call(&mut store, "readTransfer", dto).unwrap();
        row_payload.push_str(reply["payload"].as_str().unwrap());
        offset = reply["offset"].as_u64().unwrap();
        if reply["end"] == true {
            break;
        }
    }
    assert_eq!(
        serde_json::from_str::<Value>(&row_payload).unwrap()["key"],
        identity
    );
    let malformed = serde_json::to_string(
        &json!({"table":"projects", "keys":[identity], "sql":"DELETE FROM product_records"}),
    )
    .unwrap();
    assert!(read_request(&mut store, &h, "get", &malformed).is_err());
    let mut dto = h.clone();
    dto["purpose"] = json!("get");
    let transfer = call(&mut store, "requestStart", dto).unwrap();
    let mut dto = h.clone();
    dto["transferId"] = transfer["transferId"].clone();
    dto["offset"] = json!(1);
    dto["payload"] = json!("{}");
    assert_eq!(
        call(&mut store, "requestChunk", dto).unwrap_err().code,
        "invalid"
    );
    let mut dto = h.clone();
    dto["transferId"] = transfer["transferId"].clone();
    dto["offset"] = json!(0);
    dto["payload"] = json!("{}");
    call(&mut store, "requestChunk", dto).unwrap();
    let mut dto = h.clone();
    dto["transferId"] = transfer["transferId"].clone();
    assert!(call(&mut store, "requestFinish", dto.clone()).is_err());
    assert_eq!(
        call(&mut store, "requestFinish", dto).unwrap_err().code,
        "closed"
    );
    dispose(store);
}
#[test]
fn indexed_limit_and_aggregate_count_preserve_total_order_bytes_and_phantom_guard() {
    let mut store = fixture(Hooks::default());
    let h = begin(&mut store, &["chatMessages"]);
    let rows = (0..24)
        .map(|n| {
            let id = format!("{n:02}");
            put(
                "chatMessages",
                &id,
                row(
                    &id,
                    vec![
                        ("threadId", json!(["str", "selected"])),
                        ("content", json!(["str", "x".repeat(8192)])),
                    ],
                ),
            )
        })
        .collect();
    finish(&mut store, &h, rows).unwrap();
    let h = begin(&mut store, &["chatMessages"]);
    let base = json!({"table":"chatMessages","index":"threadId","selector":{"kind":"equals","keys":[{"kind":"string","value":"selected"}]},"reverse":true,"cursor":null,"pageSize":256,"limit":10});
    let mut cursor = Value::Null;
    let mut ids = Vec::new();
    loop {
        let mut dto = h.clone();
        let mut query = base.clone();
        query["cursor"] = cursor;
        dto["query"] = query;
        let response = call(&mut store, "query", dto).unwrap();
        ids.extend(
            response["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["row"]["key"].as_str().unwrap().to_string()),
        );
        cursor = response["cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(
        ids,
        (14..24)
            .rev()
            .map(|n| format!("{n:02}"))
            .collect::<Vec<_>>()
    );
    let mut dto = h.clone();
    dto["query"] = base.clone();
    assert_eq!(call(&mut store, "count", dto).unwrap(), json!({"count":10}));
    let mut aggregate = base.clone();
    aggregate["limit"] = Value::Null;
    let payload = serde_json::to_string(&json!({"query":aggregate})).unwrap();
    assert_eq!(
        read_request(&mut store, &h, "count", &payload).unwrap(),
        json!({"count":24})
    );
    let mut zero = base;
    zero["limit"] = json!(0);
    let mut dto = h.clone();
    dto["query"] = zero;
    assert_eq!(call(&mut store, "query", dto).unwrap()["rows"], json!([]));
    let write = begin(&mut store, &["chatMessages"]);
    finish(
        &mut store,
        &write,
        vec![put(
            "chatMessages",
            "new",
            row("new", vec![("threadId", json!(["str", "selected"]))]),
        )],
    )
    .unwrap();
    assert_eq!(
        call(&mut store, "validate", h).unwrap_err().code,
        "conflict"
    );
    dispose(store);
}

#[test]
fn encoded_metadata_envelopes_are_bounded_even_for_control_heavy_chunks() {
    let mut store = fixture(Hooks::default());
    let handle = begin(&mut store, &["projects"]);
    let mut dto = handle.clone();
    dto["purpose"] = json!("get");
    let transfer = call(&mut store, "requestStart", dto).unwrap();
    let mut dto = handle;
    dto["transferId"] = transfer["transferId"].clone();
    dto["offset"] = json!(0);
    dto["payload"] = json!("\0".repeat(32768));
    let request: Request =
        serde_json::from_value(json!({"type":"requestChunk", "request":dto})).unwrap();
    assert!(
        serde_json::to_vec(&json!({"request":request}))
            .unwrap()
            .len()
            < 262144
    );
    request.validate_wire().unwrap();
    let text = "\0\n\r\t\u{0001}".repeat(20000);
    let response = string_chunk(&text, 0, 262144).unwrap();
    assert_eq!(response["payload"].as_str().unwrap().len(), 32768);
    assert!(serde_json::to_vec(&response).unwrap().len() < 262144);
    dispose(store);
}

fn registry_catalog() -> Value {
    serde_json::from_str(registry_migrations::CATALOG_JSON).unwrap()
}
fn downgrade_registry(root: &std::path::Path, source: usize) {
    let catalog = registry_catalog();
    let entry = &catalog["registries"][source];
    let raw = registry_migrations::SNAPSHOTS
        .iter()
        .find(|(file, _)| *file == entry["file"].as_str().unwrap())
        .unwrap()
        .1;
    let tables = registry::parse(raw).unwrap().tables;
    let db = Connection::open(root.join(".local/state.sqlite")).unwrap();
    for name in registry::tables()
        .keys()
        .filter(|name| !tables.contains_key(*name))
    {
        assert_eq!(
            db.execute("DELETE FROM product_tables WHERE name=?", [name])
                .unwrap(),
            1
        );
    }
    db.execute_batch("DROP TABLE product_registry").unwrap();
    db.execute(
        "UPDATE product_workspace SET registry_hash=?",
        [entry["sha256"].as_str().unwrap()],
    )
    .unwrap();
}
fn released_fixture(source: usize) -> (PathBuf, Value, Value) {
    let mut store = fixture(Hooks::default());
    let value = row(
        "p",
        vec![
            ("kind", json!(["str", "film"])),
            ("updatedAt", json!(["num", 17])),
            ("clear", json!(["undef"])),
        ],
    );
    let h = begin(&mut store, &["projects"]);
    let receipt = finish(&mut store, &h, vec![put("projects", "p", value.clone())]).unwrap();
    let root = store.root.clone();
    store.close().unwrap();
    drop(store);
    downgrade_registry(&root, source);
    fs::write(
        root.join("assets/preserved.bin"),
        b"original managed asset bytes",
    )
    .unwrap();
    (root, value, receipt)
}
type DatabaseState = BTreeMap<String, Vec<Vec<rusqlite::types::Value>>>;
fn database_state(root: &std::path::Path) -> DatabaseState {
    let db = Connection::open(root.join(".local/state.sqlite")).unwrap();
    let names: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    let mut queries = names
        .into_iter()
        .map(|name| {
            let sql = format!("SELECT * FROM \"{name}\" ORDER BY rowid");
            (name, sql)
        })
        .collect::<Vec<_>>();
    queries.push((
        "#schema".into(),
        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name".into(),
    ));
    queries.push(("#user_version".into(), "PRAGMA user_version".into()));
    queries
        .into_iter()
        .map(|(name, sql)| {
            let mut statement = db.prepare(&sql).unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, rusqlite::types::Value>(column))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}
fn transitioned_state(mut state: DatabaseState, target: &str) -> DatabaseState {
    use rusqlite::types::Value::{Integer, Text};
    state.get_mut("product_workspace").unwrap()[0][2] = Text(digest(target.as_bytes()));
    let present: BTreeSet<String> = state["product_tables"]
        .iter()
        .map(|row| match &row[0] {
            Text(name) => name.clone(),
            _ => panic!("table name"),
        })
        .collect();
    for name in registry::parse(target)
        .unwrap()
        .tables
        .keys()
        .filter(|name| !present.contains(*name))
    {
        state
            .get_mut("product_tables")
            .unwrap()
            .push(vec![Text(name.clone()), Integer(0)]);
    }
    if !state.contains_key("product_registry") {
        let rows = state.get_mut("#schema").unwrap();
        rows.push(vec![
            Text("table".into()),
            Text("product_registry".into()),
            Text(REGISTRY_SCHEMA.into()),
        ]);
        rows.sort_by_key(|row| format!("{:?}{:?}", row[0], row[1]));
    }
    state.insert(
        "product_registry".into(),
        vec![vec![Integer(1), Text(target.into())]],
    );
    state
}
fn upgraded_state(state: DatabaseState, _source: usize) -> DatabaseState {
    transitioned_state(state, registry::REGISTRY_JSON)
}
#[test]
fn every_released_registry_upgrades_directly_preserving_all_durable_state_and_reopens_without_migration()
 {
    for source in [0, 1, 2] {
        let (root, value, receipt) = released_fixture(source);
        let before = database_state(&root);
        let mut store = FullProductStore::open(root.clone(), false, Hooks::default()).unwrap();
        assert_eq!(database_state(&root), upgraded_state(before, source));
        assert_eq!(
            fs::read(root.join("assets/preserved.bin")).unwrap(),
            b"original managed asset bytes"
        );
        assert_eq!(
            store.sequence().unwrap(),
            receipt["changeSequence"].as_u64().unwrap()
        );
        let h = begin(&mut store, &["projects"]);
        assert_eq!(get(&mut store, &h, "projects", "p")["row"]["value"], value);
        let page = scan(&mut store, &h, "projects", Some("kind")).unwrap();
        assert_eq!(page["rows"].as_array().unwrap().len(), 1);
        assert_eq!(page["rows"][0]["row"]["key"], "p");
        call(&mut store, "abort", h).unwrap();
        let status = call(
            &mut store,
            "status",
            json!({"operationId":receipt["operationId"],"fingerprint":receipt["fingerprint"]}),
        )
        .unwrap();
        assert_eq!(status, receipt);
        store.close().unwrap();
        drop(store);
        let after = database_state(&root);
        let store = FullProductStore::open(
            root.clone(),
            false,
            Hooks::new(|point| {
                if point == "product-registry-precommit" {
                    Err(Error::new(
                        "test",
                        "A current registry must not migrate twice",
                    ))
                } else {
                    Ok(())
                }
            }),
        )
        .unwrap();
        assert_eq!(database_state(&root), after);
        dispose(store);
    }
}
#[test]
fn registry_upgrade_precommit_failure_rolls_back_every_change_and_can_retry() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    for source in [0, 1, 2] {
        let (root, _, _) = released_fixture(source);
        let before = database_state(&root);
        let reached = Arc::new(AtomicUsize::new(0));
        let count = reached.clone();
        let error = FullProductStore::open(
            root.clone(),
            false,
            Hooks::new(move |point| {
                if point == "product-registry-precommit" {
                    count.fetch_add(1, Ordering::SeqCst);
                    Err(Error::new("test", "Injected registry precommit failure"))
                } else {
                    Ok(())
                }
            }),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "test");
        assert_eq!(reached.load(Ordering::SeqCst), 1);
        assert_eq!(database_state(&root), before);
        let store = FullProductStore::open(root.clone(), false, Hooks::default()).unwrap();
        assert_eq!(database_state(&root), upgraded_state(before, source));
        assert_eq!(
            fs::read(root.join("assets/preserved.bin")).unwrap(),
            b"original managed asset bytes"
        );
        dispose(store);
    }
}
#[test]
fn released_registry_bootstrap_preserves_claimed_managed_bytes_and_binary_rows() {
    use product_binary::{BinaryReply, BinaryRequest};
    for source in [0, 1, 2] {
        let mut store = fixture(Hooks::default());
        let bytes = b"managed bytes must survive additive upgrades";
        let stage_id = match store
            .run_binary(
                BinaryRequest::Prepare {
                    byte_length: bytes.len() as u64,
                    mime_type: "application/octet-stream".into(),
                },
                || Ok(()),
            )
            .unwrap()
        {
            BinaryReply::Prepared { stage_id, .. } => stage_id,
            _ => panic!("prepared binary"),
        };
        store
            .run_binary(
                BinaryRequest::Write {
                    stage_id: stage_id.clone(),
                    offset: 0,
                    bytes: bytes.to_vec(),
                },
                || Ok(()),
            )
            .unwrap();
        let claim = match store
            .run_binary(
                BinaryRequest::Seal {
                    stage_id,
                    content_hash: digest(bytes),
                },
                || Ok(()),
            )
            .unwrap()
        {
            BinaryReply::Sealed { claim } => claim,
            _ => panic!("sealed binary"),
        };
        let reference = claim.reference.clone();
        let h = begin(&mut store, &["media"]);
        let value = row("m", vec![("blob", json!(["binary", reference]))]);
        finish_entries(
            &mut store,
            &h,
            vec![
                json!({"kind":"mutation","mutation":put("media","m",value)}),
                json!({"kind":"claim","claim":claim}),
            ],
        )
        .unwrap();
        let root = store.root.clone();
        store.close().unwrap();
        drop(store);
        downgrade_registry(&root, source);
        let before = database_state(&root);
        let mut store = FullProductStore::open(root.clone(), false, Hooks::default()).unwrap();
        assert_eq!(
            database_state(&root),
            transitioned_state(before, registry::REGISTRY_JSON)
        );
        let lease_id = match store
            .run_binary(BinaryRequest::ReadStart { reference }, || Ok(()))
            .unwrap()
        {
            BinaryReply::ReadReady { lease_id, .. } => lease_id,
            _ => panic!("verified managed read"),
        };
        match store
            .run_binary(
                BinaryRequest::ReadChunk {
                    lease_id: lease_id.clone(),
                    offset: 0,
                    byte_length: bytes.len(),
                },
                || Ok(()),
            )
            .unwrap()
        {
            BinaryReply::Bytes {
                bytes: actual,
                end: true,
                ..
            } => assert_eq!(actual, bytes),
            _ => panic!("complete managed bytes"),
        }
        store
            .run_binary(
                BinaryRequest::ReadVerify {
                    lease_id: lease_id.clone(),
                },
                || Ok(()),
            )
            .unwrap();
        store
            .run_binary(BinaryRequest::ReadClose { lease_id }, || Ok(()))
            .unwrap();
        dispose(store);
    }
}
#[test]
fn invalid_released_workspaces_are_rejected_without_publishing_registry_changes() {
    for source in [0, 1, 2] {
        for fault in [
            "schema",
            "user_version",
            "marker",
            "ddl",
            "index",
            "unknown",
            "malformed",
            "missing",
            "extra",
            "orphan",
            "receipt_table",
            "change_table",
        ] {
            let (root, _, _) = released_fixture(source);
            let db = Connection::open(root.join(".local/state.sqlite")).unwrap();
            match fault {
                "schema" => {
                    db.execute("UPDATE product_workspace SET schema=2", [])
                        .unwrap();
                }
                "user_version" => db.pragma_update(None, "user_version", 2).unwrap(),
                "marker" => {
                    let path = root.join("workspace.ready.json");
                    let mut marker: Value =
                        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    marker["workspaceId"] = json!(uuid::Uuid::new_v4().to_string());
                    fs::write(path, serde_json::to_vec(&marker).unwrap()).unwrap();
                }
                "ddl" => db
                    .execute_batch("ALTER TABLE product_prepared ADD COLUMN unexpected TEXT")
                    .unwrap(),
                "index" => {
                    assert_eq!(db.execute("DELETE FROM product_indexes WHERE table_name='projects' AND index_name='kind'", []).unwrap(), 1);
                }
                "unknown" => {
                    db.execute(
                        "UPDATE product_workspace SET registry_hash=?",
                        ["0".repeat(64)],
                    )
                    .unwrap();
                }
                "malformed" => {
                    db.execute(
                        "UPDATE product_workspace SET registry_hash='not-a-registry-hash'",
                        [],
                    )
                    .unwrap();
                }
                "orphan" => {
                    db.pragma_update(None, "foreign_keys", false).unwrap();
                    db.execute(
                        "INSERT INTO product_revisions VALUES ('futureOne','orphan',1)",
                        [],
                    )
                    .unwrap();
                    assert_eq!(
                        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .unwrap(),
                        1
                    );
                }
                "receipt_table" => {
                    let text: String = db
                        .query_row(
                            "SELECT receipt FROM product_operations WHERE status='committed'",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    let mut receipt: Value = serde_json::from_str(&text).unwrap();
                    receipt["tables"] = json!(["futureOne"]);
                    db.execute(
                        "UPDATE product_operations SET receipt=? WHERE status='committed'",
                        [receipt.to_string()],
                    )
                    .unwrap();
                }
                "change_table" => {
                    assert_eq!(
                        db.execute("UPDATE product_changes SET table_name='futureOne'", [])
                            .unwrap(),
                        1
                    );
                }
                "missing" => {
                    db.execute("DELETE FROM product_tables WHERE name='shots'", [])
                        .unwrap();
                }
                "extra" => {
                    db.execute("INSERT INTO product_tables VALUES ('unexpected',0)", [])
                        .unwrap();
                }
                _ => unreachable!(),
            }
            drop(db);
            let before = database_state(&root);
            let marker = fs::read(root.join("workspace.ready.json")).unwrap();
            let error = FullProductStore::open(root.clone(), false, Hooks::default())
                .err()
                .unwrap();
            assert!(
                matches!(error.code, "schema" | "incomplete" | "corrupt"),
                "{fault}: {error}"
            );
            assert_eq!(database_state(&root), before, "{fault}");
            assert_eq!(fs::read(root.join("workspace.ready.json")).unwrap(), marker);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
fn future_registry(raw: &str, name: &str) -> String {
    let mut registry: Value = serde_json::from_str(raw).unwrap();
    assert!(registry["tables"].get(name).is_none());
    registry["tables"][name] = json!({"keyPath":"entryId","scope":"mixed","indexes":[
        {"name":"ownerId","keyPaths":["ownerId"],"unique":false},
        {"name":"ownerName","keyPaths":["ownerId","name"],"unique":true}
    ]});
    serde_json::to_string_pretty(&registry).unwrap()
}
fn migration_fixture() -> (PathBuf, Connection) {
    let mut store = fixture(Hooks::default());
    let root = store.root.clone();
    let h = begin(&mut store, &["projects"]);
    finish(
        &mut store,
        &h,
        vec![put(
            "projects",
            "original",
            row("original", vec![("kind", json!(["str", "film"]))]),
        )],
    )
    .unwrap();
    store.close().unwrap();
    drop(store);
    let db = database::connect(&root.join(".local/state.sqlite"), false, false).unwrap();
    (root, db)
}
fn migrate_to(db: &Connection, target: &str, hooks: &Hooks) -> Result<()> {
    let stored: String =
        db.query_row("SELECT registry_hash FROM product_workspace", [], |row| {
            row.get(0)
        })?;
    registry_migrations::migrate_registry_to(db, &stored, target, hooks)
}
fn insert_future_record(db: &mut Connection, raw: &str) -> Value {
    let registry = registry::parse(raw).unwrap();
    let definition = &registry.tables["futureOne"];
    let value = encoded(vec![
        ("entryId", json!(["str", "future-record"])),
        ("ownerId", json!(["str", "owner"])),
        ("name", json!(["str", "retained"])),
        ("clear", json!(["undef"])),
    ]);
    let key = registry::primary_for_table(&value, definition).unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let sequence: i64 = db
        .query_row(
            "SELECT change_sequence+1 FROM product_workspace",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let receipt = json!({"status":"committed","operationId":operation,"fingerprint":digest(b"future-record"),"changeSequence":sequence,"tables":["futureOne"]});
    let transaction = db.transaction().unwrap();
    transaction
        .execute(
            "INSERT INTO product_records VALUES (?,?,?,?,?)",
            params![
                "futureOne",
                key,
                query::ordered(&Key::String {
                    value: WireText::from_internal(&key).unwrap()
                })
                .unwrap(),
                value.to_string(),
                sequence
            ],
        )
        .unwrap();
    transaction
        .execute(
            "INSERT INTO product_revisions VALUES (?,?,?)",
            params!["futureOne", key, sequence],
        )
        .unwrap();
    for projection in query::projections_for_table(definition, &key, &value).unwrap() {
        transaction
            .execute(
                "INSERT INTO product_indexes VALUES (?,?,?,?)",
                params!["futureOne", projection.index, key, projection.ordered],
            )
            .unwrap();
        if projection.unique {
            transaction
                .execute(
                    "INSERT INTO product_unique_indexes VALUES (?,?,?,?)",
                    params!["futureOne", projection.index, projection.ordered, key],
                )
                .unwrap();
        }
    }
    transaction
        .execute(
            "INSERT INTO product_changes VALUES (?,0,?,?,?,?)",
            params![
                sequence,
                "futureOne",
                key,
                "{}",
                serde_json::to_string(
                    &query::index_values_for_table(definition, &key, Some(&value)).unwrap()
                )
                .unwrap()
            ],
        )
        .unwrap();
    transaction
        .execute(
            "INSERT INTO product_operations VALUES (?,?,'committed',?)",
            params![
                operation,
                receipt["fingerprint"].as_str().unwrap(),
                receipt.to_string()
            ],
        )
        .unwrap();
    transaction
        .execute(
            "UPDATE product_tables SET epoch=? WHERE name='futureOne'",
            [sequence],
        )
        .unwrap();
    transaction
        .execute("UPDATE product_workspace SET change_sequence=?", [sequence])
        .unwrap();
    transaction.commit().unwrap();
    validate_open_for_registry(db, raw, true).unwrap();
    value
}
#[test]
fn automatic_registry_additions_are_transitive_without_catalog_edits_and_preserve_future_records() {
    let (root, mut db) = migration_fixture();
    let first = future_registry(registry::REGISTRY_JSON, "futureOne");
    let second = future_registry(&first, "futureTwo");
    for future in [&first, &second] {
        assert!(
            registry_catalog()["registries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["sha256"] != digest(future.as_bytes()))
        );
    }
    let before = database_state(&root);
    migrate_to(&db, &first, &Hooks::default()).unwrap();
    assert_eq!(database_state(&root), transitioned_state(before, &first));
    let value = insert_future_record(&mut db, &first);
    let before = database_state(&root);
    // Reopen the actual SQLite connection; the next source is an unregistered development hash.
    db.close().unwrap();
    let db = database::connect(&root.join(".local/state.sqlite"), false, false).unwrap();
    migrate_to(&db, &second, &Hooks::default()).unwrap();
    assert_eq!(database_state(&root), transitioned_state(before, &second));
    let payload: String = db
        .query_row(
            "SELECT payload FROM product_records WHERE table_name='futureOne'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&payload).unwrap(), value);
    let unique: i64 = db.query_row("SELECT count(*) FROM product_unique_indexes WHERE table_name='futureOne' AND index_name='ownerName'", [], |row| row.get(0)).unwrap();
    assert_eq!(unique, 1);
    let before = database_state(&root);
    migrate_to(
        &db,
        &second,
        &Hooks::new(|point| {
            assert_ne!(
                point, "product-registry-precommit",
                "A persisted current snapshot must be a no-op"
            );
            Ok(())
        }),
    )
    .unwrap();
    assert_eq!(database_state(&root), before);
    // Raw formatting changes identity but preserve every definition and all business state.
    let formatted = format!("{second}\n");
    migrate_to(&db, &formatted, &Hooks::default()).unwrap();
    assert_eq!(
        database_state(&root),
        transitioned_state(before, &formatted)
    );
    db.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn automatic_registry_upgrade_failure_rolls_back_metadata_and_additions_then_retries() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let (root, mut db) = migration_fixture();
    let first = future_registry(registry::REGISTRY_JSON, "futureOne");
    let second = future_registry(&first, "futureTwo");
    for target in [&first, &second] {
        let before = database_state(&root);
        let reached = Arc::new(AtomicUsize::new(0));
        let count = reached.clone();
        let error = migrate_to(
            &db,
            target,
            &Hooks::new(move |point| {
                if point == "product-registry-precommit" {
                    count.fetch_add(1, Ordering::SeqCst);
                    Err(Error::new("test", "Interrupted additive registry upgrade"))
                } else {
                    Ok(())
                }
            }),
        )
        .unwrap_err();
        assert_eq!(error.code, "test");
        assert_eq!(reached.load(Ordering::SeqCst), 1);
        assert_eq!(database_state(&root), before);
        migrate_to(&db, target, &Hooks::default()).unwrap();
        assert_eq!(database_state(&root), transitioned_state(before, target));
        if target == &first {
            insert_future_record(&mut db, &first);
        }
    }
    db.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn changed_or_removed_future_definitions_and_invalid_future_data_do_not_write() {
    let (root, mut db) = migration_fixture();
    let first = future_registry(registry::REGISTRY_JSON, "futureOne");
    migrate_to(&db, &first, &Hooks::default()).unwrap();
    insert_future_record(&mut db, &first);
    for change in [
        "delete",
        "primary",
        "scope",
        "index",
        "unique",
        "remove_index",
    ] {
        let mut target: Value = serde_json::from_str(&first).unwrap();
        match change {
            "delete" => {
                target["tables"]
                    .as_object_mut()
                    .unwrap()
                    .remove("futureOne");
            }
            "primary" => target["tables"]["futureOne"]["keyPath"] = json!("otherId"),
            "scope" => target["tables"]["futureOne"]["scope"] = json!("content"),
            "index" => {
                target["tables"]["futureOne"]["indexes"][0]["keyPaths"] = json!(["otherOwner"])
            }
            "unique" => target["tables"]["futureOne"]["indexes"][0]["unique"] = json!(true),
            "remove_index" => {
                target["tables"]["futureOne"]["indexes"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            _ => unreachable!(),
        }
        let before = database_state(&root);
        assert_eq!(
            migrate_to(&db, &target.to_string(), &Hooks::default())
                .unwrap_err()
                .code,
            "schema"
        );
        assert_eq!(database_state(&root), before, "{change}");
    }
    db.execute(
        "DELETE FROM product_indexes WHERE table_name='futureOne' AND index_name='ownerId'",
        [],
    )
    .unwrap();
    let before = database_state(&root);
    let second = future_registry(&first, "futureTwo");
    assert_eq!(
        migrate_to(&db, &second, &Hooks::default())
            .unwrap_err()
            .code,
        "corrupt"
    );
    assert_eq!(database_state(&root), before);
    db.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn authoritative_registry_metadata_corruption_never_falls_back_to_historical_identity() {
    for fault in [
        "tampered",
        "empty",
        "multiple",
        "blank",
        "scope",
        "duplicate",
        "missing_snapshot_unknown",
    ] {
        let (root, db) = migration_fixture();
        match fault {
            "tampered" => {
                db.execute(
                    "UPDATE product_registry SET schema_json=schema_json || ' '",
                    [],
                )
                .unwrap();
            }
            "empty" => {
                db.execute("DELETE FROM product_registry", []).unwrap();
            }
            "multiple" => {
                db.pragma_update(None, "ignore_check_constraints", true)
                    .unwrap();
                db.execute(
                    "INSERT INTO product_registry VALUES (2,?)",
                    [registry::REGISTRY_JSON],
                )
                .unwrap();
                db.pragma_update(None, "ignore_check_constraints", false)
                    .unwrap();
            }
            "missing_snapshot_unknown" => {
                db.execute_batch("DROP TABLE product_registry").unwrap();
                db.execute(
                    "UPDATE product_workspace SET registry_hash=?",
                    ["0".repeat(64)],
                )
                .unwrap();
            }
            "blank" | "scope" | "duplicate" => {
                let raw = match fault {
                    "blank" => String::from("{\"version\":1,\"tables\":{}}"),
                    "scope" => {
                        let mut source: Value =
                            serde_json::from_str(registry::REGISTRY_JSON).unwrap();
                        source["tables"]["projects"]["scope"] = json!("arbitrary");
                        source.to_string()
                    }
                    "duplicate" => String::from(
                        "{\"version\":1,\"tables\":{\"x\":{\"keyPath\":\"id\",\"scope\":\"content\",\"indexes\":[]},\"x\":{\"keyPath\":\"id\",\"scope\":\"content\",\"indexes\":[]}}}",
                    ),
                    _ => unreachable!(),
                };
                db.execute("UPDATE product_registry SET schema_json=?", [&raw])
                    .unwrap();
                db.execute(
                    "UPDATE product_workspace SET registry_hash=?",
                    [digest(raw.as_bytes())],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let before = database_state(&root);
        assert!(
            migrate_to(&db, registry::REGISTRY_JSON, &Hooks::default()).is_err(),
            "{fault}"
        );
        assert_eq!(database_state(&root), before, "{fault}");
        db.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn registry_catalog_requires_exact_history_but_no_current_target_or_addition_recipe() {
    use registry_migrations::{CATALOG_JSON, SNAPSHOTS, validate_catalog};
    assert!(validate_catalog(CATALOG_JSON, registry::REGISTRY_JSON, SNAPSHOTS).is_ok());
    let current = future_registry(registry::REGISTRY_JSON, "futureOne");
    assert!(validate_catalog(CATALOG_JSON, &current, SNAPSHOTS).is_ok());
    assert!(validate_catalog(CATALOG_JSON, registry::REGISTRY_JSON, &SNAPSHOTS[..2]).is_err());
    let mut catalog = registry_catalog();
    catalog["registries"].as_array_mut().unwrap().pop();
    assert!(validate_catalog(&catalog.to_string(), registry::REGISTRY_JSON, SNAPSHOTS).is_err());
    let modified = format!("{}\n", SNAPSHOTS[0].1);
    let mut snapshots = SNAPSHOTS.to_vec();
    snapshots[0].1 = &modified;
    let error = validate_catalog(CATALOG_JSON, registry::REGISTRY_JSON, &snapshots)
        .err()
        .unwrap();
    assert!(error.message.contains("hash mismatch"));
    let mut source: Value = serde_json::from_str(SNAPSHOTS[0].1).unwrap();
    source["tables"]["projects"]["scope"] = json!("mixed");
    let modified = source.to_string();
    let mut snapshots = SNAPSHOTS.to_vec();
    snapshots[0].1 = &modified;
    let mut catalog = registry_catalog();
    catalog["registries"][0]["sha256"] = json!(digest(modified.as_bytes()));
    let error = validate_catalog(&catalog.to_string(), registry::REGISTRY_JSON, &snapshots)
        .err()
        .unwrap();
    assert!(error.message.contains("definition is incompatible"));
}

#[test]
fn mcp_native_catalogue_distinguishes_missing_present_null_and_stale_session() {
    let store = fixture(Hooks::default());
    let session: Session = serde_json::from_value(store.token()).unwrap();
    assert!(store.mcp_catalogue(&session).unwrap().is_null());
    let key = WireText::from("agentMcp.catalog.v1");
    let encoded = row("agentMcp.catalog.v1", vec![("value", json!(["null"]))]);
    store
        .db
        .execute(
            "INSERT INTO product_records VALUES (?,?,?,?,?)",
            rusqlite::params![
                "deviceSettings",
                key.clone(),
                Vec::<u8>::new(),
                encoded.to_string(),
                1
            ],
        )
        .unwrap();
    assert!(store.mcp_catalogue(&session).is_err());
    let public = json!({"version":1,"revision":0,"entries":[],"receipts":[]});
    fn encode(value: &Value) -> Value {
        match value {
            Value::Null => json!(["null"]),
            Value::Bool(b) => json!(["bool", b]),
            Value::Number(n) => json!(["num", n]),
            Value::String(s) => json!(["str", s]),
            Value::Array(a) => json!(["arr", a.iter().map(encode).collect::<Vec<_>>()]),
            Value::Object(o) => json!([
                "obj",
                o.iter()
                    .map(|(k, v)| json!([k, encode(v)]))
                    .collect::<Vec<_>>()
            ]),
        }
    }
    let encoded = row("agentMcp.catalog.v1", vec![("value", encode(&public))]);
    store
        .db
        .execute(
            "UPDATE product_records SET payload=? WHERE table_name='deviceSettings' AND row_key=?",
            rusqlite::params![encoded.to_string(), key],
        )
        .unwrap();
    assert_eq!(store.mcp_catalogue(&session).unwrap(), public);
    let mut stale = session.clone();
    stale.generation += 1;
    assert!(store.mcp_catalogue(&stale).is_err());
    dispose(store);
}
