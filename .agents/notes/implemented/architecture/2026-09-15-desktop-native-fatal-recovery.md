# Agent Note: Native Desktop fatal recovery

Status: implemented

English | [中文](2026-09-15-desktop-native-fatal-recovery.zh.md)

## Problem

A recovery document depends on the renderer and preload whose failure can prevent application startup. Multiple reports from one failed startup can also obscure the original diagnostic and interrupt recovery.

## Decision

Electron owns one native fatal dialog per application process. Explicit main-window creation, document-load, preload, renderer, Web initialization, and backend failures enter this path. Ordinary requests retain local error handling, and the shared Web plugin manager owns package-operation failures. Expected cancellation and shutdown do not enter recovery. No elapsed-time heuristic classifies a slow startup as fatal.

The first report claims presentation before awaiting the dialog. Later reports remain in logs. A crash report file under the application logs directory retains the complete reported diagnostic, and the dialog names it on its own line ([fatal diagnostics and crash reports](2026-09-22-fatal-diagnostics-and-crash-reports.md)). The dialog bounds the first diagnostic to its final eight lines and limits the complete detail to 1,200 UTF-16 code units, including truncation notice, report path, and reinstall advice, because native dialogs cannot scroll. The dialog offers exit, restart, or disabling third-party bundles followed by a whole-application restart. Recovery calls the shared app-boot `sanitizeProfile` function under the existing profile lock after Host shutdown. The function restores caller-supplied bundles and renames the profile patch to a unique backup without parsing it, requiring runtime initialization, or deleting installed files. Callers own profile shutdown and write exclusion; Desktop is the current production caller. The home-level patch remains unchanged. An explicit recovery-operation failure is presented separately and does not count as another automatic fatal report.

The Web document stays in place. A carrier callback owns startup failure presentation while the shared boot page retains its spinner; ordinary browser boot still renders its own failure report. Only the primary application frame may report a Web boot failure. Backend state remains in the main process, and native recovery directly owns disabling all third-party bundles. Desktop has no profile reset or emergency recovery document. A fatal backend failure requires one of the native recovery actions rather than an in-process retry.

This supersedes recovery-page and reset behavior in the [immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md), whose immediate visibility and direct Host startup rationale remain active. The [Web wrapper decision](2026-09-10-desktop-web-wrapper.md) owns shared plugin management and native profile preparation.

## Alternatives considered

A Web modal depends on client initialization, while a second recovery document adds renderer resources and preload recovery paths. Native dialogs remain usable when those components fail. Automatically resetting configuration or restarting on every report can delete user configuration or create restart loops; explicit actions preserve user control.

**Disable bundles while retaining the active profile patch.** A malformed patch or a patch that inserts a broken plugin can still prevent startup. Renaming preserves the user’s exact bytes for manual repair while removing that layer from startup; unique backup names preserve earlier recovery attempts.

## Consequences

Recovery cannot report a killed or crashed Electron main process, and a silent startup hang has no automatic timeout prompt. A malformed home-level patch still blocks startup after profile recovery and requires manual repair. Backups accumulate in the profile directory without automatic pruning; users remove them when no longer needed. Invalid profile JSON can prevent disabling plugins; exit and restart remain available after the operation reports its failure. Focused lifecycle tests cover fatal signals, cancellation, first-report deduplication, and shutdown ordering; locale expectations record dialog diagnostics and actions, and boot tests retain ordinary browser failure presentation.
