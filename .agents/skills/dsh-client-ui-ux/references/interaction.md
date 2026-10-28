# Interaction and feedback

## Feedback surfaces

Apply [dsh-error-handling](../../dsh-error-handling/SKILL.md#localized-actionable-visible-reports) to failure reports. Choose the surface by the lifetime of the message relative to the surface that produced it:

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
