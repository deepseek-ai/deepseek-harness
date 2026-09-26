# Agent Note: Desktop standard macOS window menus

Status: implemented

English | [中文](2026-09-16-desktop-window-menus.zh.md)

## Problem

The Desktop shell replaces Electron's default application menu with a custom template that listed only the application and Edit menus. Electron builds only the roles a template declares, so macOS lost the File and Window menus and the application hide commands the default template supplies, including Close Window (⌘W), Minimize (⌘M), and Hide (⌘H). None of those shortcuts did anything in the Desktop application while every comparable macOS application responds to them (issue #4374).

## Decision

On macOS the template declares `{ role: 'windowMenu' }` after the Edit menu, and a separator-delimited run of `hide`, `hideOthers`, and `unhide` before Quit in the application submenu. Those roles contribute only the standard items; no Services submenu, window list, or other macOS default is declared. Windows and Linux keep the application and Edit menus. The [page-close decision](../architecture/2026-09-21-desktop-page-close-shortcuts.md) owns the custom File menu and close behavior.

Electron supplies English defaults for the Window and Edit roles. Explicit labels override role defaults while retaining native actions and shortcuts; the localized application commands are documented in the [Desktop README](../../../../apps/desktop/README.md). Minimize and hide execute through Electron's roles without custom handlers. Close and activation behavior is partly superseded by [close-to-background](../architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.md); the menu declarations here remain in effect.

## Alternatives considered

**Bind ⌘W to minimizing or hiding the window.** macOS reserves Minimize for ⌘M and Hide for ⌘H, and comparable applications close the front window with ⌘W. Binding another command to the reported shortcut would contradict the platform convention the change follows.

**Declare only the Window menu.** That menu supplies Minimize and Zoom but no Close, leaving ⌘W unbound.

**Add a bare `{ role: 'close' }` item to the application submenu.** It avoids a File menu containing a single command, but places a window command among the app-wide Plugins, Updates, Hide, and Quit items where no macOS application puts it.

**Declare the File and Window menus on every platform.** The same template declares Ctrl+W there; with one window, closing it invokes `window-all-closed` and quits the application. The menu-restoration task did not request this quit path; the page-close decision explicitly specifies the Desktop fallback.

**Recreate the main window on Dock activation regardless of other windows.** The plugin window can outlive the main window, so gating `activate` on `mainWindow` instead of `BrowserWindow.getAllWindows()` would let a Dock click always restore the main window. That changes window lifecycle beyond restoring the suppressed platform commands, so the existing `activate` condition stays.

## Consequences

macOS retains native Window and application hide commands through four menu roles. Window and Edit retain Electron’s default English labels; application commands use the Desktop locale.

## Testing

`apps/desktop/tests/main-startup.spec.ts` verifies the declared menu roles per platform and records English and Chinese application-label snapshots. Role-based menu items execute natively, so a programmatic `click()` and the Vitest Electron mock cannot exercise the shortcuts. The isolated Electron 44 demo confirms that explicit application labels appear in native menus; the template snapshots do not qualify native shortcut execution.
