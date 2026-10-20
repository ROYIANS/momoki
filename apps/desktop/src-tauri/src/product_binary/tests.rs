use super::*;

struct OwnedConnection(Option<Connection>);
impl std::ops::Deref for OwnedConnection {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("Fixture connection is closed")
    }
}
impl std::ops::DerefMut for OwnedConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("Fixture connection is closed")
    }
}

struct Fixture {
    root: PathBuf,
    workspace_id: String,
    db: OwnedConnection,
    store: BinaryStore,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("momoki-product-binary-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let workspace_id = uuid::Uuid::new_v4().to_string();
        let db = Connection::open(root.join("fixture.sqlite")).unwrap();
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
            .unwrap();
        db.execute_batch(BINARY_SCHEMA).unwrap();
        db.execute_batch("CREATE TABLE fixture_records(id TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        let store = BinaryStore::new(&root, &workspace_id).unwrap();
        Self {
            root,
            workspace_id,
            db: OwnedConnection(Some(db)),
            store,
        }
    }
    fn prepare(&mut self, length: u64) -> (String, String) {
        match self
            .store
            .run(
                &self.db,
                BinaryRequest::Prepare {
                    byte_length: length,
                    mime_type: "application/octet-stream".into(),
                },
            )
            .unwrap()
        {
            BinaryReply::Prepared {
                stage_id,
                binary_id,
                chunk_bytes,
                ..
            } => {
                assert_eq!(chunk_bytes, CHUNK);
                (stage_id, binary_id)
            }
            _ => panic!("prepared stage"),
        }
    }
    fn sealed(&mut self, bytes: &[u8]) -> BinaryClaim {
        let (stage_id, _) = self.prepare(bytes.len() as u64);
        for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
            self.store
                .write_raw(&stage_id, (index * CHUNK) as u64, chunk)
                .unwrap();
        }
        let hash = paths::hex_digest(Sha256::digest(bytes));
        match self
            .store
            .run(
                &self.db,
                BinaryRequest::Seal {
                    stage_id,
                    content_hash: hash,
                },
            )
            .unwrap()
        {
            BinaryReply::Sealed { claim } => claim,
            _ => panic!("sealed stage"),
        }
    }
    fn claim(&mut self, claims: &[BinaryClaim]) {
        let verified = self
            .store
            .verify_claims(&self.db, claims, &mut || Ok(()))
            .unwrap();
        let transaction = self.db.transaction().unwrap();
        claim_prepared(&transaction, &uuid::Uuid::new_v4().to_string(), &verified).unwrap();
        transaction.commit().unwrap();
    }
    fn path(&self, reference: &ManagedBinaryRef) -> PathBuf {
        self.root
            .join(binary_relative(&reference.binary_id).unwrap())
    }
    fn read_start(&mut self, reference: &ManagedBinaryRef) -> String {
        match self
            .store
            .run(
                &self.db,
                BinaryRequest::ReadStart {
                    reference: reference.clone(),
                },
            )
            .unwrap()
        {
            BinaryReply::ReadReady { lease_id, .. } => lease_id,
            _ => panic!("read lease"),
        }
    }
    fn count(&self, table: &str) -> u64 {
        self.db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                sql_length(row, 0)
            })
            .unwrap()
    }
    fn cleanup(&mut self) -> Result<()> {
        let db =
            self.db.0.as_ref().ok_or_else(|| {
                Error::new("fixture", "Binary fixture connection is already closed")
            })?;
        self.store.close(db)?;
        self.db
            .0
            .take()
            .expect("Owned fixture connection")
            .close()
            .map_err(|(_, error)| error)?;
        fs::remove_dir_all(&self.root)?;
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            if std::thread::panicking() {
                eprintln!(
                    "Binary fixture cleanup during unwind failed: {} {}",
                    error.code, error.message
                );
            } else {
                panic!(
                    "Binary fixture cleanup failed: {} {}",
                    error.code, error.message
                );
            }
        }
    }
}

#[test]
fn fixture_drop_closes_actual_sqlite_and_active_binary_leases_before_removing_root() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"retained read bytes");
    fixture.claim(std::slice::from_ref(&claim));
    let lease = fixture.read_start(&claim.reference);
    assert!(fixture.store.reads.contains_key(&lease));
    let (stage, _) = fixture.prepare(2);
    fixture.store.write_raw(&stage, 0, b"a").unwrap();
    assert!(fixture.store.writes.contains_key(&stage));
    let root = fixture.root.clone();
    assert!(root.join("fixture.sqlite").exists());
    drop(fixture);
    assert!(
        !root.exists(),
        "Closed binary fixture left its private directory"
    );
}

