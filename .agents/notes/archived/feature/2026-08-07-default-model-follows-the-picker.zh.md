# Agent Note: 默认模型跟随选择器

Status: implemented
Archived: 2026-09-04

[English](2026-08-07-default-model-follows-the-picker.md) | 中文

## 问题

会话模型选择器与部署默认值是同一项偏好的两个层次。如果选择器只影响其所在会话，下一个空白会话可能选择不同模型，用户却没有途径使默认值与选择器一致。如果默认值位于 Host 网关内部，直接创建 Agent 的入口只有依赖 Host 或复制状态才能共享它。

推理强度使持久化形态变得重要：不含强度的模型选择必须清除已存强度，否则下一个 Agent 可能会采用所选模型不接受的强度。

## 决定

`AgentDefaultModelConfig` 提供 `ctx.agentDefaultModel`，并把 `{provider, model, reasoningEffort?}` 注册为 `agent-default-model` Settings 分节。其 `{provider, model}` 组合条目是 base 层，`settings.yaml` 提供用户层。该服务不偏向特定入口，因此直接创建与 Session Controller Remote 创建共享同一个默认值（[headless 直接 core 入口](../architecture/2026-08-09-headless-direct-core-entry-point.zh.md)）。

`reasoningEffort` 属于 Settings 分节，但不属于插件配置。Settings 层按字段合并，因此已配置的强度会在用户选择省略它时继续存在。`saveSelection()` 写入完整的用户分节；因此，缺少该字段会清除已存强度。部署级强度默认值属于适配器 profile，并由它按模型解析。

`session.selectModel` 把被接受的 `ModelSelection` 应用于所在会话，并调用 `saveDefaultModelSelection()` 保存共享的 Agent 默认值。存储失败只记日志，不撤销会话选择。没有 Settings 提供方的部署保留组合条目，被接受的选择只停留在该会话中。

`ApiProxyDefaults` 携带 `defaultModelSelection()` 与 `saveDefaultModelSelection()` 闭包，因此 `createApiProxy` 不依赖 Settings seam。`ApiProxyService` 将它们分别接到 `ctx.agentDefaultModel.currentSelection()` 与 `ctx.agentDefaultModel.saveSelection()`。

`selectionFor(agent)` 每次读取时都解析各层：先取进程内的会话选择，其次取会话最新记录的 `request/header`，最后取当前 Agent 默认值。已有请求日志的会话持续绑定到日志中持久化的选择。空白会话即使创建于偏好保存之前，也会观察到当前默认值；这与 New Session 界面可能复用空白会话的行为一致。

已存选择不要求属于目录。某条提供方路由可能服务其仅供参考的目录未列出的模型。因此，`session.models` 会在已公布分组之外单独报告已存选择，并另行报告适配器是否服务其提供方。

## 影响

`session/modelCatalog` 报告当前 Agent 默认值。模型切换成功后，`settings.yaml` 中会存有一个 `agent-default-model:` 分节。Settings 页面不暴露该 namespace；模型选择器是它的编辑器。

## 无法发送消息的会话

当没有适配器服务会话所选提供方时，`session.prompt` 会在开启轮次前以 `model-unavailable` 拒绝。这一方法是强制执行边界；禁用 composer 只是客户端提供的便利。

`session.models` 报告 `routable`。ui-model-selection 插件通过 `ctx.conversation.blocks` 投影不可路由的选择，composer 随之变为不可操作，同时保留模型 seat 可用。客户端不知道是否可路由时不会阻断输入，包括目录首次加载或加载失败的情况。

可路由性与目录成员关系不同。仍在服务的提供方路由可以处理未公布的模型，因此不在目录分组中并不代表会话不可用。

## 考虑过的替代方案

| 替代方案 | 约定不匹配之处 |
|---|---|
| 已存提供方不可用时回落到组合条目 | 产品会静默切离用户选择。 |
| 根据目录成员关系校验已存选择 | 目录仅供参考，可能省略仍可请求的模型。 |
| 使用合并 patch 保存 | 省略的 `reasoningEffort` 无法清除已存字段。 |
| 只保存空白会话中的选择 | 对话期间知情作出的选择不会成为部署默认值。 |
| 增加单独的「设为默认」手势 | 会话选择器与未来会话偏好虽然代表同一用户选择，却仍可能分歧。 |
