# Cordis rc.11 vendor upgrade plan

Status: proposed

## Problem

The upgrade starts from the [vendored](README.md) baselines Cordis core 4.0.0-rc.7, Loader 1.0.0-rc.5, Include 1.0.4, HMR 1.0.15 and Timer 1.1.2, with 24 local-modification entries. [Cordis v4.0.0-rc.11](https://github.com/cordiverse/cordis/releases/tag/v4.0.0-rc.11) incorporates some fixes and replaces other mechanisms. Updating every package and retiring every patch in one change would combine configuration, persistence, lifecycle and module-replacement decisions.

DSH also has consumers that upstream Cordis does not own. Volatile configuration fields are stable references updated without restarting plugins; the settings UI reads their live values. A profile selects ordered plugin bundles and configuration overrides. [DSH HMR](../packages/boot/hmr/README.md) coordinates module replacement and profile changes through `ctx.hmr`. An entry's module namespace is its raw import result, retained before selecting `default` or `apply` so HMR can identify the module already loaded. These consumers must remain usable at every merge point.

## Proposal

Keep source vendoring and stage the upgrade as independently reviewable PRs, each covering a complete concern with its producers and consumers. Upgrade Core with the minimum cross-package compatibility changes, then complete Loader, Include and vendor HMR separately. Retire an existing patch when its replacement is adopted and verified; retain independently applicable patches until their behavior has a replacement. PR 0 records this plan only. It does not approve the open runtime decisions or implement the upgrade.

### Package scope

| Package | Target from the rc.11 tag | Treatment |
|---|---|---|
| `vendor/cordis` | 4.0.0-rc.11 | Upgrade with the Core compatibility slice. |
| `vendor/loader` | 1.0.0-rc.8 | Import required slices first; complete the package after resolution and change reporting land. |
| `vendor/include` | 1.1.1 | Separate patch composition from journal adoption. |
| `vendor/hmr` | 1.1.1 | Upgrade independently of the Include journal. |
| `vendor/timer` | 1.1.4 | Upgrade independently of Core. |
| `vendor/group` | Keep the existing pin | Its entry source matches the tag after rescoping. The Group implementation lives in Loader and still requires migration. |
| `vendor/logger-console` | Keep the existing pin | All three source files match the tag after normalizing scope, relative import extensions and comments. Core's logger changes remain part of the Core upgrade. |
| `vendor/cosmokit`, `vendor/schemastery` | Keep the existing pins | Retain the volatile extensions; their upstream upgrades are outside this plan. |

The comparison above checks the current vendored source against the release tag; it does not assume equal version numbers imply equal code. DSH package versions, exports and build settings remain governed by the repository. A partially synchronized Loader, Include or HMR keeps its old manifest baseline and records the imported upstream slice in the local-modification log. Advance the package baseline only when the complete package has been reconciled, with remaining differences recorded explicitly.

### PR dependencies

The identifiers below are plan labels, not GitHub issue numbers. Preconditions are merge requirements. Independent PRs can be developed and reviewed concurrently; a dependent PR can start against the proposed changes before its predecessors merge, but must validate the actual combined result before merging.

`Vn` below identifies item `n` in the [current local-modification log](README.md#local-modifications), not a PR. **Retire** means the upstream implementation replaces the local difference; **partial** means some behavior still needs a local adaptation; **retain** means the requirement remains; **prepare** does not retire a patch. These are proposed outcomes, confirmed only by the owning PR's tests. Track each item by its subject if later manifest edits renumber the log.

| PR | Scope | Prerequisite PRs | Existing vendor modifications | Required evidence |
|---|---|---|---|---|
| 0 | This plan, package comparison and open decisions. | None | None retired; records the proposed disposition. | Documentation checks; no runtime changes. |
| 1 | Define access to raw config, candidate resolution and the active instance's effective config, and migrate settings, Config Editor, volatile updates and HMR readers together. Initially delegate to the old framework fields. | 0 | Prepare V15 (lazy/raw config) and V22 (volatile); retire neither yet. | Preserve existing objects, validation, settings and volatile behavior. Candidate validation does not replace the active instance's references; introduce no dependency from vendor code to DSH packages. |
| 2 | Add upstream-compatible `hmr.watch()` to both HMR providers with compatible typing, migrate the existing Include to explicit registration, and remove the equivalent Include scans. Use DSH HMR's existing coordination queue. | 0 | Adapt V9's config-path matching to explicit watches; retain its readiness and native-path requirements. | Callback ordering, disposal, explicit paths and `root: []` under the old Core; one Include refresh per change under either provider. Preserve profile watching and both module-replacement algorithms. |
| 3 | Upgrade Timer to 1.1.4, retaining DSH locale resources and build metadata. | 0 | Retain V24 (display metadata); no logged runtime patch retired. | Concurrent interval reads, throttle cancellation and void return types; check callers using the old Core. |
| 4a | Upgrade Core to rc.11 with the minimum Loader, Include and HMR compatibility slice described below. | 1 | Retire V12 (activation observer), V21 (logger disposer) and, after canonical-fiber audits, V20 (Entry identity workaround). Partial V6 (lifecycle) and V15 (config model). Retain/adapt V22 and V23 (module namespace). | Config resolution, volatile identity, service isolation, dependent-before-provider teardown, retained effect regressions and application startup. |
| 4b | Import Loader's project-relative bare-specifier resolver, runtime API detection and fallback when Node internals are absent. | 0 | Retire V19: upstream now detects the internal loader by its available APIs. | Resolve in the config project's package scope, retain subpaths, handle read-only helper creation and test Node 24's older v1 API. |
| 4c | Complete Loader's `EntryChange` / `commit(change)` reporting and remaining changes together with upstream Include's pure patch implementation and journal helper module. Adapt the old writer and in-memory trees; keep `applyEntryPatches` and `entryListSchema` exports. | 4a, 4b | Retire V18 (`disabled` expressions). Partial V11: retire the duplicate patch algorithm and insert-index fix; retain public exports. Retain/adapt V22, including the schema receiver fix, and V23. | Create, move, remove and self-update reports; no false self-disposal writes; later patches address inserted rows; cloning and config dumps agree with mounting. The old Include writer remains active. |
| 4e | Complete vendor HMR's upgrade to 1.1.1, preserving required local path, readiness and explicit-watch behavior. | 2, 3, 4a | Partial V9: adopt upstream ordering and path handling where equivalent; retain explicit readiness and realpath gaps. Retain V1 (no YAML locale imports). | Three-stage module replacement, nested entries, disabled/removed entries, explicit watches and the existing local path cases. |
| 4f | Upgrade Include to its journal implementation, retaining the explicit watch registration already adopted in PR 2. | 2, 4c | Retire V8 (old refresh implementation) and V13 (`writeTask` type). Partial V14: replace the write queue; decide unsaved-error reporting. Retain the remaining V11 exports and V15 child-expression marker. | File/runtime conflict handling, patch-owned writes, shutdown results, nested expressions and one coordinated refresh under either HMR provider. |

Shared integration differences remain in every affected sync: V2 (manifests), V3 (TypeScript projects), V4/V10 (imports and Node-compatible modules), V5 (build overrides), V7 (API documentation), V16 (published Core source) and V17 (scope). Untouched packages retain them without edits. V6 only loses the stale-epoch guard already supplied upstream; its remaining ownership and cleanup guarantees stay. V15 replaces the old raw/effective-config and event implementation, but the Include child-expression behavior remains local. V22 is not upstreamed by this release, including its schema-bound `simplify` call.

After PR 0, PRs 1, 2, 3 and 4b have no implementation dependency on one another. Core depends on configuration preparation; it does not depend on Timer. Loader completion and vendor HMR can proceed independently after Core. Include journal adoption depends on Loader and the complete watch migration, not on the new vendor HMR replacement algorithm; PRs 4e and 4f can merge in either order. No single GitHub stack should impose a dependency between unrelated branches. Shared files such as the vendor manifest may still require merge-conflict resolution.

### Minimum Core compatibility slice

PR 4a must migrate every caller of the changed Core APIs in the same PR, including callers outside vendor. This is a complete Core upgrade with local patches, paired with selected Loader changes; it is not a claim that Loader already equals 1.0.0-rc.8.

- Adopt upstream raw `Fiber.config`, `internal/config(fiber, next)`, `internal/commit` and the new `internal/update` arguments and awaited result. Update the config accessors, provider hooks, boot observers and old Include's update listener together. The temporary commit listener writes through the old tree writer until PR 4c.
- Carry the required Loader entry/context awaiting chain, activation-failure observer and isolation changes with Core's `Impl.ctx`, `Impl.isolate`, `committed` and dependent tracking. Update direct implementation readers such as the preset registry. Include Group behavior owned by `vendor/loader/src/config/group.ts`; do not confuse it with the unchanged `vendor/group` entry package. Before retiring V20, ensure volatile updates and every other direct lifecycle-field access use the canonical `fiber.ctx.fiber`.
- Keep Include's nested-entry expressions literal until the owning child resolves them. Keep the namespace field needed by DSH HMR and preserve active volatile references through the agreed config mechanism. Update raw-config access in both HMR implementations without replacing the DSH module-replacement policy.
- Reapply the still-needed effect ownership, reentrant disposal and observer-containment guarantees to the new Core lifecycle. Remove patches already supplied by the imported Core source. Verify the combination with provider/dependent teardown before treating the compatibility slice as complete.

Module resolution, structured tree-change reporting, journal reconciliation and the new vendor HMR algorithm are not prerequisites for these Core interfaces. Their PRs remain separate unless executable compatibility tests expose an additional dependency; amend this plan before broadening a PR silently.

### Temporary compatibility code

PR 4c changes tree mutation producers to `commit(change)` while the old Include remains installed. That Include can implement `commit(change)` by invoking its existing `write()` operation; it deliberately ignores the detailed change report until the journal replaces the writer. In-memory trees, including `PresetTree`, implement a no-op commit. This avoids maintaining two mutation-reporting protocols in Loader. PR 4f deletes the Include writer adapter and old queue.

PR 4c imports `patch.ts` together with its `journal.ts` helpers and their Loader `EntryChange` dependency, even though Include does not start runtime journaling yet. The public patch export may remain an alias; it must not retain a second algorithm. Every temporary divergence has an owning introduction PR and a named removal PR. No runtime version detection or second Core event protocol is planned.

PR 2 moves Include refresh ownership in one step: both HMR providers expose `watch()`, the existing Include registers its callback, and both providers stop their equivalent Include scans. The upstream HMR source no longer performs that scan, so importing it before migrating the Include consumer would lose config refresh. Moving the complete watch concern first avoids a temporary scan adapter and makes the later module-replacement and persistence decisions independent.

### Decisions owned by individual PRs

| Decision | Owning PR | Proposal and unresolved choice |
|---|---|---|
| Active effective config | 1, 4a | Store or expose the object actually supplied to the current instance. Resolving a candidate through `internal/config` must not overwrite it. Decide the publication point and invalidation rules before switching Core; a WeakMap alone does not establish those rules. |
| Persistence outcome | 4f | Prefer the journal's retry and reconciliation mechanism. Decide how explicit callers observe modifications still unsaved at shutdown. Do not require a historical failure to remain fatal after a successful retry merely because the old test expects it. |
| Nested config interpolation | 4a, 4f | Preserve child-owned expression evaluation. Keep the existing Include marker initially; any refinement that permits interpolation of Include's own fields while excluding child lists is a separate behavior change. |
| HMR replacement failure | 4e | Adopt upstream behavior for vendor HMR. Preserve DSH HMR's current source-reload rollback policy in this series; replacing that policy requires its own proposal and tests. |
| Effect cleanup guarantees | 4a | Retain guarantees not supplied by rc.11. Further upstreaming or retirement is separate work, not a prerequisite for reaching the release baseline. |

## Acceptance criteria

- Every implementation PR leaves supported applications usable and passes checks appropriate to its changes. A later PR may not be required to repair an earlier PR's startup, types, persistence or teardown.
- Each source-vendor update follows the [sync procedure](README.md#sync-procedure), including `pnpm run test` and `pnpm run build`, and updates its own manifest, local-modification log, affected documentation and generated references. The [pre-push workflow](../.agents/skills/dsh-pre-push-checks/SKILL.md) selects additional focused checks. Documentation freshness is not deferred to a final cleanup PR.
- Every changed behavior has an explicit decision and focused regression coverage. Tests for an intentionally superseded behavior change with its implementation and explain the new expectation.
- Once all implementation PRs are complete, Core, Loader, Include, vendor HMR and Timer use their selected rc.11-tag sources with enumerated remaining patches. Group, logger-console, Cosmokit and Schemastery keep their existing pins. All temporary writer and config adapters have been removed or reduced to the agreed permanent accessors.
- Final integration verification exercises settings and volatile updates, profile recomposition, both HMR providers, Include persistence and representative built application launches. This is an acceptance checkpoint, not an otherwise empty PR.

## Risks

PR 4a remains the largest necessary compatibility change: Core's service lifetime and configuration model cross repository package boundaries. The minimum slice is based on source inspection, not a completed migration experiment. Focused tests may identify additional inseparable changes.

Intermediate Loader, Include and HMR copies intentionally combine an old baseline with documented upstream slices. Missing slice records would make a later sync unsafe. Deferred config, candidate validation, journal writes and asynchronous disposal must be tested in combination rather than inferred from independently passing unit cases. A new Include's type dependency on HMR must not force both concrete providers into the same incompatible `Context.hmr` declaration.
