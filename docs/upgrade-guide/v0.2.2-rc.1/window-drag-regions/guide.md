---
kind: upgrade-guide
description: "Custom Client overlays that relied on global macOS no-drag exclusions must declare their window regions."
---

# Explicit window regions for custom Client overlays

English | [中文](guide.zh.md)

## Change

After upgrading from 0.2.2-rc.1, macOS Desktop automatically excludes interactive controls only inside `data-window-drag` rows or `data-window-drag-controls` scopes. Previously, matching controls and ARIA roles anywhere in the application received `no-drag`. Custom Client plugins that relied on that rule for content covering a draggable header must now declare an exclusion. Ordinary scrollable content without an explicit region declaration contributes no region, so content clipped above its viewport no longer blocks header dragging.

This affects custom overlays outside those scopes that cover a drag row. Controls already inside a marked row, overlays using shared primitives with their own exclusions, and components with explicit `no-drag` declarations need no migration. The rule applies only to macOS Desktop; plain Web and Windows behavior is unchanged.

## Migration

1. Inspect the JSX and CSS Modules of custom Client overlays that can cover a header. Check whether their interactive content relied on the previous automatic exclusion.
2. For an interactive viewport without nested drag rows, put `data-window-drag-exclude` on its visible viewport element. This excludes the viewport's own rectangle and keeps clipped descendants out of the region calculation. For a container whose controls need separate exclusions, put `data-window-drag-controls` on their containing element. Overlays and containers with nested drag rows must declare their regions separately; follow the [window-region rules](../../../../packages/client/web/README.md#understand-the-implementation).
3. Keep exclusions on visible owners rather than every focusable descendant. Use a shared `Modal` or `MenuSurface` for the corresponding overlay, or explicitly exclude the custom overlay's visible box. A body portal with no layout box needs an exclusion on its visible content.
4. Load the updated plugin in macOS Desktop. Open the overlay over a header and confirm its controls act without dragging the window. Close it and confirm the header's blank area still drags; scroll the plugin's content out of view and confirm that clipped content does not block the header.
