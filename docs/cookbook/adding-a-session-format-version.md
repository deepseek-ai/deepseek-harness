# Cookbook: adding a Session log format version

English | [中文](adding-a-session-format-version.zh.md)

## Summary

Use this tutorial to introduce the next structural Session log version without rewriting released data. Read the [version and release-status authority](../session-format-status.md) to identify the checkout writer and the latest released format. Let N denote that verified released format and N+1 the target; substitute numeric values for these placeholders in names and metadata. Start with a working contributor checkout and read the [package checklist](adding-a-package.md), [format library](../../packages/session/session-format/README.md), and [released-format decision](../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md).

## Table of Contents

- [1. Choose the version and release base](#choose-the-version)
- [2. Add an identity edge](#add-an-identity-edge)
- [3. Implement per-artifact stages and validation](#stages-and-validation)
- [4. Update current-version consumers](#current-version-consumers)
- [5. Create snapshot successors](#snapshot-successors)
- [6. Validate the integrated result](#validate)
- [Dev Note](#dev-note)

<a id="choose-the-version"></a>
## 1. Choose the version and release base

Bump the format for a structural change to headers, event envelopes, core event semantics, or surface reconstruction. Ordinary event additions do not require a bump; follow the [versioning rule](../../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md). Distinguish the Session format integer from package release versions, SQLite schema versions, projection-unit versions, and protocol-wrapper versions.

Use a shared `release/*` integration base for N+1. The base change adds the writer, codec, catalog wiring, identity migration, and verification. Create each independent child branch from that base and target its PR at the release branch, not another independent child’s branch. Each child adds its structural transformation, validators, consumers, and tests to the same adjacent migration package. Do not allocate extra versions just to represent review order. Merge reviewed children into the release branch through PRs, then validate the combined result before release. Honor release-branch force-push and deletion protections; do not force-sync it.

Released codecs and migration semantics remain frozen. Do not amend a released edge to implement a new structural feature. Only the N→N+1 edge may incorporate coordinated changes before N+1 ships; after release, further structural changes need the next adjacent edge.

Use disposable, isolated Harness homes for unreleased N+1 integration testing. An interim N+1 file already has the target writer version, so a later edit to N→N+1 will not migrate that file again. Re-run from unchanged historical input in a fresh test home; never repair this by rewriting a committed generation or reusing a real user's home.

Before changing the writer, use the [archive command](../persistence-changes/historical-formats/README.md#maintenance) to preserve its complete persistence schema, then add the bilingual format reference under `docs/persistence-changes/historical-formats/vN.*`. Preserve all earlier records. The format coverage check requires every integer below the new writer to have its own document; the current generated catalog covers only the new writer.

<a id="add-an-identity-edge"></a>
## 2. Add an identity edge

Follow the package checklist to create a library for N→N+1, not a mounted plugin. An identity body conversion is only an initial wiring scaffold. The [V2-to-V3 specification](../../packages/session/session-format-v2-to-v3/README.md#v2-to-v3-specification) is a fixed example of explicit transformations and preservation rules, not an edge to extend or treat as an identity conversion.

Declare `dsh.sessionFormatMigration` with numeric `from: N` and `to: N+1`, an export path, and the exported migration, source codec, target codec, target-header validator, and target restorer. Reuse the source codec exported by the preceding edge package and depend on that package; do not copy or redefine a released codec. Export the target codec and validators from the new package. Add the edge as a direct dependency of the catalog and add the workspace’s TypeScript paths and project references.

Set `SESSION_FORMAT_VERSION` in [core Session types](../../packages/core/session/src/types.ts) to N+1 alongside the new edge declarations, then generate the catalog. The command below generates only the declared chain; it does not implement a new version:

```sh
pnpm run gen-session-format-catalog
```

The [generator](../../scripts/gen-session-format-catalog.ts) requires exactly one adjacent package for every step from zero to the writer version, matching directory/package names, matching adjacent codec exports, and declared dependencies. It rejects gaps, duplicate or extra edges, unknown metadata members, and a catalog that does not share Session through peer plus development dependencies. Fix the declarations rather than hand-editing `generated.ts`. The catalog is build-static; plugin mounting must not determine historical readability.

<a id="stages-and-validation"></a>
## 3. Implement per-artifact stages and validation

Use the [Stage interfaces](../../packages/session/session-format/src/types.ts), not a whole-artifact array-to-array migrator. An immutable `SessionFormatMigration` declaration supplies `migrateHeader`, `validateTargetHeader`, and `createStage`. Every call to `createStage` creates independent state for one source artifact. Keep counters, pending events, and reference maps there; never share a mutable stage across Sessions.

Implement `transformEvent(event, context)`, `transformRun(run, context)`, and `finish(context)`. Emit synchronously through `context.emitEvent` or `context.emitRun`; a call can produce zero, one, or many outputs. Let a stage consume codec-owned compact runs directly, or iterate `run.expand()` without materializing an intermediate array. The caller owns scheduling, and the chain finishes upstream stages before downstream stages.

Treat the inherited cut as a logical event count, not a physical row count. Expose `headerInheritedEventCount` only when it is known before EOF; `finish` returns the exact target cut. A preceding cardinality-changing edge can make that count unavailable at construction. Derive it from validated seed markers when required, and test seeded multi-hop restoration from each supported historical generation through N+1, not just direct N input. Never substitute zero for an unknown cut.

Define the new edge's event admission and transformation rules explicitly. The [V2-to-V3 source audit](../../packages/session/session-format-v2-to-v3/README.md#source-audit) and [alpha V0→V1 rule](../../.agents/notes/implemented/architecture/2026-08-31-alpha-historical-unknown-event-refusal.md) own the policies of those released edges, not the new edge. Do not generalize either to every edge. A change to structure or event positions requires classifying source events, payload members, and references, and explicitly deciding whether opaque data can remain valid. [Equal-version retention](../../.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md) alone does not prove a structural transformation safe. Validate target semantics and give each newly accepted case a rejecting counterexample; never widen older edges to hide an unsupported transformation.

Prove strict restoration through `sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`, feeding rows in order and calling `finish()`. This exercises physical decoding, the complete chain, and installed current Session validation. Production's recoverable/transformed policy is not a replacement for strict fixture and publication verification. Preserve documented historical validation exceptions rather than claiming stricter source validation than the edge actually performs.

<a id="current-version-consumers"></a>
## 4. Update current-version consumers

Trace each current-version consumer, including Session creation/restoration, JSONL filename selection and publication, the catalog's current encoder/restorer, projection-cache generation identity, replay and snapshot normalization, and TypeScript/Python SDK recordings. Use the writer constant where a value means current; keep literal historical versions in released codecs and historical fixtures. Update current documentation and generated references through their owners.

Do not bump unrelated versions automatically. A request wrapper's `sessionFormatVersion` identifies its embedded Session generation; its outer schema version has its own meaning. Projection-unit state versions likewise do not replace the cache's Session-generation identity.

Verify both read and write paths. Header-only listing must not read bodies or publish. Historical read open may return the migrated in-memory artifact without writing; write open must verify and publish only the final current successor before append. The source path, bytes, and inode stay unchanged. A newer or invalid selected generation must not cause fallback to a predecessor. The [preparation decision](../../.agents/notes/implemented/architecture/2026-09-05-read-only-session-migration-preparation.md) owns publication timing.

<a id="snapshot-successors"></a>
## 5. Create snapshot successors

Read [snapshot ownership](../../snapshots/AGENTS.md) and the [snapshot library](../../packages/test-support/session-snapshot/README.md). Select the owning scenario, not an adapter that only references it. After implementing N+1, keep each historical file and generate its successor using the target version’s canonical parent and child filenames. Never rename a predecessor to the target filename or change only its header.

For unchanged replay input, use keyless refresh on the owner, then replay without write-back. These SDK commands use `text-turn` and the checkout's writer version. Implement and wire N+1 before using them to generate that version, and select the actual affected owner for a feature:

```sh
pnpm run test:snapshot:refresh snapshots/sdk/sdk.snapshot.ts -t text-turn
pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t text-turn
```

Review the new generation, request sidecars, and protocol output together. Verify every predecessor remains byte-identical and that parent/child roles remain contiguous. Selection uses the numerically highest generation, so update shared references to the owner's selected parent. Do not use the packed-layout migrator as a version upgrader. If the model transcript must change, the scenario owner uses live recording under the [testing policy](../testing.md), with its required provider key.

Keep deliberate historical cases explicit through `snapshot.yml`'s `sessionFormat.version` and supported `coverage` names; record and refresh leave their Session fixtures untouched. Update the [corpus policy](../../scripts/session-snapshot-corpus-policy.ts) for the current generation while retaining focused direct-edge, multi-hop, packed-row, retry/failure, and shipped-profile coverage. Check the corpus and both SDK projections; do not mass-refresh unrelated scenarios merely to silence a validation failure.

<a id="validate"></a>
## 6. Validate the integrated result

Run from the repository root. These commands check catalog declarations, Stage composition, the released V2→V3 edge, and generation selection. They are a baseline; add focused coverage for the new edge:

```sh
pnpm run verify-session-format-catalog
pnpm exec vitest run scripts/gen-session-format-catalog.spec.ts packages/session/session-format/tests packages/session/session-format-v2-to-v3/tests packages/session/session-format-catalog/tests
pnpm run test:snapshot scripts/session-snapshot-corpus.corpus.ts
```

After implementing the new edge, add its actual test path to the focused Vitest run. Add the changed JSONL, replay, projection, and SDK tests selected by the actual diff, plus the built publication-Worker smoke when that path changes. Require successful strict migration, identity preservation for the skeleton, malformed and unknown-required-event refusal, deterministic repeated restores, independent concurrent stage state, seeded multi-hop cuts, unchanged predecessors, and no fallback. Report exact commands and failures, not an inferred full-suite result.

Update the [owning Agent Note](../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) rather than adding a redundant decision record. Keep the [release record](../session-format-status.md#updating-the-record) unchanged until publication; after publication, update it with verified release evidence. Audit related active notes for supersession; retain independent rationale and leave archived notes frozen. Update bilingual prose together, re-record each changed pair with the repository tool, then run documentation checks:

```sh
pnpm run verify-translation-pairing --write docs/cookbook/adding-a-session-format-version.md
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
git diff --check
```

<a id="dev-note"></a>
## Dev Note

None.
