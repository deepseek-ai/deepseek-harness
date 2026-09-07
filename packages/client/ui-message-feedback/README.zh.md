---
description: "Web GUI 的逐消息反馈：已定稿助手消息动作行中的 Like/Dislike 对与可选备注；供反馈体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-message-feedback

[English](README.md) | 中文

## 概述

本包为 Web GUI 增加逐消息反馈：一对 Like/Dislike 按钮加一个可选备注，作为已定稿助手消息动作条的 `feedback` 条目贡献。它渲染在每个轮次的收尾助手消息上——多步骤轮次中较早的步骤产出工具行而非可评分正文。每个 Session 一个控制器支撑该 Session 内所有消息的控件，因此一次列表读取即可填充整段对话。评分与备注是仅写日志的 Session 事件：它们绝不进入模型上下文。删除会撤回当前条目，但不会抹除早先的日志记录。

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

与 `ui-conversation` 一起挂载本插件；Like/Dislike 对随即出现在每个轮次收尾助手消息的动作行中，位于复制与分支之间。再次点击已记录的评分会撤回反馈；切换到另一侧会保留既有备注。备注编辑器是一个锚定在其触发按钮下方的对话框浮层，因此无论编辑器是否打开，该行都保持单行。

### 失败

评分或列表加载失败在行内展示；备注保存失败在浮层内展示，面板保持打开以便修正草稿。只有已定稿的消息能到达该槽位——被中断冻结的部分输出不带 `messageId`，因此没有反馈控件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包贡献 `conversation.chat.assistant-actions` 的 `feedback` 条目（order 10），由 ui-conversation 声明并渲染在已定稿助手消息的 IconActions 行内。每个 Session 一个 `MessageFeedbackController` 支撑该 Session 内所有消息的控件，因此一次 `messageFeedback.list` 读取即可填充整段对话；该读取延迟到首次 hover 或 focus 才发起，而非挂载时触发。变更经 `ctx.remote.messageFeedback` 提交，按条目的比较并交换由宿主负责。每次 `put` 与 `delete` 都携带本控制器最后观察到的 `version`；`version-conflict` 响应带回权威条目，因此竞争失败时直接用该响应本身对账，无需重新拉取。变更按 Session 串行，排队中的操作总是与已提交的版本比较。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当反馈面不够用时阅读以下页面。它们从浏览器条带进入 Session 日志后端与会话外壳。

- [dsh-message-feedback](../../feedback/message-feedback/README.zh.md)——拥有按条目比较并交换与持久化的 Session 日志后端。
- [ui-conversation](../ui-conversation/README.zh.md)——声明助手动作条并渲染动作行。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无。评分与备注是仅写日志的事件，不是模型输入。可选的 Session 日志投递使用请求元数据，而非模型上下文。

#### KV Cache 影响

无；反馈变更不改变模型可见的历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前反馈表面。它们是当前包约束，不是通用评分对比或任务积压。

- **备注大小是宿主策略**——部署方配置 `maxNoteBytes`（Web bundle 中为 8192），超长备注由宿主以 `note-too-large` 拒绝。编辑器不预先校验该上限，因此超长备注在保存时才失败，而不是在输入过程中。
- **无跨标签页推送**——另一个标签页的评分要等到重连或下一次冲突响应才可见，不会立即出现；控制器不消费反馈日志事件。
- **仅限对话视图**——trajectory 与 waterfall 视图不渲染反馈控件，尽管它们的助手节点也带有相同的 `messageId`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件持有一个 slot 注册和按 Session 的 controller map，两者由同一 effect disposer 释放；生命周期测试已直接观察该关系。
