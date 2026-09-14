---
description: "The event-sourced session log and in-memory store for users and maintainers building, inspecting, or extending the durable record behind every agent interaction."
kind: "package-reference"
---

# @deepseek-ai/dsh-session

English | [中文](README.zh.md)

## Summary

`dsh-session` records every model-visible fact in an append-only session log and derives model history from that record. Consumers can inspect, replay, fork, and flush sessions while preserving historical events; compaction hides superseded entries from the active conversation without deleting them. Sessions remain in memory unless a persistence backend is added, and durability checkpoints wait for configured backends. Choose this package wherever an agent needs a reconstructable session record; it does not call models.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-session` wherever a session must exist. It creates and holds event-sourced `Session` instances in memory; durable storage is layered on by a persistence plugin that subscribes to the `session/event` feed.

### Create and inspect sessions

`ctx.sessions.create()` builds a live session bound to the calling fiber; `get(id)` and `list()` find sessions, and `fork()` creates a child session from a stable prefix of a live one.

```text
const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
ctx.sessions.get(sessionId)      // the live session
ctx.sessions.list()              // every live session, in creation order
```

### Append and derive

`session.append(type, data, opts?)` commits one typed event — it snapshots and freezes the payload, validates it as lossless JSON, and notifies observers. `session.deriveMessages()` projects the log into the `Message[]` the model sees, incrementally and cached:

```text
session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  { surfaceOp: 'append' })
session.deriveMessages()         // the derived model history
```

Surface events (`system/message`, `user/message`, `assistant/message`, `tool/result`) require `surfaceOp` in both typed events and append input. A replacement uses exactly `{ op: 'replace', startSeq, endSeq }`, with inclusive `SessionSeq` endpoints in current surface order. An Assistant message embeds its exact compact provider stream and forbids `sourceEventSeqs`. Known log-only events forbid both metadata fields and never produce a message.

Plugins declare content-changing events with `@messageProjection` and register a pure definition through `ctx.sessions.registerMessageProjection()`. Session calls the definition before accepting an event and caches its immutable message updates. Missing definitions reject append and restore; unloading a used definition also blocks cached reads. Detached constructors and `foldSurface(events, projections)` require explicit definitions. Reconstructors pass the fold's `projectedMessages` to `deriveEventMessage()`; live instance methods apply the same projections automatically. [Plugin-owned message projections](../../../.agents/notes/implemented/architecture/2026-09-11-plugin-owned-message-projections.md) defines ownership and offline assembly.

Append, seed/restore, and event adoption/snapshot reject any `header.system` and exactly empty optional request-header fields (`tools: []`, `adapterDefaults: {}`) instead of normalizing input. Tool-result `data.error` is allowed only when `message.content[0].isError === true`; failure identity remains optional. Rejected appends do not change the log, derived state, or event feed. Adoption validates event-local metadata but not referenced history or replacement membership.

`system/message` holds the rendered system prompt: the first one is surface node 0, the prepared call capability governs admission, with a non-empty rendering consolidated at the first system node on an incapable route or appended after cached history inside a continuing `in-history` series; empty system nodes project to no message, so clearing the prompt requires logged empty replacements of all active system nodes, not just the latest; the surface fold rejects a replacement covering node 0 while it is a `system/message` unless the replacing event is itself a `system/message` over exactly that node, while later system nodes carry no protection and a compaction range may shadow them ([decision](../../../.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md)).

### Read the log

`session.seq` reads the current log length without materializing an array, and `session.eventAt(seq)` reads one accepted, deeply frozen event by sequence number. `session.snapshotEvents(fromSeq?, toSeqExclusive?)` materializes a frozen, stable snapshot of a half-open range; a complete current snapshot is cached until the next append. `eventAt()`, `snapshotEvents()`, and `ownEvents()` are deprecated: existing logic may remain unmigrated for now, but new production calls are prohibited. Repository test files may use these three readers under their scoped lint allowance ([policy](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)). Callers that only need a length use `seq`.

Session log positions use two numeric types. `SessionSeq` identifies an existing event or inclusive event watermark; `SessionLogOffset` identifies a gap, prefix length, or read boundary and may equal the event count. `SessionSeqCursor` adds the `-1` “no event yet” value, while `OptionalSessionSeq` uses `null` when absence is data. The constructors validate non-negative safe integers, and the brands disappear at runtime, so durable JSON and wire values remain ordinary numbers.

### Fork a session

`ctx.sessions.fork(source, boundary?, childSessionId?)` selects source events through an inclusive `boundary` seq (default: the current last event), requires the prefix to end outside an open turn, and creates a live child session with lineage metadata. A tool-time delegation that must branch mid-turn clips to a completed prefix instead.

The logical `SessionHeader.isSeeded` field reports whether fork history exists without exposing a positional integer. `Session.inheritedEventCount` retains the exact checked `SessionLogOffset`; `ownEvents()` returns events at and after that cut, and `isOwnSeq(seq)` accepts only an existing child-owned position. A low-level seeded constructor must supply an explicit `seed` and `inheritedEventCount` because the constructor seed can contain child-owned setup events after the inherited prefix.

### Flush durable state

`ctx.sessions.flush(session)` dispatches the awaited durability checkpoint: every persistence listener flushes and the call settles after all of them. A producer that needs an immediate durability barrier awaits it instead of assuming the write-behind drained.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is built on event sourcing: a `Session` is an append-only log of typed `SessionEvent`s, and everything else — model history, transcripts, telemetry, titles, persistence — derives from that stream. The surface is a derived projection: an incremental manager validates append candidates, advances the ordered view from committed events, and tracks `replaceGeneration` for positional replacements and `contentGeneration` for replacements and plugin-owned message changes. Model-visible means logged: anything that reaches a model request must be reconstructable from the log. Each model attempt that reaches settlement commits one event: `assistant/message` carries the assembled model-visible message plus its compact timed stream, while `assistant/attempt` retains a failed, retried, cancelled, or stream-error attempt without adding model history. A hard process loss before settlement leaves no durable attempt stream.

### Request headers

`request/header` stores a full canonical snapshot of the non-history request envelope with reason `initial`, `resume`, `change`, or `series`. An explicit message-series start, a surface replacement, or a plugin-owned message change writes a `series` snapshot when the envelope is unchanged; a simultaneous change uses `startsSeries: true`. Same-series steps, retries, and ordinary later turns inherit the latest snapshot. `adapterDefaults` distinguishes values resolved by the adapter from explicit settings, and `foldRequestHeader()` selects the latest snapshot. This self-contained record supports partial-window rendering and exact reconstruction at the cost of growth per message series; the [reconstructable-requests Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md) owns the detail.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SessionStore` service, store lifecycle, `fork`, `flush` |
| [`src/types.ts`](src/types.ts) | `SessionEventMap`, `SessionEvent`, `UserMessage`, `SessionHeader`, `TurnEndReasonMap` |
| [`src/surface.ts`](src/surface.ts) | Ordered surface projection, replacement validation, `deriveEventMessage` |
| [`src/request-header.ts`](src/request-header.ts) | `request/header` folding and reconstruction |
| [`dsh-util-values`](../../util/values/README.md) | Shared lossless JSON validation and detached snapshots |
| [`src/repair.ts`](src/repair.ts) | Cold repair of crash-orphaned logs |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: seq, turn/step enclosure, tool call/result pairing |