#[test]
fn fixture_cleanup_errors_fail_normally_and_preserve_an_existing_body_panic() {
    for body_panics in [false, true] {
        let mut fixture = Fixture::new();
        let root = fixture.root.clone();
        fixture.root = root.join("absent-cleanup-directory");
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _fixture = fixture;
            if body_panics {
                panic!("Original binary fixture body failure");
            }
        }));
        let payload = outcome.expect_err("A failed fixture cleanup must remain observable");
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .expect("String panic payload");
        if body_panics {
            assert_eq!(message, "Original binary fixture body failure");
        } else {
            assert!(message.starts_with("Binary fixture cleanup failed:"));
        }
        fs::remove_dir_all(&root).unwrap();
    }
}

#[test]
fn managed_claim_and_domain_result_share_actual_sqlite_rollback() {
    let mut fixture = Fixture::new();
    let claims = [
        fixture.sealed(b"media"),
        fixture.sealed(b"immutable material version"),
        fixture.sealed(b"setting snapshot bytes"),
    ];
    assert_eq!(
        fixture.count("product_binaries"),
        0,
        "publication is not ready row authority"
    );
    let verified = fixture
        .store
        .verify_claims(&fixture.db, &claims, &mut || Ok(()))
        .unwrap();
    {
        let transaction = fixture.db.transaction().unwrap();
        claim_prepared(&transaction, &uuid::Uuid::new_v4().to_string(), &verified).unwrap();
        transaction
            .execute("INSERT INTO fixture_records VALUES('job','completed')", [])
            .unwrap();
        assert!(
            transaction
                .execute("INSERT INTO fixture_records VALUES('job','duplicate')", [])
                .is_err()
        );
        // Dropping the transaction rolls all file claims/domain/receipt changes back.
    }
    assert_eq!(fixture.count("fixture_records"), 0);
    assert_eq!(fixture.count("product_binaries"), 0);
    assert_eq!(fixture.count("product_binary_intents"), 3);
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    for claim in &claims {
        assert!(fixture.path(&claim.reference).exists());
    }
    fixture.claim(&claims);
    assert_eq!(fixture.count("product_binaries"), 3);
    assert_eq!(fixture.count("product_binary_intents"), 0);
    for claim in claims {
        assert!(
            !fixture.store.abort(&fixture.db, &claim.stage_id).unwrap(),
            "abort after SQL commit cannot erase committed bytes"
        );
    }
}

#[test]
fn ordered_chunks_checksum_and_no_ready_partial_data() {
    let mut fixture = Fixture::new();
    let (stage_id, _) = fixture.prepare(4);
    assert!(fixture.store.write_raw(&stage_id, 1, b"abc").is_err());
    assert!(fixture.store.write_raw(&stage_id, 0, b"abcde").is_err());
    assert!(fixture.store.write_raw(&stage_id, 0, b"").is_err());
    assert!(
        fixture
            .store
            .write_raw(&stage_id, 0, &vec![0; CHUNK + 1])
            .is_err()
    );
    fixture.store.write_raw(&stage_id, 0, b"abc").unwrap();
    assert!(
        fixture
            .store
            .run(
                &fixture.db,
                BinaryRequest::Seal {
                    stage_id: stage_id.clone(),
                    content_hash: "0".repeat(64)
                }
            )
            .is_err()
    );
    assert_eq!(fixture.count("product_binaries"), 0);
    assert!(fixture.store.abort(&fixture.db, &stage_id).unwrap());
    assert_eq!(fixture.count("product_binary_intents"), 0);
    assert!(
        !fixture
            .root
            .join(stage_relative(&stage_id).unwrap())
            .exists()
    );
}

#[test]
fn zero_byte_carrier_is_lossless_and_storage_does_not_invent_domain_limits() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"");
    fixture.claim(std::slice::from_ref(&claim));
    let lease = fixture.read_start(&claim.reference);
    match fixture.store.read_chunk(&lease, 0, CHUNK).unwrap() {
        BinaryReply::Bytes { bytes, end, .. } => {
            assert!(bytes.is_empty());
            assert!(end);
        }
        _ => panic!("empty read"),
    }
    fixture
        .store
        .run(&fixture.db, BinaryRequest::ReadVerify { lease_id: lease })
        .unwrap();
    let (stage, _) = fixture.prepare(33 * 1024 * 1024 + 1);
    fixture.store.abort(&fixture.db, &stage).unwrap();
}

