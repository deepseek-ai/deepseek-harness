# Agent Note: Rule-driven IM dispatch leaves the v1 package set

Status: implemented

English | [中文](2026-10-27-im-dispatch-out-of-v1.zh.md)

## Problem

`dsh-im-session-dispatch` carried most of the IM plane's complexity: a QuickJS sandbox compiled to WebAssembly for model-written route rules, its own `im_rules` storage unit, a `copy`/`cut` path that took messages away from the dispatcher, rule notices in both directions, and nine dispatcher plus five worker tools. Only one deployment used it. `dsh-im-session-tasks` was coupled to it and to platform threads: it posted a topic announcement, fell back to a `#task` message on platforms without threads, learned thread ids from the first reply, and listened on `im/message` to route topic replies, with a `topicDelivery: rules` mode that existed only for the dispatcher.

## Decision

The rule-driven dispatcher moved into the one deployment plugin that uses it, outside this repository, unchanged in its rule language and storage. In this repository:

- The [`@deepseek-ai/dsh-experimental-im` host](../../../../packages/experimental/im/src/dispatcher.ts) gained a minimal default: with `defaultDispatch` configured, an addressed message no listener handles reaches one session shared by every chat. It has no routing and no rules; without the configuration an unhandled message is ignored as before.
- Background work left with it: no task service ships, so a plugin that needs worker sessions hosts them through `ctx.im.sessions` and routes the messages it wants a worker to receive.
- A publication targets a chat in its session's bindings, so a session bound to several chats answers where it was asked.

## Alternatives considered

**Keep dispatch in v1 without QuickJS.** A predicate language the harness maintains would still need its own store, notices, and tools, and would still be used by one deployment.

**Routing topic replies in the task service.** Which messages reach a worker is routing policy, and routing belongs to the plugin that owns the sessions; a task service would otherwise keep a second, platform-specific router beside every strategy.

## Consequences

A deployment that ran `dsh-im-session-dispatch` mounts its own plugin and its own dispatch presets; its `im_rules` and `im_tasks` records stay on the medium untouched because neither unit name nor version changed, and no storage domain in this repository opens them.
