# Agent Note: Trajectory 持久化图片附件

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-trajectory-image-attachments.md) | 中文

## Problem

Trajectory 不展示会话图片。持久化的 `{ type: 'image', attachment: ImageAttachmentRef }` 块在详情面板里渲染成格式化 JSON，纯图片的用户消息在记录表中是一个空行。Trajectory 唯一认识的图片路径是对内联 wire 字段（`url`、`image_url`、base64 `data`）的 `imageSrc` 嗅探，而生产事件从不携带这些字段：每个生产方都在事件追加前提交持久化的 `ImageAttachmentRef`。用户无法从执行记录确认模型看到了哪张图（[issue #2986](https://github.com/deepseek-harness/deepseek-harness/issues/2986)），而 Chat 已经能展示同样的附件。

## Decision

- `ui-conversation` 拥有按会话的持久化图片 URL 缓存。`HistoricalImageCache` 从 `ui-chat` 移入 `packages/client/ui-conversation/src/client/conversation/historical-images.ts`，以 `ctx.uiConversation.imageUrl(sessionId, attachment)` 提供。Chat 与 Trajectory 通过同一实例解析，因此一个会话附件只产生一次 `session.attachment` 读取和一个浏览器 URL，并随 Session binding 释放而撤销。这部分取代了 [client Session/Conversation 所有权](../architecture/2026-08-20-client-session-conversation-ownership.zh.md)中记录的 `ui-chat` 缓存归属。
- 画廊 owner 契约（`MessageImagesOwnerProps`、`RenderMessageImages`）移入 `ui-conversation` 客户端契约。`ui-chat` 的 `conversation.message.images` SlotMap 行沿用共享 owner 类型；`ui-trajectory` 以同一 owner 类型声明自己的子槽位 `conversation.trajectory.images`；`ui-attachment` 把同一个 `MessageImages` 画廊组件注册进两个键，因此加载、重试与灯箱行为在两个视图中完全一致。
- `TrajectorySourceBlock` 以 `attachment?: ImageAttachmentRef` 取代 `imageSrc`/`imageAlt`。内联来源嗅探（`sourceImage`、`safeImageSource`）与 Trajectory 本地的 `PanelImage` 渲染器一并删除：没有生产方向会话日志写入内联图片字节或 URL，这些路径是死代码，且 issue 明确排除上传来源的临时路径。
- 内容含图片但没有文本的记录，其记录表行以 locale 持有的 `layout.imageOnly` 计数标注；只含图片的工具结果的摘要也使用同一标签，而不是 JSON 转储。
- 存储与 BFF 均不改动：`session.attachment` 已按会话日志引用授权（缺失、损坏与未被引用的附件显式失败并进入画廊的重试态），sha256 内容寻址已保证每张图片只存一份。

## Alternatives considered

**保留 Trajectory 自己的 `<img>` 渲染并喂给它解析好的 URL。** 这会重复 `ui-attachment` 已拥有的加载占位、重试控件和灯箱，并与[基于 slot 的附件所有权](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.zh.md)相抵触，该决定已拒绝跨插件直接 import 组件。

**把 `conversation.message.images` 的声明上提到共享父级，让两个视图渲染同一个键。** `renderSlot` 的类型限定在声明入口自己的 children 表内，同级的 `conversation.view` 入口无法渲染另一个入口的子键；slot registry 也拒绝对同一键的第二次声明。共享 owner 类型的第二个键是受支持的组合方式，且允许主题独立替换任一画廊。

**在持久化路径之外保留内联 `imageSrc` 嗅探。** 所有生产方（宿主 prompt admission、`read_image`、MCP 投影、ACP 入口）都在事件追加前提交持久化引用，嗅探不会命中任何东西；保留它等于保留验收标准明确排除的非持久化渲染路径。

**Trajectory 自有的图片缓存。** 每个视图一份缓存会对同一会话附件发出重复的 `session.attachment` RPC 和重复的 blob URL，违背"Chat 与 Trajectory 引用同一会话附件"的要求，且没有任何收益。

## Consequences

- 两个视图共用一个画廊实现，图片行为（尺寸、重试、灯箱、文案）不会在 Chat 与 Trajectory 之间漂移，且无论多少个视图展示，一个会话附件只读取一次。
- `TrajectoryTable` 需要把必填的 `renderImages` prop 逐层传入详情组件；`ui-trajectory` 新增对 `dsh-attachment` 的仅类型依赖，`ui-attachment` 为新的 SlotMap 行新增对 `ui-trajectory` 的仅类型依赖。
- keyless 组装快照 `apps/web/tests/trajectory-image-display.snapshot.ts` 直接钉住共享缓存这一事实：详情面板中的图片 URL 与 Chat 画廊对同一 fixture 附件的 URL 字符串相同。
