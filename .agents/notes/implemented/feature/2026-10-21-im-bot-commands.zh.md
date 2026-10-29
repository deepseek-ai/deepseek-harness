# Agent Note: IM 机器人命令

Status: implemented

[English](2026-10-21-im-bot-commands.md) | 中文

## Problem

希望停止正在运行的轮次或重置对话上下文的聊天成员，需要一种能够立即执行而不会变成模型输入的命令方式。如果将 `/stop` 或 `/clear` 当作普通消息投递进会话收件箱，正在运行的轮次要到下一步甚至整轮结束后才会处理它。

## Decision

[`@deepseek-ai/dsh-experimental-im-session-commands`](../../../../packages/experimental/im-session-commands/README.zh.md) 插件以 `{ prepend: true }` 注册在 `im/message` 事件链最前端，先于所有路由策略运行。当提及机器人的消息以受支持的斜杠命令（`/stop`、`/clear`、`/new`、`/status`、`/help`，或已在 `ctx.commands` 中注册的 `passthrough` 命令名）开头时，插件直接执行该命令，通过 `event.reply` 在聊天中回复，并返回 `handled by session-commands`，使后续路由策略不会将该消息交给模型。

接收层在解析 `/name` 与 `rawInput` 前会先去除消息开头的机器人自身提及（`@bot`）。`session-commands` 仅在 `message.addressed` 为 `true`（单聊消息，或提及了机器人的群聊消息）时生效，将未提及机器人的群消息与未知命令名通过 `next()` 向后传递。

`/stop` 对绑定到当前聊天的运行中会话调用 `ctx.im.sessions.stop`（内部调用不带 `keepInbox` 的 `agent.cancel({ kind: 'user' })`），在中止当前轮次的同时清空排队的收件箱消息；若命令发送在某个被会话绑定的话题线程内，则仅停止绑定到该线程的会话。`/clear` 与 `/new` 对该聊天中 `owner` 位于 `config.resettable`（默认为 `['dispatcher']`）的 `home` 会话调用 `ctx.im.sessions.reset`。`/status` 与 `/help` 对所有发送者开放；特权命令（`/stop`、`/clear`、`/new` 与透传命令）可通过设置 `allow: 'admins'` 限制为仅允许 `config.admins` 中的用户执行。

## Alternatives considered

**仅依赖回复卡片上的停止按钮。** 并非所有平台和输出模式都支持交互式操作按钮（`element.button.action` 与 `interaction.button`），且 `output: 'none'` 的会话不会发送状态卡片。斜杠命令在所有平台与输出配置下均可使用。

**在 `/stop` 时保留排队的收件箱消息（`keepInbox: true`）。** 保留排队消息会导致被取消的轮次刚回到空闲状态就立即消费剩余消息启动新轮次，而聊天中的 `/stop` 预期是停下当前积压的全部工作。

**支持 `/stop <session>` 参数指定任意会话。** 允许通过聊天文本指定任意会话 id 需要额外的跨聊天权限模型；将 `/stop` 限制在命令所在聊天（或话题线程）绑定的会话上无需额外授权。

## Consequences

`/stop` 会终止目标会话的当前轮次并丢弃排队的收件箱消息。由于 `im/message` 会将 `handled by session-commands` 结果持久化记录在 `im_messages` 中，同一命令事件的平台重投不会重复执行。

## Testing

`packages/experimental/im-session-commands/tests/commands.spec.ts` 覆盖 `/stop`（线程绑定、全聊天范围、线程回退与空闲状态）、`/clear` 与 `/new`、`/status`、`/help`、透传命令执行、重投幂等性、未提及机器人的群消息以及 `allow: 'admins'` 权限校验。`packages/experimental/im/tests/intake.spec.ts` 覆盖去除前导自身提及后的斜杠命令解析。
