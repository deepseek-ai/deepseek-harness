---
description: "面向用户与维护者的计划模式说明：用于选择、配置或排查带部署引导、/plan 命令与经用户评审退出的逐 agent 规划功能。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plan-mode

[English](README.md) | 中文

## 概述

`dsh-plan-mode` 为 agent（智能体）提供计划模式：激活期间，agent 先探索和设计再执行，遵循你的部署所写的引导行事，并在执行前把完成的计划呈交你批准。你可以用 `/plan` 进入计划模式，并随命令附带消息及有序的图片或文件附件；用 `/plan off` 离开。完成的计划会以评审形式呈现，你可以批准它，或让 agent 回去继续规划。计划模式是引导而非强制：每个工具仍然可用，因此沙箱模式与审批提示仍是施加限制的方式。当希望 agent 先思考再行动时选择它；会话恢复或 fork 后计划模式依然保持。

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

计划模式激活时，agent 会按你的指令行事，并先呈交计划供评审，而不是立即执行。常用路径：配置引导文本，用 `/plan` 进入计划模式，agent 调用 `exit_plan_mode` 时评审完成的计划。

### 何时选择

当希望 agent 先探索和设计再执行、并且想先批准计划时，选择计划模式。它不限制 agent：每个工具仍可调用，因此需要强制限制时请使用沙箱模式与审批提示。当 agent 应立即按你的请求行事、无需规划阶段时，跳过它。

### 最小配置

唯一必需的配置是 agent 规划期间遵循的引导文本；添加任何其他内容都会在加载时失败。

