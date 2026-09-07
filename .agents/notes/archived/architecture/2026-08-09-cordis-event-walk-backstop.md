# Agent Note: An independent Events backstop closes the cordis-surface exhaustiveness gap

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-cordis-event-walk-backstop.zh.md)

## Problem

`gen-cordis-catalog` renders every service and event the Typert host-face projection discovers, and fail-closed page maps (`SERVICE_PAGE`, `EVENT_SCOPE_PAGE`) guarantee each discovered key or scope lands on exactly one `docs/subsystems/` page ([per-subsystem regions decision](../process/2026-07-28-per-subsystem-cordis-surface-regions.md) owns the page-region mechanism). Discovery itself was only backstopped for services: an independent AST scan read every `declare module 'cordis'` Context merge and demanded each declared key be rendered or carry a named `SERVICE_WALK_EXEMPTIONS` reason.

Events had no such backstop. The projection walks only files reachable from host-face package exports, so an `interface Events` merge in client-face code — or in any file the host analyzer cannot reach — vanished with no trace: 12 declared events (`slash/input-*`, `theme/change`, `locale/change`, and the client runtime's `*/changed` invalidation signals) were documented nowhere generated and nothing would ever notice a thirteenth. The services scan also globbed only `packages/*/*/src/*.ts`, so 13 client-face Context keys declared in nested files (`src/client/**`) were invisible to the very scan meant to prevent silent vanishing.

## Decision

Events get the exact mirror of the services backstop, and both scans read the full package source tree.

`scripts/cordis-walk.ts` gains `eventNameList` (every member name of an `interface Events` merge, read from method and property members alike so a shape the projector would reject still enters the scan); the scan yields every `declare module 'cordis'` block in a file (the Typert analyzer reads them all, so stopping at the first would hide a second block's face), and its quote-agnostic prefilter matches the `declare module` heads instead of the literal text `interface Context`, so an Events-only or double-quoted merge file is not skipped. The scan glob in `gen-cordis-catalog` deepens from `packages/*/*/src/*.ts` to `packages/*/*/src/**/*.{ts,tsx}` (two patterns). A third partition direction guards the scan itself: every rendered service key and event name must also be visible to the scan, so a scan regression (glob, prefilter, block walk) is a hard error rather than a silent backstop decay.

A new curated `EVENT_WALK_EXEMPTIONS` map names every declared event the projection cannot see, with the reason and the package README that owns its surface. Keys are full event names, not scopes: client-face events share scopes with rendered host events (`commands/changed` beside the host `commands/*` family), so a scope-level exemption would mask a host-face regression. The partition check is fail-closed in both directions, exactly like the service maps: an unexempted invisible event, an exemption for an event that renders, and an exemption no merge declares are all hard errors.

The partition judgment moved out of `computeOutputs` into the pure `walkPartitionProblems(input, maps)` so every acceptance path is provable by unit test without running the Typert projection; `computeOutputs` feeds it the rendered model plus the independent scan and keeps aggregating page-splice errors as before.

The audit that motivated this found the host face already complete: 48 rendered services + 10 walk exemptions covered all 58 host-visible Context keys, all 49 host events rendered, and every type name in every rendered signature is classified by the existing fail-closed `LINK_MAP`/`FOUNDATION_TYPE_NAMES`/`TYPE_LINK_EXEMPTIONS` check. The 25 findings (12 events, 13 keys) were all client-face; each now carries a named exemption pointing at its owning README, consistent with the existing `uiRenderer`/`connection` precedent.

## Verification

`scripts/gen-cordis-catalog-partition.spec.ts` proves each acceptance path: the green partition, an invisible unexempted event (named with its declaring file), a stale rendered-event exemption, a stale never-declared exemption, the service mirror of each, unmapped rendered surface in both page maps, rendered surface the scan cannot see (the third direction), and the scan reaching nested Events-only merges, every block of a multi-block file, double-quoted heads, and `.tsx` sources. Deleting one live exemption from the real tree makes `gen-cordis-catalog` fail loud with the event's name and declaring file; restoring it returns the generator to a byte-identical no-op regeneration (85 artifacts, 0 written), which also proves the new exemptions exactly cover the scanned surface. `verify-cordis-catalog` in doc-sync executes the partition on every run.

## Alternatives considered

- **Render the client face instead of exempting it.** Analyzing `faces: ['host', 'client']` and giving client services/events generated regions is the real fix for the underlying blind spot, but it changes what the subsystems catalog IS (host-tier reference) and requires page decisions for browser-only surfaces; the existing `TODO(cordis-catalog-interface-services)` already tracks widening the projection. The backstop is the guarantee; rendering is an upgrade behind it.
- **Scope-level event exemptions.** Smaller map, but `commands/changed` (client) shares the `commands` scope with rendered host events, so exempting a scope would swallow a future host-face event silently — the exact failure mode this note removes.
- **Deriving exhaustiveness from Typert instead of a raw AST scan.** The projection and the backstop must fail independently: a Typert reachability bug is precisely what the backstop exists to catch, so the scan deliberately stays a plain `ts.createSourceFile` walk with no shared machinery.
- **Gating the transitive type closure of rendered signatures.** Measured before deciding: every type name reachable in rendered signatures is already classified, and deeper field-of-field types are owned by the pages' hand-curated `type-equiv` pastes and package READMEs; a closure gate would force page homes for internals without a reader-facing need.

## Consequences

A new cordis event — host or client, any file depth — must either render onto a subsystems page or name itself in `EVENT_WALK_EXEMPTIONS` with its documentation owner; deleting one must retire its exemption. The same now holds for Context keys declared anywhere under `src/`. The curated maps grew by 25 client-face entries whose reasons all point at package READMEs, keeping the subsystems catalog a host-tier reference. `walkPartitionProblems` is the single home of the partition judgment; future backstop dimensions (e.g. rendering the client face, schema surfaces) extend it and its spec rather than re-inlining checks into `computeOutputs`.
