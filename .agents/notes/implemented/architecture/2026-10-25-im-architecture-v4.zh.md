# Agent Note: v4 中的 IM 架构

Status: implemented

[English](2026-10-25-im-architecture-v4.md) | 中文

## Problem

IM 集成需要解决三个相互独立的问题：平台投递了什么以及会话拥有哪些权限、入站消息应当路由给哪个会话、以及运行中的轮次应当如何在聊天中展示。如果将会话路由与输出渲染耦合在同一个核心服务中，每次部署都会被绑定到单一路由策略与单一平台的载荷构造逻辑，且新增斜杠命令、路由策略或输出样式都必须修改核心服务。

## Decision

`@deepseek-ai/dsh-experimental-im` 是平台无关的宿主服务：负责接纳并存储平台消息、托管 agent 会话、执行聊天权限校验与发送回执记录，并跟踪轮次活动。会话路由、斜杠命令、后台任务与轮次输出渲染均由独立插件实现。

### The host

[`ImService`](../../../../packages/experimental/im/src/index.ts) 按照 [`api.ts`](../../../../packages/experimental/im/src/api.ts) 中的定义提供 `ctx.im`（`sessions`、`history`、`outputs`、`send`、`stream`、`format`、`bot`、`chat` 与 `status()`）。接收模块（[`intake.ts`](../../../../packages/experimental/im/src/intake.ts)）在消息记录与事件去重摘要均持久化写入 `im_messages` 后才完成 `satori/receive`，随后适配器才向平台返回 ACK。已被接收层记录的 `(bot, eventId)` 再次投递就是同一次投递：首次投递写入的记录为准，载荷与它不同时只记录一次告警；不匹配任何 `sources` 规则的聊天既不入库也不发出事件。派发循环随后对每条被接纳消息触发 `im/message` 事件链——不同聊天并行派发，同一聊天内按 `seq` 顺序串行派发——并记录处理结果。过期清理仅删除已完成的旧记录；处于待处理状态的消息与回执会一直保留，直到处理完成。

托管会话（[`sessions.ts`](../../../../packages/experimental/im/src/sessions.ts)）以插件定义的键寻址（默认分派器使用 `im:dispatcher`，其它插件可使用任意键），每个键对应一个活动会话，组合配置、聊天绑定、输出渲染器与自定义元数据直接保存在会话记录中。`ensure` 创建或更新会话记录，`deliver` 在写入 agent 收件箱前先持久化投递意图（`steer`、`followup` 或 `inject`）并通过核对会话日志去重，`reset` 释放当前 agent 并递增 `generation` 以生成新的 `sessionId`，`stop` 取消正在运行的轮次。出站发送统一经过 [`send.ts`](../../../../packages/experimental/im/src/send.ts)，传入可选的 `operationId` 时会将发送结果记录为持久化回执（`confirmed`、`failed`、`uncertain` 或 `partial`）。

### Message routing and the default dispatcher

`im/message` 是在 [`api.ts`](../../../../packages/experimental/im/src/api.ts) 中声明的事件链。使用 `{ prepend: true }` 注册的监听器先于路由策略运行——[`session-commands`](../../../../packages/experimental/im-session-commands/src/index.ts) 位于该位置，使 `/stop`、`/clear`、`/new`、`/status`、`/help` 与透传命令在任何策略将文本转为模型输入前直接执行。路由插件按普通顺序注册，遇到不属于自己的消息时调用 `next()` 向后传递。当在 `@deepseek-ai/dsh-experimental-im` 上配置了 `defaultDispatch` 时，最内层的兜底处理器（[`dispatcher.ts`](../../../../packages/experimental/im/src/dispatcher.ts)）会将未被认领且提及了机器人的消息投递给一个全局共享会话（`key: 'im:dispatcher'`，`owner: 'dispatcher'`），随消息到达自动累积聊天绑定，并在每条消息前添加 `<im-chat key="…" source="…" type="…" />` 头部；未配置 `defaultDispatch` 时则返回 `ignored`。如果监听器抛出异常，消息会保持 `pending` 等待重试，因此监听器必须使用确定性的投递 id 和 `operationId`。

