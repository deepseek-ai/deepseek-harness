# Agent Note: Rule-driven IM dispatch leaves the v1 package set

Status: implemented

English | [中文](2026-10-27-im-dispatch-out-of-v1.zh.md)

IM no longer ships a profile, per-chat conversations, task workers, the one-shot example, or turn renderers: [IM runs one shared session as an experimental bundle](../simplification/2026-10-28-im-shared-session-minimal-plane.md) records that decision; the sections below on those plugins describe the design they followed.

## Problem

`dsh-im-session-dispatch` carried most of the IM plane's complexity: a QuickJS sandbox compiled to WebAssembly for model-written route rules, its own `im_rules` storage unit, a `copy`/`cut` path that took messages away from the dispatcher, rule notices in both directions, and nine dispatcher plus five worker tools. Only one deployment used it. `dsh-im-session-tasks` was coupled to it and to platform threads: it posted a topic announcement, fell back to a `#task` message on platforms without threads, learned thread ids from the first reply, and listened on `im/message` to route topic replies, with a `topicDelivery: rules` mode that existed only for the dispatcher.

## Decision

The rule-driven dispatcher moved into the one deployment plugin that uses it, outside this repository, unchanged in its rule language and storage. In this repository:

- The [`dsh-im` host](../../../../packages/experimental/im/src/dispatcher.ts) gained a minimal default: with `dispatcher` configured, an addressed message no listener handles reaches one session shared by every chat. It has no routing and no rules; without the configuration an unhandled message is ignored as before.
- `dsh-im-session-tasks` only starts and manages task agents. Where a worker answers is a placement the starting strategy supplies (or a placer it registers per owner name); the default binds the worker to the chat and thread of the owner's current trigger. The package publishes nothing and routes no inbound message: a strategy that wants later messages to reach a worker finds the task and calls `deliver`.
- An output renderer publishes into the trigger's chat when the session may write there, so a session bound to several chats answers where it was asked.

## Alternatives considered

**Keep dispatch in v1 without QuickJS.** A predicate language the harness maintains would still need its own store, notices, and tools, and would still be used by one deployment.

**Keep topics in the task service.** Which messages reach a worker is routing policy, and routing belongs to the strategy that owns the sessions; the task service would otherwise keep a second, platform-specific router beside every strategy.

## Consequences

A deployment that ran `dsh-im-session-dispatch` mounts its own plugin and its own dispatch presets; its `im_rules` and `im_tasks` records stay readable because neither unit name nor version changed. `topicDelivery` is no longer a task-service field, and a profile that sets it carries an ignored key. A conversation that starts a task no longer opens a platform topic, so a reply posted under the worker's answer reaches the conversation, not the worker.