#[test]
fn actual_large_file_streams_past_fixture_cap_and_reopens_without_full_file_cache() {
    let mut fixture = Fixture::new();
    let length = 33 * 1024 * 1024 + 123;
    let (stage_id, _) = fixture.prepare(length);
    let pattern: Vec<u8> = (0..CHUNK).map(|i| (i % 251) as u8).collect();
    let mut digest = Sha256::new();
    let mut offset = 0;
    while offset < length {
        let size = (length - offset).min(CHUNK as u64) as usize;
        fixture
            .store
            .write_raw(&stage_id, offset, &pattern[..size])
            .unwrap();
        digest.update(&pattern[..size]);
        offset += size as u64;
    }
    let claim = match fixture
        .store
        .run(
            &fixture.db,
            BinaryRequest::Seal {
                stage_id,
                content_hash: paths::hex_digest(digest.finalize()),
            },
        )
        .unwrap()
    {
        BinaryReply::Sealed { claim } => claim,
        _ => panic!("large sealed"),
    };
    fixture.claim(std::slice::from_ref(&claim));
    fixture.store.close(&fixture.db).unwrap();
    fixture.store = BinaryStore::new(&fixture.root, &fixture.workspace_id).unwrap();
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    let lease_id = fixture.read_start(&claim.reference);
    let export_path = fixture.root.join("large-export.bin");
    let mut exported = File::create(&export_path).unwrap();
    let mut hash = Sha256::new();
    let mut offset = 0;
    while offset < length {
        match fixture.store.read_chunk(&lease_id, offset, CHUNK).unwrap() {
            BinaryReply::Bytes { bytes, .. } => {
                assert!(bytes.len() <= CHUNK);
                exported.write_all(&bytes).unwrap();
                hash.update(&bytes);
                offset += bytes.len() as u64;
            }
            _ => panic!("large chunk"),
        }
    }
    exported.sync_all().unwrap();
    fixture
        .store
        .run(&fixture.db, BinaryRequest::ReadVerify { lease_id })
        .unwrap();
    assert_eq!(offset, length);
    assert_eq!(fs::metadata(export_path).unwrap().len(), length);
    assert_eq!(
        paths::hex_digest(hash.finalize()),
        claim.reference.content_hash
    );
    assert_eq!(
        fixture
            .store
            .reads
            .values()
            .next()
            .unwrap()
            .file
            .metadata()
            .unwrap()
            .len(),
        length
    );
}

#[test]
fn missing_and_corrupt_material_preserve_catalog_and_reject_stale_read_lease() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"original");
    fixture.claim(std::slice::from_ref(&claim));
    let lease = fixture.read_start(&claim.reference);
    fs::remove_file(fixture.path(&claim.reference)).unwrap();
    assert!(fixture.store.read_chunk(&lease, 0, CHUNK).is_err());
    match fixture
        .store
        .run(
            &fixture.db,
            BinaryRequest::Availability {
                reference: claim.reference.clone(),
            },
        )
        .unwrap()
    {
        BinaryReply::Availability { state } => assert_eq!(state, BinaryAvailability::Missing),
        _ => panic!("missing availability"),
    }
    assert_eq!(fixture.count("product_binaries"), 1);
    fs::write(fixture.path(&claim.reference), b"replaced").unwrap();
    match fixture
        .store
        .run(
            &fixture.db,
            BinaryRequest::Availability {
                reference: claim.reference.clone(),
            },
        )
        .unwrap()
    {
        BinaryReply::Availability { state } => assert_eq!(state, BinaryAvailability::Corrupt),
        _ => panic!("corrupt availability"),
    }
    assert!(
        fixture
            .store
            .run(
                &fixture.db,
                BinaryRequest::ReadStart {
                    reference: claim.reference
                }
            )
            .is_err()
    );
    assert_eq!(fixture.count("product_binaries"), 1);
}

#[test]
fn changed_between_hash_and_sql_commit_rejects_all_claims() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"before");
    let verified = fixture
        .store
        .verify_claims(&fixture.db, std::slice::from_ref(&claim), &mut || Ok(()))
        .unwrap();
    fs::write(fixture.path(&claim.reference), b"changed").unwrap();
    let transaction = fixture.db.transaction().unwrap();
    transaction
        .execute("INSERT INTO fixture_records VALUES('job','completed')", [])
        .unwrap();
    assert!(claim_prepared(&transaction, &uuid::Uuid::new_v4().to_string(), &verified).is_err());
    transaction.rollback().unwrap();
    assert_eq!(fixture.count("fixture_records"), 0);
    assert_eq!(fixture.count("product_binaries"), 0);
}

#[test]
fn recovery_partial_known_stages_is_idempotent_and_retains_unknown_files() {
    let mut fixture = Fixture::new();
    let (stage_id, _) = fixture.prepare(100);
    fixture.store.write_raw(&stage_id, 0, b"partial").unwrap();
    let unknown = fixture.root.join(".staging/binaries/unknown.stage");
    fs::write(&unknown, b"unrelated bytes").unwrap();
    fixture.store.writes.clear(); // equivalent to process exit without cleanup
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    assert_eq!(fixture.count("product_binary_intents"), 0);
    assert!(
        !fixture
            .root
            .join(stage_relative(&stage_id).unwrap())
            .exists()
    );
    assert_eq!(fs::read(unknown).unwrap(), b"unrelated bytes");
}

