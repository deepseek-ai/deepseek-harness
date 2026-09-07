# Agent Note: Suppressing Windows subprocess windows

Status: implemented
Archived: 2026-09-04

English | [中文](2026-09-03-hidden-windows-subprocess-windows.zh.md)

## Problem

The local subprocess provider can run under a GUI or service host with no visible console. Windows creates a new visible window for a child process when the host does not supply one, so an ordinary command or a `taskkill` helper can flash and take focus even though the harness has no user-facing terminal for that process.

## Decision

The provider sets `windowsHide: true` on every non-terminal `spawn` and on both synchronous `taskkill` call sites. The main child uses this option only for the Windows execution path; `taskkill` is itself Windows-only. Terminal processes retain the visibility and console behavior owned by the PTY implementation.

The option hides console windows and GUI windows that honor the Windows process startup visibility setting. Callers do not choose this behavior because the local provider owns whether its background process management creates host windows.

## Alternatives considered

**Hide only the main child.** Rejected because cancellation, timeout escalation, terminal teardown, and host-exit cleanup can still launch `taskkill` and flash a console window.

**Expose a caller option.** Rejected because consumers cannot reliably know whether the local host has a console, and inconsistent choices would reintroduce focus-stealing process-management windows.

**Hide only console programs.** Rejected because Node exposes one Windows startup option rather than a reliable pre-spawn executable classification, and probing the target would add platform-specific races without preserving a useful product behavior.

## Consequences

Background subprocess operations do not create visible Windows child or `taskkill` windows. A directly launched GUI program that honors the startup visibility setting also starts hidden; consumers that need an interactive visible application must use a capability that owns that user interaction instead of the background subprocess provider.

Unit tests inject the process launchers and pin `windowsHide` for the main child and both `taskkill` paths without creating host-global windows or terminating real processes.
