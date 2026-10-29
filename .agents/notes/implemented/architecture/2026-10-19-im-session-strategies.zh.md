# Agent Note: IM 会话策略

Status: implemented

[English](2026-10-19-im-session-strategies.md) | 中文

IM 已不再随附专用 profile、按聊天会话、任务 worker、单次命令示例或轮次渲染器：该决策记录在 [IM 以实验性组合包运行一个共享会话](../simplification/2026-10-28-im-shared-session-minimal-plane.zh.md)；下文涉及这些插件的部分描述的是它们当时遵循的设计。

v4 宿主已取代本文早期描述的 `ctx.imSessions` 服务接缝：[v4 中的 IM 架构](2026-10-25-im-architecture-v4.zh.md) 记录了当前实现——路由插件通过监听 `im/message` 事件链工作，会话由 `ctx.im.sessions` 托管，`@deepseek-ai/dsh-experimental-im` 内置可选的默认 `dispatcher` 分派会话。

## Problem

不同的 IM 部署对入站聊天消息如何映射到 agent 会话有不同需求。按聊天隔离的部署为每个聊天维护一个独立的持久化会话，并将耗时工作委派给后台任务；而集中处理多个聊天的部署则希望由一个共享的分派会话统一接收各聊天的消息并负责回复或委派。两种模式都需要相同的消息准入、持久化存储、发送回执与 `im_*` 授权工具。如果将单一路由模型写死在 IM 宿主中，其他路由模式就必须复制整套宿主逻辑。

## Decision

[IM 服务](../../../../packages/experimental/im/README.zh.md) 负责平台接收、持久化存储、会话托管（`ctx.im.sessions`）、消息发送（`ctx.im.send`/`stream`）与 `im_*` 工具，而消息进入哪个会话则由 `im/message` 事件链上的监听器（以及 `@deepseek-ai/dsh-experimental-im` 上可选的默认 `dispatcher` 兜底会话）决定。

`dsh-im-session-conversations` 实现按聊天的会话策略：每个已接纳聊天对应一个持久化会话（`conversation:<chatKey>`），将该聊天设为 `home` 绑定，并按来源应用提及过滤、投递模式、群聊环境上下文、输出渲染器与可选的任务委派提醒。当运维人员在 `@deepseek-ai/dsh-experimental-im` 上配置 `dispatcher`（[`dispatcher.ts`](../../../../packages/experimental/im/src/dispatcher.ts)）时，未被前置策略认领且提及了机器人的消息会进入全局共享的 `im:dispatcher` 会话；该会话自动将见过的每个聊天加入绑定列表，并在每条消息前附上 `<im-chat key="…" source="…" type="…" />` 头部。所有读取与发送工具均支持可选的 `chat` 参数，以便绑定了多个聊天的分派会话或任务 worker 指定目标聊天。

后台任务由 `dsh-im-session-tasks`（`ctx.imTasks`）统一提供，任何 `owner` 名称在 `config.owners`（默认为 `['conversation', 'dispatcher']`）中的托管会话均可启动、查看并控制后台任务 worker，无需在每个路由策略中重复实现任务管理。

## Alternatives considered

**在 `@deepseek-ai/dsh-experimental-im` 中写死按聊天路由。** 将 `conversation:<chatKey>` 路由硬编码进宿主会导致单次命令插件（`session-oneshot`）、自定义路由插件或全局共享分派会话无法复用同一套接收与会话存储。

**在每个路由策略内部各自实现后台任务管理。** 每个策略都需要重复实现 worker 会话创建、`im_tasks` 持久化、`task_*` 工具与完成通知。将任务生命周期集中在 `dsh-im-session-tasks` 中可让任意策略直接复用 `ctx.imTasks`。

**仅靠静态系统提示词标识来源聊天。** 分派会话绑定的聊天随新消息到达而增加；在每条投递的消息前加上 `<im-chat key="…" />` 头部，可以直接告知模型当前消息所属的聊天，而无需重写之前的轮次记录。

## Consequences

`im_sessions` 中的每个会话键都记录创建它的 `owner` 名称（如 `conversation`、`dispatcher`、`session-tasks`、`oneshot`），当不同 `owner` 尝试使用已有键调用 `ctx.im.sessions.ensure` 时会被拒绝。共享的 `dispatcher` 会话在单个会话内串行处理多个聊天的轮次，而 `session-conversations` 则为每个聊天并行维护独立的会话。
