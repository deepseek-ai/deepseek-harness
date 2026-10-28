---
description: "Review a DSH page or modal as a whole, explain findings through design principles, and verify supported changes."
---

# Cookbook: review a UI design

English | [中文](reviewing-ui-design.zh.md)

## Summary

Use this cookbook for explicitly requested comprehensive reviews and for evidence steps justified by a change's impact or regression risk. Ordinary development follows the lightweight path in the [UI change workflow](../../.agents/skills/dsh-client-ui-ux/SKILL.md#required-review-loop); it does not execute every section below. The [principles and case reference](../ui-design-review-cases.md) supplies judgment criteria, not a mandatory checklist. Existing tests, GUI PR GIFs and designer/product approval remain governed by their original owners.

Check the complete icon box, including intentional internal whitespace, text columns and gaps before judging the drawn contour. Hit targets are not icon boxes; do not align each glyph’s painted pixels independently. See the [alignment principle](../ui-design-review-cases.md#alignment).

Check associated icons and text against the [same-foreground rule](../../.agents/skills/dsh-client-ui-ux/references/icons.md#placement-and-use), including submenu values with chevrons and search placeholders with magnifiers. Compare rendered color and opacity in both themes; preserve semantic exceptions.

## Table of Contents

- [1. Define the page or modal in scope](#proposition)
- [2. Inspect the task and its implementation](#inspect)
- [3. Preserve the starting point](#baseline)
- [4. Change the smallest responsible component](#implement)
- [5. Verify behavior and comparable images](#verify)
- [6. Deliver the complete evidence](#deliver)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

<a id="proposition"></a>
## 1. Define the page or modal in scope

Identify the user task and affected page or modal. Record scope when several regions, consumers or design choices need coordination; a straightforward local change needs no separate plan. For an explicitly requested comprehensive review, enumerate the requested pages/modals and relevant states. Do not present local inspection as a whole-page result.

Use the [judgment priorities](../ui-design-review-cases.md#judgment) across that scope: alignment and spatial grouping first, then density, hierarchy, states, component choice, icon optics and geometry. Express each finding as an observable relationship, such as content appearing closer to the next group than to its own label. Follow the user’s requested order and authorization; a full review can identify multiple related defects, and permission to implement routine adjustments does not replace the [required designer/product review](../../.agents/skills/dsh-client-ui-ux/SKILL.md#design-review-escalation).

Read the [client UI skill](../../.agents/skills/dsh-client-ui-ux/SKILL.md) and the applicable architecture before editing. Use the [responsive skill](../../.agents/skills/dsh-responsive-ui/SKILL.md) for width and input changes, the [style reference](../web-styling.md) for tokens, and the [radius standard](../ui-radius.md) for corner geometry. This workflow adds review and evidence steps, not another set of visual tokens.

<a id="review-scope"></a>
### Select scope by visual impact

Choose inspection scope from the table below. For broader changes, a few task-note sentences can track affected groups, consumers and risk conditions; use a coverage table only when it helps a multi-region review. Local changes do not need a scene inventory. File count and package boundaries do not determine visual reach.

| Change | Minimum inspection scope |
|---|---|
| Local copy, icon, color or spacing | Read the containing page or modal for context; inspect the owning group, neighboring groups and affected peers sharing its axes or role, including distant peers |
| Page, form or card layout; new page or modal | Review the containing page or modal as a whole, including relevant scrolling and expanded content |
| Shared component | Trace all affected consumers; inspect each distinct layout, content and state variant in its assembled context |
| Global typography, tokens or styling | Map affected component families and page layouts; expand coverage across those families, rather than treating the change as local |
| Behavior without an intended style change | Inspect the states that can change visible relationships, including loading, errors, disabled controls, expansion and focus |

A shared consumer can reuse evidence only when the relevant implementation, size, container constraints, content behavior and states are equivalent; record the grouping and its basis. Inspect uncertain cases directly. Source inspection of all consumers is not a claim to have opened every page. Expand scope when a defect recurs beyond the initial region or a fix changes adjacent relationships. Record unrelated discoveries separately instead of silently starting a product-wide redesign.

Apply the [minimum checks](../../.agents/skills/dsh-client-ui-ux/SKILL.md#minimum-checks-for-affected-ui) to each changed property: color requires both themes; layout, spacing, typography and sizing require constrained and long-content checks; interaction requires the affected path and states. These are inspection requirements, including for local edits, not a demand for a screenshot of every condition. Apply the owning responsive and behavior requirements; do not exhaust unrelated combinations or replace coverage reasoning with a fixed screenshot count. Reuse unchanged rules and valid evidence within the task, and recapture after a coherent batch of edits rather than every CSS adjustment. Read only the relevant principle sections and examples; an uncertain design decision is a reason to retrieve more detail.

<a id="inspect"></a>
## 2. Inspect the task and its implementation

Inspect the affected result at the normal application entry point. Reuse an instance serving the current implementation; do not restart or rebuild solely for each small edit. Follow the relevant task path and use computed styles when needed to distinguish layout defects from content, loading or unfinished animation.

For ordinary changes, a finding needs its location, visible problem, correction and verification. Add source ownership, alternatives and conditions that would invalidate the correction when they affect the decision. Prioritize visible or shared defects; differing source numbers alone do not justify standardization.

When diagnosing spacing, record layout boxes, margins, padding, line boxes and visible glyph edges separately. State whether a close control aligns by its button edge or icon box, and check trigger/menu text insets across their different icon sizes. An annotation of visible whitespace is not a measured CSS margin.

### Reconcile the baseline across the whole interface

Use the [applicable-standards map](../ui-design-review-cases.md#review-baseline) to gather the current radius, material, typography, component, feedback, responsive and artwork rules that apply to this task. Record named exceptions and the relevant existing variants. When a personal or external skill differs, use the repository owner; when implementation differs from the owner, preserve the discrepancy as a finding rather than silently choosing one.

Apply the [whole-page and modal principles](../ui-design-review-cases.md#whole-interface-review) to the selected scope. Keep the whole composition as context and compare affected regions and repeated relationships before using local fixtures for detail. Explicit full reviews cover every region; local corrections must preserve neighboring alignment, grouping, nested corners, clipping and focus.

### Make the relationships explicit

Identify the relevant groups and alignment references. Draw axes or annotate a full-context screenshot only when the relationship is complex, disputed or needs explanation; this is not a prerequisite to reading CSS. The following prompts are optional aids for documenting a review, not fields to fill for every local change.

| Observation | Record | Example |
|---|---|---|
| Task and groups | What each group describes or operates on; its children and neighboring groups | Conversation title / three-action cluster; members section / tasks section |
| Alignment | Objects, axis, and reference container; deliberate exceptions | Baseline-defined peer-row text starts; centered icon-plus-label in the primary button |
| Spacing | Which gaps are internal, repeated, and between groups | Heading is closer to its cards than to the preceding section |
| Peer geometry | Comparable roles and visible size, radius, and color relationships | Equal circular bases; one search-prompt foreground role |
| States | Simultaneous and neighboring combinations | Selected conversation beside another hovered conversation |
| Evidence scope | What is visible and what remains uninspected | Full Desktop sidebar versus an isolated conversation row |

Walk the region in three passes: whole composition, relationships between groups, and details within groups. Use source and computed geometry to explain the visible result afterward. For alignment, compare rendered text starts and slot centers; for spacing, compare visible boundaries as well as CSS boxes. Record CSS pixels separately from screenshot pixels and preserve the zoom/device scale. Do not infer a new design constant from a scaled image.

A useful finding states a violated relationship: “The title-to-action gap is smaller than the gaps inside the action cluster, so the title joins the first action visually; separate the two groups and retest long-title hover.” “Spacing looks off” and “all gaps use tokens” do not explain the judgment. A visible inconsistency can fail the design requirement even when it does not block a task; do not dismiss it as harmless because a click still succeeds.

Before declaring the page or modal reviewed, reconcile its actual regions and relevant states with the inspected evidence. Include content reached by scrolling, expansion or tab changes. A local fixture or example cannot substitute for an uninspected part of that whole. For a limited review, list the remaining scope explicitly.

Use locally maintained production-component fixtures to reproduce controlled states or compare variants. They supplement actual application inspection. Capture/report tools and their scene adapters can live outside the repository and consume the source checkout; they are not required product dependencies or CI acceptance. Read their local instructions for supported scenes and limits.

### Keep a coverage record

Use the following record for an explicitly requested comprehensive review or when several regions need tracking. Ordinary local changes need no coverage table or separate note reproducing every field. Inspect the affected relationships and preserve justified equivalence when grouping shared consumers.

| Page or dialog and entry | Semantic groups and cross-group relationships | Inspected conditions | Finding and owner | Evidence after correction | Uninspected |
|---|---|---|---|---|---|
| Name the actual entry and region | Specify both endpoints and complete boxes or text axes | Content, width, theme, state | Record the rule and responsible component | Comparison and relevant behavior results | State limits rather than an ambiguous covered status |

For complex findings, explain the compared objects, intended relationship, supporting evidence and risky neighboring effects. Include a plausible wrong fix or retest condition when it clarifies the decision; ordinary findings use the short form above. Keep unsupported candidates pending and investigate confirmed repeated problems within the chosen scope, without starting unrelated cleanup.

<a id="baseline"></a>
## 3. Preserve the starting point

Preserve a recoverable starting version and relevant captures when a comparison is requested or needed to assess a broader change or regression risk. Routine local changes do not require an extra source snapshot or before image. When retaining a baseline, include existing uncommitted work rather than assuming `HEAD` represents the visible application, and record the source identity and capture conditions.

When captures are needed, save images and their conditions in `.ui-review/` at the checkout root or another explicitly selected local directory. The repository ignores `.ui-review/` for generated evidence; review tools can remain installed outside the checkout.

Use a scene map for comprehensive reviews or multi-state comparisons that need it; simple changes can be checked directly at the affected position. Include expanded rows, dialogs and relevant loading/disabled states when they affect the claim. A collapsed parent does not cover hidden controls. Use safe fixture data for destructive or unavailable states instead of changing a user's real task just for a screenshot.

<a id="implement"></a>
## 4. Change the smallest responsible component

Fix the owner responsible for the task: the page for page layout, its primitive for a shared control state, or the library for glyph imbalance repeated across consumers. Reuse components and theme aliases, verify affected relationships and preserve independent workspace changes. A development fix need not first become a formal review finding.

Check the states that can conflict with the change: for example selected with hover or keyboard focus, expanded with focus, busy with disabled, and validation with long content. Check the narrow container and the width just on each side of a changed breakpoint. Preserve input drafts, keyboard focus, dismissal, and access to the primary action when layout changes. Follow the [testing policy](../testing.md) for checks that exercise behavior; do not add assertions that merely repeat CSS declarations.

Verify the causal structure first, confirm that styles actually apply, then inspect appearance and behavior. Record complete icon boxes, text starts, painted button edges, and hit-target positions separately where useful; target rectangles cannot stand in for every alignment measurement. Shared-component adjustments include consumers with and without optional descriptions, unequal content, and real neighbors rather than only the report fixture.

When build or hot-reload state is uncertain, create a separate application instance using the intended sources and verify its artifacts to avoid old scripts with new styles. An unchanged DOM snapshot, stale test selector, or failing capture hook cannot establish whether a visual correction passes or fails; identify the failure owner and verify current behavior with relevant tests without capture hooks.

<a id="verify"></a>
## 5. Verify behavior and comparable images

Inspect the affected result and directly affected neighbors in the actual page. If a required scene is unavailable, report the missing check, reason and next verification; labeled production-component fixtures provide partial evidence, not an actual-page pass. Extra screenshots and comparisons are required when requested or needed to explain broad changes or assess regression risk; routine edits need no separate report. This changes recordkeeping, not the minimum inspection or existing GIF rules. For a comparison, match content, theme, locale, viewport, zoom, device scale, interaction state and content anchor; let fonts, data and transitions settle.

When producing a comparison, save final captures separately and pair them with the corresponding starting scene under matching conditions.

For retained comparisons, check dimensions and capture conditions; use scene IDs when there is an inventory. Correct mismatched conditions instead of stretching images, silently changing crops or presenting a reconstructed fixture as an earlier application screenshot. Inspect the delivered images and check that they support the stated scope.

Two captures with the same rendered-source fingerprint demonstrate the capture and reporting workflow, not a UI improvement. An actual before-and-after comparison captures the starting implementation before editing and the resulting implementation afterward. Keep that distinction visible in the delivered report.

Use equal-sized paired crops with the same content origin when a full page hides a small difference; retain enough context to show the relationship being judged. If a content change requires a different crop, disclose it and keep the original full-context captures available. Verify both themes when color, state, or icon balance is involved, and use enlarged views only as a supplement to the intended display size.

<a id="deliver"></a>
## 6. Deliver the complete evidence

An ordinary handoff states what changed, what was checked and any material gap; a short explanation or screenshot can suffice. For a requested detailed case report, place the scene/problem and design judgment beside its image, caption the source and explain what to inspect. Avoid detached screenshot collections or images that do not show the claimed relationship.

When a before/after comparison is part of the deliverable, label both sides and distinguish application captures from isolated component scenes. If the user requests all changes, reconcile that scope with the final diff, including nested controls, and state missing evidence. Do not require a paired report for every ordinary correction.

For comprehensive reviews, distinguish inspected-without-findings, defects and uninspected regions. For ordinary changes, report the result and material gaps without a per-region status ledger. Add rule ownership, wrong-fix examples, exceptions or retest conditions only when useful to explain a finding. Known defects cannot be canceled by unrelated passing checks.

Report the checks actually run and their outcome, and distinguish automated metadata checks, behavior tests, and human visual inspection. Include material limitations such as an unavailable application state or an untested platform. Do not describe the work as fully verified while required scenes or checks remain outstanding.

Use the [UI change workflow](../../.agents/skills/dsh-client-ui-ux/SKILL.md#required-review-loop) at handoff, review and push to check new cumulative effects or invalidated evidence, not to repeat completed inspection. No extra report is required for an unchanged result. Tests and agent inspection do not replace the existing [designer/product approval requirement](../../.agents/skills/dsh-client-ui-ux/SKILL.md#design-review-escalation).

### Comparison delivery and cumulative changes

For a formal comparison report, use before on the left and after on the right. Add non-obscuring annotations only when helpful, on the after image, and retain originals; a removable overlay is useful for interactive reports. Choose a readable narrow-screen presentation rather than requiring a special report interface. Ordinary handoffs may use simple labeled images or concise text; the original GIF requirements remain unchanged.

Deduplicate cumulative summaries by location: pair the earliest reliable before image with the final implementation, retaining comparable conditions. Keep intermediate rounds only as historical evidence, not separate final results; reverted proposals are not current results. List another session's retained changes separately without claiming them. Disclose missing baselines or uncertain ownership. Record actual checks without adding repeated runs as extra coverage.

For an all-changes summary, trace each claim to the cumulative diff, current owner and retained evidence. Separate net changes from behavior already in the baseline; resolve later user revisions before naming final values. Label older captures as historical when they no longer show the current result, and distinguish source-confirmed behavior from a scene inspected again. Feed reusable decisions back to their rule owner and contrasting cases, not local pixel values or an unsupported whole-product pass.

<a id="further-exploration"></a>
## Further Exploration

Use these owners for the details needed by a particular review.

- [UI design principles and review cases](../ui-design-review-cases.md) — whole-page and modal judgment, applicable rules, and explanatory examples.
- [Rule ownership and maintenance](../../.agents/skills/dsh-client-ui-ux/SKILL.md#maintain-one-owner-per-rule) — where to change a principle and how local tools consume it.
- [Web UI style reference](../web-styling.md) — component reuse and styling ownership.

<a id="dev-note"></a>
## Dev Note

None.
