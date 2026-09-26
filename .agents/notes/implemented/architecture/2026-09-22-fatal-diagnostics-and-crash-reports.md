# Agent Note: Fatal diagnostics and Desktop crash reports

Status: implemented

English | [中文](2026-09-22-fatal-diagnostics-and-crash-reports.zh.md)

## Problem

Two field failures of the Desktop application were diagnosed from screenshots of the fatal recovery dialog, which shows the last eight lines of the error and used to promise that the full diagnostic was in the Electron console. A packaged installation never surfaces that console.

On Windows, `OutputCollector.spillAll` in `dsh-subprocess-local` opened its spill file inside the child's stdout `'data'` listener. The `openSync` with `'wx'` threw `ENOENT`, which for that flag means the private per-process spill directory was gone (it is created once and never recreated; what removed it was not observed), and because no process-level handler existed the Desktop Host died with Node's default uncaught-exception output. The `path:` property happened to land in the eight visible lines; nothing else about the failure was recoverable.

On macOS, the boot audit listed a set of Web client rows as `import failed (see console for the import error)` while the real import error stayed in the renderer console. The eight visible names match exactly the rows that depend on one application batch, so a single failed load of that batch script explains the screenshot; whether the failure was a transport error, a stale-URL 404, or a truncated response was not determinable. A batch was requested exactly once, so any transient failure was final.

Both cases shared three gaps: fatal diagnostics were not persisted, the Host had no `uncaughtException` policy, and a single fallible step was allowed to fail a whole feature.

## Decision

Four decisions ship together.

**Uncaught exceptions are fatal and reported; the failed operation is never resumed.** `installFailLoud` in `dsh-app-boot` registers the same handler for `'uncaughtException'` as for `'unhandledRejection'`: write one labelled `util.inspect` diagnostic to stderr, await the surface's release hook under the existing timeout, exit 1. Control never returns to the failed operation and the event loop runs only until the release settles or times out, because only the throw site knows which state is intact; a `'data'` listener that threw mid-update has already dropped a chunk and half-set its own fields, and resuming would turn a visible crash into silently wrong output. `util.inspect` replaces `err.stack` because a `node:fs` error's `code`, `syscall`, and `path`, and any `cause` chain, are enumerable properties the stack line omits. The rejection label `fatal load failure` is unchanged because the Web profile expected-output e2e tests match it; exceptions use `fatal uncaught exception`.

**Spill files are best-effort at every step.** `spillPath` was already optional and a failed final close already withheld it. `spillAll` now contains every filesystem failure while opening or appending: it discards the spill, reports once through the owner's logger (`SpillOptions.onFailure`, wired to `ctx.logger.error` by the runtime and the SSH helper), and leaves the in-memory tail collecting. The removed directory is not recreated: the security of the design rests on a random name created once by this process, and recreating a known name would give that up. A fresh random directory on `ENOENT` is deferred work.

**A fatal Desktop failure writes a crash report before its dialog.** Every `reportFatal` caller names its source (`host`, `web-boot`, `renderer`, `main`). `DesktopFatalRecovery.report` awaits `writeCrashReport` for at most one second, then shows the dialog with the file path on its own line, independent of whether the error was shortened and in the listener-conflict variant too. The report holds the source, whether the backend had reached ready, application and runtime versions, the complete inspected error (the backend state carries the original failure object, and a Host startup failure carries the Host's own inspected error over the fatal IPC event, because the Host's stderr and that message race and the shell reports the first failure it sees), and the primary window's recent error-level console output captured from `webContents` `'console-message'` (a 64 KiB tail). Reports live under `app.getPath('logs')`, are owner-only where the platform allows, and startup keeps the ten newest. A fatal failure during shutdown writes a report without a dialog. Buttons and recovery actions are unchanged.

**A failed batch script is a per-row problem, not a boot failure.** In `ClientModuleSystem.arrive`, a transport failure (the script `error` event; nothing executed) is retried once on the same URL, shared by every row waiting on that batch. A script that loaded without registering a row is never re-executed: the batch registers packages in sequence and `register()` rejects duplicates, so a replay would stop at the first package the original run did register. Every executed batch URL is remembered, so this holds even when the first importer from the batch was a row it did register and a later row finds itself missing. Either way each still-missing row then loads its own one-resource combo URL, which the Host serves for every package; a failed batch URL is remembered so later rows skip to their fallback, while a one-resource URL stays retryable across imports (within one boot the Loader imports each entry once, so a missing row gets one fallback attempt). Dependency failures are wrapped with the consumer and dependency names. The module system records the last `import()` or `prefetch()` failure per row at the outer operation, so factory execution errors are captured as well as arrival errors, and `assertEntriesActive` reports that text per fiberless entry.

