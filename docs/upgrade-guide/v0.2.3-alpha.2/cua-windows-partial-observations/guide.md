---
kind: upgrade-guide
description: "Windows getState returns a marked partial accessibility tree when a descendant disappears during a read."
---

# Windows accessibility reads can return partial trees

English | [中文](guide.zh.md)

## Change

In v0.2.3-alpha.2, Windows `getState` failed with `STALE_SNAPSHOT` if a descendant disappeared during the read. It now returns the rows it could read. If the window’s accessibility root disappears before the helper can read it, the call fails with `STALE_SNAPSHOT`.

Every successful raw Windows `getState` result includes the boolean `hasUnreadableElements`. When it is `true`, `tree` marks a single unreadable element with `[One child could not be read.]` or the unread remainder of a child list with `[Child list incomplete.]`. Neither marker has an element ID. When the read produces no markers, the field is `false`. The separate `truncated` flag reports omissions caused by element or depth limits.

## Migration

1. Preserve `hasUnreadableElements` when forwarding raw results, and display the markers as plain text. If a control could be in a marked branch, read the tree again or use `window.getScreenshot()` before concluding that the control is absent.
2. With `showDiff: true`, a read with unreadable elements returns all observed rows. Replace the displayed tree with those rows. Only a complete read establishes a baseline for later notifications.
3. To verify, follow a marked read with a complete read of the same window using the same options. Check that both responses show their observed trees in full and that the second reports `hasUnreadableElements: false`.
