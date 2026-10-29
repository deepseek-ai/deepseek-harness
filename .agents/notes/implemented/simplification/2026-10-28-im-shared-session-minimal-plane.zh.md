# Agent Note: IM 以实验性组合包运行一个共享会话

Status: implemented

[English](2026-10-28-im-shared-session-minimal-plane.md) | 中文

## Problem

IM 平面曾在宿主之外附带五个可选插件：按聊天划分的会话（`dsh-im-session-conversations`）、后台任务 worker（`dsh-im-session-tasks`）、单次命令示例（`dsh-im-session-oneshot`），以及两个轮次渲染器（`dsh-im-output-summary`、`dsh-im-output-trace`）。它们合计约八千行代码，并带来一个持久化的 `im_tasks` 存储单元、一个仅写入日志的 `im/progress-summary-request` 事件，以及一个带独立命令行入口、默认按聊天路由的专用 `im` profile。而宿主本身已经包含可用部署所需的全部能力：持久化接收、托管会话、发布回执、`im_*` 工具，以及默认分发器——它把每条未被处理且提及机器人的消息投递到所有聊天共享的一个会话。

## Decision

IM 是实验性能力，不再拥有自己的 profile。[IM 组合包](../../../../packages/experimental/im-bundle/README.zh.md) 向已有的常驻 profile 插入 Host 条目，只挂载宿主（[`dsh-experimental-im`](../../../../packages/experimental/im/README.zh.md)）、平台适配器和 [`dsh-experimental-im-session-commands`](../../../../packages/experimental/im-session-commands/README.zh.md)。它既不在 `OPTIONAL_BUNDLES` 中，也不在按需目录中，因为它会增加运行时依赖，并且需要凭据和补丁才能工作；运维人员通过 `dsh plugin add` 安装。路由由宿主的 `defaultDispatch` 完成：一个会话（`im:dispatcher`）服务所有已接纳的聊天，每条投递的消息都带有标明其聊天的 `<im-chat …/>` 头部。`session-commands` 默认重置 `dispatcher` owner 的会话。由于没有挂载渲染器且 `output` 默认为 `none`，会话只通过 `im_send`、`im_reply` 和 `im_send_file` 发布消息。

宿主写在投递用户消息上的 `im` 消息来源只携带 `kind: 'im'` 与 `relay` 上下文形式（[记录](../../../../docs/persistence-changes/2026-10-28-im-message-source.zh.md)）。它仍是独立的来源类型，因为读取方把 `kind: 'user'` 视为所有者输入：技能触发和若干上下文插件只接受该类型，外部聊天文本不得携带它。此前的 `delivery` 与 `trigger` 字段没有任何读取方使用；投递去重依赖确定性的收件箱消息 ID。

`im/message` 事件链与 `ctx.im.outputs` 仍是宿主的扩展点，部署仍可挂载自己的路由插件或渲染器。

## Alternatives considered

**保留专用的 `im` profile。** 带命令行入口和启动闸门的 profile 让 IM 成为单独的应用：它改动了启动器的 profile 模板与全局必需条目，IM 部署也无法与运行中的 Web Host 共用进程。作为 Host 条目，IM 运行在已经托管 Agent 的任意 profile 中。

**保留按聊天会话作为默认。** 按聊天会话可以隔离历史，但每个聊天都需要自己的组合配置行，随附 profile 也需要两份相互对应的来源列表。共享会话只需要一份组合配置。

**保留任务 worker 处理长任务。** 任务 worker 是一个托管会话，可以在所属会话轮次结束后继续在聊天中发布。共享会话本来就能在任何已绑定聊天中发布，`dsh-subagent` 也已支持带完成通知的后台工作；剩下的差异不足以支撑一个持久化存储单元和四个工具。

**保留摘要渲染器。** 流式进度卡片改善了聊天中的展示，但需要平台无关的流式渲染、每次摘要一个分叉的模型请求，以及记录该请求的持久化事件。显式工具发布已满足所需行为。

**把 IM 输入写成 `kind: 'user'`。** 这样可以避免持久化类型变更，但会让任何聊天成员触发仅限所有者的行为。

## Consequences

部署需要在 `im` 行上配置 `sources` 和 `defaultDispatch`；没有 `defaultDispatch` 时，已接纳的消息只会入库并记录为 `ignored`。所有聊天共享一份历史和一条串行的轮次队列。`/clear` 与 `/new` 从共享会话的 home 聊天（即它最先收到消息的聊天）重置该会话。只有 agent 调用发布工具时，用户才会看到回答。

当部署需要时，可以在现有事件链或渲染器注册表上以独立插件的形式重新引入按聊天路由、任务 worker 或渲染器。

Verification: `packages/experimental/im/tests/*.spec.ts`、`packages/experimental/im-session-commands/tests/commands.spec.ts`、`packages/experimental/im-bundle/tests/loader-composition.spec.ts` 与 `scripts/im-persistence.spec.ts`。
