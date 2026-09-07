---
description: "Canonical Session-log ratings and notes for finalized assistant messages."
kind: "package-reference"
---

# @deepseek-ai/dsh-message-feedback

English | [中文](README.zh.md)

## Summary

This service records positive or negative ratings and optional verbatim notes for finalized assistant messages. The canonical Session log owns every creation, edit, and deletion; `list`, `put`, and `delete` expose current feedback without constructing or waking an Agent. Feedback is log-only and does not enter model history.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount `dsh-message-feedback` alongside `sessions` and `sessionPersistence`. It needs no storage-domain service. The Web bundle supplies the browser consumer and a note limit of 8192 bytes.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxNoteBytes` | required | Positive safe-integer maximum UTF-8 bytes in one optional note. |

A supplied note must contain a non-whitespace character and fit the configured byte limit. Blank notes return `note-blank`; oversized notes return `note-too-large`. Accepted text is preserved exactly, including surrounding whitespace. Omitting a note clears it. Note validation precedes Session lookup.

### Reading and changing feedback

| Operation | Request | Success | Business failures |
|---|---|---|---|
| `list` | Session id | Current items in creation order | Session not found |
| `put` | Session, message, rating, optional note, expected version | Current item | Session or target not found, version conflict, invalid note |
| `delete` | Session, message, expected version | Item absent | Session not found, version conflict |

Create with `ifVersion: null`; edit or delete with the returned version. Stale mutations return `version-conflict` and the current item. Each material put mints a fresh token and preserves the original creation time. A matching no-op put returns the same item without appending an event. Deleting an absent item succeeds regardless of the supplied version, without appending an event. Recreating a deleted item starts a new creation time and ordering position.

Targets must be non-empty assistant messages produced by append-origin events. User messages, empty assistant placeholders, and replacement-origin messages return `target-not-found`. Feedback survives restart; a fork starts without owned feedback even when its inherited prefix contains parent feedback.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Canonical log and durability

`feedback/message-put` stores the owning Session id and complete item, including its version and timestamps. `feedback/message-delete` stores the owner and message id. Current state is derived from these events, ignoring other Session owners. Durable payloads are validated before use. No second feedback store or cache exists.

Live operations append through `Session.append` and await `sessions.flush`, then verify the captured log endpoint and Session header through a persistence read handle before reporting success. Cold mutations hold a persistence write handle across read, validation, comparison, append, flush, and close. Cold reads use a read handle. Neither path constructs a Session or appends lifecycle events.

A per-Session queue serializes operations within one service instance; the persistence write handle excludes competing cold writers. Disposal stops admission and drains admitted operations before releasing the service. Persistence failures reject instead of becoming business failures. A failed flush does not roll back an accepted event; callers can list and retry with its version. Successful no-op mutations also flush the current prefix.

Cold material mutations notify `feedback/committed` after flush with a borrowed read-only canonical prefix; observers must deep-clone it before transferring ownership. Observers finish before write ownership is released, must not await another feedback operation for that Session, and cannot reject an already committed mutation. Live consumers observe `session/event`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Remote service, payload validation, event projection, and persistence ownership |
| [`src/types.ts`](src/types.ts) | Requests, results, and Session event declarations; types only |

No runtime invariant companion is published: the service derives feedback directly from validated canonical events and owns no independently mutable projection.

See the [feedback subsystem](../../../docs/subsystems/feedback.md), [Session persistence](../../../docs/subsystems/persistence.md), and [browser consumer](../../client/ui-message-feedback/README.md) for their respective APIs.

<a id="model-experience"></a>
## Model Experience

### Message feedback

#### What the model sees

Nothing. `feedback/message-put` and `feedback/message-delete` carry no surface placement, tool, prompt section, or model-facing context. Log export and delivery policies belong to their consumers.

#### Token effect

Zero. Ratings, notes, and service results do not enter model requests.

#### KV Cache effect

Independent. Feedback does not change the model request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Log-only authority:** existing `message_feedback` sidecar data is neither read nor migrated. Those files remain untouched, but their feedback is unavailable through this service.
- **Deletion retains history:** delete removes current feedback, not earlier ratings or notes from the append-only log; it is not a privacy-erasure operation.
- **Writer ownership:** another process holding a Session write handle causes cold mutations to reject. The service does not wake that owner or coordinate Remote calls across processes.
- **Trusted callers:** requests contain no authenticated actor or audit identity. Deployments must protect the Host gateway.
- **Telemetry export:** for all users and providers, including `deepseek-official`, the shipped OTel backend in `FEEDBACK_ONLY` releases the complete canonical prefix only after new explicit text feedback, rating/note edits, or withdrawal. The prefix includes context and verbatim notes; later records wait for the next feedback, and `DISABLED` prevents capture. Deployments own redaction; see the [OTel export policy](../../session/session-telemetry-otel/README.md).
- **Scan cost:** each `list`, `put`, or `delete` that reaches an existing Session scans its full event log to derive current feedback; cold operations also read the full log from persistence. Work grows with total Session history, not just the number of feedback items.
- **Retention:** `maxNoteBytes` limits one note, not aggregate log size or mutation count.

<a id="dev-note"></a>
### Dev Note

The [package tests](tests/message-feedback.spec.ts) cover current-state and durable-history semantics; the [Loader composition](tests/loader-composition.spec.ts) verifies live and cold JSONL operations across restart.
