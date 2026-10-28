---
name: dsh-client-ui-ux
description: Use before implementing any DSH user-visible UI change and during UI review, including layout, copy, icons, styling and interaction states in client, experimental and app packages. Select applicable rules before coding and verify the affected rendered relationships before handoff.
---

# DeepSeek Harness UI development

Use this entry before changing UI. It owns execution timing, scope and completion; the owners below supply decisions. Apply the guidance to the user task, not as an exhaustive checklist. Existing repository rules and named exceptions govern values; cases explain judgment and do not define coverage.

## Required review loop

Layout, copy, icons, styling and interaction changes trigger this loop without a separate review request. Behavior-only edits include affected loading, error, disabled, expanded and focus states. Documentation-only changes and refactors with evidence of unchanged rendering do not need new captures; state that basis.

1. **Before coding, make the design decisions.** Name the user task, affected page or modal, semantic groups, shared alignment references and intended group separation. Select existing components and variants, read applicable owners below, and identify relevant states and consumers using the [impact scope](../../../docs/cookbook/reviewing-ui-design.md#review-scope). Record these choices and planned evidence in a few task-note sentences. Preserve starting source and images; uncommitted UI is not represented by `HEAD`. New UI can use a sketch and established sibling as its starting reference; label them honestly.
2. **Implement using those decisions.** Reuse the selected components and existing values. Check group structure and shared axes before optical detail. For sidebar work, apply the [master design baseline](../dsh-ui-alignment/SKILL.md#sidebar-design-baseline), including its deliberate differences between roles and states. Expand scope when a shared consumer, neighbor or state can change. Batch coherent edits before recapturing; do not run a full-product audit for each CSS change.
3. **Before completion, inspect the final rendered result.** Verify affected relationships and behavior in the assembled page or modal, retain comparable before/after evidence for changed positions, and run relevant repository checks. Distinguish inspected, equivalent-by-evidence, unresolved and uninspected scope. Missing required scenes, unresolved defects or failing checks prevent a complete-validation claim; state the gap and next verification.
4. **Before PR or push, reconcile the cumulative diff.** Check overlapping edits and missing coverage. Reuse evidence while source, dependencies, content, states and capture conditions remain valid; rerun only invalidated or missing checks. Deliver scope, decisions, evidence, results and material gaps.

Keep the record in the task or local artifacts, not a new tracked checklist per edit. Load applicable owners once while unchanged; retrieve examples only for uncertain decisions. Choose conditions by risk, not every width × theme × state combination or a fixed screenshot count. The [review cookbook](../../../docs/cookbook/reviewing-ui-design.md) owns detailed evidence procedures. Tool success does not judge visual quality.

## Select the rule owners

For layout and grouping changes, read alignment and spacing directly before positioning elements. For other changes, read their applicable owners and preserve existing relationships. Each row has one responsibility; do not copy numeric scales between them.

| Decision needed before implementation | Owner |
|---|---|
| Shared axes, text starts, centering, tree indentation, complete icon boxes | [Alignment](../dsh-ui-alignment/SKILL.md) |
| Semantic groups, inner/outer gaps, repeated rhythm, section separation | [Spacing and grouping](../dsh-ui-spacing/SKILL.md) |
| Interface icon selection, drawing, supplied-artwork normalization, style, optical weight, icon/label color | [Icons](../dsh-ui-icons/SKILL.md) |
| Color, typography and existing treatments | [Visual foundation](references/visual-foundation.md); [Web styling](../../../docs/web-styling.md) owns tokens/materials |
| Radius tiers, nested/flush/independent corners and exceptions | [Radius standard](../../../docs/ui-radius.md) |
| Feedback lifetime, loading, overlays, scrolling and platform clearance | [Interaction and feedback](references/interaction.md); [error handling](../dsh-error-handling/SKILL.md) owns failure guarantees |
| Space allocation, truncation, input capabilities and retained focus | [Responsive UI](../dsh-responsive-ui/SKILL.md) |
| Official plugin artwork and feature previews | [Official artwork](../dsh-official-plugin-artwork/SKILL.md) |
| Copy, locale ownership and component semantics | [Prose standard](../dsh-prose-standard/SKILL.md), [locale ownership](../../notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md), [primitives catalog](../../../packages/client/ui-primitives/README.md#component-catalog) |
| Density, information hierarchy, combined control states and component choice | [Principle reference](../../../docs/ui-design-review-cases.md#density) sections 3–6 |

## Reuse before adding

Extend the existing component, container or interaction when the new capability fits it. An extra menu item or primitive prop usually belongs in that owner. Right-sidebar content registers in the existing sidebar. Reuse existing icons first; follow the [icon owner](../dsh-ui-icons/SKILL.md#reuse-existing-icons-first) to decide when a new drawing or normalization is needed.

Before restructuring components, read [client instructions](../../../packages/client/AGENTS.md) and [client defensive patterns](../../../docs/defensive-patterns/client-components.md) for slots, props, state flow, effects and layering.

## Check the rules together

Inspect the whole composition for context, then the affected cross-group and internal relationships, including distant peers and relevant expanded content. Match both endpoints of each shared axis. Compare complete icon boxes before optical adjustment; keep group separation clear. Geometry must preserve popup and focus visibility; spacing must retain field feedback; narrow layouts must retain actions and drafts. Inspect theme material and platform backdrop where affected. Full-interface claims require all their regions; a fixture or crop establishes only what it renders.

## Maintain one owner per rule

Update the existing owner when a principle changes. Add a focused skill only when it makes a distinct implementation decision; otherwise extend an existing section or reference. Add one routing row here only for a new responsibility. Keep examples in the [case reference](../../../docs/ui-design-review-cases.md), linking to the owner instead of copying its rules. AGENTS files and PR workflows link to this loop and do not repeat its checklist.

For a rule change, state applicability, decision, exceptions and observable verification in its owner; add or update a case that distinguishes a valid result from a plausible wrong fix. Search other owners for superseded statements. Declare whether existing consumers are being migrated or only future edits must comply. Rule edits do not establish that existing UI already conforms. Add a deterministic gate only for a mechanically decidable invariant; rendered judgment remains part of the development loop. Local review tools read these repository owners and retain the reviewed source and rule revisions; they do not maintain a second standards copy.

## Design review escalation

Obtain designer or product review before landing new pages or interaction patterns, broad shared-component or global visual changes, and unresolved design tradeoffs. Routine local corrections use this loop without another human checkpoint. Explicit independent reviews and periodic human audits can widen scope and feed recurring misses into owning rules; neither replaces development-time decisions or creates an automatic schedule.
