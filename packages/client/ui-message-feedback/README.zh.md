---
description: "Web 反馈界面：已定稿助手消息动作行中的 Like/Dislike 对、两种评分与 `/feedback` 共用的反馈弹窗，以及确认和失败 toast；供反馈体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-message-feedback

[English](README.md) | 中文

## 概述

本包是 Web GUI 的反馈界面：已定稿助手消息动作条中的 Like/Dislike 对、输入框浮层中的反馈弹窗及其确认与失败 toast，以及让不带文本的 `/feedback` 打开弹窗的装饰。点赞和点踩都会打开弹窗，先收集分类与可选描述，再记录所选评分。每个 Session 一个 surface 支撑所有条目，因此一次列表读取即可填充整段对话，一个弹窗同时服务 Session 与其消息。评分、分类与备注是仅写日志的 Session 事件，绝不进入模型上下文。

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

与 `ui-conversation`、`ui-commands` 一起挂载本插件；Like/Dislike 对随即出现在每个轮次收尾助手消息的动作行中，位于复制与分支之间，输入框菜单里的「反馈」行则打开弹窗。已记录的评分显示实心图标，不需要悬停也一直可见。点赞和点踩都会打开弹窗：七个分类标签和一个详情框都可不填；提交后才会记录带所填内容的对应评分并弹出感谢 toast，对话日志随每个反馈事件一起投递。再次点击已记录的评分会直接撤回，不打开弹窗。不带文本的 `/feedback`，无论是从菜单选中还是直接输入后发送，都会为 Session 打开同一个弹窗；`/feedback <text>` 仍走宿主命令路径并显示确认行。

### 失败

评分或列表加载失败在行内展示；提交失败通过警告 toast 展示，弹窗保持打开以便修正草稿。只有已定稿的消息能到达消息条目——被中断冻结的部分输出不带 `messageId`，因此没有反馈控件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包贡献 `conversation.chat.assistant-actions` 的 `feedback` 条目（order 10），由 ui-conversation 声明并渲染在已定稿助手消息的 IconActions 行内；同时贡献 `conversation.input.overlay` 的 `feedback-dialog` 条目（order 2），它通过 body portal 渲染 Modal 与 Toast 基元，并让 toast 以其所在的输入框卡片为中心。`/feedback` 装饰是经 `ctx.commandUi.decorate` 注册的 `action`，因此菜单选中或不带参数的回车会消费触发 token 并打开弹窗，而带参数的命令行仍到达宿主命令。

每个 Session 有一个 `MessageFeedbackController` 支撑所有消息控件，以及一个 `FeedbackDialogController` 拥有弹窗草稿、提交与 toast 序号。消息控制器只读取一次 `messageFeedback.list`，且延迟到首次 hover 或 focus 才发起，而非挂载时触发；变更串行执行，每次都携带最后观察到的版本，`version-conflict` 响应带回权威条目，据此对账视图而不重新拉取。任一评分操作执行前，该行都会检查已提交条目：评分相同则调用 `retract`，它会在串行队列内重新检查评分并在并发变更后变为无操作；其他状态则携带所选评分打开弹窗。弹窗控制器按目标提交：消息目标通过消息控制器 put 一条带弹窗备注与分类的对应评分，Session 目标通过 `ctx.remote.sessionFeedback` 记录。成功会关闭草稿并弹出确认 toast；被替换的旧草稿迟到的成功只弹确认 toast、不关闭新草稿；失败会保留弹窗并弹出停留时间更长的警告 toast。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当反馈界面不够用时阅读以下页面。它们从浏览器条带进入 Session 日志后端与会话外壳。

- [dsh-message-feedback](../../feedback/message-feedback/README.zh.md)——拥有按条目比较并交换与持久化的 Session 日志后端。
- [dsh-command-feedback](../../feedback/command-feedback/README.zh.md)——`/feedback` 命令、`sessionFeedback` Remote 与分类表。
- [ui-commands](../ui-commands/README.zh.md)——`/feedback` 行所经过的命令装饰约定。
- [ui-conversation](../ui-conversation/README.zh.md)——声明助手动作条与输入框浮层。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无。评分、分类与备注是仅写日志的事件，不是模型输入。可选的 Session 日志投递使用请求元数据，而非模型上下文。

#### KV Cache 影响

无；反馈变更不改变模型可见的历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前反馈界面。它们是当前包约束，不是通用评分对比或任务积压。

- **备注大小是宿主策略**——部署方配置 `maxNoteBytes`（Web bundle 中为 8192），超长备注由宿主以 `note-too-large` 拒绝。弹窗不预先校验该上限，因此针对消息的超长描述在提交时才失败，而不是在输入过程中；Session 级备注没有上限。
- **无跨标签页推送**——另一个标签页的评分要等到重连或下一次冲突响应才可见，不会立即出现；控制器不消费反馈日志事件。
- **仅限对话视图**——trajectory 与 waterfall 视图不渲染反馈控件，尽管它们的助手节点也带有相同的 `messageId`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件持有两个 slot 注册、一个命令装饰，以及一个按 Session 划分的控制器对 map；它们都由插件 fiber 的同一个 effect disposer 释放。生命周期规格测试证明，所属 fiber 释放时会撤销所有注册并丢弃所有控制器，因此不存在需要在运行时检查的第二权威来源。
