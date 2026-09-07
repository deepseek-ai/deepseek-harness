# Agent Note: Models-page extension slots

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-models-page-extension-slots.zh.md)

## Problem

Provider sign-in for the pi-ai catalog (GitHub Copilot, OpenAI accounts) is moving out of the product into an optional out-of-tree plugin for provider terms-of-service reasons. The plugin needs its sign-in button and attempt UI inside the Models page's provider cards — the surface where a user meets a provider — but `ui-settings-models` rendered its cards from closed code: the only integration path was editing this package, which an external plugin cannot do, and the page's one open seam (`settings.section`) can only add a whole separate page.

## Decision

`ui-settings-models` declares two SlotMap seats in `src/client/slot-contract.ts`, claims them as `children` of its `settings.section` registration, and re-exports their types from `./client` so an out-of-tree plugin can merge them with a type-only import.

`settings.models.provider-card` is `keyed` with `entryKey = ConfigurableProviderView.settingsNs`: one registration under an adapter family's settings namespace receives every card of that family — shipped catalog routes, adopted directory rows, and hand-declared routes alike — while the section never interprets the key. The key domain stays the open string space (no `keyProps` table) because hand-declared route ids are user-chosen at runtime. The seat dispatches on every card that shows a directory row: a saved row's card, its first-run setup posture, and the add-provider draft (its dormant row, `configured: false` in practice), which is where sign-in matters most — the user has just met the provider and holds no key. The hand-declared draft card has no directory row before saving and dispatches nothing. Owner props carry the row's `ConfigurableProviderView`, its `configured` join, and its confirmed api-key credential state (`keyConfigured`, which the first consumer uses to withhold sign-in beside a stored key); nothing more has a current consumer.

`settings.models.footer` is a `list` seat after the rows and the add controls, for section-level extension content such as orphaned-record management.

Without registrants both seats render nothing, so the shipped page is pixel-identical to before.

## Alternatives considered

**A `list` seat with self-filtering registrants instead of keying.** Every registrant would render (and return null) on every card, and two plugins could silently interleave UI inside one family's cards. Keying by namespace gives one accountable extension owner per adapter family and zero wasted dispatches, and reuses the exact pairing rationale of `settings.plugin.item`.

**Keying by provider route id.** Route ids are dynamic — hand-declared routes are named by users at runtime — so a plugin could not register ahead of the rows it wants and would have to churn registrations as the directory changes.

**A `chain` seat replacing the whole card body.** No current consumer needs to replace the editor; the sign-in surface is additive. A takeover contract would also make the section's layout a compatibility surface. A chain can still be added later without disturbing these seats.

**Keeping the sign-in UI wired inside `ui-settings-models` (the pre-plugin design).** Ships the terms-of-service-sensitive surface in the product, which is the outcome this extension point exists to avoid.

## Consequences

An out-of-tree plugin can now integrate per-family card UI into the Models page with no product edits; `llm-pi-ai-oauth` is the first consumer. The cost is a public contract: `ProviderCardExtrasOwnerProps` exposes `ConfigurableProviderView` at the `./client` boundary, and the dispatch sites (saved card, setup posture, add draft, footer) become behavior extensions rely on. Per adapter family the keyed cell renders one owner at a time: a second registration under the same namespace at the same priority is refused by the registry, while a different priority deliberately shadows it (the lowest-priority entry renders) — the slot kit's standard override channel, never a silent merge.
