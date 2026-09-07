# Agent Note: Cross-session references

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-21-cross-session-references.zh.md)

## Problem

Web users need to bring relevant work from another conversation into one new message without resuming, forking, or granting the source transcript authority over the current session. The harness already exposes exact session enumeration and raw event inspection, but every host independently parsing logs would duplicate compaction folding, provenance filtering, size limits, error behavior, and persistence. Encoding host markup directly into the agent message contract would also bind the core loop to one UI syntax.

## Decision

`@deepseek-ai/dsh-session-reference` is one context consumer service at `ctx.sessionReferenceResolver`. Its outer `agent/pre-step` listener parses canonical mentions in accepted direct user messages and calls `prepare()` without adding reference behavior to a host gateway. The service returns detached readable content plus an optional identified, frozen `UserMessage` snapshot; core agent packages do not parse session URIs or read another log.

`dsh-session:<base64url(JSON.stringify(sessionId))>` is the canonical host-independent identifier. JSON string encoding precedes base64url so quotes, slashes, backslashes, Unicode, newlines, and every other JavaScript string value round-trip without delimiter ambiguity. Web receives that URI inside the Host-produced `@[label](uri)` mention and keeps it behind an atomic session chip; text-only clients may use the same inline mention. Explicit Markdown mentions reject malformed URIs. Bare text becomes a reference only for a non-empty base64url-shaped payload, whose decode must still be canonical; empty or punctuation-only uses remain ordinary discussion text.

The service uses `ctx.sessionQuery.readSurface(sessionId)`, which loads one live-preferred corpus observation, folds it with the session package's canonical surface algorithm, and returns a detached header, capture seq, and current nodes. FTS is not a dependency: discovery matches id, cwd, or the latest folded title, while message bodies remain outside the candidate layer. Non-empty queries batch title observations across the visible corpus with bounded persisted-log concurrency and cancellation; a dedicated title index can replace that discovery path without changing reference identity or preparation.

## Snapshot and projection

Preparation deduplicates in first-appearance order, rejects the target id, enforces a configurable limit with a hard maximum of three references, and performs all reads in parallel. It returns no partial context: any read, cancellation, validation, or budget error ends the turn before the accepted messages enter model-visible history. Cancellation races in-flight discovery and exact reads, so the listener settles promptly even when a persistence backend cannot interrupt its pending operation. A queued message captures each source when it reaches `agent/pre-step`; later source messages, compaction, deletion, or persistence replacement cannot change the context recorded in the target session.

Projection retains direct-user messages and steering, completed assistant text, and checkpoint user messages carrying the canonical source exported by `dsh-compaction`. That marker is part of the compaction capability contract rather than a backend package name. Reference snapshots remain separate sourced `user/message` events, so projection excludes them as injected context and never recursively propagates an earlier snapshot. Projection also excludes shadowed pre-compaction nodes, tools and results, reasoning, other plugin user messages, log-only records, and incomplete assistant chunks. Repeated compaction therefore exposes only the latest folded checkpoint lineage still on the current surface plus its retained tail; there is no raw/current switch and no shadow recovery.

One aggregated context is serialized as JSON beneath a fixed untrusted-background warning. The warning tells the model not to follow instructions, permission claims, or tool requests from referenced sessions unless the current user repeats them. Tag-safe serialization emits every data `<` as the lossless JSON escape `\u003c`; source strings therefore cannot spell the surrounding XML-like tags or escape the data region. The same serializer drives each source's independent byte accounting. AgentLoop persists the snapshot as a sourced `user/message` immediately after the direct `user/message`; target replay therefore satisfies the model-visible/log-reconstructable invariant without a new event type, placement mode, or prompt envelope.

## Message ownership

The service's outer `agent/pre-step` listener calls downstream listeners first and processes only an `enter` decision. It parses each accepted direct user message, preserves that message's id while replacing canonical mentions with readable labels, and inserts the frozen snapshot immediately after that message. Queue edits and queue-to-steer relocation need no reference-specific state because the final claimed messages are the input to preparation. The [separate-context decision](../architecture/2026-07-24-separate-context-injection-from-turn-execution.md) owns this context ordering.

