---
description: "对话 UI 的附件呈现：混合草稿附件栏、文档拖放目标、历史图片画廊与原图灯箱；供 Web 附件体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-attachment

[English](README.md) | 中文

## 概述

本包渲染对话 UI 中与附件相关的一切：composer 下的一条有序草稿附件栏、全视口拖放提示层、Chat、Trajectory 与工具结果中的长期保留的图片，以及查看原图的灯箱。附件数据、上传状态、图片加载与回调来自声明这些 slot 的持有方。需要 DeepSeek Chat 风格的附件体验时选择它。

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

图片拖放回调与输入框的原图读取回调通过 slot 注入从 [ui-file-drag](../ui-file-drag/README.zh.md) 获取。图片图库 Factory 也通过声明的注入接口接收回调；自定义 Factory 替换实现必须提供该接口。 `MessageImage` 和 `ImageGallery` 必须接收普通 `getTriggerProps` 函数，每张原图绑定一次，将同一份 `contextMenuProps` 传给缩略图和灯箱。

与 [`ui-conversation`](../ui-conversation/README.zh.md) 一起挂载本插件，工具结果需要图片图库时也要挂载 [`ui-tool`](../ui-tool/README.zh.md)。插件等待这些 slot 的声明，并把组件注册进去。用户会看到混合草稿附件栏、带上传控件的 DeepSeek Web 文件卡、带限制说明的拖放遮罩、按数量定尺寸的消息图片、工具卡片图库，以及支持 Escape、遮罩和关闭按钮的灯箱。

### 草稿附件

图片与通用文件按选择顺序进入同一条不换行的横向附件栏。所有条目均为 64px 高：图片是 64px 方形缩略图，通用文件是 240px 宽的 DeepSeek Web 卡片，带 16px 圆角、蓝色渐变文档图标、文件名，以及大写扩展名与字节大小。溢出隐藏时由边缘箭头翻页，滚动条保持隐藏，新增条目会滚动到栏尾展示。文件上传时图标位置显示 spinner，传输层报告字节时显示进度，首次报告前使用不定态进度条；失败时显示重试。上传中的图片在缩略图底边显示同样的进度条，上传失败的图片缩略图变成重试控件；Host 拒绝的图片则用缩略图的提示说明原因，点按也能固定该提示，只能移除。移除按钮在悬停或键盘聚焦时出现，在触摸设备上保持可见。单击图片会打开原图。

### 消息图片与灯箱

Chat 中的一条用户消息把文件与图片放在同一个靠右、可换行的排列中，并保持来源顺序。消息仅有一张图片且没有其他附件时，图片按长边 240px 渲染（宽高比钳制在 [0.25, 4]，从不放大）；消息有多个附件时，每张图片显示为固定 64px 方块，与 240×64px 文件卡同排。加载完成的图片单击打开文档级灯箱；加载失败则显示重试控件。灯箱按 Escape、按下遮罩或点关闭按钮关闭，并把焦点还给打开者。

Trajectory 附件行使用 48px 方形缩略图，完整缩放图片而不裁剪。加载与重试图标保持相同尺寸，提供本地化的工具提示和可访问名称；图片打开同一个灯箱。插槽持有方可以为缩略图与灯箱提供仅用于展示的图片名称，而不改变持久化引用或缓存查询。

已加载的会话图片可拖入输入框作为图片附件，也可将原文件拖到其他应用。拖动不会打开灯箱。共享图片传递组件将 Web 拖动的原图字节保留到手势结束；Desktop 使用系统文件拖放。准备或拖放失败时保留图片，并显示本地化的重试提示。

应用内 Web 图片拖放不显示全屏遮罩。没有实际文件的外来或过期图片令牌会被忽略。浏览器传递限制见 [ui-primitives](../ui-primitives/README.zh.md#known-limitations-and-deferred-work)。

### 拖放遮罩

外部文件拖到页面上方时，全视口遮罩显示拖放提示，包括插画和标题；接受拖放时还会显示一行限制说明。遮罩只呈现状态，是否接受由持有方的文档级监听器决定，拖放处理器通过 entry API 报告放下的成员中哪些是文件夹，以便持有方引用或拒绝它们。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件提供 root 作用域的 `conversation.images.content` Factory。官方 `MessageImages` 条目通过 `ctx.slots.inject`，以优先级 100 填入 `conversation.chat.user.images`、`conversation.chat.message.images`、`conversation.trajectory.images` 和 `tool.call.images`。较低优先级的条目只替换自身所在位置，移除后恢复官方条目。各默认条目复用同一画廊，显式传入图片引用、授权 loader、布局参数和可选的完整 labels。Factory 负责画廊展示与默认文案，不拥有 Session 状态或读取授权。各领域拥有自己的 Slot 声明。Composer 附件栏仍为独立条目，包入口不导出任何组件。

| 文件 | 职责 |
|---|---|
| [`src/client/ComposerAttachments.tsx`](src/client/ComposerAttachments.tsx) | 有序图片／文件栏＋拖放遮罩的组装 |
| [`src/client/drop-events.ts`](src/client/drop-events.ts) | 每个已挂载附件视图的 effect 安装的 document 拖放监听 |
| [`src/AttachmentRail.tsx`](src/AttachmentRail.tsx) | 附件横向溢出、滚轮转换、边缘箭头 |
| [`src/client/MessageImages.tsx`](src/client/MessageImages.tsx) | 每消息画廊＋灯箱的组装 |
| [`src/MessageImage.tsx`](src/MessageImage.tsx) | 单图尺寸、加载／重试、点击打开；本地提交回显预览直接显示其 object URL |
| [`ImageLightbox`](../ui-primitives/src/ImageLightbox.tsx) | 铺在共享遮罩上的文档级模态预览 |
| [`src/DropOverlay.tsx`](src/DropOverlay.tsx) | 不接收指针事件的拖放提示 portal |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

如果附件界面本身还不够，请阅读以下页面。这些页面从本包填充的 slot 讲到负责输入流程的会话外壳。

- [ui-conversation](../ui-conversation/README.zh.md)——声明附件 slot，并负责 composer 与图片接收。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件行如何加载并注册 slot。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

消息图片和原图预览通过共享图片库将右键手势转发给 [ui-context-menu](../ui-context-menu/README.zh.md)。原始授权 URL 与 MIME 元数据独立于缩略图展示。

<a id="model-experience"></a>
## 模型体验

无，因为该插件只渲染由对话 UI 提供的附件状态，不贡献模型可见输入。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前附件功能范围。它们是包约束，不是通用图片查看器对比或任务积压。

- **灯箱无缩放与下载**——预览仅以适配视口的尺寸渲染原图。
- **灯箱不锁定焦点**——它设置 `aria-modal` 并在关闭时归还焦点，但 Tab 仍可移动到背后的页面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
