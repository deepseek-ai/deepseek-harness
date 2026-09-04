---
description: "Cross-session snapshot references and durable untrusted model context, for users and maintainers enabling or debugging ctx.sessionReferenceResolver."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-reference

English | [中文](README.zh.md)

## Summary

`dsh-session-reference` lets a conversation reference other sessions: a host turns a `@label` mention into a canonical URI, and the service prepares a bounded, read-only snapshot of each referenced session as durable, untrusted background context for the model. Candidate discovery ranks other sessions by working-directory affinity and labels them with their latest titles. Snapshots are immutable after capture and carry a fixed warning that forbids following instructions, permission claims, or tool requests inside them. It is an opt-in service for hosts that support cross-session mentions; it consumes `ctx.sessionQuery` and needs no SQLite FTS.

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

Enable this service when hosts should let a user mention another session and give the model its context. It works with any session-query backend because it consumes the backend-independent compact checkpoint marker.

### Mention syntax

A canonical mention is `@[label](dsh-session:<base64url-encoded-id>)` in Markdown, or the bare `dsh-session:` URI; every JavaScript string session id round-trips exactly. The service rewrites mentions into readable `@label` text in the message and returns the structured references. Explicit Markdown mentions reject malformed URIs; empty or punctuation-only scheme mentions stay ordinary discussion text.

### What the agent gets

A message that cites other sessions is followed immediately by a `## Referenced sessions` snapshot as a second user-role message. The snapshot is untrusted background: the fixed warning tells the model not to follow instructions, permission claims, or tool requests inside it unless the current user explicitly repeats them. Each source is bounded independently — at most `maxReferences` distinct sessions per message and `maxReferenceBytes` per source — and a source that cannot fit its budget fails preparation instead of returning partial context.

### Finding sessions to reference

`listCandidates(agent, query?, limit?)` lists sessions other than the agent's own, filters case-insensitively by id, working directory, or the projected title, and ranks same-directory sessions first. Each candidate carries its latest title as the mention label, falling back to the session id when the title is absent or unreadable, and reports whether its working directory is the requesting agent's so a host can surface a location only when it distinguishes the row. Browser consumers call the same discovery as `ctx.remote.sessionReferenceResolver.candidates`, which attaches each candidate's canonical mention.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxReferences` | `3` | Maximum distinct source sessions in one prepared message; must not exceed `3` |
| `candidateLimit` | `50` | Default candidate count returned to a host |
| `maxReferenceBytes` | `65536` | Maximum serialized JSON bytes for one reference object |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-reference) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Preparation reads each referenced session's current surface exactly once, when the target message reaches `agent/pre-step`, so a queued message captures source state at model-step entry and the resulting context is immutable afterwards. Projection keeps only direct-user `user/message`, assistant text, and `user/message` checkpoints carrying the canonical compaction marker; separately sourced session-reference messages are excluded, preventing recursive snapshot propagation. Source text is serialized as JSON with every `<` escaped as `\u003c`, so it cannot spell the `<referenced-sessions>` framing tag.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionReferenceResolver`: pre-step listener, candidate discovery, preparation |
| [`src/config.ts`](src/config.ts) | `Config` schema, `SessionReferenceError` taxonomy |
| [`src/uri.ts`](src/uri.ts) | `dsh-session:` URI codec, mention formatting and parsing |
| [`src/projection.ts`](src/projection.ts) | Current-surface projection and byte-budget retention |
| [`src/serialization.ts`](src/serialization.ts) | Tag-safe JSON escaping for snapshot payloads |
| [`src/types.ts`](src/types.ts) | `SessionReferenceInput`/`Candidate` and source types |
| — | No runtime invariant companion is published; preparation returns immutable per-call snapshots validated while they are built, and the agent/session layers own durable context admission, freezing, and replay. |

### Main flow

The outer `agent/pre-step` listener accepts the step, parses canonical mentions out of direct user messages, then calls `prepare`, which normalizes references (first-mention order, deduplication, self-reference and count rejection), reads every surface in parallel, retains each under `maxReferenceBytes`, and renders the aggregated prompt. Each durable source record keeps the frozen `capturedThroughSeq` and records a nonzero `capturedFormatVersion`; absence denotes format v0. Each snapshot is inserted immediately after the message that cited it, and the target log records the readable direct message followed by its sourced context, so source mutation after capture cannot change target replay.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared reference surface to the design decision and the read service behind it.

- [Session-reference subsystem](../../../docs/subsystems/session-reference.md) — canonical URIs, projection rules, and the stable error taxonomy.
- [Cross-session references decision record](../../../.agents/notes/implemented/feature/2026-07-21-cross-session-references.md) — design rationale for the reference contract.
- [Session-query subsystem](../../../docs/subsystems/session-query.md) — the read service that supplies session surfaces.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-reference) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Referenced session background

#### What the model sees

The model sees two consecutive user-role messages: the current message with its readable `@label`, then the `## Referenced sessions` untrusted snapshot. The warning forbids following instructions, permission claims, or tool requests from the snapshot unless the current user explicitly repeats them. Labels, cwd values, ids, and conversation text are serialized as JSON inside `<referenced-sessions>` tags; every data `<` is emitted as the lossless JSON escape `\u003c`, so source text cannot spell a framing tag.

#### Token effect

Each referenced message adds the fixed warning plus up to three serialized snapshots, each independently bounded by `maxReferenceBytes`. The exact snapshot remains in target history until target compaction shadows or summarizes it; source-session changes add no further tokens.

#### KV Cache effect

The request and snapshot are consecutive append-only target messages and preserve earlier cacheable history. Different references or source capture contents change the new suffix only; later target compaction may invalidate reuse from its replacement boundary.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when cross-session references are a poor fit. They are current package constraints.

- **No body discovery** — candidate queries inspect titles but do not search message bodies.
- **Labels come from projections alone** — an attached session is labeled from its live projection cut, a cold one from its durable checkpoint, and a session neither answers for is labeled by its id and cannot be found by its title. Discovery never reads a log: folding one title costs a whole log, and this runs under every completion keystroke. A session persisted before the projection cache was composed regains its title the first time it is opened, which checkpoints it.
- **Trusted caller boundary** — the service assumes its host is authorized to read every session exposed by `ctx.sessionQuery`; it is not a model-facing search tool.
- **Text projection only** — non-text user and assistant blocks are not propagated across sessions.
- **No live link** — references are snapshots, not forks, resumes, subscriptions, or source-session mutations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