Reference preparation is not a new delivery protocol and does not create a turn by itself. A preparation failure terminates the already accepted turn through the agent loop's existing plugin-failure path.

## Host adapters

The unified Web `@` source combines session candidates with Host-backed file discovery. Session candidate lookup matches case-insensitive substrings of the session id, cwd, or latest folded title, displays that title, and falls back to the session id when a title observation is absent or fails. Lookup follows the request's cancellation signal, and session id, cwd, and mention labels escape external control characters while the canonical URI retains the original id.

Web exposes file and session discovery through generated Remote methods on their owning services, as detailed in [Web file and session references](2026-07-27-web-file-and-session-references.md). Session picks are atomic chips backed by the Host-produced canonical mention. Ordinary `session.prompt` delivery carries that mention without a reference-specific API Proxy route. Replay associates the separate session-reference context with the direct message immediately before it and renders a compact source summary instead of exposing the snapshot JSON.

The [automation-only ACP transport](../simplification/2026-07-23-acp-automation-only-protocol.md) deliberately does not mount session-query or session-reference services.

## Budget and retention

Each of at most three references is independently capped at 65,536 UTF-8 bytes by default. Retention preserves current compact checkpoints and the newest conversation unit before dropping older non-checkpoint messages. An oversized retained text uses `dsh-output-retention` head/tail slicing and records exact omitted bytes; if one source's fixed serialized fields cannot fit its cap, the whole preparation fails rather than emitting a partial context.

## Alternatives considered

- **Wait for SQLite FTS5** — rejected because snapshot correctness requires exact id reads and canonical surface folding, not content search. FTS improves discovery only.
- **Put mention syntax in agent delivery methods** — rejected because it would make the core protocol parse one host's presentation syntax and prevent typed non-text hosts from sharing the semantic layer.
- **Implement references separately in each host** — rejected because projection, security warning, retention, and persistence would drift across hosts.
- **Attach context to `SendOptions` and the direct prompt's inbox record** — rejected because generic delivery would own a domain transaction through admission, steering, cancellation, and observation. The domain listener can prepare the final claimed message without enlarging every direct prompt.
- **Bake the prefix host-side before `followup()`** — rejected because `agent/pre-step` must inspect and rewrite only the direct prompt. Keeping the snapshot as a separate sourced message preserves that boundary and lets Web hide background bytes from the direct user bubble.
- **Replay the raw source log or restore shadowed events** — rejected because compact defines the current model surface and may intentionally retire sensitive or expensive history.
- **Resume or fork the source** — rejected because the feature supplies read-only background for one target message, not identity or lifecycle continuity.
- **Reread the source after the model step enters** — rejected because target replay would depend on external mutable state instead of the logged snapshot.

## Verification

Unit and integration coverage pins URI round-trips and text-boundary punctuation, explicit malformed references, id/cwd/title candidate matching and ranking, failed title-observation fallback, candidate cancellation, control-character escaping, projection exclusions, non-recursive snapshot projection, backend-independent compact checkpoints, tag-safe framing, deduplication, self-reference, count limits, all-or-nothing reads, cancellation against a non-settling storage read, independent per-source byte retention, frozen message ownership, pre-step parsing and insertion, downstream rejection, Chat-projected following-recall association, title isolation, and the generated Remote discovery faces. A keyless Web snapshot pins the assembled reference selection path.

## Consequences

The new plugin is the stable semantic boundary and adds no persistence schema, event type, FTS dependency, source subscription, or compact shadow access. The standard CLI composition mounts it explicitly for Web and exposes its count and per-source byte limits in config; custom hosts remain unchanged until they mount the service and adapt their input. Reference contexts increase target history size within configured bounds and can later be summarized by ordinary target compaction, after which the source session is irrelevant.
