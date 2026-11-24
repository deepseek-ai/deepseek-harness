# Agent Note: IM architecture in v4

Status: implemented

English | [中文](2026-10-25-im-architecture-v4.zh.md)

## Problem

An IM integration has to answer three independent questions: what the platform delivered and what a session is allowed to do with it, which session should receive an incoming message, and how a running turn should be displayed in the chat. Combining routing and output rendering inside the core IM service forces every deployment onto a single routing strategy and a single platform payload builder, and requires modifying the core whenever a new slash command, routing strategy, or output format is needed.

## Decision

`@deepseek-ai/dsh-experimental-im` is a platform-neutral host: it admits and stores platform messages, hosts agent sessions, enforces chat bindings and publication receipts, and tracks turn activity. Routing, slash commands, background tasks, and turn output rendering are separate plugins.

### The host

[`ImService`](../../../../packages/experimental/im/src/index.ts) provides `ctx.im` (`sessions`, `history`, `outputs`, `send`, `stream`, `format`, `bot`, `chat`, and `status()`) as defined in [`api.ts`](../../../../packages/experimental/im/src/api.ts). Intake ([`intake.ts`](../../../../packages/experimental/im/src/intake.ts)) resolves `satori/receive` only after both the message record and the event deduplication digest are persisted in `im_messages`, and the adapter acknowledges the platform event afterwards. Redelivering a `(bot, eventId)` the intake already recorded is the same delivery, so the record the first delivery stored stands and a payload that drifted from it is logged once; messages from chats not matched by any `sources` rule are neither stored nor emitted. The dispatch loop then runs the `im/message` waterfall for each admitted message—different chats in parallel, messages within the same chat sequentially in `seq` order—and records the outcome. Retention removes only expired settled records; pending messages and pending receipts remain until resolved.

Hosted sessions ([`sessions.ts`](../../../../packages/experimental/im/src/sessions.ts)) are keyed by an owner-defined string (`im:dispatcher` for the default dispatcher, or any key a plugin picks) with one active session per key, storing the composition, bindings, output renderer, and owner metadata on the record itself. `ensure` creates or updates the record, `deliver` persists a delivery intent (`steer`, `followup`, or `inject`) and deduplicates it against the session log before inserting into the agent inbox, `reset` disposes the agent and increments `generation` to issue a new `sessionId`, and `stop` cancels a running turn. Outbound sends go through [`send.ts`](../../../../packages/experimental/im/src/send.ts), where an optional `operationId` records a durable receipt (`confirmed`, `failed`, `uncertain`, or `partial`).

### Message routing and the default dispatcher

`im/message` is a waterfall declared in [`api.ts`](../../../../packages/experimental/im/src/api.ts). Listeners registered with `{ prepend: true }` run before routing strategies—[`session-commands`](../../../../packages/experimental/im-session-commands/src/index.ts) uses this position so `/stop`, `/clear`, `/new`, `/status`, `/help`, and passthrough commands run before any strategy turns the message into model input. Routing plugins register in normal order and call `next()` when a message does not match their rules. When `defaultDispatch` is configured on `@deepseek-ai/dsh-experimental-im`, the innermost fallback ([`dispatcher.ts`](../../../../packages/experimental/im/src/dispatcher.ts)) delivers any remaining addressed message to a single shared session (`key: 'im:dispatcher'`, `owner: 'dispatcher'`), accumulating chat bindings as messages arrive and prefixing each message with `<im-chat key="…" source="…" type="…" />`; without `defaultDispatch`, the fallback returns `ignored`. If a listener throws, the message remains `pending` for retry, so listeners must pass deterministic delivery ids and `operationId` values.

### Session strategies

Routing is a listener's decision: a plugin that wants one session per chat, one session per command, or one session per topic registers on `im/message` and hosts what it needs through `ctx.im.sessions`. The shipped bundle mounts `session-commands` and, when `defaultDispatch` is configured, the host's own dispatcher; no other listener claims a message.

### Output renderers

The host aggregates agent events for each turn of a hosted session into an `ImActivity` snapshot, emits `im/activity`, and drives the renderer named by `spec.output` through `ctx.im.outputs` ([`outputs.ts`](../../../../packages/experimental/im/src/outputs.ts)). `output: 'none'` is the default, so a hosted session publishes only when the agent calls `im_send`, `im_reply`, or `im_send_file`; the shipped bundle registers no renderer, and a plugin that wants streamed progress registers one instead of changing the host.

### Platform layer

Below `ctx.im` sit the vendored Satori packages: [`plugin-im-core`](../../../../vendor/im/core/src/index.ts) (protocol, per-mode element registry, transformation and fallback table, capability evaluation, degradation scoring, stream scheduler, and test conformance kit), [`satori-element`](../../../../vendor/im/element/src/index.ts) (element types and GFM markdown conversion), and the [`plugin-im-adapter-lark`](../../../../vendor/im/adapter-lark/src/bot.ts) and [`plugin-im-adapter-qq`](../../../../vendor/im/adapter-qq/src/bot.ts) adapters.

## Alternatives considered

**A single `ctx.imSessions` strategy service instead of the `im/message` waterfall.** Requiring the host to call a single strategy service prevents command plugins, custom command handlers, and routing strategies from composing in sequence, and forces platform adapters to wait on strategy injection before connecting. A waterfall allows pre-routing command listeners, routing plugins, and the default dispatcher fallback to compose in a deterministic order.

**Building platform card payloads inside the host.** Embedding one platform's card JSON and streaming schedule inside `dsh-im` couples every deployment to that platform and makes automatic turn streaming mandatory. Separating `im/activity` and `ctx.im.outputs` keeps platform-neutral rendering in a plugin that registers on that registry while allowing `output: 'none'` sessions to publish solely through explicit tool calls.

**Streaming assistant text into the chat by default.** Automatically publishing every assistant turn conflicts with agents that use explicit `im_send`/`im_reply` calls to decide what to say and in which chat. Defaulting `output` to `'none'` keeps session hosting independent of turn rendering.

**Splitting the `im_*` tools into a separate `tool-*` package.** Splitting them from the service that owns chat grants and publication receipts required duplicate internal contracts to pass session identity and permissions across packages. Registering the `im_*` tools in the host keeps each tool alongside the state it enforces.

## Consequences

A deployment mounts `@deepseek-ai/dsh-experimental-im` together with the routing plugins and output renderers it needs. If no routing plugin matches a message and `defaultDispatch` is not configured, the message is acknowledged, stored, and recorded as `ignored` in `ctx.im.status()`.

Waterfall listeners are responsible for idempotency: because a throwing listener leaves the message `pending` for retry, plugins must supply deterministic delivery ids and `operationId` values so retries do not duplicate inbox insertions or outbound messages.

Verification: `packages/experimental/im/tests/{intake,dispatcher,sessions,send,outputs,activity,tools,store}.spec.ts` cover the host modules; `packages/experimental/im-session-commands/tests/commands.spec.ts` covers the commands plugin. See [IM storage unit identity in v4](2026-10-25-im-storage-unit-identity.md) for the three storage domain names (`im_messages`, `im_sessions`, `im_receipts`).
