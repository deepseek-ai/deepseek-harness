# Agent Note: IM bot commands

Status: implemented

English | [中文](2026-10-21-im-bot-commands.zh.md)

## Problem

A chat participant who wants to cancel a running turn or reset a conversation needs a command that executes immediately without becoming model input. If `/stop` or `/clear` is delivered to the session inbox like an ordinary message, a running turn only sees it at the next step or after the turn finishes.

## Decision

The [`@deepseek-ai/dsh-experimental-im-session-commands`](../../../../packages/experimental/im-session-commands/README.md) plugin registers on the `im/message` waterfall with `{ prepend: true }`, ahead of routing strategies. When an addressed message starts with a recognized slash command (`/stop`, `/clear`, `/new`, `/status`, `/help`, or a configured `passthrough` command name registered in `ctx.commands`), the plugin executes the command, replies in the chat with `event.reply`, and returns `handled by session-commands` so no routing strategy delivers the message to an agent.

Intake strips leading self-mentions (`@bot`) before parsing `/name` and `rawInput`. `session-commands` acts only when `message.addressed` is `true` (direct chats, or group messages that mention the bot), passing unaddressed group messages and unknown command names to `next()`.

`/stop` calls `ctx.im.sessions.stop` (`agent.cancel({ kind: 'user' })` without `keepInbox`) on running sessions bound to the chat—narrowed to sessions bound to `message.thread.id` when the command arrives inside a thread that a session is confined to—discarding any queued inbox items alongside the cancelled turn. `/clear` and `/new` call `ctx.im.sessions.reset` on the chat's `home` sessions whose `owner` is in `config.resettable` (`['dispatcher']` by default). `/status` and `/help` are unprivileged; privileged commands (`/stop`, `/clear`, `/new`, and passthrough commands) can be restricted to `config.admins` by setting `allow: 'admins'`.

## Alternatives considered

**Relying on card stop buttons alone.** Not every platform or output mode supports interactive card buttons (`element.button.action` and `interaction.button`), and sessions with `output: 'none'` publish no status card at all. Slash commands work across every platform and output renderer.

**Preserving queued inbox messages on `/stop` (`keepInbox: true`).** Keeping queued messages causes the agent to immediately start another turn from the remaining queue as soon as the cancelled turn settles, whereas `/stop` in chat is expected to halt all pending work for that session.

**Accepting a session id argument in `/stop <session>`.** Allowing a chat message to name an arbitrary session id would require cross-chat authorization checks; scoping `/stop` to the sessions bound to the chat (or thread) where the command was sent requires no extra authority.

## Consequences

`/stop` aborts the active turn and clears queued inbox messages for the targeted sessions. Because `im/message` records the `handled by session-commands` outcome in `im_messages`, platform redeliveries of the same command event do not execute the command twice.

## Testing

`packages/experimental/im-session-commands/tests/commands.spec.ts` covers `/stop` (thread-bound, chat-wide, thread fallback, and idle), `/clear` and `/new`, `/status`, `/help`, passthrough command execution, redelivery idempotency, unaddressed group messages, and `allow: 'admins'` permission checks. `packages/experimental/im/tests/intake.spec.ts` covers command parsing with leading self-mentions.
