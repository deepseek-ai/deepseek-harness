---
description: "Web GUI 的 plan 模式状态徽章：显示 plan 模式已开启并可将其关闭的 composer 控件；供 plan 模式的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plan

[English](README.md) | 中文

## 概述

本包在 Web GUI 中渲染 plan 模式状态徽章：当宿主计算的投影有效目标为 plan 模式时，composer 显示一个 warn 色「Plan ×」按钮，可关闭 plan 模式；否则该座位保持为空。plan 模式本身——`/plan` 命令、已提交的 `plan/mode` 状态、投影单元与 policy 段——归 `dsh-plan-mode` 所有；本包只渲染投影并发送用户同样可以手敲的内容。模型经稳定的 `exit_plan_mode` 工具退出 plan 模式；其 plan 评审走已组合的 Web question 通道。

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

与 `ui-conversation` 及 `dsh-plan-mode` 一起挂载本插件；plan 模式激活时，徽章随即占据 composer 的 plan 座位（访问模式控件右侧）。经 `/plan` 命令路径进入 plan 模式——从 composer 的 `+` Command 菜单选择 Plan，或键入 `/plan`——再用徽章将其关闭。

### 徽章显示什么

当有效目标为 plan 模式时，该座位渲染 warn 色「Plan ×」状态按钮，执行 `/plan off`。否则座位保持为空：未组合 plan-mode 的宿主，或尚无会话的 Draft，都不显示任何内容。plan 模式为有效目标期间，composer 文本框的 placeholder 切换为 plan 任务提示——「describe your task to generate plan」——除非持有表面提供自己的 placeholder。

### 失败

准入失败（`matched: false`、业务错误、传输故障）以内联错误呈现，徽章保持显示直至投影确认退出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

徽章占据 conversation 声明的 `conversation.input.plan` 单实例座位；node 半部是空 apply（roster 行）。读取经标准工具包 `useProjection` 走通用投影对：有效目标是 `pending ? !active : active`——折叠的宿主值而非客户端乐观态，因此到达的帧无论哪个方向都会纠正徽章。座位注入面携带一个动词 `exitPlanMode`，经 `ctx.remote.commands.execute` 执行 `/plan off`，并把准入失败映射为一行内联错误。placeholder 与提示文案位于 ui-conversation 的 `conversation` locale 命名空间，与已认领 `/plan` 命令的提示逐字共用。无障碍描述是「Plan mode on, press to turn off」。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 plan 面不够用时阅读以下页面。它们从徽章进入 plan 模式领域与 composer 外壳。

- [dsh-plan-mode](../../plan/plan-mode/README.zh.md)——拥有 plan 模式、`/plan` 命令、投影与 policy 段。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.plan` 座位与 placeholder locale 键。
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
- **徽章属于默认 composer**——待处理的整 composer 交互（如 plan 评审）会临时取代 InputBar 及其徽章。
- **无未激活 plan 控件**——入口使用共享 Command source；有能力但模式未激活的会话在工具行不显示 plan 入口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。plan state 与 boundary 归 `dsh-plan-mode` 审计；本包 control 只是由包测试覆盖声明、注册和释放的 slot effect。