#[test]
fn changed_stage_after_final_flush_is_not_unlinked_or_claimed() {
    for alias in [false, true] {
        let mut fixture = Fixture::new();
        let bytes = b"published bytes";
        let (stage_id, binary_id) = fixture.prepare(bytes.len() as u64);
        fixture.store.write_raw(&stage_id, 0, bytes).unwrap();
        let content_hash = paths::hex_digest(Sha256::digest(bytes));
        let target = fixture.root.join(binary_relative(&binary_id).unwrap());
        let source = fixture.root.join(stage_relative(&stage_id).unwrap());
        let foreign = fixture.root.join("foreign-link");
        let reached = std::cell::Cell::new(false);
        let error = fixture
            .store
            .seal_with_flush(
                &fixture.db,
                &stage_id,
                &content_hash,
                &mut || Ok(()),
                |path, identity, length, links| {
                    paths::flush_published_file(path, identity, length, links)?;
                    reached.set(true);
                    if alias {
                        fs::hard_link(&source, &foreign)?;
                    } else {
                        fs::remove_file(&source)?;
                        fs::write(&source, b"foreign stage bytes")?;
                    }
                    Ok(())
                },
            )
            .expect_err("changed cleanup authority must reject sealing");
        assert!(reached.get());
        assert!(matches!(error.code, "containment" | "changed"));
        assert_eq!(fixture.count("product_binary_intents"), 1);
        assert_eq!(fixture.count("product_binaries"), 0);
        assert_eq!(fs::read(&target).unwrap(), bytes);
        assert_eq!(
            fs::read(&source).unwrap(),
            if alias {
                &bytes[..]
            } else {
                &b"foreign stage bytes"[..]
            }
        );
        assert!(recover(&fixture.root, &fixture.db, &fixture.workspace_id).is_err());
        assert_eq!(fixture.count("product_binary_intents"), 1);
        assert_eq!(
            fs::read(&source).unwrap(),
            if alias {
                &bytes[..]
            } else {
                &b"foreign stage bytes"[..]
            }
        );
        if alias {
            assert_eq!(fs::read(&foreign).unwrap(), bytes);
        }
    }
}

#[test]
fn recovery_flush_cannot_authorize_deleting_a_changed_stage() {
    for alias in [false, true] {
        let mut fixture = Fixture::new();
        let bytes = b"published bytes";
        let (stage_id, binary_id) = fixture.prepare(bytes.len() as u64);
        fixture.store.write_raw(&stage_id, 0, bytes).unwrap();
        let content_hash = paths::hex_digest(Sha256::digest(bytes));
        fixture
            .db
            .execute(
                "UPDATE product_binary_intents SET content_hash=? WHERE stage_id=?",
                rusqlite::params![content_hash, stage_id],
            )
            .unwrap();
        let target = fixture.root.join(binary_relative(&binary_id).unwrap());
        let source = fixture.root.join(stage_relative(&stage_id).unwrap());
        let foreign = fixture.root.join("foreign-link");
        fs::hard_link(&source, &target).unwrap();
        fixture.store.writes.clear();
        let reached = std::cell::Cell::new(false);
        let error = recover_intent_with_flush(
            &fixture.store.root,
            fixture.store.root_identity,
            &fixture.db,
            &stage_id,
            true,
            |path, identity, length, links| {
                paths::flush_published_file(path, identity, length, links)?;
                reached.set(true);
                if alias {
                    fs::hard_link(&source, &foreign)?;
                } else {
                    fs::remove_file(&source)?;
                    fs::write(&source, b"foreign stage bytes")?;
                }
                Ok(())
            },
        )
        .expect_err("changed recovery stage must not be erased");
        assert!(reached.get());
        assert!(matches!(error.code, "containment" | "changed"));
        assert_eq!(fixture.count("product_binary_intents"), 1);
        assert_eq!(fixture.count("product_binaries"), 0);
        assert_eq!(fs::read(&target).unwrap(), bytes);
        assert_eq!(
            fs::read(&source).unwrap(),
            if alias {
                &bytes[..]
            } else {
                &b"foreign stage bytes"[..]
            }
        );
        if alias {
            assert_eq!(fs::read(foreign).unwrap(), bytes);
        }
    }
}

