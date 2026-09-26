# Agent Note: Hide the Desktop window on close and confirm interruptible quits

Status: implemented

English | [中文](2026-09-23-desktop-close-to-background-and-quit-confirmation.zh.md)

Window timing and shutdown ownership otherwise follow [showing the window before the Host starts](2026-09-09-desktop-immediate-window-and-direct-start.md); the task rule reuses the [update restart check](2026-08-25-electron-desktop-packaging-and-updates.md). This partially supersedes the [standard macOS window menus](../bug-fix/2026-09-16-desktop-window-menus.md) decision: ⌘W no longer destroys the window through Electron's role, and Dock activation reopens the hidden window when no window is visible instead of only when none exists. That note's menu declarations stay in force.

## Problem

Closing the Desktop window destroyed it. On macOS the Host kept running but the Dock rebuilt a fresh page, losing the current session, draft, and scroll position; on Windows the close quit the application and cut running tasks without any warning. Quit itself never asked, although the Host knows which agents, jobs, and scheduled reminders would stop.

## Decision

Closing the main window hides it on both platforms; the page and the Host keep running and the next show presents the same document. Windows gets a permanent tray icon (single click opens, context menu offers Open and Quit) because Windows users expect × to quit and need a visible way back, plus a first-close acknowledgement through the shared update-dialog overlay before hiding. Only Confirm records acknowledgement; cancellation keeps the window visible. Closing sends no system notification. macOS keeps the Dock and ships no menu bar icon. Closing the welcome window before the workspace opens quits on Windows and drops the unused main window on macOS, so the Dock rebuilds the welcome.

Every ordinary quit entry asks the Host over the private IPC channel for two facts: active tasks under the update-restart rule, and armed scheduled reminders reported by the `schedule` family of `workspace/session-activity` for the sessions loaded in this run. Both absent, the quit proceeds silently; otherwise a native message box without an owner window shows one of three fixed explanations with Quit as the default and Cancel on Esc. Repeated quit requests join the open box, the copy is frozen while it is open, and approval does not re-inspect. A Host that is not ready cannot run tasks and the quit proceeds; an inspection failure or a missed two-second deadline counts as running tasks because a needless prompt is cheaper than a silent interruption. The installer restart, fatal recovery, the development restart command, and operating-system session end skip the confirmation.

The Windows tray bitmaps are rendered from the vector icon at seven sizes and committed as an ICO; the confirmation on Windows uses the application icon in a task dialog and stays light because the control does not follow the application theme. The installer and uninstaller copy for a running application points at the tray.

## Alternatives considered

**Keep quitting on close and add a confirmation there.** It asks on every close, and Windows users would still lose background work whenever they dismissed the window. Hiding matches the product requirement that tasks continue.

**Render the quit confirmation in the shell's HTML overlay.** The overlay needs a visible parent window and a working renderer; the quit must also work when the window is hidden or the page is stuck, so the native dialog is the reliable choice.

**Reuse the update-tasks IPC request with a flag.** The quit needs a second fact and a shorter deadline; a distinct request keeps the update admission lock semantics untouched and lets both share one correlation id space.

**Downscale one large bitmap for the tray.** Rasterizing the vector source per size keeps edges crisp at 100 % through 400 % display scale, which a single downscale does not guarantee.

## Consequences

Users can close the window freely; background tasks and scheduled reminders continue, and reopening restores the same page. Quitting warns only when it interrupts something. Windows carries a tray icon for the whole run, and a hidden window that finishes a user-initiated update download defers its install confirmation until the window is shown again. Reminders in sessions never loaded during the run are neither counted nor resumed until those sessions open, and Desktop does not enable scheduled tasks by default, so the scheduled-task copy appears only once that feature is on.

Verification covers the four inspection outcomes, inspection failure and deadline, each quit entry's bypass or confirmation, the close-to-hide path with the tray and the first-close acknowledgement, the deferred update prompt, the Host-side inspection, the IPC correlation and deadline, and the committed tray icon's bitmap set. Windows tray and dialog behavior needs a manual pass on a Windows machine at several display scales.