### Append validation

Every append uses the shared iterative `snapshotJsonValue()` pass, which reads, validates, and copies each nested value once, so a stateful getter cannot supply one value to validation and another to storage. Non-lossless-JSON payloads (BigInt, cycles, sparse arrays, `-0`, exotic prototypes) are rejected at the append site, before any backend flush. The append path constructs each `SessionSeq`; surface events additionally validate marker shape, cited source-event sequences, and complete shadowed-node coverage for replacements.

### Derived history

`deriveMessages()` caches deep-frozen projections and returns a fresh array per call. The four surface event types (`system/message`, `user/message`, `assistant/message`, `tool/result`) supply their recorded message identities and content; an empty-content system node projects to no message. Plugin-owned projections change derived content without mutating recorded messages. Replacements and projection decisions invalidate the cache. Embedded Assistant streams and `assistant/attempt` events remain replay and diagnostic data only.

### The request header

The loop logs a full canonical `request/header` snapshot (call config, adapter defaults, assembled tool schemas — the rendered system prompt is a `system/message` surface node, not header state) at each loop-instance boundary and on change; `foldRequestHeader(events)` reconstructs it by selecting the latest snapshot, making every conversation request a pure function of the log. Route metadata (`request/context`) is separate logged state appended only when the provider, model, capacity, or `systemPromptUpdate` mode differs; it records the actual prepared call's mode after prompt and user admission, rather than supplying that admission decision.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [Session subsystem](../../../docs/subsystems/session.md) — the full event vocabulary, surface types, and generated service API.
- [Persistence subsystem](../../../docs/subsystems/persistence.md) — how backends make this log durable.
- [Core subsystem](../../../docs/subsystems/core.md) — the loop that writes and derives from sessions.
- [Generated persistence catalog](../../../docs/persistence-catalog.md) — every session event with its payload and declaration site.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### Derived message history