#[test]
fn final_file_flush_failure_retains_intent_and_recovery_never_invents_a_claim() {
    let mut fixture = Fixture::new();
    let bytes = b"publication bytes";
    let (stage_id, binary_id) = fixture.prepare(bytes.len() as u64);
    fixture.store.write_raw(&stage_id, 0, bytes).unwrap();
    let content_hash = paths::hex_digest(Sha256::digest(bytes));
    let target = fixture.root.join(binary_relative(&binary_id).unwrap());
    let source = fixture.root.join(stage_relative(&stage_id).unwrap());
    let reached = std::cell::Cell::new(false);
    let error = fixture
        .store
        .seal_with_flush(
            &fixture.db,
            &stage_id,
            &content_hash,
            &mut || Ok(()),
            |path, identity, length, links| {
                assert!(path.exists(), "failure hook ran before actual publication");
                paths::flush_published_file(path, identity, length, links)?;
                reached.set(true);
                Err(Error::new(
                    "fixtureFlush",
                    "injected published file flush failure",
                ))
            },
        )
        .expect_err("final-file flush must reject sealing");
    assert_eq!(error.code, "fixtureFlush");
    assert!(reached.get());
    assert_eq!(fixture.count("product_binaries"), 0);
    assert_eq!(fixture.count("product_binary_intents"), 1);
    assert_eq!(
        fixture
            .db
            .query_row(
                "SELECT state FROM product_binary_intents WHERE stage_id=?",
                [&stage_id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "writing"
    );
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(fs::read(&target).unwrap(), bytes);
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert_eq!(
        fixture.count("product_binaries"),
        0,
        "recovery manufactured a domain claim"
    );
    let claim = BinaryClaim {
        stage_id,
        reference: ManagedBinaryRef {
            version: 1,
            workspace_id: fixture.workspace_id.clone(),
            binary_id,
            byte_length: bytes.len() as u64,
            mime_type: "application/octet-stream".into(),
            content_hash,
        },
    };
    fixture.claim(std::slice::from_ref(&claim));
    assert_eq!(fixture.count("product_binaries"), 1);
}

#[test]
fn recovery_handles_death_between_publication_link_and_unlink() {
    let mut fixture = Fixture::new();
    let bytes = b"publication bytes";
    let (stage_id, binary_id) = fixture.prepare(bytes.len() as u64);
    fixture.store.write_raw(&stage_id, 0, bytes).unwrap();
    let content_hash = paths::hex_digest(Sha256::digest(bytes));
    fixture
        .db
        .execute(
            "UPDATE product_binary_intents SET content_hash=? WHERE stage_id=?",
            params![content_hash, stage_id],
        )
        .unwrap();
    let target = fixture.root.join(binary_relative(&binary_id).unwrap());
    let source = fixture.root.join(stage_relative(&stage_id).unwrap());
    fixture
        .store
        .writes
        .get(&stage_id)
        .unwrap()
        .file
        .sync_all()
        .unwrap();
    fs::hard_link(&source, &target).unwrap();
    fixture.store.writes.clear();
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    recover(&fixture.root, &fixture.db, &fixture.workspace_id).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), bytes);
    let claim = BinaryClaim {
        stage_id,
        reference: ManagedBinaryRef {
            version: 1,
            workspace_id: fixture.workspace_id.clone(),
            binary_id,
            byte_length: bytes.len() as u64,
            mime_type: "application/octet-stream".into(),
            content_hash,
        },
    };
    fixture.claim(std::slice::from_ref(&claim));
    assert_eq!(fixture.count("product_binaries"), 1);
}

#[test]
fn publication_never_overwrites_even_empty_destination() {
    let mut fixture = Fixture::new();
    let (stage_id, binary_id) = fixture.prepare(3);
    fixture.store.write_raw(&stage_id, 0, b"abc").unwrap();
    let target = fixture.root.join(binary_relative(&binary_id).unwrap());
    fs::write(&target, b"").unwrap();
    assert!(
        fixture
            .store
            .run(
                &fixture.db,
                BinaryRequest::Seal {
                    stage_id: stage_id.clone(),
                    content_hash: paths::hex_digest(Sha256::digest(b"abc"))
                }
            )
            .is_err()
    );
    assert_eq!(fs::read(&target).unwrap(), b"");
    assert_eq!(fixture.count("product_binaries"), 0);
    assert!(
        fixture.store.abort(&fixture.db, &stage_id).is_err(),
        "ambiguous foreign destination must be preserved"
    );
    assert!(target.exists());
}

#[test]
fn duplicate_forged_and_foreign_claims_reject_before_commit() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"claim");
    assert!(
        fixture
            .store
            .verify_claims(&fixture.db, &[claim.clone(), claim.clone()], &mut || Ok(()))
            .is_err()
    );
    let mut forged = claim.clone();
    forged.reference.mime_type = "audio/wav".into();
    assert!(
        fixture
            .store
            .verify_claims(&fixture.db, &[forged], &mut || Ok(()))
            .is_err()
    );
    let mut foreign = claim.clone();
    foreign.reference.workspace_id = uuid::Uuid::new_v4().to_string();
    assert!(
        fixture
            .store
            .verify_claims(&fixture.db, &[foreign], &mut || Ok(()))
            .is_err()
    );
    fixture.claim(std::slice::from_ref(&claim));
    assert!(
        fixture
            .store
            .verify_claims(&fixture.db, &[claim], &mut || Ok(()))
            .is_err()
    );
}