```yaml
- name: '@deepseek-ai/dsh-plan-mode'
  config:
    section: |
      You are in plan mode. Explore and design before presenting the complete
      plan through exit_plan_mode.
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `section` | 必填 | 计划模式激活时作为 `plan:policy` 提示词段落渲染的引导 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-plan-mode)是每个受支持字段及其 JSDoc 的穷尽式真源。

<a id="model-and-human-interactions"></a>
### 进入与离开计划模式

输入 `/plan` 进入计划模式，或输入 `/plan <message>` 连同一条指令一起进入——该消息会成为你在计划引导下的下一条请求。输入 `/plan off` 直接离开计划模式；它还会取消尚未生效的计划模式进入。

你可以在 `/plan` 消息中附带图片与通用文件，它们按选择顺序随指令一起提交。带附件的 `/plan off` 会在模式变更前被拒绝，因此草稿和附件卡仍可继续使用。`/plan` 命令在支持斜杠命令的界面中可用，例如 Web 客户端。

### 经评审的退出

agent 完成计划后，会以 markdown 形式、从标题开头书写计划并调用 `exit_plan_mode`。你评审该计划的原文，选择 `Approve` 离开计划模式，或选择 `Keep planning` 带反馈把 agent 送回去。

选择 `Keep planning`（可附自由文本反馈）会让 agent 回去修订计划；关闭评审改为发言，则告知 agent 等待你的下一条消息。若没有可用的交互评审，`exit_plan_mode` 无法运行，你仍可用 `/plan off` 离开计划模式。

### 观察计划状态

界面可以显示计划模式是否激活，以及你请求的模式变更是否仍在等待生效。该状态在每个标签页中一致，并能在重启后保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

计划模式是产品包，而不是能力 seam：没有可替换的后端，因此状态、引导、命令与退出工具都集中在一处。持久姿态是单一仅记日志、整值替换的事件，绝不是实时镜像，因此恢复、fork 与压缩（compaction）都通过折叠日志复原它。引导是软性层——本包注册一个提示词段落和一个工具，通过文本而非过滤能力来约束。

### 持久状态与步骤边界追加

本包持久化一条仅记日志、整值替换的事件 `plan/mode`，最后一条已记录值即为状态。没有轮次开启时，模式变更会立即追加；轮次开启期间，它保持待生效，直到下一个被接受的轮内 pre-step——agent 运行时唯一的追加点——且追加失败不能阻塞轮次。`set`/`get` 服务方法及其确切返回状态见 [`src/index.ts`](src/index.ts)，并读取已注册的 `plan` 投影；注册表或 key 缺失时，第一次依赖它们的访问会显式失败。

### `/plan` 命令

命令子插件只在组合了命令服务时激活。它把不带参数的 `/plan` 映射为激活，把恰好为 `off` 的参数映射为未激活且不发送模型输入，把其他非空参数映射为激活并把去除首尾空白的文本通过 `agent.steer()` 作为下一步骤的普通已记录用户消息提交。已准入的图片块与文件块按选择顺序进入这条消息；带附件的 `/plan off` 会在模式变更前失败。命令以外的入口可以直接驱动 `ctx.planMode`；确切的分支处理见 [`src/index.ts`](src/index.ts)。

### 退出工具

`exit_plan_mode` 在计划模式未激活时仍保持注册，因此进入或离开只改变提示词段落，绝不改变请求的工具目录。经批准的评审会记录一个静默的待生效退出，由下一个被接受的轮内 pre-step 追加，当前这批工具调用剩余部分仍保留计划引导。缺少用户交互通道，或评审等待期间服务重载，调用都会失败关闭，`/plan off` 仍是手动退路。

### 会话投影单元

组合了 `ctx.sessionProjections` 时，本包通过可选注入注册 `plan` 单元。该单元把已记录的 `/plan` 命令运行转为候选目标，在 `plan/mode` 上提交已记录状态，并为 `view` 推导 `{ active, pending }`，其中 `pending` 仅在未结算或已成功的选择与已记录状态不同时为 true——这是仅凭日志即可恢复的纯回放量。key 由 [`src/types.ts`](src/types.ts) 的声明合并加入 `SessionProjectionMap`；框架负责驱动该单元，卸载插件 fiber 会注销该 key。plan-mode 读取要求该单元与 `turnBoundary` 单元存在；注册表或任一 key 缺失时都会显式失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、`ctx.planMode` 服务、`plan:policy` 段落、`/plan` 命令、`exit_plan_mode` 工具 |
| [`src/types.ts`](src/types.ts) | `plan` 投影 key 声明与 `PlanProjection` 协议值 |
| [`src/client.ts`](src/client.ts) | types 出口的客户端命名空间再导出 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：校验 `plan/mode` 载荷结构 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从子系统语义逐步进入生成的目录与设计决策。

- [计划模式子系统参考](../../../docs/subsystems/plan.zh.md)——计划模式的行为、配置与退出工具的约定。
- [plan/ 包映射](../README.zh.md)——本组及其唯一的包。
- [`exit_plan_mode` 工具目录条目](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plan-mode)——模型收到的确切 schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-plan-mode)——每个受支持配置字段及其含义。
- [plan 专用协作状态](../../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.zh.md)——计划模式背后的设计决策。

-----

<a id="model-experience"></a>
## 模型体验

### Plan 策略系统提示词

#### 模型看到什么

计划模式激活时，模型会在 first-party 提示词顺序 500 处看到部署方提供的原样 `section` 文本；未激活模式不贡献任何文本。

##### 配置示例

```markdown
You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.
```

#### Token 影响

未激活模式不增加 token；激活模式把已配置的段落加入每个请求。

#### KV Cache 影响

该段落在计划模式内保持稳定，但进入或离开会从 first-party 顺序 500 起改变系统提示词。

### 人类命令

#### 模型看到什么

`/plan`、`/plan off` 及其终端结果留在模型历史之外。除恰好为 `off` 以外的非空后缀会在选择计划模式后，通过 `agent.steer()` 成为一条用户消息：已准入的图片块与文件块按选择顺序排列，之后是去除首尾空白的文本块。不带参数的 `/plan` 若带有已准入附件，会 steer 一条只含这些块的用户消息。计划模式已激活时选择 `/plan off`，只会在最后记录的请求头描述了计划模式的情况下追加标准的已记录用户切换通知；取消待生效条目不贡献通知，因为没有请求观测到它。

#### Token 影响

可选消息的历史 token 成本与单独提交该内容相同。不带附件的 `/plan` 与 `/plan off` 不增加 token；带附件的 `/plan` 产生常规图片与文件句柄成本。一次带叙述的激活状态退出会追加一条简短且会保留的切换通知。

#### KV Cache 影响

用户块是仅追加的对话增长。进入或离开计划模式会改变更早的策略段落；带叙述的退出通知追加在可复用请求前缀之后。

### 退出工具 schema 与评审交互

#### 模型看到什么

[`exit_plan_mode` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plan-mode) 在两种状态下均可用；在计划模式之外执行会失败，而计划模式内经批准的评审返回规范的 `{ approved: true }` 值，并渲染既有的确认文本。拒绝仍是携带评审反馈的失败调用，放弃评审则是一次指明用户接手的失败调用。

#### Token 影响

稳定 schema 的成本取决于 ToolRuntime mode，每次传入的 plan 参数与评审结果都会保留在对话历史中。

#### KV Cache 影响

模式转换不改变工具目录；plan 参数与评审结果按常规方式扩展对话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述计划模式在哪些情况下不符合你的预期，或需要额外的注意。它们是当前包约束，不是路线图。

- **引导而非强制**——计划模式只通过文本约束；需要强制限制的部署要分别配置沙箱模式与审批策略。
- **待生效选择只存在于进程内**——某轮最后一个被接受的 pre-step 之后作出的选择，若进程在另一个被接受的轮内 pre-step 之前退出就会丢失；UI 必须重新应用它。
- **没有创建时 plan 选项**——fork 的 agent 继承已记录的计划状态，新 spawn 的 agent 则从未激活开始。
- **存活的子级无法打开评审**——由另一个存活 agent 所有的子级调用 `exit_plan_mode` 会失败，并被要求把尚未解决的决策包含进最终结果；仅有持久化 fork 谱系并不能阻止恢复为运行时根的会话打开该评审。
- **只有一个专用评审渲染器**——只有 Web UI 具备 `plan-review` 呈现；其他交互提供方通过其通用选项流程呈现同一请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放的设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：第二种协作模式

设计说明拒绝了通用命名模式注册表，因为产品只交付了 `plan`；未来的协作状态只应在出现两个具体用例后建立共享 seam，任何抽取都必须保持 `plan/mode` 的仅记日志折叠、边界追加与经评审的退出不变。

</details>
