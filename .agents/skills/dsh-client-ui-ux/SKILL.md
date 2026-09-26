---
name: dsh-client-ui-ux
description: Design and review DeepSeek Harness client UI changes — visual token discipline, reuse-before-adding, feedback surfaces (toast vs in-place notice vs empty state), overlay and menu safety, platform window adaptation, loading states, and error copy placement. Use when adding or changing product-user-visible GUI behavior in packages/client, or when reviewing such a PR.
---

# DeepSeek Harness Client UI/UX

This skill is guidance, not a complete checklist. It covers judgment calls that lint, typecheck, and the i18n gate cannot make: where feedback appears, what gets reused, and how surfaces behave at window edges and across platforms. Copy quality itself follows [dsh-prose-standard](../dsh-prose-standard/SKILL.md); locale ownership follows the [locale-owned copy decision](../../notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md); styling ownership and token rules live in [docs/web-styling.md](../../../docs/web-styling.md) and the [ui-primitives component catalog](../../../packages/client/ui-primitives/README.md#component-catalog) — this skill adds judgment on top of those rules, not a second copy of them.

## Visual foundation

- **Use existing tokens for color, radius, and spacing.** Before introducing a literal value, search the target page and its nearest established sibling (the Plugins page is the usual reference for full-page surfaces) for the token or value already in use, and adopt it. The same applies to whole treatments — toasts, menus, in-message artifact previews, sidebar tab layout, colors, clearance rules, page padding: reuse the established component or rule wherever one exists instead of inventing a parallel one.
- **Verify every color in both light and dark mode.** An ink/background pair must stay readable under both themes before it ships. Dimmed tones are the standing counter-example: they suit decorative surfaces, but on text they routinely fall below readability in one theme — never put a dimmed color on text without checking both.
- **Font weight tops out at 500 in feature CSS you add or change.** Do not use 600+ for emphasis; differentiate with size or ink instead. The markdown typography tokens owned by ui-theme are the standing exception.
- **Pick font sizes from the theme typography variables when an existing role matches, otherwise from the page's existing scale.** Parallel content shares one size; never invent a size for a single element, and keep the number of distinct sizes on a page small (13px is the established row/detail size). When the page itself has no precedent, borrow the size and spacing ratios of the most similar existing page or element.
- **Icons, text, and neighbouring elements stay proportionate and aligned.** Every element lines up with its siblings along a deliberate axis (baseline, vertical center, or shared edge), and an icon's size stays in proportion to the text beside it; never ship an element that aligns to nothing or visibly outweighs its neighbours.

## Reuse before adding

- **Extend an existing component, container, or interaction before creating a new one.** A new capability that fits an existing surface (an extra menu item, a new prop on an existing primitive) beats a parallel element stacked beside it.
- **Icons come from the existing icon library.** Pick the semantically closest existing icon; a new glyph requires designer approval before it lands — when reviewing a PR that adds one, suggest requesting a designer review.
- **Right-sidebar content registers a slot in the existing sidebar**, never a separate sidebar. Every sidebar tab declares a tab icon matching its meaning.
- **Icon-only actions whose meaning is not obvious get a Tooltip.** Informational content the pointer must rest on or select uses HoverCard instead. Prefer these shared primitives over ad-hoc title attributes.

## Feedback surfaces

Choose the surface by the lifetime of the message relative to the surface that produced it:

- **Transient operation outcomes use the app-wide Toast primitive**, not in-place notices, and the toast's state and rendering live in a host that outlives the reporting surface (a `shell.overlay` entry, as RowActionToast does) — a toast rendered by the panel itself unmounts with that panel. A deletion can close the panel or tab that requested it; only a toast held outside that surface survives the close. Report success and failure; do not report still-pending states.
- **A failed operation keeps the data visible.** A failed deletion keeps its row; the toast announces the failure. Never blank content to show an error for a transient operation.
- **In-place notices are for states tied to the surface itself**: a query failure with its Retry action, field validation on the form that owns the field. A populated panel keeps a compact notice beside its retained content; only an empty panel centers a full error state.
- **Error copy is plain language, and short.** No internal jargon or technical nouns unless an error code must be exposed for debugging. Prefer one clear sentence; anything explainable in two sentences must not grow into paragraphs. A Chinese notice of at most two sentences omits the trailing 句号（。）. The notice must not break the existing layout — reserve its space or overlay it; never shift neighbouring elements.

## Loading states

- Lists use their skeleton; every other page-level load centers a bare spinner. Never place a spinner in a corner of the page.
- One loading treatment per page/component — concurrent regions must not each flash their own style.
- No loading text unless the context needs it (narrow sidebars almost never do).

## Overlays and menus

Every menu, popover, and tooltip must be verified for all three before merge:

- **Dismissable**: outside click (and Escape where focusable) closes it.
- **Viewport-fitting**: it slides or flips to stay inside the window with an edge margin, and flips only into a side that actually fits (no oscillation when neither side fits).
- **Unclipped**: it escapes `overflow` ancestors and containing blocks (portal to body where needed) and is never covered by neighbouring elements.

Scrollbars stay inside their container: use the shared scrollbar styles rather than component-specific selectors, and verify the bar neither overflows the container nor gets clipped by its rounded corners or edges — keep a small inset instead of letting it sit flush against the container edge.

## Platform window adaptation

- Any new header element or full page must account for macOS and Windows window chrome. On macOS the titlebar clearance is `--dsh-frame-top-clearance`, consumed by Menu, Modal, and overlay primitives as their top safe margin — **never change the global variable to fix one page**. Add a scoped `[data-platform='darwin']` override on the page's own inset instead, and assert the override in the page's stylesheet spec.
- State the intended total offset (clearance + page inset) when reviewing, so two pages aligning to "the same top spacing" agree on the sum, not just one addend.

## Spacing review

- Review every changed region for gaps: nothing sits flush against its neighbour without an intentional gap, and adjacent icons and elements keep the region's established spacing.
- Prefer symmetry for parallel elements; an unexplained one-off gap or offset usually signals a missed shared value.

## Design review escalation

- A PR with extensive UI changes, or any clearly user-perceivable change to UI or interaction, must get a designer or product review. When no approver holds that role, suggest requesting one from the design/product reviewers (roster as of 2026-09: yx zhang, yifffan, zhangziya, gaokaige; update this list here when membership changes).
