# Agent Note: The absent-probe parent repair runs on Windows only

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-28-windows-only-absent-probe-repair.zh.md)

## Problem

`JsonlSessionPersistence.exists` treats ENOENT as absence, and before returning false it stats the path's parent so a session directory blocked by a regular file surfaces as a storage fault rather than as a missing session. Windows needs that: it reports ENOENT, not ENOTDIR, for `regular-file/child`. POSIX does not — `open(2)` specifies ENOTDIR when a component of the path prefix is not a directory, which the repair's own guard comment already recorded.

The stat ran on every platform and on every absent probe. `findLog` issues four probes per project directory — two rejecting the legacy flat-file layout, one for the opposite encoding, one for the log itself — and the coordinator resolves an id twice per `inspect`: once in `prepareCore`, once in `isPreparedSourceCurrent`, which runs even when the prepared source is cached. All but one directory answers absent, so nearly every probe paid the extra stat.

## Decision

The repair is reached only under `process.platform === 'win32'`, matching the platform dispatch `materialize` already uses. POSIX keeps the ENOTDIR that `open` itself reports.

## Testing

Counting `node:fs/promises` calls through the suite's existing module mock, against a store with five project directories — the layout of a real `~/.dsh/sessions`:

| Operation | Before | After |
|---|---|---|
| `load` an existing session | 40 open + 41 stat | 40 open + 3 stat |
| `load` an absent id | 20 open + 20 stat | 20 open + 0 stat |

The package's 242 tests pass unchanged and per-file coverage is identical; the new branch carries the same `v8 ignore` marker as the sibling platform dispatch.

That POSIX never reaches the repair was confirmed directly rather than taken from the comment: opening `regular-file/child` and `regular-file/child/deeper` reports ENOTDIR on macOS, while only a genuinely missing directory reports ENOENT.

## Alternatives considered

**Keep the stat on every platform as defense in depth.** Rejected: on POSIX it can only confirm what `open` already reported, so it detects no fault the caller would otherwise miss — it doubles the syscalls of every absent probe to re-derive a known answer.

**Remove the repair outright and let Windows report absence.** Rejected: it exists so a session directory blocked by a regular file stays a storage fault instead of reading as a missing session, which is the fail-loud stance the backend takes elsewhere.

## Consequences

Path resolution keeps its full cost in `open` calls: four per project directory per lookup, twice per `inspect`. This removes the stat half only, and the remaining cost still grows with the number of project directories rather than with the number of sessions.

Collapsing the scan needs an id-to-path index, which first requires deciding what happens to the per-lookup legacy-artifact guard that `rejects a compressed obsolete flat-file artifact during targeted lookup` pins: that test writes its artifact after `list()` has memoized the root encoding check, so the guard covers store mutation after memoization, and an index hit would return before reaching it. One `readdir` per project directory, which would supply both the id-to-path map and that guard without a cache, measured no faster than this change, so any further win requires memoization and its invalidation.
