---
description: "Use this reference when recovering Desktop failures or collecting reports; it explains report contents, operation history, and shutdown limits."
---

# Desktop recovery and diagnostics

English | [中文](README.zh.md)

## Summary

This reference describes Desktop native failure recovery, diagnostic reports, recent plugin operation records, and collection and shutdown limits.

## Table of Contents

- [Recover from a failure](#recovery)
- [Report contents](#report-contents)
- [Recent operation records](#operation-records)
- [Collection and shutdown](#collection-and-shutdown)

<a id="recovery"></a>

## Recover from a failure

Fatal main-window creation, main-document loading, preload, renderer, Web initialization, or backend failures open one native recovery dialog per application process. It shows a bounded tail of the first error, notes any truncation, and offers “Exit”, “Restart”, “Disable third-party plugins, back up profile patch, and restart”, and “Get diagnostic report” while report writing is pending or after it succeeds. Startup failures retain the Web loading page and spinner; runtime failures retain the current page. Expected shutdowns, cancelled navigation, and ordinary requests do not trigger recovery. The shared Web plugin manager reports package-operation errors; Host startup failures after plugin changes enter native recovery. There is no startup timeout heuristic. A listener failure containing `listen EADDRINUSE` replaces the diagnostics and reinstall advice with guidance to quit other running DSH instances, and offers “Exit”, “Restart”, and “Get diagnostic report” while report writing is pending or after it succeeds.

Recovery uses the last confirmed Desktop language from the local cache before Host settings are available; an absent or invalid cache falls back to system languages.

Recovery waits for Host shutdown before changing plugin activation. The native recovery action calls the shared app-boot recovery function under the profile transaction lock. It disables third-party bundles and renames the profile’s `cordis.patch.yml` to `cordis.patch.yml.bak-<timestamp>` (with an ordinal on collisions) without parsing it; the next startup creates an empty patch. Installed packages and earlier backups remain. The home-level patch is unchanged. The Electron console records the backup path (or its absence) and the unchanged home-level patch. Invalid profile data, rename failures, or write failures are reported as recovery-operation errors; completed changes remain, and Desktop does not restart as though recovery succeeded. Desktop has no profile-reset action or emergency HTML document.

<a id="report-contents"></a>

## Report contents

Native dialog details include at most 1,200 UTF-16 code units and eight diagnostic lines, plus the crash report path or its pending/unavailable status. Retrieving a pending or unavailable report preserves any recovery-operation failure headline and details. Configuration paths and startup entries precede the composition inventory so plugin rows cannot displace them when output is truncated. Host error diagnostics retain only the last 64 Ki characters written to stderr. Earlier output is discarded so a long-running Host does not grow the shell’s diagnostic buffer indefinitely.

Before the first fatal dialog opens, Electron writes a crash report to the platform logs directory (`app.getPath('logs')`: `~/Library/Logs/DeepSeek Harness` on macOS, `logs` under the application’s `userData` directory on Windows and Linux), waiting at most one second for the write; a slow or failed write shows the dialog with an explicit pending or unavailable status. Get diagnostic report checks the same write and reveals a saved file in the system file manager without restarting or stopping the Host; a write that completes after the initial deadline remains available. The user attaches that file to a support ticket. The attachment contains the original failure; later recovery-operation errors remain in the dialog and require a separate screenshot. Retrieving a saved report shows its sharing or reveal-failure heading while retaining the recovery error details. If writing fails, the dialog hides Get diagnostic report and suggests providing a screenshot.

The file `crash-<UTC time>-<source>.log` records the source (`host` for a Host exit, `web-boot` for a renderer boot failure, `renderer` for a renderer or document failure, `main` for a shell error), whether the backend had reached ready, application and runtime versions, the error with its enumerable properties and cause chain (cut at 256 KiB), the Host’s own error and explicitly selected startup metadata (at most 64 Ki characters, including a truncation notice; startup errors reserve space for metadata by limiting the original error and startup-entry details to 8 Ki characters each, with explicit truncation notices) when the Host reported a startup failure over IPC before exiting, and the primary window’s recent error-level console output (at most 64 KiB).

A Host exit report therefore contains the retained stderr tail, which may include plugin output. A fatal failure during shutdown writes a report without opening a dialog. Files are owner-only where the platform supports it; startup keeps the ten newest reports and removes older ones without touching other files in the directory.

<a id="operation-records"></a>

## Recent operation records

Operation records and the application single-instance lock are isolated by `userData`; the shared platform logs directory does not store operation records. The reader only reads the two operation files under `userData/plugin-operations`. Repairing an unfinished append preserves complete lines in the current segment and the previous segment.

Version-exemption changes reuse the bundle enable/disable record fields. When the exemption and installed versions match, the record cannot distinguish an exemption change from a bundle toggle.

Host `transportDropped` is a lower bound as of the last successful delivery; Desktop rejects malformed or mismatched-run records without adding them to that counter.

The journal retains two 256 KiB segments, accepts records up to 4 KiB, and bounds queued writes to 64 KiB.

Exit, recovery restart and installer preparation wait at most 500 ms for queued writes; a timeout disables further writes and later drains return immediately without another wait, while an already-issued OS request may still settle.

Records cover manager operations observed after Host startup, not direct CLI commands or manual file changes. Package-manager output remains in its existing detailed logs and is not copied into this summary. Missing records, a start without an end, and damaged history do not establish a successful operation. This collection does not diagnose kernel hangs, OOM or native crashes.

Persistence failures also disable the writer for the rest of this shell lifetime, including after recovery or installer failure. This bounds repeated failing I/O and avoids appending behind an uncertain partial write. Restarting the application creates a new writer. Omission and repair counters cover only the current shell lifetime. Retained segments provide a larger local troubleshooting window than the deliberately smaller report attachment.

<a id="collection-and-shutdown"></a>

## Collection and shutdown

After saving the basic report, the shell attempts to append recent plugin-management records in an isolated Worker packaged as `lib/operation-report-worker.js` inside `app.asar`. The completion marker and omission counters distinguish a finished collection from missing or partial material.

The Host announces its run ID before profile loading; reported Host errors carry that ID as `hostRunId`, matching operation records from the same lifetime. Failure before this announcement leaves the run identity unknown. Recent operations are context, not proof of cause.

Collection reads only two owned files under `userData/plugin-operations`, at most 64 KiB and 100 records; the complete appended section is limited to 64 KiB.

The 500 ms collection budget reserves its final 100 ms for cooperative cancellation before requesting forced Worker termination; completion waits for its exit. Application exit, recovery exit or restart, and confirmed update installation also cancel collection and wait at most 500 ms for Worker exit. A rejected shutdown cleanup is logged without skipping the remaining cleanup waits. Shutdown prevents late basic-report saves from starting another collector. An update installation failure permits future collection again.

Worker messages interrupt collection between bounded records; an in-flight file open, stat, read or close must settle, and synchronous parsing cannot be preempted within one record. The final append uses an abort signal but can leave partial bytes. Forced termination remains the fallback when cooperative cleanup does not finish.

The basic report remains available independently. Only one collector runs at a time; concurrent reports keep their basic content without an auxiliary section. A rejected termination request does not release that slot until exit is observed. Get diagnostic report can reveal the basic file before the append finishes. The completion marker confirms only that collection ended, not that all operations were captured; queued bytes and omission counters describe missing material.

See [local verification](../../tests/README.md#verification-diagnostics) for fault setup and acceptance steps, and the [Desktop README](../../README.md) for the application overview and development entry points.
