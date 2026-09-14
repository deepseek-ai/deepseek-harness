---
description: "dsh Web 客户端的持久化工作流运行 Conversation Node：把顶层工作流运行重建为带嵌套成员折叠的独立聊天节点。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workflow-run

[English](README.md) | 中文

## 概述

使用 `dsh-client-ui-workflow-run` 可以把每个持久化的顶层工作流运行作为独立 Chat 节点查看。展开运行可查看阶段，展开阶段可查看成员；运行中、失败、已取消与已中断的层级默认展开，已完成层级保持折叠。只有当运行中的成员属于当前会话且可在本地访问时，才能打开其子会话。节点只显示身份与状态；脚本、输出、错误、日志、用量、拓扑与控制操作不属于本界面。

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

经 `dsh-tool-workflow` 发起的顶层工作流运行会在对话中显示为独立节点：展开运行查看其阶段，展开阶段查看其成员。阶段组只来自开始过的成员；成员结算只改变状态，不删除或重排成员。

### 导航节点

运行使用 32 像素行，带常驻 chevron、行内状态点与状态文字；阶段使用 disclosure 行，在主区显示标题与成员数、在固定尾部显示聚合状态；成员使用 16 像素状态点槽、会截断文本的名称区与固定状态列。打开成员的子会话需要成员仍在运行、子 id 位于普通会话列表、列表行为 `origin: 'subagent'`、`parentId` 等于当前会话，且列表行仍标记运行——远程、仅地址化、父级不符或终态的行都不可交互。

### 状态与完成

完成状态会立即更新，但只要焦点仍位于展开内容内，自动折叠就会等待焦点离开。若所属轮次或步骤已关闭但终点事件缺失，界面把相应运行或成员显示为已中断，而不改写工具结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

节点是持久化会话事件的确定性回放：`tool-workflow/run-start` 以 `runId` 创建唯一上下文，成员开始、成员结束与运行结束事件按日志顺序更新该上下文。只有 update 的历史尾页会保持 pending，直到更早页面补入唯一 start；此后 prepend、完整回放与实时 append 得到相同状态。

### 展开选择

普通运行更新保留当前选择，首次进入异常状态时仅自动展开一次，正常完成时仅自动折叠一次；已完成阶段在同一 phase key 下有新的成员开始运行时，该阶段与外层运行会再次自动展开。若一次全新的正常周期在同一次渲染中完整到达，而运行仍处于活动状态，该阶段最终保持折叠，但外层运行会自动展开一次，以展示更新后的摘要。阶段选择由 `WorkflowRunPanel` 持有，因此关闭并重新打开外层运行不会重置这些选择；renderer remount 会根据持久化事实重建每层的初始选择。

### 装配

本包把 Definition、locale 字典与 `workflow-run` renderer 都注册为 Cordis effect；移除客户端 entry 会撤销三者。shipped Web bundle 在 `ui-conversation` 与 `ui-tool` 之后装配该插件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖工具 seam、对话宿主与工具展示层。

- [tool-workflow](../../workflow/tool-workflow/README.zh.md)——拥有四类 `tool-workflow/*` 会话事件的工具。
- [ui-conversation](../ui-conversation/README.zh.md)——承载 `conversation.chat.node` slot 的聊天界面。
- [ui-tool](../ui-tool/README.zh.md)——本节点相邻的工具调用展示层。
- [Conversation 子系统](../../../docs/subsystems/conversation.zh.md)——业务自有功能如何注册 Conversation node。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，只渲染持久化工作流记录，不改变模型上下文。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义哪些运行会产生记录、节点暴露什么；它们是当前包约束。

- **只有经 `dsh-tool-workflow` 发起的顶层调用会生成这些记录**：嵌套 PTC mode 调用和直接 `WorkflowEngine` 消费方不会生成。
- **导航刻意只面向实时运行**：终态成员继续保留供复盘，但本节点永不为其提供冷会话入口。
- **节点只显示运行、阶段、成员身份与状态**：脚本、输出、错误、日志、用量、静态拓扑与控制操作都不属于本界面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。浏览器插件只贡献由 effect 持有的 Conversation Definition、keyed renderer 与 dictionary；测试证明资源释放时会撤销这三项贡献；Host tool 包负责持久事件不变式。
