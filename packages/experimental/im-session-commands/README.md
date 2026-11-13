---
description: "Handle IM chat slash commands (`/stop`, `/clear`, `/new`, `/status`, `/help`, and passthrough commands such as `/compact`) before routing strategies run."
kind: "package-reference"
---

# @deepseek-ai/dsh-im-session-commands

English | [中文](README.zh.md)

## Summary

Execute slash commands in IM chats without sending the command text to the model. `/stop` cancels running turns bound to the chat, `/clear` and `/new` reset the session whose home is the chat to a fresh context, `/status` reports session identity, model, run state, queued messages, and last activity age, `/help` lists available commands, and configured passthrough commands such as `/compact` run against the `dsh` command registry. The plugin registers at the head of the `im/message` waterfall, replies directly in the chat, and forwards non-command messages to the next listener. Privileged commands can be restricted to configured administrator user ids.

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

Mount `@deepseek-ai/dsh-im-session-commands` alongside `@deepseek-ai/dsh-im`. Because it registers its `im/message` listener with `{ prepend: true }`, commands it handles never reach downstream routing strategies. The shipped [IM profile](../im-bundle/README.md) mounts it with the default configuration below.

```yaml
- id: im-session-commands
  name: '@deepseek-ai/dsh-im-session-commands'
  config:
    allow: all
    admins: []
    passthrough: [compact]
    resettable: [dispatcher]
    locale: zh
    retentionMs: 604800000
```

| Field | Default | Meaning |
|---|---|---|
| `allow` | `'all'` | `'all'` allows any sender to run privileged commands; `'admins'` restricts them to `admins` |
| `admins` | `[]` | Sender ids allowed when `allow: 'admins'`: a platform user id (`ou_xxx`) or `botId\|userId` |
| `passthrough` | `['compact']` | Command names forwarded to `ctx.commands` |
| `resettable` | `['dispatcher']` | Session `owner` names that `/clear` and `/new` are allowed to reset |
| `locale` | `'zh'` | Reply language (`'zh'` or `'en'`) |
| `retentionMs` | 7 days | Minimum age before recorded command receipts expire |

See the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-im-session-commands) for the complete schema.

### Commands

| Command | Behavior | Default `zh` reply |
|---|---|---|
| `/stop` | Cancel running sessions bound to the chat (or bound to the message's thread when any session is confined to that thread) | `已停止 {count} 个会话。` |
| `/clear` | Reset the chat's `home` sessions whose `owner` is listed in `resettable` | `已重置 {count} 个会话，下一轮对话将使用新的上下文。` |
| `/new` | Alias for `/clear` | `已重置 {count} 个会话，下一轮对话将使用新的上下文。` |
| `/status` | Report the `home` session's id, model, run state, queued inbox count, and time since last activity | Five `标签：值` lines |
| `/help` | List the built-in commands followed by registered `passthrough` commands | `可用命令：` plus one line per command |
| `<passthrough>` | Execute the named command in `ctx.commands` against the chat's `home` session | The command's output text, or `已完成。` |

When no matching session is active or present, the plugin replies with `没有正在运行的会话。`, `没有可重置的会话。`, or `当前聊天还没有会话。`. Senders rejected by `allow: 'admins'` receive `你没有权限执行这个命令。`. `/status` and `/help` are always permitted for all senders because they do not modify session state.

### Command matching rules

The plugin handles a message only when `message.addressed` is `true` and `message.command` is present (in group chats, leading `@bot` mentions are stripped before parsing `/name`). If a message does not address the bot, does not start with a slash command, or names a command that is neither built-in nor registered under `passthrough`, the plugin calls `next()` so downstream routing plugins receive the message unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`SessionCommands` coordinates four services: `ctx.im` (session lookup, `stop`, and `reset`), `ctx.commands` (passthrough command listing and execution), `ctx.agents` (live agent status and inbox queue inspection), and `ctx.storageDomain` (the `im_session_commands` domain). Execution is serialized per `message.key`. On the first run of a command, `SessionCommands` computes the answer (passing a message-keyed `operationId` and `expectedGeneration` on resets so re-running an unsettled `/clear` or `/new` neither advances a later generation nor resets twice), writes the reply text and target session list to `im_session_commands` before calling `event.reply`, and returns `{ kind: 'handled', by: 'session-commands', sessions }`. If a retry or restart re-enters `im/message` after the command already ran, the recorded receipt is replayed into `event.reply` and returned directly without recomputing against mutated session state; settled receipts expire after `retentionMs`.

Target sessions are selected from `ctx.im.sessions.forChat(chat)`: if the message arrived in a thread and at least one session bound to the chat is confined to that thread (`binding.thread === message.thread.id`), only those thread-bound sessions are targeted; otherwise all sessions bound to the chat are targeted. `/clear` and `/new` further filter targets to sessions where `binding.home === true` and `resettable` includes `record.owner`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry; registers the prepended `im/message` listener, opens `im_session_commands`, and aborts in-flight passthrough calls on dispose |
| [`src/commands.ts`](src/commands.ts) | Permission checks, target session selection, durable command receipts, built-in command handlers, and passthrough execution |
| [`src/locale.ts`](src/locale.ts) | `zh` and `en` reply templates, `{count}` substitution, and relative time formatting |
| [`src/config.ts`](src/config.ts) | Configuration schema and defaults |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [IM host service](../im/README.md) — `im/message` waterfall, hosted sessions, and outcome persistence.
- [Default dispatcher](../im/README.md#the-default-dispatcher) — creates the `dispatcher` session that `/clear` and `/new` reset.
- [IM bundle](../im-bundle/README.md) — the bundle that mounts this plugin.
- [IM subsystem](../../../docs/subsystems/im.md) — public types and Cordis API catalog.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin answers a command with one chat reply and returns before any routing strategy can hand that message to an agent.

#### KV Cache effect

Independent: a command starts no model request, and a reset it performs only makes the next turn of that session build a fresh prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The following constraints apply to `@deepseek-ai/dsh-im-session-commands`:

- **Group commands require addressing the bot** — an unaddressed `/stop` in a group chat is ignored by this plugin and passed to downstream listeners.
- **`/stop` cancels all running sessions targeted in the chat or thread** — it does not accept a session id or task number argument to stop a single session selectively.
- **`/clear` and `/new` are identical** — both reset the session generation immediately without archiving or exporting the prior transcript.
- **Only `resettable` owners are reset** — with the default `resettable: ['dispatcher']`, sessions owned by other plugins are not reset by `/clear` or `/new`. The shared dispatcher session's home is the first chat it heard, so only that chat can reset it.
- **Resetting a session changes its `sessionId`** — any background tasks started by the previous `sessionId` remain linked to the old id and will not appear in the new session's `task_list`.
- **`/status` requires a `home` session** — if no session has `home: true` for the chat, `/status` replies `当前聊天还没有会话。`; for a session whose agent is not currently loaded in memory, `queued` reports `0`.
- **Unregistered `passthrough` names fall through** — if a command name in `passthrough` is not registered in `ctx.commands`, the message is passed to downstream routing strategies as regular text.
- **Built-in replies support `zh` and `en` only** — `locale` selects between the two built-in string tables.
- **`admins` matches user ids only** — administrator checks compare `message.sender.id` and `${bot}|${message.sender.id}`, never display names.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`/status` and `/help` are intentionally unprivileged. Adding a built-in command requires updating `BUILTIN_ORDER`, `describe`, and both locale tables in [`src/locale.ts`](src/locale.ts).

</details>
