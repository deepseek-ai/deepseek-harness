# Agent Note: Projection-cache predecessor recovery and Session-format binding (session_projcache v3-v6 → v7)

Status: implemented

English | [中文](2026-09-02-projcache-cross-version-read-compat.zh.md)

## Problem

The `session_projcache` storage domain evolved through several on-disk generations. An upgraded DSH_HOME exposed three risks:

- **A v3 single-file home bricked startup after the upgrade**: the per-record layout's legacy bootstrap migrated the old whole-unit file without checking its `unit.version`, stamping the old records with the current version into the new tree; the domain layer's per-record zod validation at open then hit the missing now-required fields → `invalid-record` → the whole domain refused to open → the plugin tree failed to load. And because the bootstrap writes before validation runs, **the first boot permanently wrote the bad documents into the new tree** ("poisoning") — every later boot saw a non-empty tree, never took the legacy path again, and the home stayed unusable.
- **A v4 per-record home lost its listing titles after the upgrade**: v4 documents were silently discarded by the version-stamp check (the per-record contract), and SessionList is a zero-I/O cache-only read, so a miss served the row without projections; titles only returned as each session was individually reopened.
- **A Session-format bump could reuse a fold produced under older event semantics**: versions 3 through 6 did not record the Session format generation. Treating an absent generation as current would let a cache row bypass bounded historical normalization or a cardinality-changing migration.

The cache domain's own contract is "a stale or unreadable cache costs a longer tail replay, never a wrong value, never a refused load" — the hard failure and the wholesale discard each broke the first half of that contract or the product expectation.

## The on-disk generations

| domain version | shipped in | layout | on-disk form | identity fields | row fields |
|---|---|---|---|---|---|
| 3 | 0.1.1-rc.2 | single | one file `storages/session_projcache.json` (`{unit:{name,version}, global, tables}`) | `createdAt`, `cwd?` | `ver`, `seq`, `val` |
| 4 | 0.1.2-alpha.3 | per-record | one file per session `storages/session_projcache/sessions/<sessionId>.json` (`{version, record}`) | `createdAt`, `cwd?` | same |
| 5 | 0.1.2-alpha.4 | per-record | same as v4 | + `isSeeded` (shipped required; now optional), `inheritedEventCount` (same) | same (`seq` numbers mean the same as v4; only type brands were added) |
| 6 | pre-v1 mainline | per-record | same as v5 | same as v5 | same |
| 7 | current | per-record | same as v5 | + `formatVersion`; current writes also require both lineage fields | same |

The only substantive v4→v5 difference is the two lineage identity fields; v6 changed only the write stamp. The `ver/seq/val` row representation is identical across these predecessor generations, and `seq` numbering did not change ([the 2026-08-31 seq/offset brands note](2026-08-31-session-sequence-and-log-offset-brands.md) pins the on-disk numbers as unchanged). v3→v4 was a layout migration with identical record content. Version 7 adds the Session format generation to the cache identity because row semantics cannot be inferred from the domain stamp.

One derived shape also exists: a v3 home that ran the v5 build once (the poisoned state) — its new tree holds documents **stamped 5 whose content is a v3 record** (no lineage fields).

## Decision

Declared read compatibility — reads tolerate vouched-for older versions, writes always stamp the current one:

1. **`DomainSpec.compatibleVersions` (new, optional)**: the domain owner declares "records stored under these older versions are also readable under the current record schemas" (typically by declaring the fields old records lack as optional). `defineDomain` validates each entry as a non-negative integer below the current version; `descriptorOf` projects the set onto the backend `KvUnitDescriptor`.
2. **json backend per-record reads** accept version stamps in "current ∪ compatibleVersions"; anything outside the set is still discarded as foreign. **The write path always stamps the current version** (the first checkpoint after reading an old record naturally advances it). The `single` layout stays exact-version.
3. **Legacy-bootstrap version gate (the actual bug fix)**: the old whole-unit file's `unit.version` must fall inside the accepted set to be migrated; otherwise the file is left alone and the unit reads empty — stamping records the owner never vouched for turns a discardable stale cache into hard schema failures at the domain layer.
4. **The projcache domain declares `version: 7, compatibleVersions: [3, 4, 5, 6]`**, and the format and lineage identity fields are optional in the stored schema so vouched-for predecessor records can open. Current writes always include all three fields.
5. **Identity matching is stricter than structural admission**: an absent `formatVersion` never matches a current Session, so predecessor rows cannot seed a projection and refold from the authoritative log. Once the format matches, `identityMatches` normalizes absent lineage to unseeded (`?? false` / `?? 0`): exact for an unseeded session, while a seeded expectation fails the match. Poisoned v5 homes therefore boot safely, but their unbound rows are not exposed as current values.
6. **Schema-validation backstop: `invalidRecords: 'backup-and-skip'` (declared by this domain only)**. A stored record that still fails to parse beyond read compatibility no longer refuses the whole domain: the domain layer calls the backend's `KvUnit.backupRecord` (json per-record implementation = rename the document to `<key>.json.bak.<YYYYMMDDHHmm>`, bytes kept, never read again), prints the concrete failure with `logger.error` (domain, table, key, destination, zod cause), and continues the open with the record absent; the next cold read rebuilds and rewrites that session's cache. **The policy is an explicit per-domain declaration and the default stays fail-loud** — other domains still refuse the whole load on invalid stored data, and a backend without `backupRecord` (single layout, row stores) also falls back to fail-loud. Naming history: quarantine → backup-and-skip (user ruling: the word must carry both "back up" and "skip", sharing its root with the `.bak` suffix; skip-backup was rejected because the CLI `--skip-X` convention reads it as "do not back up"). For this domain it supersedes the reset/destroy recovery path of the [2026-07-28 storage recovery proposal](../../proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.md), which stays live for authoritative and whole-medium damage.

