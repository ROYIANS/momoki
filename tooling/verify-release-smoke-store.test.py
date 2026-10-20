#!/usr/bin/env python3
"""Synthetic verifier failure contracts; these are not packaged runtime proof."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("verifier", Path(__file__).with_name("verify-release-smoke-store.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def encode(value):
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["bool", value]
    if isinstance(value, str):
        return ["str", value]
    if isinstance(value, int):
        return ["num", value]
    if isinstance(value, dict):
        if set(value) == {"version", "workspaceId", "binaryId", "byteLength", "mimeType", "contentHash"}:
            return ["binary", value]
        return ["obj", [[key, encode(item)] for key, item in value.items()]]
    if isinstance(value, list):
        return ["arr", [encode(item) for item in value]]
    raise ValueError("Unexpected synthetic value")


def stored_key(value):
    # Match Rust WireText::from_units/ToSql: four lowercase hex digits per
    # UTF-16 unit, including empty strings, NUL and unpaired surrogates.
    return value.encode("utf-16-be", errors="surrogatepass").hex()


class VerifySmokeStore(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="momoki-release-verifier-")
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "product-workspace-v1"
        (self.workspace / ".local").mkdir(parents=True)
        (self.workspace / "assets").mkdir()
        self.database = self.workspace / ".local" / "state.sqlite"
        self.content = b"MOMOKI_VERIFIER_MARKER\n" + b"fixture repeated bytes\n" * 18000
        self.binary = "11111111-1111-4111-8111-111111111111"
        self.asset = self.workspace / "assets" / ("id-" + self.binary.encode().hex())
        self.asset.write_bytes(self.content)
        self.expected = {"projectName": "UI project", "fixtureFilename": "fixture.txt", "fixtureBytes": len(self.content),
                         "fixtureSha256": hashlib.sha256(self.content).hexdigest(), "previewMarker": "MOMOKI_VERIFIER_MARKER",
                         "sourcePath": str(self.root / "removed-source.txt")}
        self.reference = {"version": 1, "workspaceId": "workspace", "binaryId": self.binary, "byteLength": len(self.content),
                          "mimeType": "text/plain", "contentHash": self.expected["fixtureSha256"]}
        self.material = {"id": "material", "name": "fixture.txt", "revision": 1, "kind": "document", "scope": {"kind": "global"}}
        self.version = {"id": "version", "materialId": "material", "revision": 1,
                        "payload": {"type": "file", "filename": "fixture.txt", "mimeType": "text/plain", "blob": self.reference}}
        with sqlite3.connect(self.database) as db:
            db.executescript("""
                CREATE TABLE product_workspace(id,schema,change_sequence);
                CREATE TABLE product_records(table_name,row_key,payload);
                CREATE TABLE product_binaries(binary_id,byte_length,mime_type,content_hash,operation_id);
                CREATE TABLE product_operations(operation_id,status);
                CREATE TABLE product_binary_intents(stage_id);
            """)
            db.execute("INSERT INTO product_workspace VALUES('workspace',1,3)")
            db.execute("INSERT INTO product_binaries VALUES(?,?,?,?,?)", (self.binary, len(self.content), "text/plain", self.expected["fixtureSha256"], "operation"))
            db.execute("INSERT INTO product_operations VALUES('operation','committed')")
            for table, key, row in [("projects", "project", {"id": "project", "name": "UI project"}),
                                    ("libraryMaterials", "material", self.material), ("materialVersions", "version", self.version)]:
                db.execute("INSERT INTO product_records VALUES(?,?,?)", (table, stored_key(key), json.dumps(encode(row))))

    def tearDown(self):
        self.temporary.cleanup()

    def update(self, table, key, value):
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE product_records SET payload=? WHERE table_name=? AND row_key=?", (json.dumps(encode(value)), table, stored_key(key)))

    def test_valid_exact_mapping_is_read_only(self):
        before = self.database.read_bytes()
        result = verifier.verify(self.workspace, self.expected)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["binaryId"], self.binary)
        self.assertEqual(result["sha256"], hashlib.sha256(self.content).hexdigest())
        self.assertEqual(self.database.read_bytes(), before)
        self.assertEqual(sorted(path.name for path in self.database.parent.iterdir()), ["state.sqlite"])

    def test_stored_identity_matches_the_native_utf16_contract(self):
        for encoded, decoded in [
            ("00700072006a005f00610061006500330030006400620036002d0064003900320064002d0034006600300037002d0062003200360032002d003900640036003000360034003900310032006200630062",
             "prj_aae30db6-d92d-4f07-b262-9d6064912bcb"),
            ("4e2d6587d83cdf39", "中文🌹"),
            ("00410000004ed83ddc1f", "A\0N🐟"),
            ("0061d80000620000", "a\ud800b\0"),
            ("", ""),
        ]:
            # The literal first pair was observed read-only from the actual
            # isolated UI-created project. The remaining canonical pairs cover
            # the same production WireText representation without SQL repair.
            self.assertEqual(stored_key(decoded), encoded)
            self.assertEqual(verifier.decode_stored_key(encoded), decoded)

    def test_malformed_or_plaintext_stored_identity_is_rejected(self):
        for key in (None, 123, [], {}, "project", "007", "0070 0072", "007G", "007A"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "stored UTF-16"):
                verifier.decode_stored_key(key)
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE product_records SET row_key='project' WHERE table_name='projects'")
        with self.assertRaisesRegex(ValueError, "stored UTF-16"):
            verifier.verify(self.workspace, self.expected)

    def test_decoded_primary_identity_still_must_match_each_payload(self):
        for table, key, message in [
            ("projects", "project", "persisted UI project"),
            ("libraryMaterials", "material", "identity/revision/scope"),
            ("materialVersions", "version", "Version key mismatch"),
        ]:
            with self.subTest(table=table):
                changed = stored_key("different-" + key)
                with sqlite3.connect(self.database) as db:
                    db.execute("UPDATE product_records SET row_key=? WHERE table_name=? AND row_key=?",
                               (changed, table, stored_key(key)))
                with self.assertRaisesRegex(ValueError, message):
                    verifier.verify(self.workspace, self.expected)
                with sqlite3.connect(self.database) as db:
                    db.execute("UPDATE product_records SET row_key=? WHERE table_name=? AND row_key=?",
                               (stored_key(key), table, changed))

    def test_owned_bytes_corruption_fails_even_when_size_matches(self):
        self.asset.write_bytes(b"X" + self.content[1:])
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            verifier.verify(self.workspace, self.expected)

    def test_original_source_must_be_removed(self):
        Path(self.expected["sourcePath"]).write_bytes(self.content)
        with self.assertRaisesRegex(ValueError, "source still exists"):
            verifier.verify(self.workspace, self.expected)

    def test_material_scope_cannot_drift(self):
        self.material["scope"] = {"kind": "project", "id": "project"}
        self.update("libraryMaterials", "material", self.material)
        with self.assertRaisesRegex(ValueError, "scope"):
            verifier.verify(self.workspace, self.expected)

    def test_binary_must_be_committed_with_operation(self):
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE product_operations SET status='aborted'")
        with self.assertRaisesRegex(ValueError, "committed with"):
            verifier.verify(self.workspace, self.expected)

    def test_foreign_reference_fails(self):
        self.reference["workspaceId"] = "another-workspace"
        self.update("materialVersions", "version", self.version)
        with self.assertRaisesRegex(ValueError, "exact import"):
            verifier.verify(self.workspace, self.expected)

    def test_path_shaped_binary_id_fails_before_file_access(self):
        self.reference["binaryId"] = "../outside"
        self.update("materialVersions", "version", self.version)
        with self.assertRaises(ValueError):
            verifier.verify(self.workspace, self.expected)

    def test_ambiguous_material_versions_fail(self):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO product_records VALUES(?,?,?)", ("materialVersions", stored_key("duplicate"), json.dumps(encode(self.version))))
        with self.assertRaisesRegex(ValueError, "material version"):
            verifier.verify(self.workspace, self.expected)

    def test_incomplete_binary_intent_fails(self):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO product_binary_intents VALUES('incomplete')")
        with self.assertRaisesRegex(ValueError, "Incomplete binary"):
            verifier.verify(self.workspace, self.expected)

    def test_wrong_workspace_schema_fails(self):
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE product_workspace SET schema=99")
        with self.assertRaisesRegex(ValueError, "workspace owner"):
            verifier.verify(self.workspace, self.expected)

    def test_uncheckpointed_wal_fails(self):
        Path(str(self.database) + "-wal").write_bytes(b"remaining WAL")
        with self.assertRaisesRegex(ValueError, "Uncheckpointed"):
            verifier.verify(self.workspace, self.expected)

    @unittest.skipIf(os.name == "nt", "Host symlink fixture requires separate Windows privileges; native reparse tests remain mandatory")
    def test_owned_file_symlink_is_rejected(self):
        outside = self.root / "outside"
        outside.write_bytes(self.content)
        self.asset.unlink()
        self.asset.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            verifier.verify(self.workspace, self.expected)

    def test_codec_duplicate_or_unsupported_value_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            verifier.decode(["obj", [["key", ["str", "one"]], ["key", ["str", "two"]]]])
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            verifier.decode(["not-real-codec", []])
        for number in (float("nan"), float("inf"), True):
            with self.assertRaisesRegex(ValueError, "finite numeric"):
                verifier.decode(["num", number])


if __name__ == "__main__":
    unittest.main()
