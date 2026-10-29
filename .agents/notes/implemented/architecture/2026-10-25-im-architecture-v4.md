# Agent Note: IM architecture in v4

Status: implemented

English | [中文](2026-10-25-im-architecture-v4.zh.md)

IM no longer ships a profile, per-chat conversations, task workers, the one-shot example, or turn renderers: [IM runs one shared session as an experimental bundle](../simplification/2026-10-28-im-shared-session-minimal-plane.md) records that decision; the sections below on those plugins describe the design they followed.

## Problem

An IM integration has to answer three independent questions: what the platform delivered and what a session is allowed to do with it, which session should receive an incoming message, and how a running turn should be displayed in the chat. Combining routing and output rendering inside the core IM service forces every deployment onto a single routing strategy and a single platform payload builder, and requires modifying the core whenever a new slash command, routing strategy, or output format is needed.

## Decision

`@deepseek-ai/dsh-experimental-im` is a platform-neutral host: it admits and stores platform messages, hosts agent sessions, enforces chat bindings and publication receipts, and tracks turn activity. Routing, slash commands, background tasks, and turn output rendering are separate plugins.

### The host

[`ImService`](../../../../packages/experimental/im/src/index.ts) provides `ctx.im` (`sessions`, `history`, `outputs`, `send`, `stream`, `format`, `bot`, `chat`, `caps`, and `status()`) as defined in [`api.ts`](../../../../packages/experimental/im/src/api.ts). Intake ([`intake.ts`](../../../../packages/experimental/im/src/intake.ts)) resolves `satori/receive` only after both the message record and the event deduplication digest are persisted in `im_messages`, and the adapter acknowledges the platform event afterwards. Redelivering the same `(bot, eventId)` with an identical payload is a no-op; redelivering the same id with a different payload throws a `conflict` error; and messages from chats not matched by any `sources` rule are neither stored nor emitted. The dispatch loop then runs the `im/message` waterfall for each admitted message—different chats in parallel, messages within the same chat sequentially in `seq` order—and records the outcome. Retention removes only expired settled records; pending messages and pending receipts remain until resolved.

Hosted sessions ([`sessions.ts`](../../../../packages/experimental/im/src/sessions.ts)) are keyed by an owner-defined string (`conversation:<chatKey>`, `im:dispatcher`, `task:<id>`, `oneshot:<messageKey>`) with one active session per key, storing the composition, bindings, output renderer, and owner metadata on the record itself. `ensure` creates or updates the record, `deliver` persists a delivery intent (`steer`, `followup`, or `inject`) and deduplicates it against the session log before inserting into the agent inbox, `reset` disposes the agent and increments `generation` to issue a new `sessionId`, and `stop` cancels a running turn. Outbound sends go through [`send.ts`](../../../../packages/experimental/im/src/send.ts), where an optional `operationId` records a durable receipt (`confirmed`, `failed`, `uncertain`, or `partial`).

### Message routing and the default dispatcher

`im/message` is a waterfall declared in [`api.ts`](../../../../packages/experimental/im/src/api.ts). Listeners registered with `{ prepend: true }` run before routing strategies—[`session-commands`](../../../../packages/experimental/im-session-commands/src/index.ts) uses this position so `/stop`, `/clear`, `/new`, `/status`, `/help`, and passthrough commands run before any strategy turns the message into model input. Routing plugins register in normal order and call `next()` when a message does not match their rules. When `config.dispatcher` is configured on `@deepseek-ai/dsh-experimental-im`, the innermost fallback ([`dispatcher.ts`](../../../../packages/experimental/im/src/dispatcher.ts)) delivers any remaining addressed message to a single shared session (`key: 'im:dispatcher'`, `owner: 'dispatcher'`), accumulating chat bindings as messages arrive and prefixing each message with `<im-chat key="…" source="…" type="…" />`; without `config.dispatcher`, the fallback returns `ignored`. If a listener throws, the message remains `pending` for retry, so listeners must pass deterministic delivery ids and `operationId` values.

### Session strategies

`session-conversations` assigns each admitted chat its own persistent session (`conversation:<chatKey>`) with that chat as its `home` binding, applying per-source addressing rules, delivery mode, ambient group context, output renderer, and system prompt guidance. `session-oneshot` is the minimal example of a custom session plugin: one ephemeral session per `/ai` command, disposed after its first turn reaches idle.

