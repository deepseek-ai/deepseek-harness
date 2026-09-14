# Agent Note: Foreground activation for the Win32 picker via a synthesized Alt press

Status: implemented

English | [中文](2026-09-07-win32-picker-foreground-alt-key.zh.md)

## Problem

The web GUI host picks a workspace directory through the native Win32 folder dialog, which runs in a child process the host spawns (issue #3543). Windows grants the foreground only to the foreground process, to a process it started, or to a process that received recent input; a child of a background server process qualifies for none of these, so the dialog that `Show` opens sits behind every visible window even though it is the child's first window. The first-window activation assumption behind the spawn design ([archived feature note](../../archived/feature/2026-08-02-win32-in-process-folder-dialog.md)) holds only when the spawner chain owns the console foreground, as in a console-launched CLI.

## Decision

`runFolderDialog` calls a new `pressAltForForeground` binding between the `showing` notice and the blocking `Show`. The binding synthesizes one Alt press (`keybd_event` with `VK_MENU`, down then up) on the dialog thread, which makes Windows count this process as the most recent input owner — one of the documented grounds for foreground activation — so the dialog window `Show` creates activates as foreground. The bindings module already loads koffi's `user32`, so the change adds one function fetch and two invocations. The press is unconditional on Windows. When the process already holds foreground rights (a console-launched CLI), the dialog activates anyway and the press is inert; the window focused at that moment still receives the lone Alt and may briefly highlight its menu bar. Environments that suppress injected input (secure desktops, restricted remote sessions, an elevated foreground window) leave the dialog behind other windows, and the package README records that limit.

## Alternatives considered

**Custom URL protocol with a browser click gesture.** Draft PR #3544 granted the foreground by navigating the foreground browser to a registered `dsh-picker://` URL, which makes the shell launch the dialog process as a foreground descendant. The grant is deterministic by design, but the mechanism spans registry and VBS launcher files, a protocol entry point, a picker-result HTTP route with per-boot tokens, and a first-use browser confirmation, and it adds a server route the browser can reach. The synthesized press removes that entire surface.

**AllowSetForegroundWindow from the clicker.** The API must be called by the current foreground process — the browser — and may name only one permitted process; the spawner cannot invoke it on the browser's behalf.

**AttachThreadInput to the focused thread.** Attaching the dialog thread to the focused window's thread also bypasses the foreground restriction and avoids the keystroke side effect, but it is equally undocumented, needs the focused window's thread id at show time, and fails when the focused window belongs to a higher-integrity process; it was not prototyped.

## Consequences

The picker keeps its single spawned-child design and gains foreground behavior in the background-host case at the cost of one koffi call pair. The bindings spec pins the Alt down/up sequence and its position immediately before `Show` over the fake COM world; the logic spec pins the full showing → press → `Show` order. The Windows CI lane still opens and abort-closes a real dialog with the press present but asserts no activation. Validation on a Windows 11 machine with the foreground lock forced to its maximum reproduced the failure without the press (dialog behind other windows) and the foreground dialog with it in five of five repeat runs; Windows 10 is unverified. Synthesized input is consumed asynchronously by the raw input thread, so the activation grant is in principle race-prone; no miss appeared across the repeat runs, and fragile environments stay a documented package limitation rather than a second mechanism, because the browse backend remains the composition-level answer where native picking cannot be trusted.
