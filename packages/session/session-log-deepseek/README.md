---
description: "Incremental canonical session-log upload for deployments enabling official DeepSeek request metadata."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-deepseek

English | [中文](README.zh.md)

## Summary

Incremental canonical session-log upload for official DeepSeek LLM API requests. This function plugin injects `ctx.sessions` and `ctx.deepseekLlmApiExtensions`, then owns the `dsh_session_log` request field and the durable `session-log-deepseek/delivery-accepted` event from which it derives the acceptance watermark. Disable it only when the official API must not receive a Session-log suffix.

## Table of Contents

- [Configuration](#configuration)
- [Request field](#request-field)
- [Acceptance and retry](#acceptance-and-retry)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Register the `dsh_session_log` contribution. Set it to `false` to stop Session-log upload. |
| `maxBytes` | 8 MiB | Largest serialized `dsh_session_log` field, in UTF-8 bytes, that one request carries. |

Shipped profiles mount the plugin, so the default configuration registers the request field and appends the acceptance watermark; an overlay opts out with `enabled: false`.

<a id="request-field"></a>
## Request field

For a request carrying a live `sessionId`, the plugin folds the greatest accepted watermark for that exact Session format generation, snapshots `Session.events`, and sends the longest contiguous run after the watermark that fits `maxBytes`. A process-local fold scans each event once and consumes later appends incrementally; restart and HMR rebuild it from the durable log. The version-1 field contains `sessionFormatVersion`, a raw session header (`seedLength` is present only for a seeded Session), numeric `afterSeq` and `throughSeq`, and every complete canonical event translated to raw-number envelope fields. Forked sessions ignore inherited parent watermarks because both the recorded Session id and format generation must match the request source. Surface events require `surfaceOp`, with numeric `startSeq` and `endSeq` for replacements; only system, user, and tool events may carry `sourceEventSeqs`. Assistant provider metadata stays in the embedded stream, and log-only events carry neither metadata field.

`maxBytes` bounds the complete serialized field in UTF-8 bytes, including the header and numeric envelope fields. A backlog above the limit drains across consecutive accepted requests, each continuing after the previous `throughSeq`. When the first pending event alone exceeds the limit, the request omits `dsh_session_log`, the plugin logs a warning, and the watermark stays before that event until `maxBytes` admits it. An event too large for the runtime to serialize at all is handled the same way, and no `maxBytes` value admits it.

<a id="acceptance-and-retry"></a>
## Acceptance and retry

The DeepSeek adapter calls the prepared contribution's `accept()` after HTTP 2xx, before it consumes the SSE body. Acceptance appends `session-log-deepseek/delivery-accepted` with the uploaded `throughSeq` and `sessionFormatVersion`; a record that omits the format field denotes v0. The next request uploads that event as part of its new suffix. Transport failures, non-2xx failures, and requests that the DeepSeek adapter sends without extension fields after they fail to serialize append no acceptance record, so later requests resend the uncertain range. Concurrent deliveries may be accepted out of order; folding the maximum matching `throughSeq` prevents cursor regression.

A crash after server acceptance but before the watermark reaches persistence can replay an accepted range after restart. This is the at-least-once failure direction: uncertainty creates duplicates, never a skipped sequence. The ordinary session checkpoint policy persists the watermark at the next semantic checkpoint; this plugin performs no independent I/O.

Direct requests without a live Session omit `dsh_session_log`. Normal agent, compaction, and session-title calls carry their live Session id.

<a id="model-experience"></a>
## Model Experience

### Session-log metadata

#### What the model sees

Nothing. `dsh_session_log` is a sibling of the DeepSeek request's model-input fields and is not inserted into `messages`, the system prompt, or tool schemas.

#### Token effect

Zero model-input tokens; the field only increases HTTP request bytes, bounded by `maxBytes`.

#### KV Cache effect

None; the model-visible request prefix remains unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Crash-window duplicates** — a 2xx followed by process loss before the acceptance watermark persists causes conservative replay on resume.
- **No live Session means no field** — direct or stale-session calls have no canonical log to snapshot; explicit absence semantics remain deferred.
- **An oversized event stalls upload** — an event whose field alone exceeds `maxBytes` is not sent, and later events wait behind it until the limit increases; an event too large to serialize at all stays blocked.
- **Provider rejection fails the request** — a provider that rejects the request because of this field fails the model request and leaves the cursor unchanged instead of truncating the log.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
