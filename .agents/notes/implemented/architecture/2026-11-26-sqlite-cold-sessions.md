# Agent Note: Cold SQLite Session payloads

Status: implemented

English | [中文](2026-11-26-sqlite-cold-sessions.zh.md)

## Problem

The [event-row layout](2026-11-25-sqlite-event-rows-and-derived-tables.md) supports indexed point reads and SQL queries. Compressing each event separately uses more disk space than compressing a complete Session, including for histories that rarely reopen.

## Decision

A configurable background pass (`coldAfterDays`, 30 days by default; `0` disables) archives eligible Sessions as one Zstandard level-12 frame per logical JSONL log under `<database>.cold/`. SQLite retains event identities, envelopes (`codec` 254) and derived rows, recording the synced archive and clearing inline payloads in one transaction. Any `open()` (read or write) and any non-empty fork from an archived parent restores the payloads before returning, coalescing concurrent in-process openers and reusing the decoded events on write open. Existing JSONL generations are untouched. Shared fork history stays inline so a shared Segment neither duplicates payloads nor forces unrelated Sessions to rehydrate. As an explicit temporary design decision, worker-backed online compaction (`compactStorage()`, running `VACUUM` and `PRAGMA wal_checkpoint(TRUNCATE)` on a worker thread while local database writes queue asynchronously) is internal to `dsh-session-persistence-sqlite` rather than part of the public `SessionPersistence` service contract, because no other persistence backend requires `VACUUM`-style space reclamation and no shared external trigger contract exists.

## Alternatives considered

- **Change compression for hot rows.** Larger frames reduce storage but make an indexed point read decode neighboring events.
- **Use level 3 or 19.** On the same 154-Session corpus, a codec-only run at level 12 saved about 22 MiB over level 3. Level 19 saved about 11 MiB more but took roughly 14 times as long as level 12 to encode.
- **Put metadata and payloads in JSONL.** Removing event rows would remove their SQL indexes and event identities. Keeping envelopes permits SQL counts and joins without reading cold files.
- **Compact automatically.** Returning pages to the filesystem rewrites the database file; freed pages already re-enter SQLite's freelist for in-place reuse without imposing rewrite locks and temporary disk spikes on active workloads.
- **Expose `compactStorage()` on `SessionPersistence` now.** No other persistence backend requires `VACUUM`-like page reclamation, and no UI, CLI, or schedule trigger exists. Keeping `compactStorage()` internal to `dsh-session-persistence-sqlite` avoids letting one backend shape the shared service seam prematurely.

## Consequences

Three alternating fresh-process rounds on 154 real-corpus Sessions (242,523 events) on Apple Silicon macOS (Node 24.22.2) archived every Session in 37.6 s and compacted the database through the internal `compactStorage()` worker in 688 ms. Total disk use dropped from 364.1 MiB (hot SQLite) to 151.3 MiB (25.1 MiB SQLite plus 126.2 MiB of `.cold` archives), 58.5% smaller than hot SQLite and 2.8% smaller than Zstandard JSONL (155.6 MiB). `list()` (61.2 ms first call, 18.0 ms warm), `stat()` across all 154 Sessions (112.9 ms total, 526 µs p50 against 5,104 µs on JSONL), and derived SQL queries (`session_summary` 0.8 ms, `llm_calls` 9.4 ms, `session_tools` 51.6 ms) triggered zero rehydrations. First cold `open('read') + read()` took 42.4 ms at p50, 328.1 ms at p90 (2,896 events), and 3.51 s at max (26,261 events); subsequent reads took 6.59 ms at p50, and 50-event tail reads across all 154 Sessions took 441.1 ms against 8,723.1 ms on JSONL. Resuming an archived Session in the production `headless` profile and running five live tool-calling turns took 117.4 ms total on the median Session (54.3 ms resume plus 63.2 ms turns, against 189.0 ms on JSONL) and 372.9 ms at p90 (254.8 ms resume plus 118.0 ms turns, against 205.9 ms for the five turns alone on JSONL).

The [provider reference](../../../../packages/session/session-persistence-sqlite/README.md#archiving-idle-sessions) specifies the idle cutoff, SQL visibility, backup, and [store compaction](../../../../packages/session/session-persistence-sqlite/README.md#compact-the-store). The [Loader test](../../../../packages/session/session-persistence-sqlite/tests/event-rows.e2e.ts) verifies archiving, internal `compactStorage()`, tool-query preservation, and reopening through the shipped headless profile.
