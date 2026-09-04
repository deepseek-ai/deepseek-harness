# Agent Note: Per-session snapshot replay for nested agents

Status: implemented

English | [中文](2026-06-22-subagent-snapshot-replay.zh.md)

## Problem

The snapshot tier (`pnpm run test:snapshot`) boots the real `acp-agent` subprocess, replays a recorded session through [`dsh-llm-replay`](../../../../packages/test-support/llm-replay), and diffs the normalized automation wire + re-persisted session log against committed expected outputs. Most scenarios exercise assembled backend behavior through that real process boundary.

It was built for ONE session per process, and that assumption is wired into two places:

- **`dsh-llm-replay` keyed nothing.** It served the Nth `llm/stream` call the Nth recorded entry from a single global cursor. With a parent agent AND an in-process subagent both streaming on one context, the calls interleave and the single cursor hands the child the parent's script (and vice versa).
- **The harness harvested one log.** `findSessionLog` walked the sessions root and returned the FIRST `.jsonl` it found. A subagent runs as a second `Session` with its own log, so the child's transcript was silently dropped.

This was the `TODO(subagent-snapshots)` deferral recorded in the [subagent seam Agent Note](../feature/2026-06-21-subagent-capability-seam.md): the in-process backends shipped with unit + e2e coverage, but the full-transcript snapshot tier could not express a nested-agent shape until this infrastructure landed.

## Decision

Replay is keyed **per calling session**, and the harness harvests **every** session log.

### 1. The calling session id rides on the model request

`GenerateOptions` gains an optional `sessionId`, stamped from `agent.session.id` during request assembly. Adapters ignore it; an `llm/stream` listener uses it to route by the issuing session. Its type is `Branded<'SessionId'>` (from `dsh-brand`) rather than `SessionId` from `dsh-session`, because that package imports `Message` from `dsh-llm` and importing back would create a cycle. The types are equivalent, so a session id assigns without a cast. Moving the brand to a dedicated ids package remains separate work because it would touch every id import.

### 2. Replay binds live sessions to recorded scripts by first-call order

A nested scenario records more than one role: parent `session[.vN].jsonl`, then one per subagent child as `session.<ordinal>[.vN].jsonl`. V0 omits `.v0`; positive generations use lowercase `.vN`; the harness selects the numerically highest file per role. `dsh-llm-replay` loads that selected set and derives one script per recorded Session. The primary script always binds first; child scripts bind by header `createdAt`, with recorded id breaking timestamp ties. Persisted discovery separately uses `createdAt` to assign child fixture ordinals.

Live session ids are freshly random every run and never equal the recorded ones, so a live session cannot bind to a script by id equality. Instead it binds by **first-call order**: the first live session to make any model call claims the first ordered script (the parent — earliest `createdAt`, and necessarily the first to stream, because it must run a turn before it can delegate), the next new live session claims the next script, and so on. Each session then advances its own cursor independently.

This keys by WHO calls, not by global call order — so it stays correct even if subagents ever run concurrently or in the background (a global cursor would interleave them). A call carrying no `sessionId` (a direct unit-test `stream()`) is treated as one anonymous session bound to the primary script, so the single-session path is byte-for-byte the old behavior. More distinct live sessions than recorded scripts is a fail-loud error (an unrecorded subagent appeared), never a silent mis-route.

Child fixtures sort by `createdAt`, which matches call order while siblings run strictly sequentially. The id tiebreak only makes degenerate collisions deterministic. Concurrent or background children must introduce an explicit first-call ordinal instead of relying on timestamps.

## Alternatives considered

The alternative considered and rejected was a **call-ordered merge of the parent and child logs** into one global script (sound only because in-process subagent execution is strictly nested — the parent blocks on the child). It is simpler for the synchronous execution model but bakes in the parent-blocks-on-child invariant that a future backgrounded/concurrent subagent would break; per-session keying does not.

### 3. The harness harvests every log, primary-first

`harvestSessionLogs` recursively selects the numerically highest canonical generation under each persistence Session directory, parses each header, and orders them primary-first: the top-level Session (no `parentSession`) leads, then each child by ascending `createdAt`. `RunResult.sessionLogs` is the plural result; record and refresh write each current output under `session[.vN].jsonl` or `session.<ordinal>[.vN].jsonl`, retain older generations for roles still produced, and diff the selected highest replay inputs against fresh current outputs. The normalizer already accepted plural Session ids and collapses any stray UUID, so no normalizer change was needed.

### 4. Scenarios

Two nested scenarios were added and recorded against the real API:

- **`subagent-spawn-in-process`** — the parent delegates one subtask via the `subagent` tool to a fresh spawn child (2 sessions).
- **`subagent-multi`** — the parent delegates two subtasks, each to its own spawn child (3 sessions), stressing the per-session keying with three concurrent scripts and the `createdAt` ordering of two children under one parent.

Both replay keyless in the default gate.

## Consequences

- The `TODO(subagent-snapshots)` deferral is resolved: nested-agent transcripts are now a first-class snapshot shape.
- `GenerateOptions.sessionId` is a small, honest core API addition useful beyond replay (telemetry, request routing).
- The `subagent` tool is bound to a single provider, so both children in `subagent-multi` are spawn (fresh). The keying routes by session, not by backend, so it is already correct for fork. The script *derivation* needed the fork cut because a fork child's log begins with the seeded parent prefix, including the parent's Assistant settlements; deriving from the whole log would replay the parent's responses as the child's. The persisted seed boundary closes that gap — see [Persist the seed boundary so fork-child replay routes correctly](2026-06-22-fork-child-replay-seed-boundary.md) — and recorded fork + mixed spawn+fork scenarios exercise both transports through one transcript (see [Record fork and mixed spawn+fork snapshot scenarios](../../archived/testing/2026-06-22-fork-snapshot-scenarios.md)).
- Out-of-process (ACP) subagents are a different replay shape entirely (each child is its own PROCESS with its own replay), tracked as `TODO(acp-subagent-replay)` in `subagent-acp`.
