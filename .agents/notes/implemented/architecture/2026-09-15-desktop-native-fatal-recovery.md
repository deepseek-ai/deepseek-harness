# Agent Note: Native Desktop fatal recovery

Status: implemented

English | [中文](2026-09-15-desktop-native-fatal-recovery.zh.md)

## Problem

A recovery document depends on the renderer and preload whose failure can prevent application startup. Multiple reports from one failed startup can also obscure the original diagnostic and interrupt recovery.

## Decision

Electron owns one native fatal dialog per application process. Explicit main-window creation, document-load, preload, renderer, Web initialization, and backend failures enter this path. Ordinary requests and package operations retain their local error handling; the Host restarts after failed package writes, and a failed Host restart enters native recovery; expected cancellation and shutdown do not enter recovery. No elapsed-time heuristic classifies a slow startup as fatal.

The first report claims presentation before awaiting the dialog. Later reports remain in logs. The Electron console retains the complete reported diagnostic. The dialog bounds the first diagnostic to its final eight lines and limits the complete detail to 1,200 UTF-16 code units, including truncation notice and reinstall advice, because native dialogs cannot scroll. The dialog offers exit, restart, or disabling third-party bundles followed by a whole-application restart. Disabling writes activation metadata under the existing profile transaction lock after Host shutdown, without requiring runtime initialization or deleting installed files. An explicit recovery-operation failure is presented separately and does not count as another automatic fatal report.

The Web document stays in place. A carrier callback owns startup failure presentation while the shared boot page retains its spinner; ordinary browser boot still renders its own failure report. Only the primary application frame may report a Web boot failure. The plugin window exposes package operations only; backend state remains in the main process, and native recovery directly owns disabling all third-party bundles. Desktop has no profile reset, plugin-window recovery controls, or emergency recovery document. A fatal backend failure requires one of the native recovery actions rather than an in-process retry.

This supersedes recovery-page and reset behavior in the [immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md), whose immediate visibility and direct Host startup rationale remain active. The [in-place profile decision](2026-09-09-desktop-in-place-profile.md) still owns package transactions and partial changes.

## Alternatives considered

A Web modal depends on client initialization, while a second recovery document adds renderer resources and preload recovery paths. Native dialogs remain usable when those components fail. Automatically resetting configuration or restarting on every report can delete user configuration or create restart loops; explicit actions preserve user control.

## Consequences

Recovery cannot report a killed or crashed Electron main process, and a silent startup hang has no automatic timeout prompt. Invalid profile JSON can prevent disabling plugins; exit and restart remain available after the operation reports its failure. Focused lifecycle tests cover fatal signals, cancellation, first-report deduplication, and shutdown ordering; locale expectations record dialog diagnostics and actions, and boot tests retain ordinary browser failure presentation.