### Session strategies

路由由监听器决定：希望按聊天、按命令或按话题划分会话的插件自行注册到 `im/message`，并通过 `ctx.im.sessions` 托管所需会话。随附的组合包只挂载 `session-commands`，并在配置了 `defaultDispatch` 时挂载宿主自带的默认分派器；其余消息没有监听器认领。

### Output renderers

宿主将托管会话每轮的 agent 事件汇总为 `ImActivity` 快照，发出 `im/activity` 事件，并通过 `ctx.im.outputs`（[`outputs.ts`](../../../../packages/experimental/im/src/outputs.ts)）驱动会话 `spec.output` 指定的输出渲染器。`output: 'none'` 是默认值，托管会话仅在 agent 调用 `im_send`、`im_reply` 或 `im_send_file` 时发布内容；随附的组合包不注册任何渲染器，需要流式进度的插件自行注册，无需改动宿主。

### Platform layer

`ctx.im` 之下是内置的 Satori 包：[`plugin-im-core`](../../../../vendor/im/core/src/index.ts)（协议、按模式的元素注册表、转换与回退表、能力评估、降级计分、流式调度器与一致性测试套件）、[`satori-element`](../../../../vendor/im/element/src/index.ts)（元素类型与 GFM Markdown 转换），以及 [`plugin-im-adapter-lark`](../../../../vendor/im/adapter-lark/src/bot.ts) 和 [`plugin-im-adapter-qq`](../../../../vendor/im/adapter-qq/src/bot.ts) 平台适配器。

## Alternatives considered

**使用单一 `ctx.imSessions` 策略服务替代 `im/message` 事件链。** 由宿主调用单一策略服务会使斜杠命令插件、自定义命令插件与路由策略无法按顺序组合，并迫使平台适配器在连接前等待策略服务注入。事件链允许前置命令监听器、路由插件与默认分派会话按确定顺序协同工作。

**在宿主内部构造平台卡片载荷。** 将单一平台的卡片 JSON 构造与流式更新节奏写进 `dsh-im`，会把所有部署绑定到该平台，并使自动流式输出成为强制行为。拆分出 `im/activity` 与 `ctx.im.outputs` 后，平台无关的渲染逻辑留在注册到该注册表的插件中，同时允许 `output: 'none'` 的会话仅通过显式工具调用发言。

**默认将助手文本流式发布到聊天。** 自动把每一轮文本发到聊天中，会与通过显式调用 `im_send`/`im_reply` 决定发言内容和目标聊天的 agent 产生冲突。将 `output` 默认设为 `'none'` 可保持会话托管与轮次渲染正交。

**将 `im_*` 工具拆分到独立的 `tool-*` 包中。** 把它们从管理聊天授权与发送回执的服务包中拆出，需要维护额外的跨包内部接口来传递会话身份与权限。将 `im_*` 工具注册在宿主中，使工具与其依赖的状态管理保持在同一包内。

## Consequences

部署按需挂载 `@deepseek-ai/dsh-experimental-im`、路由插件与输出渲染器。若没有任何路由插件认领消息且未配置 `defaultDispatch`，被接纳的消息仍会完成 ACK、入库并在 `ctx.im.status()` 中记录为 `ignored`。

事件链监听器需自行保证幂等性：监听器抛错会让消息保持 `pending` 并在后续重试，因此插件必须提供确定性的投递 id 和 `operationId`，避免重试时重复写入收件箱或重复发送消息。

验证：`packages/experimental/im/tests/{intake,dispatcher,sessions,send,outputs,activity,tools,store}.spec.ts` 覆盖宿主各模块；`packages/experimental/im-session-commands/tests/commands.spec.ts` 覆盖命令插件。三个持久化存储域（`im_messages`、`im_sessions`、`im_receipts`）的命名规则见 [v4 中的 IM 存储 unit 身份](2026-10-25-im-storage-unit-identity.zh.md)。
