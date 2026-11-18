---
description: "Web GUI 的 plan 模式状态徽章：显示 plan 模式已开启并可将其关闭的 composer 控件；供 plan 模式的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plan

[English](README.md) | 中文

## 概述

计划模式让你在实施前审阅计划。通过 `/plan` 进入，通过编辑器中的状态按钮退出。提交的计划自动在右侧边栏打开供审阅；批准、拒绝或关闭审批后，仍可通过已完成回合末尾的产物卡片查看。重新打开同一计划会聚焦已有标签页，刷新浏览器后临时正文会过期；请从计划卡片重新打开。

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

与 `ui-conversation` 及 `dsh-plan-mode` 一起挂载本插件；plan 模式激活时，徽章随即占据 composer 的 plan 座位（访问模式控件右侧）。经 `/plan` 命令路径进入 plan 模式——从 composer 的 `+` Command 菜单选择「计划」，或键入 `/plan`——再用徽章将其关闭。

### 徽章显示什么

当有效目标为 plan 模式时，该座位渲染蓝色「计划」状态按钮——标签前是计划图标，按钮可用且被悬停或键盘聚焦时换成圆形 ×——点击执行 `/plan off`。否则座位保持为空：未组合 plan-mode 的宿主，或尚无会话的 Draft，都不显示任何内容。plan 模式为有效目标期间，composer 文本框的 placeholder 切换为 plan 任务提示——「describe your task to generate plan」——除非所属 surface 提供自己的 placeholder。

### 查看已提交的计划

回合结束后，每次提交的计划都会显示在该回合末尾的产物区域，并采用文件产物卡片的样式，包含 Markdown 图标、标题和“打开”操作。在当前浏览器会话中，每份待审计划自动打开一次；关闭后，重新挂载审批组件不会再次展开，新提交会打开其对应计划。历史卡片仅在点击后打开。通过卡片或审批条带上的“查看全文”链接可阅读完整 Markdown。计划在[内容预览](../ui-sidebar-documentpreview/README.zh.md#content-previews)标签页中打开，标题取计划的第一个一级标题。未加载提供内容预览的文档预览插件时，计划标签、卡片和审批条带仍会显示，但打开按钮置灰，提示文字会指出缺少的插件。不同提交保留独立标签页；是否开始实施仍由审批按钮决定。

没有已记录调用标识的审批也会自动打开。完整正文只保存在当前窗口的内存中，待处理审批卡片会重新打开同一个标签页。刷新页面会丢失该正文：恢复的标签页显示内容预览的失效提示，仍在等待的审批可以再次打开它。在嵌入式子对话中打开计划时，预览使用当前可见的侧栏，标签页键包含子会话标识。

### 失败

准入失败（`matched: false`、业务错误、传输故障）以内联错误呈现，徽章保持显示直至投影确认退出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

徽章占据 conversation 声明的 `conversation.input.plan` 单实例座位；node 半部是空 apply（roster 行）。读取经 standard-kit 的 `useProjection` 走通用投影对：有效目标是 `pending ? !active : active`——折叠的宿主值而非客户端乐观态，因此到达的帧无论哪个方向都会纠正徽章。座位注入面携带一个动词 `exitPlanMode`，经 `ctx.remote.commands.execute` 执行 `/plan off`，并把准入失败映射为一行内联错误。placeholder 与提示文案位于 ui-conversation 的 `conversation` locale 命名空间，与已认领 `/plan` 命令的提示逐字共用。

计划卡片和待审批入口把完整 Markdown 直接传给 `ctx.contentPreviews.open`，使用包含会话标识的调用 key 或审批 key，并从开头标题派生预览标题。共享内容标签沿用当前侧栏位置，内嵌子代理计划也在父会话侧栏打开。`contentPreviews` 是可选服务，服务可用前卡片和审批控件保持禁用；审批自动打开还等待 `ctx.sidebarRight.mounted`。导航正文只保存在内存中，刷新后请从计划或审批卡片重新打开过期预览。计划卡片仍通过 Conversation Definition 从已记录的原生或 PTC 调用派生，并与文件产物共同贡献到 `conversation.chat.turnTail`。

框架绑定的 `usePlans(turn)` 只提供该回合的已提交计划数据。Chat 随节点更新维护成员索引，并在读取时排列该集合；卡片渲染不扫描整段对话，也不订阅其他回合或节点类型。

已提交计划卡片的圆角和图标底框材质遵循[文件卡片家族](../../../docs/ui-radius.zh.md#radius-scale)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 plan surface 不够用时阅读以下页面。它们从徽章进入 plan 模式领域与 composer 外壳。

- [dsh-plan-mode](../../plan/plan-mode/README.zh.md)——拥有 plan 模式、`/plan` 命令、投影与 policy 段。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.plan` 座位与 placeholder locale 键。
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.zh.md#content-previews)——显示计划文档和临时审批的右侧边栏内容标签页。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plan-mode)——模型退出 plan 模式所用的 `exit_plan_mode` 工具 schema。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 chip 派发的 `/plan off` 命令行：`dsh-plan-mode` 拥有该命令行驱动的模型可见 policy 段、退出工具 schema 与已记录状态。

#### KV Cache 影响

进入或离开 plan mode 会改变活跃的 `plan:policy` 系统提示词段，因此改变请求前缀；chip 本身不添加任何提示词内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前 plan 徽章。它们是当前包约束，不是 plan 模式对比或任务积压。

- **Plan 模式是引导而非执行沙箱**——需要强制只读规划的部署必须组合独立的沙箱与审批策略。
- **徽章属于默认 composer**——待处理的涉及整个 composer 的交互（如 plan 评审）会临时取代 InputBar 及其徽章。
- **未激活时无 plan 控件**——入口使用共享 Command source；有能力但模式未激活的会话在工具行不显示 plan 入口。
- **预览正文在刷新后失效**——正文只保存在内存中，刷新后请从计划或审批卡片重新打开。
- **早期版本保存的计划标签页不可用**——计划改用内容预览之前保存的布局，恢复出的 `plan` 标签页没有可显示它的标签页类型，因此会显示右侧栏的不可用提示，直到手动关闭；从计划的 Chat 卡片可以重新以内容预览打开。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
