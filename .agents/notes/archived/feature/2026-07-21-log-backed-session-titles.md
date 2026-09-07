# Agent Note: Log-backed session titles

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-21-log-backed-session-titles.zh.md)

## Problem

A session needs a short human-facing title before an editor, terminal, or query consumer can present it usefully. The cheapest implementation can derive one from the first prompt, while higher-quality implementations may call a model over the first prompt or the whole conversation. Those strategies have different latency, cost, routing, and retry behavior, but every consumer needs one durable source of truth.

Session identity metadata is immutable, and the event log is the replay and fork boundary. A model-generated title often finishes after the main turn closes, so writing it synchronously would delay the agent response while writing it as mutable metadata would bypass ordinary persistence, replay, and lineage semantics. Concurrent prompts, provider HMR, cancellation, and ignored abort signals also make an unfenced background result capable of overwriting a newer title.

## Decision

The [`session-title` capability family](../../../../packages/session/README.md) owns title state and generation policy. `@deepseek-ai/dsh-session-title` provides `ctx.sessionTitle`, a deterministic first-prompt fallback, and a registry for at most one optional asynchronous provider. `@deepseek-ai/dsh-session-title-llm` owns the common auxiliary-model request policy; separate first-prompt and all-prompts plugins choose input cadence. `dsh-sdk-minimal` mounts only the fallback service. `dsh-base` mounts that service plus the first-prompt model provider with explicit overridable limits, so a fresh base-backed session gains an immediate fallback and then a non-blocking model summary. Other compositions choose either model provider explicitly.

### Event ownership and folding

Every accepted revision is a log-only `session/title` event. Its payload contains normalized non-empty text, the exact eligible human `user/message` seqs used to derive it, and either the fallback source kind or the registered provider id plus optional provider/model route. Before an auxiliary title-model dispatch, the shared helper appends a log-only `session/title-llm-request` event containing the title-provider id, exact source seqs, route, system prompt, messages, and output-token cap; a later generation failure leaves the request auditable. The dispatched envelope is deep-frozen to preserve exact agreement with that record but carries no process-local agent-loop request identity, so loop-only reconstruction checks do not compare it with the main conversation header. Validation failures that never reach dispatch create no request event. `foldSessionTitle()` selects the latest title event and adds that event's seq and timestamp as `SessionTitleSnapshot`. Neither event enters `session.surface` or `deriveMessages()`.

The title service appends `session/title` directly after checking its current revision and exact live session; the bundled model helper likewise appends its literal `session/title-llm-request` record before dispatch. Both records may sit between turns without inventing an execution boundary. Persistence admits them to bounded background batches and drains through ordinary checkpoints and lifecycle teardown; title publication does not force a per-event flush. No generic marker, cast, or settlement queue sits between the event owner and `Session.append()`. This is the domain-specific application of the [standalone log-only event decision](../simplification/2026-07-28-remove-synthetic-log-only-turns.md).

### Input and asynchronous timing

Only text blocks from human-source `user/message` events are eligible. Empty, control-only, and non-text prompts wait for the next eligible message. The service schedules the first fallback without awaiting it from the prompt path, normalizes whitespace and control sequences, applies the configured word and UTF-8 byte limits without splitting a code point, and records the first message seq.

Automatic provider work starts only after the main loop has a current logged provider/model route. A newly appended `request/header` starts pending work directly; when the header is unchanged, the marked loop-built `llm/stream` request starts it after matching the folded route. Generation then runs independently of the agent response, and a completion appends a standalone event without changing turn state. Explicit `refresh(session, signal?)` materializes any missing fallback and awaits the registered provider; without a provider it returns the fallback. Caller cancellation does not roll back an already accepted fallback event, and `refresh()` rechecks the signal before returning success. Concurrent refreshes reserve their session-local revision before provider work, so a newer call aborts and supersedes an older call before either can invert provider completion order. Automatic work and concurrent refreshes share one session-local in-flight fallback promise, so the first fallback creates only one title event. A title accepted during asynchronous compaction remains log-only, so the compactor's post-summary surface-node check tolerates it; a concurrent surface mutation still invalidates the replacement.

The first-prompt provider schedules once when a fresh session first creates its fallback. An automatic failure does not reschedule on later prompts; `refresh()` is the retry path. The all-messages provider schedules after every eligible human prompt and passes all eligible messages through that revision, including seeded history. Its newer revision aborts and supersedes older pending or active work.

### Registration, routing, and failure policy

`register(provider)` validates one branded stable id, cadence, and generation function, then returns an awaitable effect disposer. A second live registration throws immediately. Provider disposal marks the registration closing, aborts its pending and active work, and waits for every call to settle before removing the registration, so replacement cannot overlap a provider that ignores cancellation. Session disposal aborts its active work. Service teardown prevents queued fallback and provider microtasks from starting, aborts active work, and drains tracked promises before unloading completes. Every session-local generation has a monotonic revision and exact registration identity; acceptance rechecks revision, registration, session liveness, service liveness, and cancellation, so stale output cannot commit.

