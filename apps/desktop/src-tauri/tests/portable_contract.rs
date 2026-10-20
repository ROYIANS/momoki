use momoki_native_storage::{WorkspaceRef, derive_ref, validate_ref};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
    format: String,
    workspace_id: String,
    references: Vec<Vector>,
    invalid: Vec<Invalid>,
    rejected_identities: Vec<Rejected>,
    hashes: Vec<HashVector>,
    sources: std::collections::BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Vector {
    asset_id: String,
    reference: WorkspaceRef,
    resolved: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Invalid {
    asset_id: String,
    reference: WorkspaceRef,
    rejected_by_oracle: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rejected {
    raw_json: String,
    rejected: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HashVector {
    length: usize,
    sha256: String,
}

#[test]
fn actual_typescript_oracle_is_exact_in_rust() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("../../fixtures/portable-contract-v1.json")).unwrap();
    assert_eq!(corpus.format, "momoki.native-contract-corpus.v1");
    assert_eq!(corpus.sources.len(), 4);
    for vector in corpus.references {
        assert_eq!(
            derive_ref(
                &corpus.workspace_id,
                &vector.reference.project_id,
                &vector.asset_id
            )
            .unwrap(),
            vector.reference
        );
        validate_ref(&vector.reference, &corpus.workspace_id, &vector.asset_id).unwrap();
        assert_eq!(
            vector.resolved,
            format!("/temporary/oracle/{}", vector.reference.relative_path)
        );
    }
    for vector in corpus.invalid {
        assert!(vector.rejected_by_oracle);
        assert!(validate_ref(&vector.reference, &corpus.workspace_id, &vector.asset_id).is_err());
    }
    for vector in corpus.rejected_identities {
        assert!(vector.rejected);
        if let Ok(id) = serde_json::from_str::<String>(&vector.raw_json) {
            assert!(derive_ref(&corpus.workspace_id, "Project", &id).is_err());
        }
    }
    for vector in corpus.hashes {
        let mut digest = Sha256::new();
        let bytes: Vec<u8> = (0..vector.length)
            .map(|index| (index % 251) as u8)
            .collect();
        for chunk in bytes.chunks(37) {
            digest.update(chunk);
        }
        assert_eq!(
            digest
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            vector.sha256
        );
    }
}

#[test]
fn malformed_wire_extra_fields_and_native_lengths_reject() {
    let valid = derive_ref("workspace", "project", "asset").unwrap();
    let mut wire = serde_json::to_value(&valid).unwrap();
    wire["sql"] = serde_json::json!("drop table assets");
    assert!(serde_json::from_value::<WorkspaceRef>(wire).is_err());
    assert!(serde_json::from_str::<WorkspaceRef>(r#"{"workspaceId":"workspace","projectId":"\ud800","relativePath":"studio/assets/id-aa"}"#).is_err());
    let long = derive_ref("workspace", &"a".repeat(119), "asset").unwrap();
    assert!(validate_ref(&long, "workspace", "asset").is_err());
    assert_ne!(
        derive_ref("workspace", "é", "asset").unwrap(),
        derive_ref("workspace", "e\u{301}", "asset").unwrap()
    );
    assert_ne!(
        derive_ref("workspace", "A", "asset").unwrap(),
        derive_ref("workspace", "a", "asset").unwrap()
    );
}
