# Agent Note: 领域图片 Slot 与共享画廊 Factory

Status: implemented

[English](2026-10-09-message-node-factories-and-delegates.md) | 中文

## 问题

用户消息、助手输出、Trajectory 记录和工具结果需要可独立替换的图片展示。官方条目可以共享同一画廊，但共享实现不能合并各自的替换位置，也不能隐藏调用方的图片读取授权。

## 决策

各领域声明自己的图片 Slot，并把框架 `renderSlot` 席位交给实际渲染它的组件。官方附件条目复用一个 Content Factory，沿用 [Body Slot 与 Content Factory 的分工](2026-10-09-reasoning-content-slot-factory.zh.md)。

| 入口 | 声明所有者与渲染组件 |
| --- | --- |
| `conversation.chat.user.images` Slot | `conversation.chat.user.content` Factory 声明，由 `UserContent` 为用户消息、待处理 steering 和本地回显渲染。 |
| `conversation.chat.message.images` Slot | Assistant 节点注册声明，由 `AssistantMarkdown` 渲染连续的输出图片组。 |
| `conversation.trajectory.images` Slot | Trajectory 视图注册声明，记录附件及工具输出块通过账本的 Slot 席位渲染。 |
| `tool.call.images` Slot | `read_image` 工具视图注册声明，由 `ToolRow` 渲染结果图片。 |
| `conversation.images.content` Factory | 附件插件注册此 root 作用域画廊，由 `MessageImagesContent` 实现。 |

附件插件以优先级 100 为四个图片 Slot 填入同一个 `MessageImages` React 适配组件。较小的优先级只替换选定领域的条目；替换条目释放后恢复官方条目。适配组件显式向 `conversation.images.content` 传入图片引用、`loadImage` 和布局参数。共享 Factory 不声明各领域的 Slot，也不通过场景参数选择领域。

图片调用方直接使用其声明的 Slot，不设置仅转发一次 Slot 调用的图片入口 Factory。用户文本仍使用独立共享的 `conversation.user.text` Factory 及其 keyed 节点 Slot，详见[用户文本决策](2026-10-10-user-text-json-nodes.zh.md)。

`AssistantNodeView` 将 Slot 席位与 `loadImage` 传给 `AssistantMarkdown`。用户包装层通过 `UserStyleBubble` 将 loader 传给 `UserContent`。Trajectory 通过账本传递自己的 Slot 席位与 loader。这些路径保持组件职责、图片顺序和 key，不使用自制的 ReactNode 图片渲染回调。

Conversation 拥有读取授权、逐 Session URL 缓存与回收。共享画廊不查找全局当前 Session：持久图片使用调用方提供的 loader 读取，本地提交回显预览保留已有浏览器 URL。画廊布局、重试、缩略图和灯箱行为仍由附件包负责。

`ChatView` 保留既有 `MarkdownDelegateProvider` 及其包装后的文件打开动作、外链动作和文件图片能力。原生图片组合不替代 Markdown 图片处理及失败反馈。

`MessageImagesContentInput` 接受可选的完整 `MessageImageLabels`。提供 labels 时原样使用，省略时由 Content Factory 的 locale 席位提供默认文案。

## 考虑过的替代方案

**所有调用方共用一个图片 Slot。** 面向某个领域的替换也会影响其他领域；共享实现不要求共享替换身份。

**跨功能包导入画廊组件。** 绕过标准 Slot 替换机制和可复用的 Factory 入口。

**传递自制图片渲染函数，或通过私有 Context 供应 loader。** 框架 Slot 席位已经表达渲染权限，显式 loader props 则保留调用方的 Session 授权。

## 验证

- 用户与输出图片使用独立 Slot；替换任意一方时，另一方及其已挂载画廊不受影响。
- 各官方图片条目优先级为 100；优先级 0 的替换条目胜出，释放后恢复官方画廊。
- 四个默认条目携带原有图片数据、授权 loader 和布局选项调用同一个 Content Factory。
- 来源顺序、key、缓存预览、读取失败重试及灯箱交互保持既有行为。
- Content Factory 接受完整自定义 labels，调用方省略时解析默认 labels。
- 卸载附件实现会移除其条目，但不移除各领域声明的 Slot。

## 影响

独立 Slot 支持各领域定制展示而无需复制画廊。领域调用方需要将框架 Slot 席位传给普通 React 后代组件，并在每次图片调用中提供授权 loader。Factory 与普通 Slot 的生命周期和所有权不同；可复用实现不拥有它出现的所有位置。
