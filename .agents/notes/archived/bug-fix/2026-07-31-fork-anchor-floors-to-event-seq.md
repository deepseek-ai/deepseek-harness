# Agent Note: Fork anchor floors to an event seq

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-fork-anchor-floors-to-event-seq.zh.md)

## Problem

The fork button on a stopped assistant message did nothing at all — no child session, no error, no visible reaction.

The frozen node behind that message is not a log event. Both the live projection and the history replay mint it with a flow-ordering seq of `turnEnd.seq - 0.9`, placing it strictly after every event of the aborted turn and before the next one, and the chat view hands that node seq to the fork entry point unchanged. `session.fork` accepts a non-negative integer on the wire, so a fractional anchor is rejected as invalid-params before the request reaches the host, and the chat entry's fork call swallows failures. Nothing distinguished the rejection from an inert button.

The host's cut rule was never the obstacle. An aborted turn ends with a logged `turn/end` carrying reason `aborted`, so it is a completed prefix like any other and the anchor simply never arrived.

## Decision

`SessionRuntime.fork` floors `atSeq` before the RPC. The fractional-seq convention belongs to `dsh-client-runtime`, which mints it in both the live and replay projections, so the same package converts it back to a real event seq at the wire boundary instead of every UI caller remembering to. Integer anchors are unaffected.

Flooring lands inside the anchor's own turn rather than clipping backward: every turn opens with `turn/start`, so `turnEnd.seq - 1` cannot itself be an earlier turn's `turn/end`. The host's first-`turn/end`-at-or-after rule then closes on the turn the reader clicked, matching the whole-turn semantics the message-level fork button already promised for completed turns.

The apiproxy fork suite pins the host half of the contract: a floored anchor inside an aborted turn cuts through that turn and seeds the child with it.

## Alternatives considered

**Accept fractional `atSeq` on the wire.** Rejected because the host contract is an event seq, not a position on a continuum; the fractional form is one client's rendering convention, and admitting it would leave `atSeq` alone among the seq-carrying payloads in taking non-integers.

**Hide the fork button on interrupted messages.** Rejected because forking a turn the reader deliberately stopped is one of the strongest reasons to fork at all, and the capability worked host-side the whole time.

**Floor in the chat entry's `forkAt` adapter.** Rejected because `ui-conversation` consumes the fractional convention without owning it; any second fork entry point would have to rediscover the same conversion.

## Consequences

Forking from a stopped turn produces a child seeded through that turn's `turn/end`. The frozen partial text is reconstructed from chunk events and was never an `assistant/message`, so it stays out of the child's model transcript exactly as it stays out of the source's on resume — the child resumes from the same context the source would.

Fork failures stay silent in the chat entry. This bug survived because that call site discards its rejection; surfacing fork errors in the UI is a separate change.
