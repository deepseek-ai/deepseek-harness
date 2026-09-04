# Agent Note: cross-process session write lease

Status: implemented

English | [中文](2026-08-31-cross-process-session-write-lease.zh.md)

## Problem

The JSONL backend's write-handle claim excluded a second writer only inside one backend instance. Two processes — two CLI sessions, or a host beside an SDK runtime — could write-open the same session and interleave appends into one log file, tearing compressed frames and seq contiguity. The seam needed durable cross-process write ownership whose arbiter lives outside every writer process, because no writer outlives every failure mode.

## Decision

`SessionWriteLease` (packages/session/session-persistence-jsonl/src/lease.ts) holds a kernel lock on `session.lock` beside the log for the whole life of a write handle: POSIX takes a non-blocking `flock(2)` through the pinned native dependency `fs-ext`, and Windows holds a named kernel semaphore (count 1) derived from the canonical lock path (`CreateSemaphoreW` in src/win32.ts beside the existing koffi bindings) — a kernel object with no filesystem footprint, destroyed with its last handle. Contention maps to `SessionAlreadyOwnedError`; the kernel releases the lock when the holder's descriptor or handle closes, including on any process death, so a crashed holder never blocks a successor and no expiry bookkeeping exists. A live but wedged holder keeps the lock until its process exits: expropriating a stalled writer was rejected because its resumed appends would tear the log, and on POSIX removing the lock file remains the explicit forfeit for that case. Because a POSIX lock names an inode rather than a path, acquisition verifies the locked inode is still the file at the lock path and retries otherwise. The lock is taken at write-open of an existing artifact and, for a created session, only right before its first materializing write — an unmaterialized session leaves no filesystem footprint, and a handle that acquired the lock keeps it through close even when materialization fails; release never removes the lock file, preserving the stable inode later lockers verify against. The browser worker deployment stubs fs-ext to immediate success: it is single-process, so the in-process write claim already excludes every writer.

## Alternatives considered

**TTL record with renewal and claim-by-rename (implemented first, replaced in review)** — a JSON record beside the log carrying an owner token and expiry, renewed on an interval, taken over by atomic rename after expiry. It survives every filesystem but is a distributed algorithm in miniature: renewal timers, loss detection, takeover claiming with re-judgment and give-back — and its residual multi-actor races still allowed bounded dual-writer overlap (one renewal interval). Kernel arbitration deletes the whole family plus the machinery, at the cost of a native build dependency and the wedged-holder semantics above.

**`proper-lockfile`** — the npm ecosystem's staleness-plus-touch implementation of the same TTL model. It retains the delete-then-recreate takeover race, detects compromise by mtime and inode (weaker than an owner token), and has had no release since 2021.

**fs-ext's own Windows face (`LockFileEx` byte-range locks)** — rejected after CI proof: Windows byte-range locks are mandatory, so any reader touching the locked file hard-fails (ripgrep died with os error 33 walking a session directory).

**Windows exclusive-open sharing mode (`CreateFileW` denying `FILE_SHARE_WRITE`)** — leaves readers untouched but pins the lock file's name and directory while held: CI showed dozens of suites failing their temp-root cleanup with EBUSY because a still-open handle blocks recursive removal, and users deleting a session directory would hit the same wall. The named semaphore keeps kernel arbitration with zero filesystem footprint.

**Hand-rolled ffi for POSIX too (`flock(2)` via koffi)** — avoids the node-gyp install-time build, but means owning both platform lock implementations plus their error mapping; `fs-ext` ships the POSIX code maintained and pinned, and the Windows side reuses the koffi bindings `win32.ts` already owns.

## Consequences

Cross-process exclusion costs a node-gyp-compiled native dependency (`fs-ext`, allow-listed in `pnpm-workspace.yaml` `allowBuilds`), one lock file per materialized session that release deliberately leaves in place, and the wedged-holder rule: a stuck process blocks that session's writers until it exits. It buys immediate crash recovery (no waiting period), no renewal traffic, and the removal of every takeover race the TTL design managed rather than prevented. Advisory `flock` is unreliable on some network filesystems (NFSv3); a root on such a mount degrades toward in-process-only exclusion. Deleting a live session's lock file forfeits exclusion on POSIX by design — the harness never does so; the agent-loop resume test uses it deliberately to simulate a wedged first lifecycle, and skips on Windows, where the lock is a kernel object no file operation can forfeit.