### Background tasks

`session-tasks` provides `ctx.imTasks` and the `task_start`, `task_list`, `task_message`, and `task_update` tools. A task is a hosted worker session (`task:<id>`) with a durable record in `im_tasks`. By default (`defaultPlacement`), a new worker is bound to the chat and thread of the owner session's current trigger message and quotes that message on its first turn; strategies can also pass an explicit `placement` or register a custom placer via `ctx.imTasks.placement(owner, place)`, and can forward later messages to a task via `ctx.imTasks.deliver`.

### Output renderers

The host aggregates agent events for each turn of a hosted session into an `ImActivity` snapshot, emits `im/activity`, and drives the renderer named by `spec.output` through `ctx.im.outputs` ([`outputs.ts`](../../../../packages/experimental/im/src/outputs.ts)). Sessions with `output: 'none'` (the default) publish nothing automatically, speaking only when the agent calls `im_send`, `im_reply`, or `im_send_file`. `output-summary` streams one message per turn showing a status line, periodic progress summaries from a forked model request, a stop button, and a completion footer; `output-trace` renders reasoning passages and tool calls in collapsible panels alongside assistant text. Both renderers emit platform-neutral elements and query `Capabilities` rather than branching on platform names.

### Platform layer

Below `ctx.im` sit the vendored Satori packages: [`plugin-im-core`](../../../../vendor/plugin-im-core/src/index.ts) (protocol, per-mode element registry, transformation and fallback table, capability evaluation, degradation scoring, stream scheduler, and test conformance kit), [`satori-element`](../../../../vendor/satori-element/src/index.ts) (element types and GFM markdown conversion), and the [`plugin-im-adapter-lark`](../../../../vendor/plugin-im-adapter-lark/src/bot.ts) and [`plugin-im-adapter-qq`](../../../../vendor/plugin-im-adapter-qq/src/bot.ts) adapters.

## Alternatives considered

**A single `ctx.imSessions` strategy service instead of the `im/message` waterfall.** Requiring the host to call a single strategy service prevents command plugins, custom command handlers, and routing strategies from composing in sequence, and forces platform adapters to wait on strategy injection before connecting. A waterfall allows pre-routing command listeners, routing plugins, and the default dispatcher fallback to compose in a deterministic order.

**Building platform card payloads inside the host.** Embedding one platform's card JSON and streaming schedule inside `dsh-im` couples every deployment to that platform and makes automatic turn streaming mandatory. Separating `im/activity` and `ctx.im.outputs` keeps platform-neutral rendering in optional plugins (`output-summary`, `output-trace`) while allowing `output: 'none'` sessions to publish solely through explicit tool calls.

**Streaming assistant text into the chat by default.** Automatically publishing every assistant turn conflicts with agents that use explicit `im_send`/`im_reply` calls to decide what to say and in which chat. Defaulting `output` to `'none'` keeps session hosting independent of turn rendering.

**Keeping IM and task tools in separate `tool-*` packages.** Splitting `im_*` and `task_*` tools from the services that own chat grants, receipts, and task records required duplicate internal contracts to pass session identities and permissions across packages. Registering `im_*` tools in `dsh-im` and `task_*` tools in `dsh-im-session-tasks` keeps each tool alongside the state it enforces.

## Consequences

A deployment mounts `@deepseek-ai/dsh-experimental-im` together with the routing plugin(s) and output renderer(s) it needs, or configures `dispatcher` on `@deepseek-ai/dsh-experimental-im`. If no routing plugin matches a message and `dispatcher` is not configured, the message is acknowledged, stored, and recorded as `ignored` in `ctx.im.status()`.

Waterfall listeners are responsible for idempotency: because a throwing listener leaves the message `pending` for retry, plugins must supply deterministic delivery ids and `operationId` values so retries do not duplicate inbox insertions or outbound messages.

Verification: `packages/experimental/im/tests/{intake,dispatcher,sessions,send,outputs,activity,tools,store}.spec.ts` cover the host modules; `packages/experimental/im-session-commands/tests/commands.spec.ts` covers the commands plugin. See [IM storage unit identity in v4](2026-10-25-im-storage-unit-identity.md) for the four storage domain names (`im_messages`, `im_sessions`, `im_receipts`, `im_tasks`).