#[test]
fn request_shapes_are_closed_and_ranges_are_bounded() {
    assert!(serde_json::from_value::<BinaryRequest>(
        serde_json::json!({"type":"prepare","byteLength":1,"mimeType":"a","path":"/tmp/anything"})
    )
    .is_err());
    assert!(serde_json::from_value::<ManagedBinaryRef>(serde_json::json!({"version":1,"workspaceId":uuid::Uuid::new_v4().to_string(),"binaryId":uuid::Uuid::new_v4().to_string(),"byteLength":1,"mimeType":"a","contentHash":"0".repeat(64),"path":"anything"})).is_err());
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"0123456789");
    fixture.claim(std::slice::from_ref(&claim));
    let lease = fixture.read_start(&claim.reference);
    assert!(fixture.store.read_chunk(&lease, 0, CHUNK + 1).is_err());
    assert!(fixture.store.read_chunk(&lease, 0, 0).is_err());
    assert!(fixture.store.read_chunk(&lease, 11, 1).is_err());
    match fixture.store.read_chunk(&lease, 3, 4).unwrap() {
        BinaryReply::Bytes { bytes, end, .. } => {
            assert_eq!(bytes, b"3456");
            assert!(!end);
        }
        _ => panic!("range bytes"),
    }
}

#[test]
fn idle_or_canceled_stages_have_no_claimed_rows() {
    let mut fixture = Fixture::new();
    let (stage_id, _) = fixture.prepare(1);
    fixture.store.writes.get_mut(&stage_id).unwrap().progressed = Instant::now() - IDLE;
    fixture.store.run(&fixture.db, BinaryRequest::Reap).unwrap();
    assert_eq!(fixture.count("product_binary_intents"), 0);
    let claim = fixture.sealed(b"verified");
    let mut checks = 0;
    let result = fixture.store.verify_claims(&fixture.db, &[claim], &mut || {
        checks += 1;
        if checks >= 2 {
            Err(Error::new("canceled", "Canceled fixture operation"))
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert_eq!(fixture.count("product_binaries"), 0);
}

#[test]
fn playback_is_verified_bounded_and_revoked_by_missing_or_changed_bytes() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"0123456789");
    assert!(
        fixture
            .store
            .playback(&fixture.db, &claim.reference, &mut || Ok(()))
            .is_err()
    );
    fixture.claim(std::slice::from_ref(&claim));
    let mut playback = fixture
        .store
        .playback(&fixture.db, &claim.reference, &mut || Ok(()))
        .unwrap();
    assert_eq!(playback.reference(), &claim.reference);
    assert_eq!(playback.read_chunk(3, 4).unwrap(), b"3456");
    assert_eq!(playback.read_chunk(8, CHUNK).unwrap(), b"89");
    assert!(playback.read_chunk(0, CHUNK + 1).is_err());
    assert!(playback.read_chunk(11, 1).is_err());
    let path = paths::managed(
        &fixture.root,
        &binary_relative(&claim.reference.binary_id).unwrap(),
        false,
    )
    .unwrap();
    fs::remove_file(&path).unwrap();
    assert!(playback.read_chunk(0, 1).is_err());
    fs::write(&path, b"0123456789").unwrap();
    assert!(playback.read_chunk(0, 1).is_err());
    assert!(
        fixture
            .store
            .playback(&fixture.db, &claim.reference, &mut || Err(Error::new(
                "canceled",
                "Canceled playback"
            )))
            .is_err()
    );
    fs::write(&path, b"XXXXXXXXXX").unwrap();
    assert_eq!(
        fixture
            .store
            .playback(&fixture.db, &claim.reference, &mut || Ok(()))
            .err()
            .unwrap()
            .code,
        "corrupt"
    );
}

#[test]
fn private_playback_authority_opens_lazily_without_hashing_and_rejects_rewritten_identity() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"0123456789");
    fixture.claim(std::slice::from_ref(&claim));
    let authority = fixture
        .store
        .playback(&fixture.db, &claim.reference, &mut || Ok(()))
        .unwrap()
        .into_authority();
    let scanned = test_verified_scan_bytes(&fixture.root);
    assert!(scanned >= claim.reference.byte_length);
    assert_eq!(authority.reference(), &claim.reference);
    for _ in 0..100 {
        let mut file = authority.open_checked().unwrap();
        assert_eq!(file.read_chunk(3, 4).unwrap(), b"3456");
    }
    assert_eq!(test_verified_scan_bytes(&fixture.root), scanned);
    // Preserve inode and size: authored bytes must still reject the old proof
    // when their modification identity changes, without re-authorizing by hash.
    let path = fixture.path(&claim.reference);
    let mut file = File::options().write(true).open(&path).unwrap();
    file.write_all(b"XXXXXXXXXX").unwrap();
    file.set_modified(SystemTime::now() + Duration::from_secs(1))
        .unwrap();
    assert_eq!(authority.open_checked().err().unwrap().code, "changed");
    assert_eq!(test_verified_scan_bytes(&fixture.root), scanned);
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"0123456789").unwrap();
    assert_eq!(authority.open_checked().err().unwrap().code, "changed");
}

