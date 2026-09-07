# Agent Note: Win32 folder picker moves to koffi in a child process

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-02-win32-in-process-folder-dialog.zh.md)

## Problem

The Windows directory picker's primary tier was a spawned PowerShell script around WinForms `FolderBrowserDialog`: the modern dialog only where PowerShell 7 happens to be installed, a regression where PowerShell 6 resolves but has no WinForms (exit 1 is not `ENOENT`, so the 5.1 fallback never ran), a `SetProcessDPIAware` ceiling of system DPI, and a picker whose behavior depended on which shells a machine ships rather than on Windows itself.

## Decision

`packages/host/directory-picker-native` now opens `IFileOpenDialog` (`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR`) in-process through koffi — already a workspace dependency for the repo's other `win32.ts` surfaces — as the primary win32 tier. The COM conversation runs in a spawned child process so the modal `Show` never blocks the host event loop; the child posts its native thread id before blocking, and the driver services aborts by re-posting `WM_CLOSE` to that thread's windows (`EnumThreadWindows`), killing the child when the close budget is exhausted. The dialog is the child's first window, so Windows activates it without a foreground call. The child thread opts into the best thread DPI awareness the host accepts (`SetThreadDpiAwarenessContext`, cascading per-monitor-v2 → per-monitor → system-aware with the return value checked), a strict upgrade over the script's system-DPI ceiling; DPI stays a cosmetic best-effort — a host accepting none of them still gets the modern dialog rather than a downgrade. The module split keeps coverage honest on every host: `win32-dialog-logic.ts` (pure sequencing) and `win32-dialog.ts` (driver) test against fakes anywhere; `win32-dialog-bindings.ts` tests against a mocked `koffi` COM world (the `dsh-session-persistence-jsonl` technique); POSIX hosts run the real spawn plumbing to its koffi-load rejection; win32 hosts run a real open-and-abort-close smoke. The PowerShell chain that preceded this tier is gone (see the [chain removal](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md)): the tier has no fallback.

## Alternatives considered

- **A prebuilt native helper (`native/` family like `@deepseek-ai/node-addon-landlock-run`).** Rejected: another npm package family, MSVC provisioning, and a Windows build/release lane — all to ship ~150 lines of C the repository cannot currently exercise on CI (no real-Windows lane); koffi delivers the same COM surface with zero new supply chain.
- **An N-API in-process addon.** Rejected for the same CI/toolchain reasons plus owned C++ for STA threading and message pumping that a child process + koffi express in TypeScript.
- **Keep PowerShell primary and probe versions.** Rejected: the picker stays hostage to shell packaging (6 vs 7, Store aliases, profiles), and 5.1's legacy dialog remains the floor wherever pwsh is absent; the fallback-trigger widening alone was accepted into the fallback tier instead.
- **Blocking the main thread for the modal call.** Rejected outright: the web host must keep serving RPC while the dialog is open.

## Consequences

- Every Windows machine gets the modern dialog with the best DPI awareness it supports (per-monitor-v2 on 1703+), PowerShell installed or not.
- Real dialog rendering and the selection path stay a manual Windows check (the auto-close smoke proves open/abort/unwind).
- The COM vtable slots and GUIDs used are frozen Windows ABI (Vista); a koffi signature mistake risks a native access violation, contained to the dialog child process — the host Node process survives and the failure surfaces as-is (no fallback tier; see the [chain removal](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md)). The mocked-koffi ABI pins and the real win32 smoke exist to catch such mistakes before shipping.
- The packaged-binary arm — the packaged executable spawning itself as the dialog entry — is not exercised by any automated test. The source plane and built `lib/worker.cjs` under plain Node are covered; packaged self-spawn remains a named coverage gap.
