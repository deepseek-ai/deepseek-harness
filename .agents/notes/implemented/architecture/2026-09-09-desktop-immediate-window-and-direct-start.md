# Agent Note: Show the Desktop window before starting the Host

Status: implemented

English | [中文](2026-09-09-desktop-immediate-window-and-direct-start.zh.md)

Profile mutation and recovery follow the [in-place profile decision](2026-09-09-desktop-in-place-profile.md).

## Problem

Waiting for backend readiness leaves users without a window during profile preparation and module loading. A complete staged health-check process repeats backend startup before the application starts its serving process, while plugin startup can still fail in the serving process.

## Decision

Electron creates the main window with a local loading page before profile reconciliation or Host startup. The page depends only on packaged shell assets and receives starting, ready, or error state through the owned preload. Readiness loads the product UI in that window; startup failures display diagnostics and available recovery actions. Closing during loading cancels further startup work and waits for the pending child to exit.

The main window owns recovery because the failed Host cannot supply its own controls. Error pages retain diagnostics, restart, and reinstallation guidance. Disabling plugins and resetting Desktop are available only in a packaged application with loaded runtime metadata and available resources. Reset removes all profile contents except its held lock, without a backup; shared product data and the Harness-home environment file remain intact. The profile directory remains in place so another transaction cannot acquire a replacement lock during cleanup. Self-contained recovery controls use intercepted form navigation when preload is unavailable. A crashed renderer invalidates the navigation cache so the startup page loads again.

Desktop starts the actual Host after preparing the profile in place, without booting a separate health-check backend. Package mutations retain dependency validation, approved lifecycle builds, runtime identity checks, and locking. Failures retain partial changes for explicit repair; there is no automatic profile rollback.

This partially supersedes staged backend probes and waiting to create the main window in the [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) and [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md). Those notes retain release, signing, transport, resource ownership, and dependency-transaction rationale. Full runtime file verification remains a packaging operation.

## Alternatives considered

**Keep a complete staged health check.** It can reject some startup failures before activation, but executes plugin initialization twice and cannot guarantee that the serving process will start. The actual Host result provides the diagnostic needed for explicit recovery.

**Keep the main window hidden until readiness.** This avoids presenting a loading page but gives users no visible progress or interaction while the backend loads. A shell-owned page can remain available when Host startup fails.

## Consequences

Users can see startup progress and recover from failures before the product UI is available. A responsive window does not imply that the backend is ready, and startup latency still requires installed-artifact measurement. Profile changes remain in place after activation fails.

Verification covers a delayed Host with a visible loading page, one serving startup for a fresh profile, failure and retry in the same window, plugin management during recovery, and closing while a child is starting. Installed GUI evidence complements lifecycle and transaction tests.