#[cfg(unix)]
#[test]
fn private_playback_authority_rejects_moved_parent_and_replaced_root_with_same_file() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"private verified identity");
    fixture.claim(std::slice::from_ref(&claim));
    let authority = fixture
        .store
        .playback(&fixture.db, &claim.reference, &mut || Ok(()))
        .unwrap()
        .into_authority();
    let scanned = test_verified_scan_bytes(&fixture.root);
    assert!(scanned >= claim.reference.byte_length);
    let assets = fixture.root.join("assets");
    let outside = fixture.root.with_extension("outside-authority-assets");
    fs::rename(&assets, &outside).unwrap();
    symlink(&outside, &assets).unwrap();
    let failure = authority.open_checked().err().unwrap();
    assert_eq!(failure.code, "containment");
    fs::remove_file(&assets).unwrap();
    fs::rename(&outside, &assets).unwrap();
    let original = fixture.root.with_extension("original-authority-root");
    fs::rename(&fixture.root, &original).unwrap();
    fs::create_dir(&fixture.root).unwrap();
    fs::rename(original.join("assets"), &assets).unwrap();
    assert_eq!(authority.open_checked().err().unwrap().code, "containment");
    fs::rename(&assets, original.join("assets")).unwrap();
    fs::remove_dir(&fixture.root).unwrap();
    fs::rename(&original, &fixture.root).unwrap();
    assert_eq!(test_verified_scan_bytes(&fixture.root), scanned);
    assert_eq!(
        fs::read(fixture.path(&claim.reference)).unwrap(),
        b"private verified identity"
    );
}

#[cfg(unix)]
#[test]
fn cached_read_playback_and_claim_handles_reject_parent_symlink_and_stay_retired() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"workspace-contained bytes");
    let verified = fixture
        .store
        .verify_claims(&fixture.db, std::slice::from_ref(&claim), &mut || Ok(()))
        .unwrap();
    fixture.claim(std::slice::from_ref(&claim));
    let read = fixture.read_start(&claim.reference);
    let verify = fixture.read_start(&claim.reference);
    let mut playback = fixture
        .store
        .playback(&fixture.db, &claim.reference, &mut || Ok(()))
        .unwrap();
    let assets = fixture.root.join("assets");
    let outside = fixture.root.with_extension("outside-assets");
    fs::rename(&assets, &outside).unwrap();
    symlink(&outside, &assets).unwrap();
    let read_error = fixture.store.read_chunk(&read, 0, 1).unwrap_err();
    let verify_error = fixture
        .store
        .read_verify(&verify, &mut || Ok(()))
        .unwrap_err();
    let playback_error = playback.read_chunk(0, 1).unwrap_err();
    let claim_error = validate_claim_files(&verified).unwrap_err();
    fs::remove_file(&assets).unwrap();
    fs::rename(&outside, &assets).unwrap();
    assert_eq!(read_error.code, "containment");
    assert_eq!(verify_error.code, "containment");
    assert_eq!(playback_error.code, "containment");
    assert_eq!(claim_error.code, "containment");
    assert_eq!(
        fixture.store.read_chunk(&read, 0, 1).unwrap_err().code,
        "expired"
    );
    assert_eq!(
        fixture
            .store
            .read_verify(&verify, &mut || Ok(()))
            .unwrap_err()
            .code,
        "expired"
    );
    assert_eq!(playback.read_chunk(0, 1).unwrap_err().code, "expired");
    assert_eq!(
        fs::read(fixture.path(&claim.reference)).unwrap(),
        b"workspace-contained bytes"
    );
}

