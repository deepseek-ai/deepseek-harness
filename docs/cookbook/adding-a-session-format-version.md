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
- [Developer V4 corpus trial](#v4-corpus-trial)
- [Dev Note](#dev-note)

<a id="choose-the-version"></a>
## 1. Choose the version and release base

Bump the format for a structural change to headers, event envelopes, core event semantics, or surface reconstruction. Backward-compatible changes can remain at the current version through new acknowledgements; follow the [versioning rule](../../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md) and [type-change rules](../persistence-changes/README.md#compatibility-rules). Distinguish the Session format integer from package release versions, SQLite schema versions, projection-unit versions, and protocol-wrapper versions.

Let N be the accepted or published version in [version/status](../session-format-status.md) when planning the next breaking change. A breaking change after accepted V4 therefore needs V5 even before V4 publication is recorded; compatible additions do not require that step.

Use a shared `release/*` integration base for N+1. The base change adds the writer, codec, catalog wiring, identity migration, and verification. Create each independent child branch from that base and target its PR at the release branch, not another independent child’s branch. Each child adds its structural transformation, validators, consumers, and tests to the same adjacent migration package. Do not allocate extra versions just to represent review order. Merge reviewed children into the release branch through PRs, then validate the combined result before release. Honor release-branch force-push and deletion protections; do not force-sync it.

Released codecs and accepted target-format meanings remain stable. The N→N+1 converter may receive fixes or support additional historical cases after N+1 ships, without a version bump, if its output remains compatible with N+1. A converter fix affects subsequent conversions, not existing N+1 successors. Document changes to previously accepted mappings and how existing outputs remain supported. Changing the established target representation or interpretation incompatibly requires the next version.

Use disposable, isolated Harness homes while N+1 remains open for integration. An interim N+1 file already has the target writer version, so a later edit to N→N+1 will not migrate that file again. Re-run from unchanged historical input in a fresh test home; never repair this by rewriting a committed generation or reusing a real user's home.

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

Use native writer output as the conversion oracle: replay the same recorded LLM messages, tool outputs, and other inputs through the old and target writers. Compare migrated old output with raw target output before any format-normalizing helper; mask only documented volatile fields. For V4, ordinary tool results become flat tool-role messages with ordinary content blocks. A theoretically permitted old structure alone does not justify a new core content type.

Alpha converters may explicitly refuse historical cases without an implemented, evidenced mapping, including otherwise valid logs. Keep the source unchanged and publish no partial successor. Prefer real corpora and reproducible writers when extending support; inspect user corpora read-only and create sanitized regression fixtures.

Document only the identifier and field mappings needed by the target format in the edge README, with a reason for each. Do not add namespaces to direct source kinds or ordinary metadata solely because they are extensible. Preserve opaque nested data. Alpha converters may refuse unexpected source fields that would acquire new target meanings rather than invent an interpretation.

Maintain the new edge's README as its single complete transformation and admission catalog, following the [V2-to-V3 specification](../../packages/session/session-format-v2-to-v3/README.md#v2-to-v3-specification). Enumerate every converted header, event, message slot, and payload field; exact rename or collision rules; preserved ids, coordinates, references, and inherited cuts; external prerequisites; refusal and opaque-data policies; and unsupported or deferred behavior. Separate historical source conversion from native target admission, and state which codec, restorer, installed validator, and recovery policy performs each check. Record any validation that is deliberately narrower than the declared schema. Update this catalog in the same change as its code; a generated schema inventory or PR description does not replace it.

Prove strict restoration through `sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`, feeding rows in order and calling `finish()`. This exercises physical decoding, the complete chain, and installed current Session validation. Production's recoverable/transformed policy is not a replacement for strict fixture and publication verification. Preserve documented historical validation exceptions rather than claiming stricter source validation than the edge actually performs.

<a id="current-version-consumers"></a>
## 4. Update current-version consumers

Trace each current-version consumer, including Session creation/restoration, JSONL filename selection and publication, the catalog's current encoder/restorer, projection-cache generation identity, replay and snapshot normalization, [physical fixture-layout validation](../../scripts/session-fixture-layout.ts), and TypeScript/Python SDK recordings. Use the writer constant where a value means current; keep literal historical versions in released codecs and historical fixtures. Update current documentation and generated references through their owners.

Do not bump unrelated versions automatically. A request wrapper's `sessionFormatVersion` identifies its embedded Session generation; its outer schema version has its own meaning. Projection-unit state versions likewise do not replace the cache's Session-generation identity.

Verify both read and write paths. Header-only listing must not read bodies or publish. Historical read open may return the migrated in-memory artifact without writing; write open must verify and publish only the final current successor before append. The source path, bytes, and inode stay unchanged. A newer or invalid selected generation must not cause fallback to a predecessor. The [preparation decision](../../.agents/notes/implemented/architecture/2026-09-05-read-only-session-migration-preparation.md) owns publication timing.

<a id="snapshot-successors"></a>
## 5. Create snapshot successors

Read [snapshot ownership](../../snapshots/AGENTS.md) and the [snapshot library](../../packages/test-support/session-snapshot/README.md). The [corpus policy](../../scripts/session-snapshot-corpus-policy.ts) keeps its declared baseline as replay input so upgrades exercise the adjacent chain; a writer bump does not require refreshing that corpus. Select the owning scenario when a current-generation successor is needed, keep each historical file, and use the target version’s canonical parent and child filenames. Never rename a predecessor to the target filename or change only its header.

For unchanged replay input, use keyless refresh on the owner, then replay without write-back. These SDK commands use `text-turn` and the checkout's writer version. Implement and wire N+1 before using them to generate that version, and select the actual affected owner for a feature:

```sh
pnpm run test:snapshot:refresh snapshots/sdk/sdk.snapshot.ts -t text-turn
pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t text-turn
```

Review the new generation, request sidecars, and protocol output together. Verify every predecessor remains byte-identical and that parent/child roles remain contiguous. Selection uses the numerically highest generation, so update shared references to the owner's selected parent. Do not use the packed-layout migrator as a version upgrader. If the model transcript must change, the scenario owner uses live recording under the [testing policy](../testing.md), with its required provider key.

Keep cases older than the retained baseline explicit through `snapshot.yml`'s `sessionFormat.version` and supported `coverage` names; record and refresh leave pinned Session fixtures untouched. Update the [corpus policy](../../scripts/session-snapshot-corpus-policy.ts) for the current generation while retaining focused direct-edge, multi-hop, packed-row, retry/failure, and shipped-profile coverage. Check the corpus and both SDK projections; do not mass-refresh unrelated scenarios merely to silence a validation failure.

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

<a id="v4-corpus-trial"></a>
### Developer V4 corpus trial

Use the one-time [migration script](../../scripts/migrate-sessions-to-v4.ts) from an installed contributor checkout whose writer is V4. Stop DSH processes using the target root before starting so writer locks and changing child logs do not prevent migration. Run from the repository root:

```sh
pnpm run migrate:sessions-to-v4
```

The default root is `~/.dsh/sessions`. Use `--sessions-dir /path/to/sessions-copy` for another corpus, or `--help` for usage. Concurrent jobs default to the available CPU count capped at 16; `--jobs N` accepts any positive safe integer, including larger expert overrides, and `--jobs 1` runs serially. A bounded queue opens only that many Sessions at once, regardless of corpus size. Each historical Session goes through the normal locked, validated publication path to create a V4 successor beside its unchanged source files. Existing V4 Sessions are opened read-only; rerunning does not reconvert them. The script makes no model requests and does not change conversion or refusal rules.

The terminal reports each Session's selected file, version, progress, outcome, and elapsed time. Individual errors do not stop later Sessions. The final summary lists every failure and the full diagnostic log under the system temporary directory; any failure returns a nonzero exit status. It also prints JSON and saves the same report as `summary.json` beside `migration.log`: counts by source version and outcome, grouped failure reasons, per-input diagnostics, runtime details, and both report paths. Known diagnostics expose event types, unexpected members, child-log involvement, and sequence numbers; unrecognized errors retain their messages without inferred causes. Include these reports when reporting a migration problem. Sessions converted during this run remain distinct from those already at V4.

Concurrent conversion can invalidate a parent’s child evidence when the child publishes V4. Only that source-change error receives one sequential retry after all initial jobs finish; corruption, unsupported formats, and held locks are reported immediately. Completion lines keep the original input index and a separate completed count, so out-of-order results remain readable.

<a id="final-v3-vocabulary"></a>
### Final V3 event vocabulary before V4 publication

While the published format remains V3 and the integration writer is V4, master can still add valid V3 event types. After each master integration and before the first V4 publication, compare the migration-owned `RELEASED_V3_EVENT_TYPES` with the latest V3-writer commit used by that refresh. Capture its full immutable id while the locally verified `origin/master` still writes V3:

```sh
V3_SOURCE_REF="$(git rev-parse --verify 'origin/master^{commit}')"
pnpm run verify-v3-event-vocabulary --source-ref "$V3_SOURCE_REF"
```

The verifier reads only that local commit and requires exact event-name equality. It rejects missing V3 names, extra copied names, and a source writer other than V3. In particular, V4-only `developer/message` must not enter the frozen V3 set. Review each difference against the V3 payload, required conversions, target admission, and consumers; adding the name alone does not establish a complete migration. Add the corresponding migration regression before accepting a new source event.

This command does not fetch or establish remote freshness. The release operator must verify that the selected commit is the latest V3 writer included in the integration; an old remote-tracking ref or passing result for an older pin is insufficient. Record the checked id with release validation. If master already writes V4, reuse the recorded final V3 commit rather than resolving current master. After V4 ships, keep the V3 vocabulary tied to that historical source; later V4 event additions do not update it. Regular static CI has no dependency on a mutable master ref.

<a id="dev-note"></a>
## Dev Note

None.