#### What the model sees

The model receives the complete messages from `system/message`, `user/message`, `assistant/message`, and `tool/result` surface entries with logged projections applied, the system prompt first. Identities, roles, sources, and unmodified blocks retain their original values; projections never mint identities. Direct prompts and injected context remain separate `user/message` events whose sources preserve their attribution. Embedded streams, `assistant/attempt`, boundaries, and other log-only facts add no message.

#### Token effect

Appended surface entries are resent on later steps. A `replace` surface operation removes the shadowed entries from future inputs without deleting their raw log records.

#### KV Cache effect

Appended surface entries preserve reusable prefixes. A `replace` operation invalidates reuse from the first shadowed message even though the underlying event log stays append-only.

### Crash-repair result

#### What the model sees

If recovery finds an assistant tool request with no durable `tool/call`, its synthetic `TOOL_NOT_STARTED` result says `The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.` If a durable `tool/call` has no result, its `TOOL_OUTCOME_UNKNOWN` result says `The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.`

#### Token effect

Zero tokens in an intact session. Each repaired call adds its retained risk-specific error text on resume.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Logged request header

#### What the model sees

The session reconstructs the tool schemas and call config that the loop actually sent; the system prompt is part of `deriveMessages()` as surface node 0 and, after an in-history update, as the latest system node. Header events add no message to history and hold no copy of the prompt.

#### Token effect

Zero duplicate tokens from logging. The system nodes and schemas still incur their normal per-request cost.

#### KV Cache effect

Logging causes no invalidation, and exact reconstruction preserves request-prefix identity. A later header with changed config or schemas may invalidate reuse from its first difference; a prompt change that replaces surface node 0 invalidates reuse from the first token, while an in-history append keeps the prefix through the cached history reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the session store needs special care. They are current package constraints, not a task backlog.

- **`fork()` cuts only at stable boundaries of live sessions** — the selected prefix must end outside an open turn and the source must be in the store; forking a persisted-but-unloaded session is excluded from the fork API.
- **`SESSION_FORMAT_VERSION` names the [current logical representation](../../../docs/session-format-status.md)** — the current reader rejects retired `header.system` and validates `system/message` payloads and protected-head rewrites. Historical headers and events belong to adjacent format packages; the adjacent migration chain converts supported history before constructing `Session`, and the write-open path publishes only the current-format successor. Equal-version unknown events require the envelope's explicit `ignorable` marker, which does not promise safe structural migration ([mechanism](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md)).
- **`TurnEndReasonMap` omits the ACP-named `refusal` / `max_turn_requests` variants** — producer-gated: they land when an adapter or the loop first emits them.
- **No session tree beyond fork** — a pi-style entry tree over branched sessions is deferred unless a consumer needs more than boundary-based forking.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
