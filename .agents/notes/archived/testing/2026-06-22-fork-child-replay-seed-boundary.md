# Agent Note: Persist the seed boundary so fork-child replay routes correctly

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-22-fork-child-replay-seed-boundary.zh.md)

## Problem

The [per-session snapshot replay Agent Note](2026-06-22-subagent-snapshot-replay.md) made the snapshot tier express a nested-agent shape: a parent plus one recorded log per in-process subagent, each replayed as its own script keyed by calling session. It noted (§ Scope, final bullet) that a fork snapshot was "a trivial future addition, not a gap in the keying." That was wrong about a fork child specifically — not the keying, but the *script derivation*.

A subagent script is derived from a recorded session log by [`deriveReplayScript`](../../../../packages/test-support/llm-replay): it expands each durable `assistant/message` or `assistant/attempt` settlement into one replay entry per `stream()` call. This is correct for a **spawn** child, whose log contains only its own model calls.

A **fork** child is different. The fork backend seeds the child session with a *balanced completed-turn prefix of the parent's log* ([`dsh-subagent-in-process-driver`](../../../../packages/subagent/subagent-in-process-driver)), and that seed becomes the child session's persisted `log` (`Session`'s constructor copies the seed into `this.log`). A fork child's `.jsonl` therefore begins with the **parent's** events — including its Assistant settlements — and only then carries the child's own turn.

Deriving the child script from the whole fork-child log therefore replays the **parent's** recorded responses as the **child's** model calls: the live fork child's first `stream()` would receive the parent's first recorded chunk sequence instead of its own. All recorded scenarios use spawn, so this never fired — but a fork snapshot would have mis-routed silently, exactly the class of bug the snapshot tier exists to catch.

## Decision

Record where a session's **inherited** prefix ends, persist it, and have the replay harness derive a child's script from its **own** events only.

### 1. Lineage metadata and an exact body-owned cut

`SessionHeader.isSeeded` records whether a Session has inherited lineage without exposing a body coordinate to header-only readers. The exact leading-event count is the separately branded `SessionLogOffset` `inheritedEventCount`; a fork supplies both `isSeeded: true` and the copied-prefix length, while a fresh spawn supplies an unseeded header and cut zero. The cut travels through `CreateSessionOptions`, `CreateAgentOptions`, persistence inspection, and restored Session state.

`inheritedEventCount` is **explicit**, never inferred from `seed.length`. A reconstruction (resume/load) seeds the session with its WHOLE stored log, so `seed.length` there is the full length, not the original boundary — the resume path passes the decoded cut beside the logical header instead.

### 2. JSONL round-trips it

The v2 JSONL header carries `isSeeded`, while `session/end-seed { inherited: true }` marks the exact cut in the body; decoding uses the last tagged marker. The frozen v0 header keeps optional numeric `seedLength` for byte compatibility, and its codec translates that historical field into the same logical pair.

### 3. Replay derives a child script after the boundary

`dsh-llm-replay` parses the selected generation through the static format catalog and retains its decoded `inheritedEventCount`. `loadSessionScripts` derives a child's entries from `fixture.events.slice(inheritedEventCount)` — the events at or after the boundary, which are the child's own model calls. For a spawn child the cut is 0 and this is a no-op.

This closes the routing correctness gap, and two recorded fork scenarios exercise it end to end — see [Record fork and mixed spawn+fork snapshot scenarios](../../archived/testing/2026-06-22-fork-snapshot-scenarios.md).

## Alternatives considered

- **Derive the boundary heuristically in `llm-replay`** (the seeded prefix is contiguous parent events ending at the last `turn/end` before the child's first `user/message`). Rejected: a brittle heuristic in the test harness that re-derives a fact the producer already knows. Persisting the boundary at its source (the fork backend) is the "explicit > implicit at package boundaries" rule applied across the persistence boundary — the reader of a child fixture never has to reconstruct where the inheritance ended.

## Consequences

- The lineage bit spans logical Session metadata while the exact cut spans only body-bearing core, persistence, query, and replay values; the v0 physical header remains unchanged.
- Spawn replay is unchanged (cut 0). Fork replay routes a child to its own script; covered by a regression in `llm-replay`'s tests (a child fixture whose seeded prefix carries a parent chunk — the derived child script must exclude it, proven red without the slice) and a JSONL persistence round trip through the shared coordinator contract.
