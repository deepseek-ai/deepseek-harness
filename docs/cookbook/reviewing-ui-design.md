---
description: "Review a DSH page or modal as a whole, explain findings through design principles, and verify supported changes."
---

# Cookbook: review a UI design

English | [中文](reviewing-ui-design.zh.md)

## Summary

Use this workflow for impact-scoped UI changes and explicitly requested whole-interface reviews. Read the page or modal as context, compare affected relationships across and within groups, then record findings and make authorized changes. The [principles and case reference](../ui-design-review-cases.md) supplies judgment criteria; examples do not define coverage. The [required review loop](../../.agents/skills/dsh-client-ui-ux/SKILL.md#required-review-loop) owns triggers, execution timing and completion criteria.

Check the complete icon box, including intentional internal whitespace, text columns and gaps before judging the drawn contour. Hit targets are not icon boxes; do not align each glyph’s painted pixels independently. See the [alignment principle](../ui-design-review-cases.md#alignment).

For sidebar review, record the current master revision and follow the [sidebar design baseline](../../.agents/skills/dsh-ui-alignment/SKILL.md#sidebar-design-baseline). Capture its relevant roles and states before comparing the working version. Older illustrations and reports cannot establish the current layout or justify restoring superseded geometry.

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

Name the user task and affected page or modal. Select the scope below before editing; routine changes do not default to a product-wide audit. For an explicit full review, enumerate the pages and modals and inspect every region and relevant state within that scope. State local scope and do not present its result as a whole-page conclusion.

Use the [judgment priorities](../ui-design-review-cases.md#judgment) across that scope: alignment and spatial grouping first, then density, hierarchy, states, component choice, icon optics and geometry. Express each finding as an observable relationship, such as content appearing closer to the next group than to its own label. Follow the user’s requested order and authorization; a full review can identify multiple related defects, and existing implementation authorization does not require renewed approval for routine adjustments.

Read the [client UI skill](../../.agents/skills/dsh-client-ui-ux/SKILL.md) and the applicable architecture before editing. Use the [responsive skill](../../.agents/skills/dsh-responsive-ui/SKILL.md) for width and input changes, the [style reference](../web-styling.md) for tokens, and the [radius standard](../ui-radius.md) for corner geometry. This workflow adds review and evidence steps, not another set of visual tokens.

<a id="review-scope"></a>
### Select scope by visual impact

Record the scope in a few task-note sentences before editing: changed position → affected groups and shared axes → consumers and conditions → planned evidence. Use a table only when several pages or variants need tracking. File count and package boundaries do not determine visual reach.

| Change | Minimum inspection scope |
|---|---|
| Local copy, icon, color or spacing | Read the containing page or modal for context; inspect the owning group, neighboring groups and affected peers sharing its axes or role, including distant peers |
| Page, form or card layout; new page or modal | Review the containing page or modal as a whole, including relevant scrolling and expanded content |
| Shared component | Trace all affected consumers; inspect each distinct layout, content and state variant in its assembled context |
| Global typography, tokens or styling | Map affected component families and page layouts; expand coverage across those families, rather than treating the change as local |
| Behavior without an intended style change | Inspect the states that can change visible relationships, including loading, errors, disabled controls, expansion and focus |

A shared consumer can reuse evidence only when the relevant implementation, size, container constraints, content behavior and states are equivalent; record the grouping and its basis. Inspect uncertain cases directly. Source inspection of all consumers is not a claim to have opened every page. Expand scope when a defect recurs beyond the initial region or a fix changes adjacent relationships. Record unrelated discoveries separately instead of silently starting a product-wide redesign.

Choose conditions that challenge the change: long or multiline content for sizing, both themes for color, constrained widths and affected breakpoints for layout, and concurrent states for interaction. Apply the owning responsive and behavior requirements; do not exhaust unrelated combinations or replace coverage reasoning with a fixed screenshot count. Reuse unchanged rules and valid evidence within the task, and recapture after a coherent batch of edits rather than every CSS adjustment. Read only the relevant principle sections and examples; an uncertain design decision is a reason to retrieve more detail.

<a id="inspect"></a>
## 2. Inspect the task and its implementation

Open the actual application at the task's normal entry point. Read in the user's order: page purpose, current content or selection, relevant explanation, primary action, then secondary actions. Identify where alignment, spacing, emphasis, or a control's behavior contradicts that order. Inspect the owning component and its computed styles to distinguish a real layout defect from content, loading, or an unfinished animation.

Write each candidate as a short finding: scene and state, observable effect on the task, source owner, smallest proposed change, and the condition that would make the change inappropriate. Prioritize frequent or shared controls and clearly visible defects. A source search for differing numbers is evidence to inspect, not sufficient reason to standardize them.

### Reconcile the baseline across the whole interface

Use the [applicable-standards map](../ui-design-review-cases.md#review-baseline) to gather the current radius, material, typography, component, feedback, responsive and artwork rules that apply to this task. Record named exceptions and the relevant existing variants. When a personal or external skill differs, use the repository owner; when implementation differs from the owner, preserve the discrepancy as a finding rather than silently choosing one.

Apply the [whole-page and modal principles](../ui-design-review-cases.md#whole-interface-review) to the selected scope. Keep the whole composition as context and compare affected regions and repeated relationships before using local fixtures for detail. Explicit full reviews cover every region; local corrections must preserve neighboring alignment, grouping, nested corners, clipping and focus.

### Make the relationships explicit

Before reading CSS, name the semantic groups and draw their shared axes on a full-context screenshot or a simple diagram. Include repeated elements across component boundaries. Record the following for each region; these are review notes, not a new product configuration file.

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

Use the following record for multi-region reviews; a local change can keep the same facts in a short task note. Do not target a fixed case count. Inspect the selected pages, groups and relationship-changing expansions in context; associate shared-component changes with their affected consumers and any justified equivalent groups.

| Page or dialog and entry | Semantic groups and cross-group relationships | Inspected conditions | Finding and owner | Evidence after correction | Uninspected |
|---|---|---|---|---|---|
| Name the actual entry and region | Specify both endpoints and complete boxes or text axes | Content, width, theme, state | Record the rule and responsible component | Comparison and relevant behavior results | State limits rather than an ambiguous covered status |

Write each finding as observation, compared objects and intended relationship, structural or computed-style evidence, smallest responsible correction, neighboring relationships at risk, and recheck conditions. Keep insufficiently supported candidates pending instead of applying bulk changes; trace confirmed problem classes through actual consumers until repeated occurrences within the declared scope have recorded results.

<a id="baseline"></a>
## 3. Preserve the starting point

Record the starting source and capture the relevant scenes before editing. Existing uncommitted work is part of that starting point: preserve it with a recoverable snapshot or exact file copies, and compare this round against that snapshot rather than assuming `HEAD` represents the visible application. Keep the source version, scene inputs, and capture conditions with the evidence.

Save the baseline captures with their source identity and conditions in a local evidence directory.

Map every intended visible change to a scene before implementing it. Include controls inside expanded rows, dialogs, alternate provider forms, and loading or disabled states when those positions change. One screenshot of a collapsed parent does not cover its hidden controls. Use safe fixture data for destructive or unavailable states instead of saving changes to a user's real task solely to obtain a screenshot.

<a id="implement"></a>
## 4. Change the smallest responsible component

Fix the owner that creates the inconsistency. A page layout belongs to that page; a shared control state belongs to its primitive; a glyph’s optical viewport belongs to the icon library when the imbalance follows it across consumers. Reuse existing components and theme aliases. Keep each correction tied to a finding from the whole-interface review, recheck affected relationships, and preserve independent workspace changes.

Check the states that can conflict with the change: for example selected with hover or keyboard focus, expanded with focus, busy with disabled, and validation with long content. Check the narrow container and the width just on each side of a changed breakpoint. Preserve input drafts, keyboard focus, dismissal, and access to the primary action when layout changes. Follow the [testing policy](../testing.md) for checks that exercise behavior; do not add assertions that merely repeat CSS declarations.

Verify the causal structure first, confirm that styles actually apply, then inspect appearance and behavior. Record complete icon boxes, text starts, painted button edges, and hit-target positions separately where useful; target rectangles cannot stand in for every alignment measurement. Shared-component adjustments include consumers with and without optional descriptions, unequal content, and real neighbors rather than only the report fixture.

When build or hot-reload state is uncertain, create a separate application instance using the intended sources and verify its artifacts to avoid old scripts with new styles. An unchanged DOM snapshot, stale test selector, or failing capture hook cannot establish whether a visual correction passes or fails; identify the failure owner and verify current behavior with relevant tests without capture hooks.

<a id="verify"></a>
## 5. Verify behavior and comparable images

Verify the result in the actual application where reachable. Supplement it with production-component fixtures for precise or hard-to-reach states, clearly labeling that source. Use the same content, theme, locale, viewport, zoom, device scale, interaction state, and content anchor for each comparison. Let fonts, data, and transitions settle; a static capture mode may suppress motion in the fixture, but must retain the intended final state.

Save final captures in a separate directory and pair them by scene identity and matching conditions.

Check matching capture IDs, dimensions and conditions against the declared scene inventory. Resolve mismatches by correcting the scene or capture conditions. Do not stretch an image, silently change its crop, or present a reconstructed fixture as an earlier application screenshot. A comparison report proves neither complete change coverage nor visual quality: reconcile the expected scenes with the final changes and inspect every image yourself.

Two captures with the same rendered-source fingerprint demonstrate the capture and reporting workflow, not a UI improvement. An actual before-and-after comparison captures the starting implementation before editing and the resulting implementation afterward. Keep that distinction visible in the delivered report.

Use equal-sized paired crops with the same content origin when a full page hides a small difference; retain enough context to show the relationship being judged. If a content change requires a different crop, disclose it and keep the original full-context captures available. Verify both themes when color, state, or icon balance is involved, and use enlarged views only as a supplement to the intended display size.

<a id="deliver"></a>
## 6. Deliver the complete evidence

Present each case as scene and problem, design judgment, then its screenshot or paired comparison immediately below. Add a caption naming what to inspect, what each side means, and the source. Do not collect unrelated cases into a detached screenshot wall. If the difference is only faintly visible or the image omits the relationship, choose stronger evidence instead of presenting it as a design exemplar.

Present each proposition with a concise explanation and its before-and-after pairs, before on the left and after on the right, linked to the originals. Identify actual application captures and isolated production-component scenes separately. If the user requests all changes, reconcile the final diff against the scene map and cover every changed visible position, including nested controls; state any missing evidence explicitly.

For each reviewed region, report one of: no visible defect found in the stated conditions, a defect with evidence, or not inspected. A finding includes the compared objects, applicable rule owner, intended relation, visible difference, correction, plausible wrong fix, retest condition, and any justified exception. Do not average away a known alignment/grouping failure with unrelated passing checks or infer an overall pass from representative glyphs.

Report the checks actually run and their outcome, and distinguish automated metadata checks, behavior tests, and human visual inspection. Include material limitations such as an unavailable application state or an untested platform. Do not describe the work as fully verified while required scenes or checks remain outstanding.

Before handoff, apply the [completion criteria](../../.agents/skills/dsh-client-ui-ux/SKILL.md#required-review-loop) to the final diff and retained evidence. A concise result with scope, comparison and relevant checks suffices for a local change; a large report is not required. Before PR or push, check cumulative interactions and evidence validity, and rerun only invalidated or missing checks. This is an agent review obligation, not automatic visual approval by CI. Human review for consequential design decisions follows the [escalation rule](../../.agents/skills/dsh-client-ui-ux/SKILL.md#design-review-escalation); explicitly requested or periodic human audits supplement daily checks.

### Comparison delivery and cumulative changes

Keep before on the left and after on the right; use horizontal browsing on narrow screens rather than splitting a pair vertically. Mark regions with a few boxes, shared axes with dashed lines, and locations with arrows only on the after side; annotations must not obscure the text or icons under inspection. Keep annotations as a removable overlay and retain untouched original captures. Explain the relationship before its comparison; retain both endpoints for cross-group findings, supplementing with detail crops and complete pages when needed. Recheck a general report tool’s default presentation against this section; successful generation does not establish left/right layout or after-side annotation compliance.

Deduplicate cumulative summaries by location: pair the earliest reliable before image with the final implementation, retaining comparable conditions. Keep intermediate rounds only as historical evidence, not separate final results; reverted proposals are not current results. List another session's retained changes separately without claiming them. Disclose missing baselines or uncertain ownership. Record actual checks without adding repeated runs as extra coverage.

<a id="further-exploration"></a>
## Further Exploration

Use these owners for the details needed by a particular review.

- [UI design principles and review cases](../ui-design-review-cases.md) — whole-page and modal judgment, applicable rules, and explanatory examples.
- [Rule ownership and maintenance](../../.agents/skills/dsh-client-ui-ux/SKILL.md#maintain-one-owner-per-rule) — where to change a principle and how local tools consume it.
- [Web UI style reference](../web-styling.md) — component reuse and styling ownership.

<a id="dev-note"></a>
## Dev Note

None.