## Relationship to earlier decisions

This partially supersedes the [native Desktop fatal recovery](2026-09-15-desktop-native-fatal-recovery.md) note: the crash report file, not the Electron console, is now the record the dialog points to, and the dialog detail carries the report-path line; that note's dialog ownership, button set, and profile recovery remain active. The `uncaughtException` handling extends the release mechanism of the [fail-loud release](../bug-fix/2026-07-31-fail-loud-releases-the-terminal.md) note to synchronous throws.

## Relationship to the Desktop logging design

The Desktop local logging design (a Worker-owned rolling JSONL log with a closed event vocabulary, redaction, and rate limits) is a continuous-log design and remains future work. It stated that Host stderr and renderer console output are never persisted and that errors reach the log only as fixed categories. This decision carves out one exception: the one-time crash report of a fatal failure keeps the raw error and the retained stderr and console tails, because that raw content is what both field diagnoses needed and the report is bounded (the error section is cut at 256 KiB, the Host diagnostic at 64 KiB, the renderer console tail at 64 KiB), local, owner-only, and written only when the application is already showing its fatal dialog. The dialog names the file so a user knows what they would be sharing. The continuous-log privacy posture is unchanged for anything that is not a crash report.

## Testing

- `dsh-app-boot`: uncaught exceptions produce the labelled diagnostic with enumerable properties and the cause chain, share the exit latch and release timeout with rejections, and both handlers uninstall.
- `dsh-subprocess-local`: `ENOENT` on open (removed directory), `ENOTDIR` on open, and `ENOSPC` on append after the file exists each leave the tail byte-exact, withdraw the spill file, report once, and never throw.
- `dsh-client-modules`: a transport failure retries once and shares the retry; a persistent failure falls back per missing row without re-fetching the batch per row; a batch that registered nothing or only some rows is not re-executed; a one-resource URL stays retryable; the final error lists every attempt; import errors are recorded for transport, factory, and dependency failures and cleared by success and invalidation.
- `dsh-client-web`: the boot audit names the recorded import error when the module system is supplied.
- Desktop: `crash-report` unit tests cover rendering, owner-only writing, write failure, pruning that leaves other files alone, and the console tail; `fatal-recovery` tests pin the dialog text with and without a report path in both locales, the one-second bound, and a single write per fatal; the startup harness asserts the report input for a running-phase Host exit including the captured renderer console.

## Consequences

The Host now exits through one path for both failure kinds, up to the release timeout later than Node's immediate default exit, so a fatal dialog can appear up to two seconds after the failure, and plugin stderr written during that release window can push the fail-loud line out of the dialog's eight-line excerpt (the report file keeps the 64 KiB tail). Spill failures are no longer visible to the user beyond a truncated result with no path; the plugin logger line is the only trace, which the Host-side continuous log design would persist. Crash reports persist raw stderr and console tails, accepted for the reasons above. A batch load failure now costs up to three requests per missing row and never fails registered rows; the shared-batch memory means a later import of a row from a failed batch goes straight to its one-resource URL for the life of the page.

## Alternatives considered

**Catch the uncaught exception and keep the Host running.** Rejected: the state after a listener throws is unknown to anything but the throw site. In the Windows case, continuing would have dropped the chunk, advertised a spill path to a file that did not exist, and thrown again on every following chunk.

**Recreate the spill directory on `ENOENT`.** Rejected for this change: recreating a known name gives up the random-directory property the design exists for. A fresh `mkdtemp` on failure needs the collector to hold a directory provider rather than a string and is deferred.

**Write the crash report synchronously so the dialog stays synchronous.** Rejected: a hung write on a slow or network-mounted profile directory would freeze the shell with no dialog at all. The asynchronous write with a one-second bound shows the dialog either way.

**Persist only classified error categories in the crash report, as the continuous-log design prescribes.** Rejected for crash reports: the `path:` property and the renderer's `bundle script … failed to load` line were the load-bearing evidence in both diagnoses and would have been reduced to `UNCLASSIFIED`.

**Retry the batch URL for every failure kind.** Rejected: re-executing a batch that already registered some packages throws `duplicate factory registration` inside the script, the `load` event still fires, and the caller sees the same "loaded without registering" it started with, unable to tell that the retry caused it.

**Keep more generations of Host batch URLs so a recomposed graph does not 404 an in-flight boot.** Deferred rather than shipped: no production trigger for a post-ready graph change was found, `lazyBody` caches response buffers so retention has a real memory cost, and the generation and age limits are deployment tunables that need `Config` fields.
