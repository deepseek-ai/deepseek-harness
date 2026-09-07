# Agent Note: Drop the Windows PowerShell picker fallback

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-04-drop-windows-powershell-picker-fallback.zh.md)

## Problem

The win32 branch of the native directory picker kept a two-tier PowerShell fallback under the koffi `IFileOpenDialog` child process: `pwsh.exe` first, then `powershell.exe` (Windows PowerShell 5.1), both running the same WinForms script with a `SetProcessDPIAware` opt-in. The chain existed to keep a working chooser when the koffi tier was "unavailable", but every trigger it plausibly protected was a failure of our own packaging or deployment, not of the operating system:

- koffi's native binary ships as an ordinary optional dependency (`@koromix/koffi-win32-x64`, no install script); a host that installs the package at all has the binary, and a host that cannot install it fails the package install loudly — the fallback code never loads either.
- "Ancient Windows" cannot occur: the Node versions this repo supports run on Windows generations far newer than the Vista-era `IFileOpenDialog` ABI the dialog needs.
- A koffi/COM defect crashes only the dialog child process (crash isolation); the correct response to our own bug is a surfaced failure, not a silent downgrade to a legacy dialog.

The chain also cost real complexity: two spawn tiers running one identical script, a fallback trigger widened from `ENOENT` to any pwsh failure to close the PowerShell 6 (no WinForms) regression, a triple-miss `AggregateError` carrying all three causes, and per-tier abort re-checks. The seam already owns the only fallback that matters — the `browse` backend at the composition level, chosen once at boot by `directory-picker-auto`.

## Decision

The win32 tier is exactly the koffi `IFileOpenDialog` child process; any failure surfaces as-is with no fallback. The PowerShell chain — the `pwsh` → Windows PowerShell 5.1 cascade, the DPI-corrected WinForms script, the `AggregateError` aggregation — is deleted, and `pickNativeDirectory`'s win32 branch is a single call. `dsh-native-command` remains a dependency for the POSIX tiers.

The fallback criterion the rest of the package already followed now applies uniformly: a fallback tier exists only for tools the OS/desktop environment provides and may omit (`zenity` → `kdialog` on Linux, which the boot-time probe also samples); tools our own package ships (`koffi`) fail loud. macOS `osascript` stays fallback-free as before.

This change consolidates and deletes the pwsh-first DPI picker-fix note: its decision is fully reversed here, and its preserved rationale no longer guides future work on a koffi-only tier. What it kept that was real: PowerShell 7 renders the modern `IFileDialog`-based folder picker where 5.1's `FolderBrowserDialog` is hardwired to the legacy `SHBrowseForFolder` tree; the script's `SetProcessDPIAware` corrected the spawn's system-DPI ceiling; the pwsh→5.1 hop existed because a resolvable PowerShell 6 has no WinForms (exit 1, not `ENOENT`). Its rejected alternatives (requiring PowerShell 7, importing `resolvePwshPath`, setting DPI awareness in the harness process) are moot with the chain gone.

## Alternatives considered

**Keep the chain but drop the pwsh quality tier (`koffi` → Windows PowerShell 5.1).** Rejected: the remaining tier still defends our own packaged dependency, still costs the script, the widened trigger, and the aggregation, and still hides our own vtable/COM defects behind a legacy dialog. The criterion "fallback only for externally provided tools" admits no Windows tier at all.

**Keep the chain as-is.** Rejected: it was the only two-level runtime fallback in the picker surface, its triggers were deployment-side failures that fail loud anyway, and it degraded a failed pick into an `AggregateError` whose most actionable entry was a PowerShell host.

**Fall back to `browse` at runtime when the native pick fails.** Rejected: the seam's flow holes are `single`-kind and the `-auto` composition already picks one backend at boot; a runtime cross-kind hop would double-mount both backends and blur the capability boundary.

## Consequences

- The win32 picker's failure surface is one error from one tier; callers see the real cause (koffi load failure, COM refusal, dialog crash) instead of a chain-aggregated error.
- `pwsh`/`powershell.exe` are no longer invoked by this package; the WinForms script, its `SetProcessDPIAware` correction, and the `-STA` flags are gone with them.
- Tests shrink accordingly: the pwsh/5.1 cascade and triple-miss cases are replaced by one "failure surfaces with no fallback" case; the default-adapter test now drives the Linux tier.
- Reintroduction condition: a future win32 mechanism outside our packaging chain (a system-provided dialog host we do not ship) would justify a single fallback tier under the same criterion.
