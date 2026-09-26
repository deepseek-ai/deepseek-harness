# Agent Note: Exact-event session forks with shared crash repair

Status: implemented

English | [中文](2026-08-18-arbitrary-seq-session-fork.zh.md)

## Problem

A branch may need the history before a tool result arrives, including a historical position in a parent that has since completed. Restricting forks to completed turns prevents that choice. Reusing crash-recovery result wording would falsely imply that the parent was interrupted.

## Decision

`SessionStore.fork` accepts any existing integer event seq exactly. It owns source membership, child identity and cut validation. `buildForkSeed`, the only export of `dsh-session/fork`, copies the inclusive prefix, inserts the child's inherited `session/end-seed` marker, and closes the open tail. The Host selects and builds from one immutable observation. Omitted `atSeq` means the latest completed turn with its independent tail, stopping before the next turn or queued user input. An explicit seq never moves.

Fork and crash recovery share the same tool-pairing algorithm. Only an open step receives missing error results before `step/end`; an open turn then receives `turn/end`. Closed steps and turns remain unchanged, including historical failures with missing results. The internal cause selects `forked` versus `interrupted`, deterministic result IDs and model-visible wording. Fork wording describes missing inherited records and warns that the parent may have executed the call after the cut. Retry advice distinguishes read-only or idempotent operations from operations with side effects.

The inherited marker precedes synthetic closers. `inheritedEventCount` counts only copied parent events; the marker and closers are child-owned and are persisted before agent publication. A constructor accepts this complete seed only when its supplied cut identifies the final inherited marker. Nested forks retain ancestor markers within their copied prefix. `firstLiveSeq` remains the length of the complete constructor input, distinct from durable inheritance.

V4 admits not-started fork results without changing released V0–V3 validators. Its codec and relationship validator use a private canonical interrupted-result view for this checked variant, then return the original fork ID and message. The V3-to-V4 migration preserves existing events. The `forked` turn-end reason is acknowledged with the finalized V4 header transition.

This replaces the [completed-turn-only controller policy](../../archived/bug-fix/2026-09-11-session-controller-fork-turn-cut.md). Explicit cuts retain the requested event exactly; omitted cuts retain completed standalone work, including manual compaction replacements, until a core-owned turn or queued-input event begins. Plugins continue to own their brackets; the controller does not classify plugin events.

## Alternatives considered

**Move the cut to a completed step.** This changes an explicit historical choice and loses the requested context. Exact cuts with logged closers preserve that context.

**Repair during request construction.** Model-visible results must be logged, so the seed records them before the model request.

**Repair calls in closed steps.** Those failures already belong to the parent; this would expand fork into a new historical repair policy and diverge from crash recovery.

**Expose a Store-dependent fork wrapper.** Store creation rules remain in Store; the pure seed helper needs only event types and the internal closer, avoiding another public entry and a Store file move.

## Consequences

Fork closes the selected open tail, not earlier malformed history. Plugins own their unmatched brackets: no `compaction/end` is synthesized. The inherited marker lets compaction recognize an inherited stale start. Parent and child sequence numbers diverge after the cut. For a new fork, `firstLifecycleSeq` starts at the child-owned marker, so telemetry includes synthetic results and closers. Restored Sessions start this lifecycle after their stored prefix; the durable fork cut alone does not identify new capture work. The chat action retains completed-turn selection; finer event selection is backend functionality and adds no side chat.

## Testing

Session and repair tests cover exact cuts, both error classifications, closed failed steps, empty histories, plugin brackets and surface replacements. Agent-loop regressions verify the actual next model request, preserved results, turn numbering and no repeated tool execution. Host tests cover live and cold sources, exact rejection and queued-input exclusion. V4 tests round-trip original fork result data, reject malformed results and validate nested forks. The keyless `fork-mid-turn` browser scenario forks a cold recording through HTTP and continues through the composer with the branch wording rendered in its expected output.
