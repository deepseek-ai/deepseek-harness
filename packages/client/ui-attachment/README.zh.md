---
description: "对话 UI 的附件呈现：草稿图片栏、文档拖放目标、历史图片画廊与原图灯箱；供 Web 附件体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-attachment

[English](README.md) | 中文

## 概述

本包渲染对话 UI 中与附件相关的一切：composer 下的待发送草稿图片、全视口拖放邀请层、Chat 与 Trajectory 中的持久图片，以及查看原图的灯箱。它是纯呈现层——附件数据、图片加载与回调都经声明槽位来自 conversation 包。需要 DeepSeek Chat 风格的图片体验时选择它；非图片文件在此没有任何表面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 [`ui-conversation`](../ui-conversation/README.zh.md) 一起挂载本插件；它等待 conversation 包的槽位声明，并把自身表面注册进这些槽位。用户随即看到：带逐图删除与点击打开的草稿图片栏、带上限说明的拖放遮罩、按数量定尺寸的消息图片，以及支持 Escape／遮罩／关闭按钮的灯箱。

### 草稿图片

草稿图片以固定 64px 缩略图呈现在一行横向滚动条中；溢出隐藏时由边缘箭头翻页，滚动条保持隐藏。新增条目滚动到栏尾展示，删除保持原位，单击经持有方的 `onOpen` 打开原图。

### 消息图片与灯箱

一条消息仅有的一张图按长边 240px 渲染（宽高比钳制在 [0.25, 4]，从不放大）；多图中的一张渲染为固定 64px 方块。加载完成的图片单击打开文档级灯箱；加载失败则显示重试控件。灯箱按 Escape、按下遮罩或点关闭按钮关闭，并把焦点还给打开者。

### 拖放遮罩

文件拖拽悬停页面时，全视口遮罩宣布可拖放：插画、标题，接受拖放时再加一行上限说明。遮罩只呈现状态——接受或拒绝由持有方的 document 级监听器决定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件通过 `ctx.slots.inject` 等待 `conversation.input.attachments`、`conversation.message.images` 与 `conversation.trajectory.images`。随后它注册 composer rail、文档拖放目标、供 Chat 和 Trajectory 共用的历史图片 gallery，以及原图灯箱。呈现组件保持纯 props：conversation 槽位持有方提供附件数据、图片加载、回调与语言包翻译器；包入口不导出任何组件。

| 文件 | 职责 |
|---|---|
| [`src/client/ComposerAttachments.tsx`](src/client/ComposerAttachments.tsx) | 草稿图片栏＋拖放遮罩的组装 |
| [`src/AttachmentRail.tsx`](src/AttachmentRail.tsx) | 滚动缩略图栏、滚轮转换、边缘箭头 |
| [`src/client/MessageImages.tsx`](src/client/MessageImages.tsx) | 每消息画廊＋灯箱的组装 |
| [`src/MessageImage.tsx`](src/MessageImage.tsx) | 单图尺寸、加载／重试、点击打开；本地提交回显预览直接显示其 object URL |
| [`src/ImageLightbox.tsx`](src/ImageLightbox.tsx) | 铺在共享遮罩上的文档级模态预览 |
| [`src/DropOverlay.tsx`](src/DropOverlay.tsx) | 不接收指针事件的拖拽邀请 portal |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当附件面不够用时阅读以下页面。它们从本包填充的槽位进入拥有输入流程的会话外壳。

- [ui-conversation](../ui-conversation/README.zh.md)——声明附件槽位并拥有 composer 与图片摄入。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册槽位。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该插件只渲染由对话 UI 提供的附件状态，不贡献模型可见输入。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前附件表面。它们是包约束，不是通用图片查看器对比或任务积压。

- **仅支持图片**——非图片文件尚无附件栏卡片与历史渲染；DeepSeek Chat 风格的文件卡片和上传进度等输入框接受非图片附件后再做。
- **灯箱无缩放与下载**——预览仅以适配视口的尺寸渲染原图。
- **灯箱不锁定焦点**——它设置 `aria-modal` 并在关闭时归还焦点，但 Tab 仍可移动到背后的页面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只贡献 effect 所有的 slot entry；slot 注册表负责其生命周期并校验声明。