7. **A predecessor title is a listing hint, not a fold shortcut**: Session-list startup remains metadata/cache-only and never opens cold log bodies. The log header is authoritative; a lifecycle-matching checkpoint is a durable-prefix witness that may lag but cannot lead the log. `cachedPredecessorTitle` therefore exposes only a predecessor `title` row that still passes the current title unit's `stateVersion` and schema. Both adjacent Session-format edges preserve title text. The hint uses `asOfSeq: -1` rather than the stored row sequence because a cardinality-changing log migration can remap that coordinate. Other predecessor rows remain hidden, and `hydratePrepared`/`coldSnapshot` retain strict format identity, because normalizers can change values such as `blank` or `lastPromptAt` even when storage is physically consistent.

### v3-v6 → v7 disposition

Versions 3 through 6 remain structurally readable because their record and row representations are valid inputs to the current schema. Their identities lack `formatVersion`, so they are deliberately unusable as current fold shortcuts. An unseeded, lifecycle-matching record may still provide its version-compatible title to zero-I/O listing; it cannot provide any authoritative seed. A cold read or live checkpoint rebuilds the values from the migrated Session log and writes a v7 record with the complete format and lineage identity. No eager value migration runs at startup; a schema-invalid accepted record follows `backup-and-skip`.

### Upgrade matrix

| home shape | behavior after the fix |
|---|---|
| v3 single-file (not poisoned) | bootstrap migrates (3 ∈ accepted set) → boot succeeds; compatible title is list-visible, unbound fold waits for cold rebuild |
| v3 + poisoned new tree | new-tree documents parse under optional fields → boot restored; compatible title is list-visible, unbound fold waits for cold rebuild |
| v4/v5/v6 per-record | documents read structurally → missing format generation rejects the fold shortcut; compatible title is list-visible; current checkpoint rewrites v7 |
| v7 current with matching identity | cached values serve normally |
| matching-format record without lineage | unseeded caller may use it; seeded caller rejects it and refolds cold |

## Alternatives considered

- **Reject predecessor stamps in the storage layer**: safe for projections, but prevents the guarded legacy bootstrap and loses the ability to retain a structurally sound record until an authoritative refold replaces it. Structural admission plus semantic identity rejection keeps the boot recoverable without serving an unproven value.
- **Treat a missing format generation as current for every use**: preserves cached values, but lets a pre-migration fold bypass the Session-format edge. Rejected because v0→v1 includes bounded historical normalizers and later edges may change event cardinality. The title-only listing hint is narrower: it does not seed a fold, and title text is invariant across the installed edges.
- **Schema `.default()` fills**: behaviorally equivalent to optional + reader normalization, but bakes the "absent = unseeded" interpretation into the durable schema's output type; ruled for optional — the schema honestly describes every accepted on-disk shape and the interpretation lives at the consumer (user ruling, 2026-09-02).
- **Roll the domain version back to 4**: a small diff, but breaks version monotonicity, depends on the "bootstrap skips no versions" bug itself, and drops every poisoned and healthy v5 home's cache.

## Consequences

- A deployment routing this domain to the sqlite backend gets none of the tolerance: sqlite implements neither `compatibleVersions` nor `backupRecord`, so behavior degrades to the old strict-version semantics (a whole-unit version mismatch still refuses with `version-mismatch`; nothing loosens, nothing serves wrong values). Shipped compositions route this domain to json, so this stays a deployment-configuration risk only.
- The optional format field lets predecessor records pass structural validation, but absence always fails current identity matching. Optional lineage is normalized only after the format matches; a seeded caller still refuses a lineage-less record. The per-row `ver` guard continues to screen every served value.
- `backupRecord` overwrites a same-minute backup of the same key (the newer bytes win); distinct minutes and distinct keys never collide.

## Testing

- `storage-json` unit tests: compat-stamped reads / out-of-set discards / writes stamping current; legacy bootstrap migrating only accepted versions (including the migrated-documents-stamp-current assertion); `backupRecord` move / absent read / rewrite / closed guard.
- `storage-domain` unit tests: `compatibleVersions` / `invalidRecords` declaration validation; backup-and-skip falling back to fail-loud when the backend has no `backupRecord`.
- `session-projection-cache` unit tests: a matching format with absent lineage serves only an unseeded Session; a predecessor record without a format generation cannot seed a fold but may serve only its compatible title hint.
- **Archived-fixture recovery tests** (`tests/fixtures.spec.ts` + `tests/fixtures/`): four media archives produced by the real released builds — `v3-single-unit.json` (the 0.1.1-rc.2 whole-unit file), `v4-session-doc.json` (0.1.2-alpha.3), `v5-session-doc.json` (0.1.2-alpha.4), `v5-lineageless-doc.json` (the unguarded bootstrap's poisoned form, synthesized from the v3 record) — each opens through the real storage stack, serves only its compatible predecessor title, never serves its unbound fold, then accepts a live write that replaces it with a v7 record carrying the complete identity and fresh value. The same suite proves backup-and-skip for a schema-failing record: boot survives, `.bak` lands, diagnostics name the failure, and a neighboring predecessor record remains rewritable.

Future bump procedure: add an older domain version to `compatibleVersions` only when the current stored schema can parse it, and let the owning reader decide whether its semantic identity is sufficient. A Session-format change never inherits an absent format generation. The package README requires every bump to land with archived fixtures and tests proving structural admission, semantic use or rejection, and current rewrite.
