# Agent Note: Parallel subagent delegations

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-parallel-subagent-delegations.zh.md)

## Problem

A model that wants fan-out batches several `subagent` calls into one assistant message — that batch is the parallel intent. The delegation tool declared no `isConcurrencySafe` classifier, so the fail-closed scheduler ([parallel tool-call Agent Note](2026-07-10-parallel-tool-call-execution.md)) treated every foreground delegation as an exclusive barrier: nine cards in the GUI, one child running, eight queued behind it for its full runtime.

The original conservative stance — a unary classifier cannot prove that sibling delegations have disjoint workspace effects — had stopped protecting anything. `run_in_background: true` and continuable delegations already overlap with every later call, including writes; `dsh-workflow-worker-thread` already runs up to its concurrency ceiling of children through the same `ctx.subagents.start()` providers against the shared workspace. Only the foreground variant was serialized.

## Decision

`dsh-tool-subagent` declares `isConcurrencySafe: () => true` for every call form (foreground, one-shot background, continuable), so sibling delegations in one assistant step overlap under the loop's rolling pool up to `maxParallelToolCalls`, with results still committed in model order.

The declaration satisfies the scheduler's safety contract structurally: a child works in its own session, a run never mutates the parent session (the start-time appends — `sandbox/mode`, `approval/policy`, `subagent/descriptor` — land only in the child's own log), and the tool returns its outputs to the loop for ordered commit. The one-shot background form's one parent-owned write is registering a Task through `tasks.start` — a synchronous, commutative insertion that satisfies the scheduler note's shared-state clause rather than the stronger no-mutation property. The provider seam requires concurrent starts and continuable preparations for distinct children to isolate operation-local state, cancellation, settlement, and cleanup. The bundled providers satisfy that contract: spawn and fork keep no mutable state between starts, fork reads only the parent's completed-turn prefix, out-of-process providers allocate state per run, and the continuation manager reserves a unique child identity and lock for each preparation.

Coordinating sibling workspace effects is the model's responsibility, the stance the product already takes for background, continuable, and workflow children. Peer harnesses agree: Claude Code's Task tool is unconditionally concurrency-safe (cap 10), oh-my-pi's task tool defaults to its overlapping `shared` class, opencode's task tool runs unbounded under its SDK, and Codex sidesteps the question by making delegation an asynchronous spawn/wait mailbox.

Capacity stays where the scheduler note put it: `maxParallelToolCalls` caps one step's unsettled tool calls — and therefore concurrently running foreground children — while background and continuable calls settle at start and free their pool slot, so children they leave running are not capped by it. LLM providers own their own capacity controls.

## Testing

Package tests pin the classifier for both call forms. A gate test drives the registry directly with two children that each block until both have started, proving the half the declaration depends on: the tool body and provider start path tolerate concurrent dispatch — hidden serialization in that stack would deadlock instead of passing silently. A continuable gate holds two provider preparations at the same await, cancels one caller before publication, and proves that the cancelled child leaves no Agent or durable Session while its sibling reaches inbox acceptance and persists independently. The scheduling half, classification actually producing overlap, is owned by the classifier pin and the snapshot below.

The authored `subagent-parallel` snapshot pins the assembled-app transcript: one assistant message carries two subagent calls, the parent log records `tool/call, tool/call, tool/result, tool/result` (serial execution would interleave call/result pairs), and both children complete as separate sessions. Its twin delegations are deliberately identical: `dsh-llm-replay` binds child scripts by first-call order and the harvester orders children by `createdAt`, and neither is deterministic across concurrent children (the `XXX(concurrent-subagents)` marker), so only interchangeable twins replay deterministically.

## Alternatives considered

**Keep delegations exclusive.** The status quo protected nothing: background and workflow children already overlap freely with writes, so serializing the foreground variant only added latency and contradicted the model's explicit batching intent.

**An input-sensitive classifier.** The call's arguments are a free-text description and prompt; nothing in them distinguishes a safe delegation from an unsafe one, so a conditional classifier would be theater.

**A Codex-style asynchronous spawn/wait redesign.** Continuable children plus `send_message` already provide the asynchronous channel; rebuilding the foreground contract around a mailbox would discard a working synchronous result path to solve a scheduling problem one declaration fixes.

**A per-instance `concurrencySafe` config knob.** No consumer needs a serial deployment: `maxParallelToolCalls: 1` already restores global serial execution, and peer-harness prior art defaults delegation to concurrency-safe.

## Consequences

Sibling children can race on shared workspace or external resources; the model owns that coordination, as it already does for every other overlapping child. Concurrent children also compete for LLM provider quota; `maxParallelToolCalls` caps only unsettled calls, not children a background or continuable call left running.

Two one-shot background delegations in one message acquire their model-visible job ids (`subagent-<n>`) in dispatch-race order. The ids are logged, so replay stays valid, but a snapshot scenario that distinguishes its background children would inherit the same determinism constraint as twin child sessions.

Ordered commits may hold a fast child's result behind a slow earlier sibling — the trade the [scheduler note](2026-07-10-parallel-tool-call-execution.md) already accepted; live surfaces still show each child's own progress.

A concurrent-children snapshot scenario with distinct prompts still needs replay-harness support (deterministic child-script binding and harvest ordering); until then such scenarios must use interchangeable twin delegations.
