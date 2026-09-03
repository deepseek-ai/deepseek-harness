# Agent Note: Projection-cache cross-version read compatibility (session_projcache v3/v4/v5 → v6)

Status: implemented

English | [中文](2026-09-02-projcache-cross-version-read-compat.zh.md)

## Problem

The `session_projcache` storage domain evolved through three on-disk generations across published releases. An upgraded DSH_HOME failed in two ways:

- **A v3 single-file home bricked startup after the upgrade**: the per-record layout's legacy bootstrap migrated the old whole-unit file without checking its `unit.version`, stamping the old records with the current version into the new tree; the domain layer's per-record zod validation at open then hit the missing now-required fields → `invalid-record` → the whole domain refused to open → the plugin tree failed to load. And because the bootstrap writes before validation runs, **the first boot permanently wrote the bad documents into the new tree** ("poisoning") — every later boot saw a non-empty tree, never took the legacy path again, and the home stayed unusable.
- **A v4 per-record home lost its listing titles after the upgrade**: v4 documents were silently discarded by the version-stamp check (the per-record contract), and SessionList is a zero-I/O cache-only read, so a miss served the row without projections; titles only returned as each session was individually reopened.

The cache domain's own contract is "a stale or unreadable cache costs a longer tail replay, never a wrong value, never a refused load" — the hard failure and the wholesale discard each broke the first half of that contract or the product expectation.

## The three on-disk generations

| domain version | shipped in | layout | on-disk form | identity fields | row fields |
|---|---|---|---|---|---|
| 3 | 0.1.1-rc.2 | single | one file `storages/session_projcache.json` (`{unit:{name,version}, global, tables}`) | `createdAt`, `cwd?` | `ver`, `seq`, `val` |
| 4 | 0.1.2-alpha.3 | per-record | one file per session `storages/session_projcache/sessions/<sessionId>.json` (`{version, record}`) | `createdAt`, `cwd?` | same |
| 5 | 0.1.2-alpha.4 | per-record | same as v4 | + `isSeeded` (shipped required; now optional), `inheritedEventCount` (same) | same (`seq` numbers mean the same as v4; only type brands were added) |

The only substantive v4→v5 difference is the two new lineage identity fields; the `ver/seq/val` row shape is identical across all three generations, and `seq` numbering did not change ([the 2026-08-31 seq/offset brands note](2026-08-31-session-sequence-and-log-offset-brands.md) pins the on-disk numbers as unchanged). v3→v4 was a layout migration with identical record content.

One derived shape also exists: a v3 home that ran the v5 build once (the poisoned state) — its new tree holds documents **stamped 5 whose content is a v3 record** (no lineage fields).

## Decision

Declared read compatibility — reads tolerate vouched-for older versions, writes always stamp the current one:

1. **`DomainSpec.compatibleVersions` (new, optional)**: the domain owner declares "records stored under these older versions are also readable under the current record schemas" (typically by declaring the fields old records lack as optional). `defineDomain` validates each entry as a non-negative integer below the current version; `descriptorOf` projects the set onto the backend `KvUnitDescriptor`.
2. **json backend per-record reads** accept version stamps in "current ∪ compatibleVersions"; anything outside the set is still discarded as foreign. **The write path always stamps the current version** (the first checkpoint after reading an old record naturally advances it). The `single` layout stays exact-version.
3. **Legacy-bootstrap version gate (the actual bug fix)**: the old whole-unit file's `unit.version` must fall inside the accepted set to be migrated; otherwise the file is left alone and the unit reads empty — stamping records the owner never vouched for turns a discardable stale cache into hard schema failures at the domain layer.
4. **The projcache domain declares `version: 6, compatibleVersions: [3, 4, 5]`**, and the two lineage fields become `.optional()`. The single reader of stored identities, `identityMatches`, normalizes absence to the unseeded lineage (`?? false` / `?? 0`): exact for unforked sessions, while a forked session's expectation is seeded → natural mismatch → discard and cold rebuild, so the lineage binding loses none of its protection.
5. **The poisoned state self-heals**: documents stamped 5 without lineage fields are declared compatible and parse under the optional schema (their content is the real pre-upgrade cache data), so the home boots again and titles serve immediately.
6. **Schema-validation backstop: `invalidRecords: 'backup-and-skip'` (declared by this domain only)**. A stored record that still fails to parse beyond read compatibility no longer refuses the whole domain: the domain layer calls the backend's `KvUnit.backupRecord` (json per-record implementation = rename the document to `<key>.json.bak.<YYYYMMDDHHmm>`, bytes kept, never read again), prints the concrete failure with `logger.error` (domain, table, key, destination, zod cause), and continues the open with the record absent; the next cold read rebuilds and rewrites that session's cache. **The policy is an explicit per-domain declaration and the default stays fail-loud** — other domains still refuse the whole load on invalid stored data, and a backend without `backupRecord` (single layout, row stores) also falls back to fail-loud. Naming history: quarantine → backup-and-skip (user ruling: the word must carry both "back up" and "skip", sharing its root with the `.bak` suffix; skip-backup was rejected because the CLI `--skip-X` convention reads it as "do not back up"). For this domain it supersedes the reset/destroy recovery path of the [2026-07-28 storage recovery proposal](../../proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.md), which stays live for authoritative and whole-medium damage.

