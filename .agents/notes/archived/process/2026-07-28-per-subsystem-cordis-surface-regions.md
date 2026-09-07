# Agent Note: Per-subsystem generated cordis-surface regions

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-per-subsystem-cordis-surface-regions.zh.md)

## Problem

One subsystem's documentation was split across three homes: its hand-written subsystems page (introduction, data structures, verbs), its `ctx.<key>` slice of the flat generated `docs/cordis-catalog/services.md`, and its event scope's slice of the flat `docs/cordis-catalog/events.md`. A reader of shell.md had to open two more documents to see the service interface and events the page was describing, and nothing tied the three views together beyond hand-maintained links. The flat catalogs also sat outside the bilingual corpus (excluded from pairing because generated output is English-only), so the reference surface had no Chinese route at all.

The [generated-catalog decision](../../archived/process/2026-06-20-generated-cordis-catalog.md) — generate from source, `@mode` tags cross-checked, fail-closed type-link coverage, the `ts cordis-catalog` fence — is not in question; what changed is WHERE the generated output lands.

## Decision

`gen-cordis-catalog.ts` injects each subsystem's service and event reference INTO its own page, between `<!-- BEGIN GENERATED cordis-surface … -->` / `<!-- END GENERATED cordis-surface -->` markers, and the flat services/events catalogs are deleted. One page per subsystem now carries introduction, data structures, and the generated wiring surface.

- **Curated fail-loud partition.** `SERVICE_PAGE` maps every discovered `ctx.<key>` to exactly one page; `EVENT_SCOPE_PAGE` maps every event scope. The generator hard-errors in both directions — an unmapped discovered service/scope, and a mapped key/scope the walk no longer discovers — so the partition cannot drift from the source surface. Independent AST scans of every `declare module 'cordis'` merge block under `packages/*/*/src/**` backstop the projection's blind spots for services AND events: a declared Context key or Events member the projection cannot render must carry a named `SERVICE_WALK_EXEMPTIONS`/`EVENT_WALK_EXEMPTIONS` reason, stale exemptions hard-error, and everything rendered must also be visible to the scan ([events-backstop decision](../architecture/2026-08-09-cordis-event-walk-backstop.md) owns the scan contract); a `TODO(cordis-catalog-interface-services)` marks teaching the projection to render the interface-typed entries.
- **Byte-identical regions across the pair.** The generator writes the SAME English region bytes into `foo.md` and `foo.zh.md`, extending the existing rule that verbatim code fences match across a pair. `verify-translation-pairing` gained a dedicated region-identity check (`partitionGeneratedRegions` in `translation-pairing.ts` owns the marker grammar) that names a divergent or malformed region precisely; the whole-document structural signature still covers the region content a second time.
- **Guarded pair auto-record.** A regeneration that changes region bytes would leave every touched pair out-of-sync, so the generator re-records a pair's `.i18n.yaml` itself — but ONLY when the write is region-confined: both sides' recorded blob hashes must match the pre-write bytes, and the region-STRIPPED content must be unchanged on both sides. Human-prose drift leaves the record stale so the pairing gate still forces the normal translation flow; a brand-new pair is never auto-recorded (the author's reviewed `--write` owns that). This keeps `.i18n.yaml` as plain `git hash-object` values — no stripped-hash semantics change.
- **The inherited tier moved, not died.** The vendor `ctx` members and `internal/*`/loader/hmr/timer events render to `docs/cordis-api/inherited.md`, next to the relocated Cordis core API pages (`docs/cordis-catalog/core/` → `docs/cordis-api/`). Framework surface lives under a framework home; the harness pages stay repository-owned vocabulary.
- **In-page links.** Signature `Types:` lines link sibling pages (`core.md`, `shell.md`); a type whose primary page is the rendering page is dropped from the line instead of self-linking. Pages reference their own region with `#cordis-surface` or a `#ctx<key>--<class>` anchor — every generated heading is preceded by an explicit `<a id>` carrying the GitHub slug (the historical flat-catalog anchor), so the fragments resolve identically on GitHub and the VitePress site, whose own slugger treats the punctuation-heavy headings differently.

## Alternatives considered

- **Keep the flat catalogs alongside the regions, both generated** — rejected: every JSDoc edit would produce double diff noise, and the scattering (one subsystem, three documents) this change exists to remove would survive.
- **Generator-owned whole pages with hand-written intros in fragment files** — rejected: the narrative prose is the majority of every existing page and belongs in the reviewed document itself; markers cost one grammar rule and keep authors editing the real file.
- **Localized regions (generator emits Chinese too)** — deferred, same status as the i18n README's long-standing note for the remaining generated docs: teaching the generator zh output means translating source JSDoc, which is machinery this change does not need. English regions inside zh pages match the existing status quo of English JSDoc inside verbatim fences.
- **Hashing region-stripped content in `.i18n.yaml`** — rejected: the record would stop being `git hash-object` of the file, breaking the recover-last-confirmed-text property and every consumer that recomputes hashes.

## Consequences

- A subsystem's whole story is one page: `docs/subsystems/<name>.md` (and its pair) carries introduction, data structures/verbs, and the generated service/event surface; `docs/cordis-catalog/` no longer exists.
- A new service or event scope cannot ship undocumented or unmapped: the generator fails until `SERVICE_PAGE`/`EVENT_SCOPE_PAGE` names its owning page, and the page must already exist with markers in both language sides.
- Regeneration after a source-JSDoc change touches the affected pages in both languages plus (when region-confined) their pair records — a mechanical, reviewable diff; prose edits keep demanding the translation flow because the auto-record guard refuses them.
- The website's subsystem nav lists every page (38 routes per locale: 35 translated pairs plus the three still-English-mirrored goal/terminal/commands), replacing the two flat catalog nav entries; the Cordis API section gained `inherited.md`.
- `packages/typert/generator/tests/cordis-catalog-contract.spec.ts` pins the region renderer (`renderPageRegion`), the same-page link-drop rule, and the fail-loud JSDoc/type-link validation; `scripts/translation-pairing.spec.ts` pins the marker grammar and blob-hash primitive; `scripts/gen-cordis-catalog-record.spec.ts` proves the auto-record guard refuses every invalid state (stale record, malformed or renamed-key sidecar, extra entries, prose drift, missing record, missing snapshot).
