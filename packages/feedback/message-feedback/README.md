---
description: "Per-message ratings and notes for finalized assistant messages, for users and maintainers choosing, composing, or debugging the feedback service."
kind: "package-reference"
---

# @deepseek-ai/dsh-message-feedback

English | [中文](README.zh.md)

## Summary

`dsh-message-feedback` lets product surfaces offer per-message feedback: a user marks an assistant message positive or negative and can attach a short note, and the rating stays with that message. Ratings are stored with the session, survive restarts, and never enter model history or telemetry. Product surfaces read, create, and change ratings through the `messageFeedback` service, whose `list`, `put`, and `delete` operations are the whole surface. The one deployment setting is the maximum note length (`maxNoteBytes`), which the Web bundle sets to 8192. Browser controls live in a separate client package; this package provides the service itself.

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

Choose this service when a product surface should let users rate and annotate individual assistant messages. Feedback attaches only to a finalized message — one that has already been sent — and using the service never starts or resumes an agent. A custom app mounts the service together with session persistence and storage; the shipped Web bundle already composes all of it with `maxNoteBytes: 8192`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxNoteBytes` | required | Maximum UTF-8 byte length accepted for one optional note. |

```yaml
- id: message-feedback
  name: '@deepseek-ai/dsh-message-feedback'
  config:
    maxNoteBytes: 8192
```

A note must contain at least one non-whitespace character and fit within the configured byte length; a blank note is rejected with `note-blank` and an oversized one with `note-too-large`. Accepted text is stored exactly as submitted — nothing is trimmed. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-message-feedback) is the exhaustive source for every accepted field and its JSDoc.

### Reading and changing feedback

Callers use three operations to read and change feedback for a session:

| Operation | Request | Success | Rejected when |
|---|---|---|---|
| `list` | the session id | the current ratings and notes, in creation order | the session is not found |
| `put` | session, message, rating, optional note, expected version | the stored rating and note | session not found, message is not a valid target, version conflict, blank or oversized note |
| `delete` | session, message, expected version | the rating is absent | session not found, version conflict |

Every change must be based on the version the service returned for that rating: a change based on an older version is rejected with `version-conflict`, and the reply carries the current rating so the caller can see what changed without another read. Deleting a rating that is already absent succeeds, and concurrent changes to different messages do not conflict. An omitted note clears an existing note.

### What you can rate

A rating attaches to one finalized assistant message: the message must exist and be an assistant message that was sent. User messages, empty assistant placeholders, and replaced messages are not valid targets and are rejected with `target-not-found`. Once recorded, the rating and note stay with that message and survive restarts; a fork of the session starts with no feedback.

### Durability

A rating is committed only after the message it refers to is durably stored, so feedback never points at a message that can be lost. Reading or writing feedback never starts or resumes an agent; the service inspects the persisted session directly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The service keeps feedback outside the session log entirely: each session owns one sidecar row in a storage domain, so a rating can never be confused with conversation content, model history, or telemetry. The sidecar is only ever committed after the message it references is durable — the row extends the target log instead of preceding it. Every operation returns a business result that distinguishes a handled failure (missing session, invalid target, stale version, bad note) from an infrastructure failure, which rejects instead of being mislabeled.

### What a sidecar holds

One row per session binds the inspected session identity (`createdAt`, `cwd`) to its feedback items; the identity fences a reused session id, so a row from an earlier lifecycle is invisible and a fork starts with no feedback. Items are immutable values — a change writes a new version of the item, preserving its creation time — and the row schema rejects duplicate message ids and reused versions so lookup stays unambiguous. The exact row schema and validation live in [`src/spec.ts`](src/spec.ts).

### Concurrency

Mutations are optimistic and per message: a caller sends the version it last observed, a stale version is rejected with the authoritative current item so the caller reconciles without another read, and every material change mints a fresh version token so a stale write can never masquerade as current. A per-session queue serializes the whole read-compare-write through one service instance; storage provides no cross-process conditional write, which is the Known Limitation below.

### Durability and target validation

A write is staged, verified, then committed: the target message is flushed through the canonical checkpoint, the physical log prefix is re-read, and only then is the sidecar row written — feedback can never reference a message that is not durable. Cold sessions are read without resuming an agent, absence is decided by the persistence store's `stat` rather than guessed, and only a real, sent assistant message is a valid target. The flush and read path lives in [`src/index.ts`](src/index.ts).

### Failure modes

The service fails closed: disposal drains in-flight writes before closing the domain, a write submitted after disposal starts is rejected as a lifecycle failure, and invalid configuration or a read before domain initialization fails loudly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service class: config validation, per-Session queue, durability barrier, `@Remote` methods |
| [`src/types.ts`](src/types.ts) | Public request, value, and failure vocabulary (types only, for generated Remote clients) |
| [`src/spec.ts`](src/spec.ts) | Storage-domain declaration: `message_feedback` domain, `sessions` table, row schemas |
| — | No runtime invariant companion is published; the private typed writer owns current row mutations, the domain schema validates rows on reopen, and no second authority exists. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the subsystem types and design boundary to the persistence primitives and the browser consumer that drives this service.

- [Feedback subsystem](../../../docs/subsystems/feedback.md) — the public types, Remote contract, and Web consumer details.
- [Message-feedback sidecar decision](../../../.agents/notes/implemented/architecture/2026-08-10-message-feedback-sidecar.md) — the design boundary that keeps this sidecar out of Session-log content.
- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — the handle `read`, `stat`, and `flush` semantics behind the durability barrier.
- [dsh-client-ui-message-feedback](../../client/ui-message-feedback/README.md) — the browser consumer that drives the Host Remote contract.
- [Feedback package map](../README.md) — where per-message feedback sits next to the log-only capture command.

-----

<a id="model-experience"></a>
## Model Experience

### Local message-feedback state

#### What the model sees

Nothing. `ctx.messageFeedback` registers no tool, prompt section, model-facing context, or Session event; feedback stays in a Host-owned sidecar unless a separately documented Consumer explicitly exposes it.

#### Token effect

Zero. No request, result, rating, note, timestamp, or failure from this package enters a model request.

#### KV Cache effect

Independent. Listing or mutating message feedback does not touch a model request prefix and cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the service is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Compare-and-set is single-process** — the per-Session queue serializes one service instance only; storage-domain has no cross-process conditional write, so multiple Host processes writing one storage root can still lose updates.
- **No durable Session deletion cascade** — Session persistence has no deletion API, and `session/disposed`/`api-session/removed` mean detach rather than durable deletion. The service therefore retains empty rows and may leave orphan rows after out-of-band log removal instead of deleting valid feedback on detach.
- **Header identity is not a content fingerprint** — `{createdAt, cwd}` detects reuse only when those fields differ; a cloned log retaining the same header identity is indistinguishable.
- **Trusted caller boundary** — `list`/`put`/`delete` carry no authenticated actor or audit identity. A deployment must expose the Host gateway only through its trusted or separately authenticated boundary until authorization and attribution are added.
- **Row bounds** — `maxNoteBytes` bounds one note, but the item count and aggregate retained bytes of one Session row are not capped; a deployment-owned row bound remains deferred until a concrete consumer defines its policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- The browser controls and the client Remote mount live in `dsh-client-ui-message-feedback` and `dsh-api-remotes`; their open items belong to those packages' notes.
- The trusted-caller limitation is the open authorization direction: the Host gateway records no actor or audit identity, and any authentication layer must land at the deployment boundary before the service exposes per-user attribution.
- Note validation precedes Session lookup by design, so `note-blank` and `note-too-large` win over `session-not-found` for a missing Session; tests pin this order.

</details>
