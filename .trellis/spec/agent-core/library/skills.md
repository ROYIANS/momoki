# Portable text skills

## 1. Scope / Trigger

`@momoki/agent-core` exposes pure helpers for portable, text-only `SKILL.md`
documents. Installation, YAML decoding, hashes, persistence, model/tool binding
and filesystem authority remain host responsibilities. Another consumer can use
these helpers with an ordinary byte map, without Studio, React, Node or a product
database. Imports between core sources retain `.js` ESM extensions.

The initial catalogue contains descriptive metadata. A skill's body is supplied
only after an explicit load; each reference is read separately. Optional
`allowed-tools` is disclosed as unsupported policy and grants no capability.

## 2. Signatures

The public root exports `SKILL_LIMITS`, `SkillMetadata`,
`InstalledSkillDescriptor`, `SkillDocumentParts`, `SkillTextRange` and:

```ts
splitSkillDocument(document: string): SkillDocumentParts;
validateSkillMetadata(decoded: unknown, directoryName?: string): SkillMetadata;
validateSkillResourcePath(path: string): string;
validateSkillResourcePaths(paths: readonly string[]): readonly string[];
formatSkillCatalogue(entries: readonly InstalledSkillDescriptor[]): string;
readSkillTextRange(text: string, offset?: number, limit?: number): SkillTextRange;
```

An installation descriptor has `skillId`, immutable `revision`, and `metadata`.
Installation identity is distinct from the content revision; uninstalling and
reinstalling must not reuse an old installation identity. Hosts may use a digest
as `revision`; the core catalogue validates bounded opaque identities rather
than imposing a hash algorithm.

## 3. Contracts

- `splitSkillDocument` splits YAML delimiters, accepts CRLF and a leading BOM,
  and preserves body text. The host retains exact original UTF-8 bytes for its
  content identity. This helper is not a YAML parser.
- Hosts decode frontmatter to `unknown` through a maintained parser with strict
  pre-conversion checks. Metadata validation accepts a plain mapping, never an
  arbitrary class instance, and returns immutable descriptive values.
- `name` uses lowercase ASCII letters/digits separated by single hyphens,
  1–64 characters, and matches the selected directory when supplied.
  `description` is nonempty and at most 1,024 Unicode scalars. Optional license,
  compatibility, metadata and allowed-tools have finite bounds. Unsupported
  scalar fields are named in `unsupportedFields`, never interpreted as policy.
- Paths are portable logical names, not operating-system containment proof.
  Only root `LICENSE`/`LICENSE.txt` and text `.md`, `.txt`, `.json`, `.yaml`,
  `.yml`, `.csv` files under `references/` or `assets/` are resource names.
  Path-set validation detects case/Unicode and file-versus-directory collisions
  before returning canonical order.
- Catalogue JSON is `{version:1,skills:[{skillId,revision,name,description}]}`,
  sorted by name, bounded to 24 KiB UTF-8, with dangerous delimiter characters
  escaped. Empty input returns `''`. It excludes body text, resource text,
  arbitrary metadata, tool policy and installation source paths.
- Resource pages use Unicode scalar offsets, not UTF-8 byte offsets or UTF-16
  indexes. Results include `text`, `offset`, `nextOffset`, `end`; default and
  maximum page size is 8,192 scalars. The host authorizes the selected manifest
  component before calling the paging helper.

Limits are shared through `SKILL_LIMITS`: frontmatter 8 KiB, body 32 KiB,
resource 128 KiB, raw package 512 KiB, 32 accepted files including `SKILL.md`,
path depth 4, path 512 UTF-8 bytes, segment 255 bytes, 1,024 examined directory
entries, 32 installed/16 enabled skills, persisted revision group 2 MiB,
128 retained revisions/64 MiB retained serialized content. Enforcement of
installation, traversal and storage limits belongs to the corresponding host.

## 4. Validation & Error Matrix

| Input | Required result |
| --- | --- |
| Missing opening/closing YAML delimiter or oversized sections | Throw before YAML interpretation/publication |
| Nonmapping metadata, invalid name/directory mismatch, empty description | Reject |
| Unknown nested field or invalid optional metadata value | Reject rather than silently accepting executable policy |
| Absolute/drive/UNC/backslash, traversal, hidden, control, reserved Windows device segment, trailing dot/space | Reject logical resource name |
| Duplicate/case/Unicode collision or path component that is also a file | Reject whole path set |
| Repeated catalogue installation/name, excessive count/bytes | Reject catalogue |
| Invalid Unicode or invalid/out-of-range page offset/limit | Reject; never split a surrogate pair |

Helpers throw validation errors. They do not persist, fall back to a current
version, repair corrupt manifests or retry host mutations.

## 5. Good / Base / Bad Cases

- Good: a host decodes bounded YAML, validates a `shot-review` folder, offers
  only its name/description and resolves later loads from its captured revision.
- Base: no installed skills produces no catalogue text and requires no skill
  read tools. Existing builtin skills retain their separate identity/policy.
- Bad: a reference path from model output is joined directly to a source folder,
  or `allowed-tools` enables a disabled tool. Logical path validation and
  descriptive metadata cannot authorize either action.

## 6. Tests Required

`packages/agent-core/src/skills.test.ts` exercises the public root with an
independent byte-map host. Assert delimiter/metadata/path and Unicode boundary
failures; deterministic escaped catalogue without private content; body loads
without resource reads; selected resource reads without sibling access; and
explicit scalar pagination. Studio's source lane can map the exact public root
to source. Emitted declaration and offline packed-consumer checks remain separate
evidence at the approved release cadence.

## 7. Wrong vs Correct

Wrong:

```ts
// A content document cannot select authority or supply a complete system prompt.
enableTools(metadata.allowedTools);
systemPrompt += document + allResources.join('\n');
```

Correct:

```ts
const metadata = validateSkillMetadata(decoded, directoryName);
const catalogue = formatSkillCatalogue([{skillId, revision, metadata}]);
// Host-owned explicit read tool later resolves exactly this revision.
// Its result is untrusted workflow guidance, subordinate to existing policy.
```
