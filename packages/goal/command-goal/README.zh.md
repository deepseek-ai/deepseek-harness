---
description: "面向在 UI 命令平面中选择、组合或排查 goal 控制的用户与维护者的 /goal 斜杠命令说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-goal

[English](README.md) | 中文

## 概述

`dsh-command-goal` 为用户提供基于持久 goal 服务的 `/goal` 命令：用户可以直接在 UI 中创建、编辑、暂停、恢复、清除并查看当前 goal，无需模型参与。命令在其 Cordis scope 中注册，因此读取该 scope 的命令适配器能发现并执行它；命令文本与输出都留在 UI 中，绝不进入模型请求。每项被接受的变更都会通过 goal 服务的持久 `goal/change` 事件落盘。有序的图片与文件附件可以随 create 或 edit 一起提交，并以一条普通用户消息发出，供后续 Goal Round 读取。为挂载了命令适配器的交互式部署选择它；没有适配器的无头与自动化应用不需要它。

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

在挂载了命令适配器的交互式部署中使用 `dsh-command-goal`——随附的 Web 客户端是参考实现。它让用户无需模型轮次即可直接控制 goal 生命周期：命令在 UI 命令平面执行，适配器直接渲染其结果。

### 命令参考

每个子命令都针对调用 agent 的当前 goal 执行；没有 goal 时，裸 `/goal` 显示用法。

| 输入 | 结果 |
|---|---|
| `/goal` | 显示当前目标、持久 phase、Round 数量与上限、进程本地续行启用状态与有效的下一步命令；被阻塞的 goal 还会显示其策略代码与说明 |
| `/goal <objective>` | 创建 goal 并启用续行，或用全新身份替换已完成 goal |
| `/goal edit <objective>` | 编辑当前目标，不改变其 phase 或续行启用状态 |
| `/goal pause` | 暂停 active goal 并停用续行 |
| `/goal resume` | 恢复已停止 goal，或在会话 resume 或 fork 后重新启用 active goal；仍受剩余 Round 上限约束 |
| `/goal clear` | 清除当前 goal，同时保留其持久历史 |

### 输入语法

只有控制词（`clear`、`pause`、`resume`、`edit`）占据完整输入时才被识别；其他任何非空后缀都是目标，因此 `/goal pause after verification` 会创建该字面目标。`edit` 内联接收替换内容，并拒绝直接替换未完成的 goal。可预期的领域拒绝会变成稳定的直接命令错误，不暴露带品牌类型的 id 或 revision；意外实现失败仍会让分发失败，使适配器能将其报告为命令失败。

### 附件

`/goal` 声明附件支持。附件只随目标本身：create 或 edit 成功后，命令提交一条用户 followup 消息，按选择顺序携带已准入的图片块与文件块，再附加固定文本 `Reference attachments for the goal objective.`。后续 Goal Round 从普通会话历史读取这些内容，goal 领域不存储附件状态。其他任何子命令以及被拒绝的 create 或 edit，都会在领域变更前返回直接错误，并保留 composer 的草稿和附件卡。

### 组合方式

命令注入命令注册表与 goal 服务。自定义应用会挂载它们的所有者与此插件；自动续行仍是独立选择：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: goal
  name: '@deepseek-ai/dsh-goal'
- id: command-goal
  name: '@deepseek-ai/dsh-command-goal'
```

随附的 `dsh` 基础配置启用持久 goal 栈与此命令。Web bundle 把 goal 服务与 driver 保留在 Host，禁用基础命令 producer，并在 `standard`、`code` 和 `cordis` agent preset 中挂载 producer；`minimal` 会省略它。ACP（Agent Client Protocol）自动化应用启用领域与模型工具，但不挂载命令适配器。独立的 `sdk-minimal` profile 省略完整 goal 栈，因此其结果 API 仍在一个关联的物理轮次后结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令如何解析输入并渲染输出；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计

- **语法，而非自由文本。** 解析器只在控制词（`clear`、`pause`、`resume`、`edit`）填满整个输入时识别它们；其他任何非空后缀都是目标。单独的 `edit` 无效，且 `edit` 拒绝直接替换未完成的 goal。
- **领域拒绝变成稳定错误。** `GoalError` 结果会转换为带固定消息的直接命令错误；意外失败会重新抛出，使适配器报告命令失败而非领域结果。渲染输出绝不暴露带品牌类型的 id 或 revision。
- **附件随目标提交。** create 或 edit 成功时，命令提交一条用户 followup 消息，按选择顺序携带已准入的图片块与文件块，再附加固定文本 `Reference attachments for the goal objective.`。其他路径不提交消息，因此分发方 composer 保留草稿和附件卡。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令语法、状态渲染、附件提交 |
| — | 不发布运行时不变式伴生入口；已接受的变更由 goal 领域负责。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

该命令是 goal 领域的薄适配器；需要了解它变更的状态与它接入的注册表时阅读以下页面。

- [goal 服务](../goal/README.zh.md)——命令变更的状态与生命周期。
- [命令服务](../../interaction/commands/README.zh.md)——命令注册表约定与分发。
- [用户 goal 命令 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-human-goal-command.zh.md)——用户体验与组合决策。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/goal` 控制

#### 模型看到的内容

斜杠输入、变更以及直接状态或错误输出不会进入模型请求。goal 领域把变更记录为 `goal/change`；已启用的同会话驱动器可以在后续续行提示词中暴露结果状态。呈现文本不会记录到日志中。当 create 或 edit 携带附件时，模型会看到一条普通用户消息：有序的图片块与文件块后跟文本 `Reference attachments for the goal objective.`。它在会话历史中位于下一个 Goal Round 之前。

#### Token 影响

读取状态、变更 goal 或收到直接命令错误不会增加模型 token。已启用的同会话驱动器可能增加后续 Goal Round 提示词。目标携带的附件会增加一条普通用户消息，产生常规文本、图片和文件句柄成本。

#### KV Cache 影响

命令发现、变更与直接输出不会影响缓存。后续续行提示词遵循驱动器的普通请求历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明命令何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **仅纯文本交互**——通用命令注册表没有模态编辑表单或替换确认回调；内联 edit 与显式 clear 能在不同适配器中保持明确且一致的破坏性意图。
- **没有逐命令 Round 上限参数**——`defaultMaxGoalRounds` 仍是部署配置；用户直接请求时，可以要求模型通过另行授权的 goal 工具编辑 `max_goal_rounds`。
- **没有持续状态组件**——裸 `/goal` 是可移植的观察接口；不提供适配器专用徽标或重连后可恢复的命令输出。
- **随附应用中只有 Web 命令适配器使用此命令**——无头、ACP 自动化和 JSON-RPC 适配器不消费 `ctx.commands`。如果组合中包含面向模型的 goal 工具，普通提示词仍能授权它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。开放且未决：持续状态组件与逐命令 Round 上限输入；两者都是延后的 UI 与配置工作。

</details>
