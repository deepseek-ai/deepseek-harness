# Agent Note: Ordinary forks have no durable creator relationship

Status: implemented

English | [中文](2026-10-23-independent-session-forks.zh.md)

## Problem

Using `parentSession` for both copied history and delegation makes an ordinary fork appear to be a subagent. Consumers can emit false child-start notifications, hide resumable sessions, or impose source-relative ordering. Removing the writer alone leaves historical ordinary forks misclassified and exposes a V4 reader assumption: inherited delivery acknowledgements require a parent id even though the validated seed range already identifies copied events.

## Decision

Ordinary forks preserve their complete selected prefix, `isSeeded`, `inheritedEventCount`, and inherited end-seed marker, but record no source id. Subagents retain their direct creator, including when their backend copies history. `origin: subagent` supplies coarse classification; a valid own-range descriptor separately supplies continuation identity. Historical parent metadata remains readable and unchanged. Runtime Agent ownership remains governed by the [explicit identity decision](2026-08-31-explicit-agent-runtime-identity.md).

The V4 reader permits another Session's delivery id only inside the validated inherited range. Own-range markers still require the current id, and every active-generation `throughSeq` must precede its marker. These checks do not require a persistent source relationship.

## Compatibility

This is a same-version behavior change with no declared persistence-type change. The generated inventory reports no schema transitions, so no new type acknowledgement or finalization checkpoint is needed. Existing ordinary forks and subagent logs retain their meanings, and the new reader accepts both parent-bearing and parentless seeds without rewriting either. Frozen schemas and historical generations remain untouched.

The released `dsh-v0.2.0-rc.2` validator and the reviewed master baseline share the parent-dependent delivery check. Before changing that check, real plain and compressed JSONL probes verified rejection through both read and write opens for parentless ordinary and nested forks, with byte-identical files afterward. Rejection occurs during completed-log relationship validation, before a handle is granted or tail repair runs. Older readers report corruption rather than an upgrade diagnostic; that diagnostic limitation is explicit in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.3/independent-session-forks/guide.md). Parentless seeds without active inherited delivery markers remain readable. This observed admission behavior meets the [safe-refusal rule](../process/2026-10-08-session-reader-compatibility-review.md); optionality alone is not the justification.

## Alternatives considered

**Keep the source under another field.** A replacement such as `forkSourceId` preserves the durable relationship the user chose to remove, along with its downstream maintenance cost.

**Erase parent metadata from existing logs.** Historical mutation loses recorded information and violates immutable-generation guarantees. Consumers distinguish old ordinary forks without cleanup.

**Bump the format solely because older readers reject some new logs.** The existing inherited range and complete-log check prevent unsafe execution and truncation. A global bump and adjacent copy add no protection to this transition; same-version refusal has a documented diagnostic limitation.

## Consequences

Ordinary-fork source tracing is intentionally unavailable in new data. Manual ordering preserves saved positions and treats new forks like other ordinary sessions. Operation-local source access preserves title increments and workspace selection. The [side-session proposal](../../proposed/feature/2026-07-08-interactive-side-sessions.md) retains its separate handback idea but cannot use a stored ordinary-fork parent. Runtime ownership, projection-cache identity, and Team membership decisions remain independently useful and are not superseded.

Verification covers real fork/persist/reopen paths for ordinary, nested, historical, and subagent seeds, rejection without writes for foreign own-range delivery and invalid coordinates, SDK notification classification, ACP resume, client ordering, and title generation. TypeScript and Python recorded SDK scenarios create ordinary and nested forks plus historical parent-bearing metadata while retaining the expected real-subagent lifecycle.
