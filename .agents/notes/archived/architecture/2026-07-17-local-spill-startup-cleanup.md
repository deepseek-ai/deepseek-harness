# Agent Note: One-shot startup cleanup for local spill files

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-17-local-spill-startup-cleanup.zh.md)

## Problem

The local spill backend never deleted the full tool results it wrote. Every oversized result added another file, so configured roots grew without bound and default per-process `dsh-spill-*` roots accumulated across runs. Immediate deletion is wrong because persisted, resumed, and forked sessions may still reference a locator. The [tool output spill policy](./2026-07-08-tool-output-spill-files.md) needs a bounded local-storage lifetime.

## Decision

`dsh-spill-local` runs one best-effort cleanup sweep after activation. It does not delay service availability, is owned by the plugin fiber (a single `ctx.effect` whose generator launches the sweep and yields an async disposer that awaits it), and is awaited during disposal so no sweep I/O outlives the fiber. There is no recurring timer and no separate process.

A `cleanupPeriodDays` config defaults to `30`; `0` disables cleanup. Schemastery rejects a negative or fractional value at load. The sweep scans the configured/active root plus any prior default `dsh-spill-*` temp roots discovered under the OS temp dir and deletes regular files whose `mtime` is strictly older than `now − cleanupPeriodDays`. It prunes every empty session directory but removes the root itself only for a discovered prior-default root; writes recreate a session directory if pruning races them. Root aliases are de-duplicated by device/inode identity, with the configured identity overriding a discovered match as active and non-prunable. It uses `lstat`, so a symlink is never followed or deleted; unrelated entries (non-`session-` directories, special files) are skipped. Every filesystem failure is caught and logged through `ctx.logger.warn`, and a warning-sink exception is also contained — the sweep never throws, so it cannot reject activation or a concurrent spill write.

Path-based deletion is restricted to directories an untrusted local OS user cannot replace during the scan. On POSIX, every root and session directory must be owned by the current user and not writable by group or others; the root's ancestor path must also be non-writable or protected by a sticky directory such as `/tmp`. Discovery rejects symlinks, while a configured symlink may resolve to a trusted target and participates in identity de-duplication. An unsafe path is skipped with a warning. The same-user account remains the trust boundary, consistent with the backend's private local-storage model.

The ctx-free sweep mechanics live in `packages/spill/spill-local/src/cleanup.ts` (`sweepSpillRoots`, `discoverDefaultRoots`), unit-testable without a `ctx`; `store.ts` owns root naming, path derivation, and writes, while the service in `src/index.ts` owns the config, cutoff, and fiber-owned launch/await.

## Alternatives considered

**Run a periodic timer.** Rejected because it adds timer lifecycle, overlap control, and another interval knob. A long-lived process may retain files until restart.

**Delete spills on session disposal.** Rejected because durable sessions, resumes, and forks retain locators.

**Delete old session directories recursively.** Rejected because a concurrent process may create a fresh spill after the age check. Per-file expiry preserves fresh writes.

**Tie cleanup to session-persistence deletion.** Rejected because the persistence seam has no common deletion lifecycle, while the local backend also owns independent temporary roots.

## Consequences

Cleanup cost the backend a startup sweep and a config knob, and bought a bounded local-storage lifetime without a timer, a daemon, or a session-lifecycle coupling. Concurrent processes may duplicate startup I/O; strict filtering and idempotent file deletion keep this safe. A long-lived process is not cleaned again until restart, and retention deliberately makes old model-visible locators stale only once they age past the cutoff. The seam itself still defines no retention policy — this is a local-backend concern.

## Testing

`dsh-spill-local` unit tests cover the exact age boundary, `cleanupPeriodDays: 0` disabling, empty-session and discovered-root pruning, symlink/unrelated-entry skipping, configured-plus-discovered-root coverage, filesystem-identity de-duplication through a configured symlink, unsafe POSIX root/session rejection, load-time config validation, filesystem- and warning-sink-failure containment, and the quiescence contract. A separate test boots the plugin through the real Loader and a cordis.yml, then observes configured expiry and directory pruning after disposal.
