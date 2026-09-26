# Agent Note: Desktop close shortcuts follow page focus

Status: implemented

English | [中文](2026-09-21-desktop-page-close-shortcuts.zh.md)

## Problem

The [shortcut PRD](https://trtgsjkv6r.feishu.cn/wiki/APvtwgbztiBLzvk9DM4cQbccnhf) gives the close command two targets: the focused right-sidebar page, or the Desktop window when no page can close. Electron's native close role bypasses the page owner. On Windows, closing the last window also quits the Desktop instance and stops its Host tasks, so this fallback is a lifecycle choice rather than a menu-label change.

## Decision

The sidebar page owner resolves close against live focus and captures the target's Session, pane, tab occurrence, and navigation revision. It closes that page through its resource cleanup handler, or collapses the sole docked guide. Stale sidebar targets do not fall back to another page or the window. Without a closeable page, Desktop requests native window closure; Web has no window fallback.

The macOS File menu routes Close Page or Window through the same owner and displays the accepted single-key binding. Native closure requires the current configuration revision, a focused and enabled product window, and inactive shortcut recording. The existing window lifecycle applies without a shortcut-specific confirmation: macOS keeps the application alive after its last window closes; Windows and Linux quit and stop the Host.

This decision owns File-menu and close behavior in place of the close-role choice in [the standard macOS menu note](../bug-fix/2026-09-16-desktop-window-menus.md). That note retains the rationale for native Window and application hide commands. [Shortcut preference persistence](2026-09-20-device-local-shortcut-preferences.md) owns accepted bindings and revision publication.

## Alternatives considered

**Use Electron's native close role.** It closes the window without asking the focused page owner and cannot preserve page cleanup or the accepted custom binding's routing.

**Disable the Windows window fallback.** This avoids a task-stopping close shortcut but omits the PRD's explicit Desktop fallback. The product keeps native window-close semantics; users who need the application to remain running can minimize it.

## Consequences

Close behaves consistently across the shortcut and macOS File menu. On Windows and Linux, pressing it outside a closeable sidebar page can stop active tasks by quitting the instance. The command does not add a background Host lifetime or a task-aware shutdown confirmation. Desktop keyboard tests cover revision and focus guards; sidebar focus tests cover captured page identity and stale targets; startup tests cover the platform menu declarations.
