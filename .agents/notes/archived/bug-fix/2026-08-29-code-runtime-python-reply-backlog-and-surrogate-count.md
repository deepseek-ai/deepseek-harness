# Agent Note: Bound the reply backlog and count lone surrogates without a match list in the CPython backend

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-29-code-runtime-python-reply-backlog-and-surrogate-count.zh.md)

## Problem

A further review round on the CPython subprocess backend (packages/experimental/code-runtime-python) surfaced two unbounded-allocation findings. First, `replyQueue` had no bound: a child that never reads fd 3 keeps the reply pipe full forever, so the drain loop waits on `drain` while every call frame it keeps sending resolves a binding and queues another reply — the backlog (and the binding results it pins) grows until the wall clock. Second, `_json_str_cost` counted lone surrogates with `_SURROGATE.findall(folded)`, which materializes one single-character string per surrogate: a surrogate-dense completion value near the budget (each surrogate serializes to six bytes, so a budget-sized value holds millions of them) allocates millions of objects before the meter returns, defeating the meter's own contract of counting without building.

## Decision

### The reply backlog is capped at 1024 pending frames

`sendReply` now counts pending replies separately from the consumed slots the drain loop clears, and settles the run as a `worker-exit` with a reply-queue message before pushing when the backlog reaches `MAX_PENDING_REPLIES`. The counter is decremented as the drain writes each frame and reset when the drain finishes, so it measures only replies the host still holds. This mirrors the frame cap's treatment of an oversized inbound frame: a child that stops participating in the protocol fails the run early instead of growing host memory until the wall clock. It is a count bound, not a byte bound — binding results carry no seam-level byte cap, so the bound limits how many are retained, not how large any one is.

### Lone surrogates are counted by length difference, not by a match list

`_json_str_cost` computed `lone = len(_SURROGATE.findall(folded))`, building a list of one single-character string per lone surrogate. The count is now the length difference between `folded` and `without = _SURROGATE.sub("", folded)`: after pair-combining, every remaining surrogate is lone and exactly one code point, so the number removed is the count, and the `without` string is needed by the meter anyway. The meter returns the identical byte cost with no per-surrogate objects.

## Testing

- `tests/runtime.spec.ts` — a hostile child floods 5000 sequential valid call frames and never reads fd 3; the run settles as `worker-exit` with the reply-queue message long before `maxWallMs`, proving the backlog cap fires instead of a wall-clock timeout. A surrogate-dense completion of 3,000,000 lone surrogates pins the boundary at scale: 18,000,002 serialized bytes succeed at an 18,000,002 budget and report `output-limit` one byte under, proving the meter counts every surrogate exactly (the len-diff is verified equal to the old findall count across lone-high, lone-low, paired, astral, and mixed cases).

## Alternatives considered

**Pause the fd-3 read side while waiting for drain instead of capping the queue.** Rejected: pausing reads would also stall processing of `done` and `log` frames the child may send after its last call, changing settlement timing; a count cap is deterministic and matches the existing frame-cap pattern.

**Keep findall and rely on the character-count lower bound.** Rejected: the lower bound admits a string by CHARACTER count while each surrogate serializes to six bytes, so a budget-sized surrogate-dense string passes it and reaches the meter; the match list is exactly the allocation the meter exists to avoid.

## Consequences

A child that stops consuming its replies now fails the run as a `worker-exit` once 1024 replies are retained, bounding host memory without a wall-clock wait. The completion-value meter counts lone surrogates with no per-surrogate allocation, keeping its documented counting-without-building contract for surrogate-dense values.