### v5 → v6 compatibility

Version 6 changes only the current write stamp and keeps the v5 record schema. `compatibleVersions: [3, 4, 5]` therefore admits both healthy v5 records and v5-stamped lineage-less records produced by the faulty bootstrap. The current schema accepts absent lineage; `identityMatches` interprets it as unseeded and rejects the record for a seeded session. The next successful checkpoint rewrites an accepted v5 record with a v6 stamp and complete lineage. No separate v5→v6 rewrite runs at startup: an unaccepted version reads as absent, while a schema-invalid accepted record follows `backup-and-skip`.

### Upgrade matrix

| home shape | behavior after the fix |
|---|---|
| v3 single-file (not poisoned) | bootstrap migrates (3 ∈ accepted set) → titles serve immediately |
| v3 + poisoned new tree | new-tree documents read directly (optional tolerance) → boot restored, titles serve immediately |
| v4 per-record | documents read directly (4 ∈ accepted set) → titles serve immediately |
| v5 healthy | documents read directly (5 ∈ accepted set) → titles serve immediately |
| v6 current | unaffected |
| old records of forked (seeded) sessions | identity mismatch → discarded, cold rebuild when the session opens (safe side) |

## Alternatives considered

- **Discard-and-rebuild only** (bootstrap gate without compatible versions): fixes the boot, but every SessionList title is lost after the upgrade until each session is reopened — fails the upgrade-and-go product requirement.
- **Schema `.default()` fills**: behaviorally equivalent to optional + reader normalization, but bakes the "absent = unseeded" interpretation into the durable schema's output type; ruled for optional — the schema honestly describes every accepted on-disk shape and the interpretation lives at the consumer (user ruling, 2026-09-02).
- **Roll the domain version back to 4**: a small diff, but breaks version monotonicity, depends on the "bootstrap skips no versions" bug itself, and drops every poisoned and healthy v5 home's cache.

## Consequences

- A deployment routing this domain to the sqlite backend gets none of the tolerance: sqlite implements neither `compatibleVersions` nor `backupRecord`, so behavior degrades to the old strict-version semantics (a whole-unit version mismatch still refuses with `version-mismatch`; nothing loosens, nothing serves wrong values). Shipped compositions route this domain to json, so this stays a deployment-configuration risk only.
- The optional lineage fields let accepted records omit lineage: a lineage-less record decodes as unseeded. The identity match still refuses it for seeded callers, and the per-row `ver` guard still screens every value, so the residual exposure is an unseeded caller reading an unseeded-shaped record — the same trust extended to genuine pre-lineage records.
- `backupRecord` overwrites a same-minute backup of the same key (the newer bytes win); distinct minutes and distinct keys never collide.

## Testing

- `storage-json` unit tests: compat-stamped reads / out-of-set discards / writes stamping current; legacy bootstrap migrating only accepted versions (including the migrated-documents-stamp-current assertion); `backupRecord` move / absent read / rewrite / closed guard.
- `storage-domain` unit tests: `compatibleVersions` / `invalidRecords` declaration validation; backup-and-skip falling back to fail-loud when the backend has no `backupRecord`.
- `session-projection-cache` unit tests: records without lineage fields serve unseeded sessions verbatim and are discarded for seeded ones.
- **Archived-fixture recovery tests** (`tests/fixtures.spec.ts` + `tests/fixtures/`): four media archives produced by the real released builds — `v3-single-unit.json` (the 0.1.1-rc.2 whole-unit file), `v4-session-doc.json` (0.1.2-alpha.3), `v5-session-doc.json` (0.1.2-alpha.4), `v5-lineageless-doc.json` (the unguarded bootstrap's poisoned shape, synthesized from the v3 record) — each opened through the real storage stack, asserting the listing serves the archived title and that a live write rewrites the document to the current version (v6 stamp + lineage fields + fresh value); plus the backup-and-skip behavior for a schema-failing record (boot survives, `.bak` lands, log is concrete, neighbor records unharmed).
- End-to-end acceptance, executed against the real release artifacts: the published 0.1.1-rc.2 and 0.1.2-alpha.3 npm builds seeded homes through their own web apps (model turns plus a rename RPC), the published 0.1.2-alpha.4 build reproduced both failures (including the poisoned tree), and the fixed build served every home shape — pristine v3, poisoned v3, v4, and fresh — with the SessionList RPC returning the recorded titles verbatim.

Future bump procedure: when a new version's shape can tolerate old records through "optional fields + reader normalization", add the old version to `compatibleVersions`; otherwise bump normally (discard and rebuild) and remove the no-longer-compatible versions from the set. Either way, the package README requires the bump to land with archived fixtures and tests proving the chosen disposition.