Model providers require explicit word, CJK-character, input-byte, output-token, and timeout limits. Optional `provider` and `model` overrides are a pair; without them the helper uses the exact route from the logged main request header. Selected messages are framed as JSON under one fixed language-aware instruction. The dispatched `GenerateOptions` carries `purpose: 'session-title'`; the DeepSeek adapter maps that purpose to thinking-disabled and omits reasoning effort so the bounded output is visible title text, while the main conversation keeps its configured thinking mode. The input limit measures the final user prompt, including wrappers, seq fields, and JSON escaping, before the request is logged or dispatched. Oversized input is rejected rather than truncated because truncation would make the recorded source seqs falsely imply complete use. The fused deadline is checked while consuming each stream chunk and after completion, so a successful result returned after timeout cannot be accepted even when an interceptor or adapter ignores abort.

Automatic provider failures are nonfatal warnings and retain the latest title. Explicit refresh failures reject to the caller. Output must be non-empty text with unique ordered seqs drawn from the fixed request; the service normalizes and byte-limits it before log acceptance.

### Explicit rename

`rename(session, title)` accepts a user title synchronously: it normalizes the text under the accepted-title byte limit, supersedes in-flight automatic work, and appends a `session/title` event with the third source kind, `user`. A user-sourced latest title pins the session: `onUserMessage` schedules no automatic revision while it stands, under either cadence. An explicit `refresh()` remains the deliberate unpin — it appends a provider or fallback event over the pinned one whenever a replacement title is derivable (an underivable fallback, e.g. under a tiny byte cap, leaves the pin standing). The Web host exposes this as the `session.rename` unary method (resuming cold sessions first) and returns the normalized title plus its event seq so the client settles its `title` projection cell before the push frame arrives.

### Forks and consumers

A fork inherits seed title events unchanged, like the rest of its source log — a pinned (user-sourced) title stays pinned in the child until an explicit refresh. The first-prompt provider does not automatically retitle a fork. The all-messages provider may append a child-owned revision after a later child prompt, using inherited and new eligible messages.

`ctx.sessionQuery.readTitle()` folds one live-preferred or persisted log without loading titles during `listSessions()`. The TUI uses the latest title as its header subtitle and sets the terminal window title to `<session title> — <configured product title>` after terminal-safe rendering. The Web host folds the same log state into a validated mux control frame after each attached-session subscription baseline and immediately after forwarding a live raw title event. The browser retains only newer title event seqs even when the control frame precedes list or session-instance creation; sidebar labels, search, breadcrumbs, and the browser title then react to the projected revision. `session.list` remains metadata-only, so a cold persisted session uses the cwd basename or id until opening or resuming it attaches the log. The browser title uses `<session title> — <existing HTML title>` only for a selected titled session and otherwise preserves the product title. Consumers reporting agent completion use the core `foldConsumedWork()` fold, so a later between-turn title record cannot replace the preceding message-triggered outcome.

## Alternatives considered

- **Mutable `SessionHeader` or side metadata** — rejected because it creates a second persistence mutation protocol, weakens immutable identity metadata, makes crash atomicity backend-specific, and gives forks ambiguous copy-versus-reference behavior. The append-only log already owns replayable latest-wins state.
- **Await title generation before returning the agent response** — rejected because auxiliary provider latency and failure would sit on the main interaction's critical path. The deterministic fallback gives immediate useful state while a better title may arrive later.
- **Put titles in derived history or the request prefix** — rejected because UI metadata would consume tokens, change cache identity, and make the main model observe its own label. A log-only event remains reconstructable without becoming model-visible.
- **Permit multiple registered providers and resolve precedence after completion** — rejected because completion order is not product precedence and would make retries, HMR, and the recorded provider nondeterministic. A deployment that needs a composite policy can register one provider that owns that policy.
- **Silently truncate oversized auxiliary input** — rejected because the provider result would cite source-message seqs whose complete text it did not receive. Keeping the prior title and warning preserves the exact input record.
- **Index titles in `listSessions()` immediately** — rejected because the existing lightweight metadata list would need per-backend derived-index synchronization. Exact `readTitle()` establishes the read contract without precommitting search or indexing policy.
- **Keep the Web host fallback-only** — rejected because the UI would expose durable titles but never improve them beyond the first-prompt prefix. The first-prompt provider keeps its latency off the main response path while making model summaries the default Web outcome.

## Consequences

- Titles survive JSONL persistence, replay, and fork inheritance without a separate mutable record.
- Web title delivery stays incremental and log-backed without a title index or persisted-list scan; cold list rows improve after attach.
- A fallback appears immediately. Each fresh Web session adds one first-prompt auxiliary call; other compositions choose whether better titles justify model cost and whether later prompts should retitle a session.
- Auxiliary request records and late accepted titles consume event seqs without consuming turn numbers, so persistence exposes both attempted dispatches and accepted updates even though model history and KV-cache identity do not change.
- One provider and monotonic per-session revisions make disposal, supersession, and stale-result rejection explicit, at the cost of leaving multi-strategy precedence to a composite provider.
- Deletion (unpinning without an explicit refresh), search, and list indexing remain outside the capability.
