---
description: "在路由策略运行前处理 IM 聊天斜杠命令（`/stop`、`/clear`、`/new`、`/status`、`/help` 以及 `/compact` 等透传命令）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-im-session-commands

[English](README.md) | 中文

## 概述

在 IM 聊天中直接执行斜杠命令，而不将命令文本发送给模型。`/stop` 取消当前聊天正在运行的轮次，`/clear` 与 `/new` 将以该聊天为 home 的会话重置为全新上下文，`/status` 报告会话 id、模型、运行状态、排队消息数与最近活动时间，`/help` 列出可用命令，配置在 `passthrough` 中的命令（如 `/compact`）则转发给 `dsh` 命令注册表执行。本插件挂载在 `im/message` 事件链最前端，直接在聊天中回复结果，并将非命令消息继续向后传递。特权命令可配置为仅允许指定管理员执行。

## 目录

- [使用方式](#use-this-package)
- [实现机制](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方式

将 `@deepseek-ai/dsh-im-session-commands` 与 `@deepseek-ai/dsh-im` 一起挂载。本插件使用 `{ prepend: true }` 注册 `im/message` 监听器，因此被它处理的命令不会进入后续路由策略。随附的 [IM profile](../im-bundle/README.zh.md) 使用以下默认配置挂载本插件。

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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allow` | `'all'` | `'all'` 允许所有发送者执行特权命令；`'admins'` 仅允许 `admins` 中的用户执行 |
| `admins` | `[]` | `allow: 'admins'` 时允许执行特权命令的用户 id 列表：可填平台用户 id（如 `ou_xxx`）或 `botId\|userId` |
| `passthrough` | `['compact']` | 转发给 `ctx.commands` 执行的命令名列表 |
| `resettable` | `['dispatcher']` | 允许被 `/clear` 与 `/new` 重置的会话 `owner` 名称列表 |
| `locale` | `'zh'` | 命令回复语言（`'zh'` 或 `'en'`） |
| `retentionMs` | 7 天 | 已记录命令回执的最短保留时间 |

完整字段定义见生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-im-session-commands)。

### 支持的命令

| 命令 | 行为 | 默认 `zh` 回复 |
|---|---|---|
| `/stop` | 取消绑定到该聊天的所有运行中会话（若消息位于某个被会话绑定的话题线程内，则仅取消绑定到该线程的会话） | `已停止 {count} 个会话。` |
| `/clear` | 重置该聊天中 `owner` 在 `resettable` 列表内的 `home` 会话 | `已重置 {count} 个会话，下一轮对话将使用新的上下文。` |
| `/new` | 与 `/clear` 相同 | `已重置 {count} 个会话，下一轮对话将使用新的上下文。` |
| `/status` | 报告该聊天 `home` 会话的会话 id、模型、运行状态、收件箱排队消息数以及最近活动距今时间 | 五行 `标签：值` 文本 |
| `/help` | 列出内置命令以及已在 `ctx.commands` 中注册的 `passthrough` 命令 | `可用命令：` 加每条命令一行 |
| `<passthrough>` | 针对该聊天的 `home` 会话执行 `ctx.commands` 中注册的同名命令 | 命令自身的返回文本，或 `已完成。` |

当没有匹配的运行中会话或可操作会话时，插件仍会回复 `没有正在运行的会话。`、`没有可重置的会话。` 或 `当前聊天还没有会话。`。被 `allow: 'admins'` 拒绝的发送者会收到 `你没有权限执行这个命令。`。若带副作用的命令在回执落定前中断，重放重试会回复 `该命令此前已开始执行，但结果未能落盘（结果未知，未重复执行）。`。`/status` 与 `/help` 不会修改会话状态，因此始终对所有发送者开放。

### 命令匹配规则

本插件仅处理 `message.addressed` 为 `true` 且解析出了 `message.command` 的消息（在群聊中，消息开头的 `@bot` 提及会在解析 `/name` 前去除；只有 `/name` 后紧跟空白或文本结束才会被解析为命令，因此 `/new/project`、`/clear()` 等属于普通文本）。如果群消息未 `@` 机器人、不包含斜杠命令，或命令名既不是内置命令也未在 `passthrough` 中配置并注册，插件会调用 `next()` 将消息原样交给后续路由插件处理。

-----

<a id="understand-the-implementation"></a>
## 实现机制

<details>
<summary>实现细节——点击展开</summary>

`SessionCommands` 协调四个服务：`ctx.im`（查询会话、停止与重置）、`ctx.commands`（列出并执行透传命令）、`ctx.agents`（读取活动 agent 的运行状态与收件箱队列）与 `ctx.storageDomain`（`im_session_commands` 存储域）。执行按 `message.key` 串行化。命令回执在 `im_session_commands` 中遵循 `pending` → 执行副作用 → `done` 的两阶段生命周期：在执行带副作用的命令（`/stop`、`/clear`、`/new` 或 `passthrough` 命令）之前，`SessionCommands` 先持久化一条包含目标会话列表的 `pending` 回执，再执行命令（重置调用传入由 `message.key` 派生的 `operationId` 与当前 `expectedGeneration`，使未决的 `/clear` 或 `/new` 重跑时既不会重复推进代次也不会误重置后续代次），随后在调用 `event.reply` 前将回执更新为包含回复文本的 `done` 状态并返回 `{ kind: 'handled', by: 'session-commands', sessions }`。若透传命令的 `execute()` 返回 `undefined`，则回滚该 `pending` 回执以便重试继续透传。若重试或重启再次进入 `im/message`，`done` 回执会直接重放而不会在已变更的会话状态上重新求值，中断遗留的 `pending` 回执则会落定为带 `interrupted` 提示的 `done` 回执而不会重跑副作用；`done` 与 `pending` 回执均在超过 `retentionMs` 后过期清理。

目标会话从 `ctx.im.sessions.forChat(chat)` 中选取：若消息位于某个话题线程内，且存在限定在该线程（`binding.thread === message.thread.id`）的会话，则仅以这些线程会话为目标；否则以绑定到该聊天的所有会话为目标。`/clear` 与 `/new` 会进一步筛选出 `binding.home === true` 且 `record.owner` 在 `resettable` 列表中的会话。

### 源码结构

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口；注册前置 `im/message` 监听器、打开 `im_session_commands` 存储域，并在插件卸载时中止进行中的透传命令 |
| [`src/commands.ts`](src/commands.ts) | 权限检查、目标会话筛选、持久化命令回执、内置命令处理与透传命令转发 |
| [`src/locale.ts`](src/locale.ts) | `zh` 与 `en` 回复文案表、`{count}` 占位符替换与相对时间格式化 |
| [`src/config.ts`](src/config.ts) | 配置 schema 与默认值 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [IM 宿主服务](../im/README.zh.md) — `im/message` 事件链、托管会话与处理结果持久化。
- [默认分派会话](../im/README.zh.md#the-default-dispatcher) — 创建可被 `/clear` 与 `/new` 重置的 `dispatcher` 会话。
- [IM 组合包](../im-bundle/README.zh.md) — 挂载本插件的组合包。
- [IM 子系统](../../../docs/subsystems/im.zh.md) — 公开类型与 Cordis API 目录。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过 `ctx.commands` 执行配置的 `passthrough` 命令（默认 `/compact` 委托给 `dsh-compaction` 发起摘要模型请求），而内建命令只直接在聊天中回复、不调用模型。

#### KV Cache 影响

内建命令为独立影响：不发起任何模型请求，执行重置只会让该会话的下一轮构建全新前缀。`passthrough` 命令的 KV Cache 行为由目标命令插件决定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

`@deepseek-ai/dsh-im-session-commands` 当前存在以下限制：

- **群聊命令必须 `@` 机器人** — 群聊中未 `@` 机器人的 `/stop` 不会被本插件执行，而是会传递给后续监听器。
- **`/stop` 会停止目标范围内的全部运行中会话** — 不支持通过参数指定只停止某一个会话或单个后台任务。
- **`/clear` 与 `/new` 行为完全相同** — 两者都会立即推进会话代次并切换上下文，不提供历史归档、撤销或导出功能。
- **仅重置 `resettable` 中列出的 owner** — 默认 `resettable: ['dispatcher']` 下，其他插件创建的会话不会被 `/clear` 或 `/new` 重置。共享分派会话的 home 是它最先收到消息的聊天，因此只有该聊天能重置它。
- **重置会话会改变 `sessionId`** — 重置前由旧 `sessionId` 启动的后台任务仍关联在旧 id 上，不会出现在新会话的 `task_list` 中。
- **`/status` 要求聊天存在 `home` 会话** — 若当前聊天尚无 `home: true` 的会话，`/status` 会回复 `当前聊天还没有会话。`；若会话的 agent 尚未加载到内存，排队消息数显示为 `0`。
- **未注册的 `passthrough` 命令会继续向后传递** — 若 `passthrough` 中配置的命令名未在 `ctx.commands` 中注册，该消息会作为普通文本交给后续路由策略。
- **内置回复仅支持 `zh` 与 `en`** — `locale` 仅可在这两套内置文案表之间切换。
- **`admins` 仅按用户 id 匹配** — 管理员校验比对的是 `message.sender.id` 或 `${bot}|${message.sender.id}`，不匹配用户显示名称。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作记录——点击展开</summary>

`/status` 与 `/help` 刻意保持非特权状态。新增内置命令时需同步更新 [`src/locale.ts`](src/locale.ts) 中的 `BUILTIN_ORDER`、`describe` 以及中英文文案表。

</details>