#[cfg(unix)]
#[test]
fn replacement_during_final_verification_retires_read_without_publishing_a_result() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(&vec![7; CHUNK + 17]);
    fixture.claim(std::slice::from_ref(&claim));
    let lease = fixture.read_start(&claim.reference);
    let assets = fixture.root.join("assets");
    let outside = fixture.root.with_extension("verification-assets");
    let mut checks = 0;
    let result = fixture.store.read_verify(&lease, &mut || {
        checks += 1;
        if checks == 2 {
            fs::rename(&assets, &outside)?;
            symlink(&outside, &assets)?;
        }
        Ok(())
    });
    fs::remove_file(&assets).unwrap();
    fs::rename(&outside, &assets).unwrap();
    assert_eq!(result.unwrap_err().code, "containment");
    assert_eq!(
        fixture
            .store
            .read_verify(&lease, &mut || Ok(()))
            .unwrap_err()
            .code,
        "expired"
    );
}

#[cfg(unix)]
#[test]
fn replacing_workspace_root_cannot_reuse_a_verified_open_file() {
    let mut fixture = Fixture::new();
    let claim = fixture.sealed(b"root inode authority");
    fixture.claim(std::slice::from_ref(&claim));
    let lease = fixture.read_start(&claim.reference);
    let outside = fixture.root.with_extension("original-root");
    fs::rename(&fixture.root, &outside).unwrap();
    fs::create_dir(&fixture.root).unwrap();
    fs::rename(outside.join("assets"), fixture.root.join("assets")).unwrap();
    let result = fixture.store.read_chunk(&lease, 0, 1);
    fs::rename(fixture.root.join("assets"), outside.join("assets")).unwrap();
    fs::remove_dir(&fixture.root).unwrap();
    fs::rename(&outside, &fixture.root).unwrap();
    assert_eq!(result.unwrap_err().code, "containment");
    assert_eq!(
        fixture.store.read_chunk(&lease, 0, 1).unwrap_err().code,
        "expired"
    );
}

#[cfg(unix)]
#[test]
fn replaced_stage_parent_is_neither_written_nor_unlinked_and_handle_is_retired() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new();
    let (stage_id, _) = fixture.prepare(4);
    let stages = fixture.root.join(".staging/binaries");
    let outside = fixture.root.with_extension("outside-stages");
    fs::rename(&stages, &outside).unwrap();
    symlink(&outside, &stages).unwrap();
    let result = fixture.store.write_raw(&stage_id, 0, b"safe");
    let external_bytes = fs::read(outside.join(format!("{stage_id}.stage"))).unwrap();
    fs::remove_file(&stages).unwrap();
    fs::rename(&outside, &stages).unwrap();
    assert_eq!(result.unwrap_err().code, "containment");
    assert!(external_bytes.is_empty());
    assert_eq!(
        fixture
            .store
            .write_raw(&stage_id, 0, b"safe")
            .unwrap_err()
            .code,
        "expired"
    );
    assert_eq!(
        fixture.count("product_binary_intents"),
        1,
        "unknown interrupted intent remains for contained recovery"
    );
    fixture.store.abort(&fixture.db, &stage_id).unwrap();
}

#[cfg(unix)]
#[test]
fn replaced_complete_stage_parent_rejects_finish_discard_and_claim_without_touching_external_bytes()
{
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new();
    let (stage_id, binary_id) = fixture.prepare(4);
    fixture.store.write_raw(&stage_id, 0, b"safe").unwrap();
    let stages = fixture.root.join(".staging/binaries");
    let outside = fixture.root.with_extension("outside-complete-stage");
    fs::rename(&stages, &outside).unwrap();
    symlink(&outside, &stages).unwrap();
    let hash = paths::hex_digest(Sha256::digest(b"safe"));
    let finish = fixture
        .store
        .seal(&fixture.db, &stage_id, &hash, &mut || Ok(()));
    let discard = fixture.store.abort(&fixture.db, &stage_id);
    let fabricated = BinaryClaim {
        stage_id: stage_id.clone(),
        reference: ManagedBinaryRef {
            version: 1,
            workspace_id: fixture.workspace_id.clone(),
            binary_id,
            byte_length: 4,
            mime_type: "application/octet-stream".into(),
            content_hash: hash.clone(),
        },
    };
    let claim_result = fixture
        .store
        .verify_claims(&fixture.db, &[fabricated], &mut || Ok(()));
    let external_bytes = fs::read(outside.join(format!("{stage_id}.stage"))).unwrap();
    fs::remove_file(&stages).unwrap();
    fs::rename(&outside, &stages).unwrap();
    assert_eq!(finish.unwrap_err().code, "containment");
    assert_eq!(discard.unwrap_err().code, "containment");
    assert!(claim_result.is_err());
    assert_eq!(external_bytes, b"safe");
    assert_eq!(fixture.count("product_binaries"), 0);
    assert_eq!(fixture.count("product_binary_intents"), 1);
    assert_eq!(
        fixture
            .store
            .seal(&fixture.db, &stage_id, &hash, &mut || Ok(()))
            .unwrap_err()
            .code,
        "expired"
    );
    fixture.store.abort(&fixture.db, &stage_id).unwrap();
}
