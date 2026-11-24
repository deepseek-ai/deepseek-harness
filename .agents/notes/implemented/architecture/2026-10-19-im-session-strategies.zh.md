# Agent Note: IM 会话策略

Status: implemented

[English](2026-10-19-im-session-strategies.md) | 中文

## Problem

不同的 IM 部署对入站聊天消息如何映射到 agent 会话有不同需求。按聊天隔离的部署为每个聊天维护一个独立的持久化会话，并将耗时工作委派给后台任务；而集中处理多个聊天的部署则希望由一个共享的分派会话统一接收各聊天的消息并负责回复或委派。两种模式都需要相同的消息准入、持久化存储、发送回执与 `im_*` 授权工具。如果将单一路由模型写死在 IM 宿主中，其他路由模式就必须复制整套宿主逻辑。

## Decision

[IM 服务](../../../../packages/experimental/im/README.zh.md) 负责平台接收、持久化存储、会话托管（`ctx.im.sessions`）、消息发送（`ctx.im.send`/`stream`）与 `im_*` 工具，而消息进入哪个会话则由 `im/message` 事件链上的监听器（以及 `@deepseek-ai/dsh-experimental-im` 上可选的 `defaultDispatch` 兜底）决定。

宿主自带的兜底处理器位于 [`dispatcher.ts`](../../../../packages/experimental/im/src/dispatcher.ts)：配置了 `defaultDispatch` 后，没有被任何监听器认领且提及了机器人的消息会进入全局共享的 `im:dispatcher` 会话；该会话自动将见过的每个聊天加入绑定列表，并在每条消息前附上 `<im-chat key="…" source="…" type="…" />` 头部。所有读取与发送工具均支持可选的 `chat` 参数，以便绑定了多个聊天的会话指定目标聊天。

## Alternatives considered

**在 `@deepseek-ai/dsh-experimental-im` 中写死按聊天路由。** 将 `conversation:<chatKey>` 路由硬编码进宿主会导致单次命令插件、自定义路由插件或全局共享分派会话无法复用同一套接收与会话存储。

**仅靠静态系统提示词标识来源聊天。** 分派会话绑定的聊天随新消息到达而增加；在每条投递的消息前加上 `<im-chat key="…" />` 头部，可以直接告知模型当前消息所属的聊天，而无需重写之前的轮次记录。

## Consequences

`im_sessions` 中的每个会话键都记录创建它的 `owner` 名称（默认兜底为 `dispatcher`，其他插件可自取名称），当不同 `owner` 尝试使用已有键调用 `ctx.im.sessions.ensure` 时会被拒绝。共享的 `dispatcher` 会话在单个会话内串行处理多个聊天的轮次。
