---
description: "面向模型的 ralph 工具：面向一个不可变目标的固定前台全新 agent 循环，供选择或配置全新 agent 迭代的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ralph

[English](README.md) | 中文

## 概述

`dsh-tool-ralph` 把 `ralph` 工具交给模型：一个固定的前台工作流，把一个不可变目标依次交给多个全新子 agent（智能体），每个子 agent 都没有对话种子，只携带上一份有界报告。它是构建在工作流与 subagent 能力之上的专用编排策略——不会向 agent loop 添加 Ralph 模式，同会话的 goal 领域也保持独立。调用在 worker 报告完成或具体阻塞、或达到 Round 上限时返回；完成与阻塞都是 worker 报告，不是独立认证。仅当直接用户明确要求 Ralph 循环或全新 agent 迭代执行时使用它；普通的长期同会话目标属于 goal 工具，有界委派属于 subagent 或工作流。

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

`ralph` 工具运行固定的前台循环：每个 Round 一个全新子 agent 在共享工作区中处理不可变目标，只有一份有界的结构化报告跨越 Round。仅当直接用户明确要求 Ralph 循环或全新 agent 迭代执行时使用它。普通的长期同会话工作请使用 goal 工具；有界委派与扇出请使用普通 subagent 或 `workflow` 工具。

### 调用工具

模型提交 `{ objective, maxRounds? }`，调用会阻塞到整个运行结算。部署配置中的 `maxRounds` 既是默认值，也是调用覆盖值的上限。终态结果为 `complete`、`blocked` 或 `budget-limited`，携带最后一份有界报告与已启动的 Round 数量；普通子 agent 失败会返回错误，其中标明失败的 Round，并在存在时保留上一次成功交接。

### 每个 Round 看到什么

每个子 agent 只接收不可变目标、当前 Round 及其上限、一条「共享工作区是权威状态」指令与上一份结构化交接；父级对话与先前子 agent 会话绝不会作为种子。工作区是跨 Round 的长期记忆。报告携带状态（`continue`、`complete` 或 `blocked`）、非空摘要、证据、后续步骤与阻塞文本；无效或过大的报告会使工作流失败，而不会被截断或误认为上限耗尽。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 每个 Round 使用的全新结构化输出提供方。 |
| `maxRounds` | `256` | 一次 Ralph 运行的默认值和部署上限。 |
| `maxHandoffChars` | `16384` | 一份 Round 报告序列化后的最大字符数。 |
| `maxResultChars` | `16384` | 返回给父级的完整成功结果最大字符数。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-ralph)是每个受支持字段的穷尽式真源。配置的提供方必须存在、支持结构化输出，并报告 `inheritsParentContext: false`；针对违反此要求的提供方的调用会在任何 Round 开始前响亮失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释固定脚本设计以及校验与生命周期机制；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

循环是部署方拥有的固定脚本：模型只提供数据，无法改变循环、提供方路由、schema 或交接校验。该工具是基于 `ctx.workflowEngine` 与 `ctx.subagents` 的普通插件——不会向 `agent-loop` 添加 Ralph 模式或全新 agent loop，同会话的 goal 领域也保持独立。[Harness 层目标式执行 Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-harness-level-loop.zh.md)拥有策略与暂缓事项。

### 固定脚本与路由

配置的提供方以 `WorkflowStartRequest.subagentProvider` 传递，因此固定脚本无法检查或更改路由，普通的模型编写 `workflow` 工具也不会因此获得提供方选择器。解析后的 Round 上限以 `WorkflowStartRequest.maxTotalAgents` 传递，使固定循环与引擎的子 agent 总数后备上限协同；上限超过引擎部署上限时，引擎会在发布运行前拒绝。

### 报告校验

特定状态的语义与序列化后的 `maxHandoffChars` 上限会在固定工作流内部及消费方边界各校验一次：继续报告需要后续步骤与空阻塞，完成报告需要证据且没有后续步骤，阻塞报告需要具体阻塞。无效、缺失或过大的报告会使工作流失败。

### 生命周期与取消

调用方 agent 是每个全新子 agent 的父级，因此会保留 cwd 与谱系，但不会复制其对话。`exec.signal` 进入工作流引擎，同时也桥接到 `run.cancel()`，以便不依赖具体实现。工具等待 `run.result` 并在 `finally` 中调用 `run.dispose()`，因此被取消的父级步骤会等到引擎完成有界终止且子 agent 完全停稳后才返回。

### 渲染意图

待处理调用使用 `generic` 卡片，标题为 `ralph`，不可变目标作为其 `rawInput`；结果继续使用 generic 卡片。两个呈现函数都只依赖工具参数与已结算的工具包络，完成与阻塞标签会说明结果由 worker 报告，而非独立认证。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：固定脚本、提供方路由、报告校验、工具注册 |
| — | 不发布运行时不变式伴生入口；工作流与 subagent 归属方校验它启动的运行与子 agent。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当工具级契约不够用时阅读以下页面。它们从共享工作流模型逐步进入引擎、subagent seam 与相邻的 goal 领域。

- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——固定循环背后的 seam 契约。
- [工作流 seam](../workflow/README.zh.md)——运行与结果词汇。
- [worker-thread 引擎](../workflow-worker-thread/README.zh.md)——执行固定脚本的引擎。
- [subagent seam](../../subagent/subagent/README.zh.md)——全新子 agent 的提供方契约。
- [goal 组](../../goal/goal/README.zh.md)——面向普通长期目标的同会话 goal 工具。
- [Harness 层目标式执行 Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-harness-level-loop.zh.md)——策略、提供方要求与暂缓事项。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

在该插件的注册作用域内，每个父级请求都会收到下方固定的路由指导。

##### Ralph 指导

```markdown
Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.
```

#### Token 影响

插件启用期间，每个请求都会产生少量固定的指导 token 开销。

#### KV Cache 影响

只要插件作用域与指导文本不变，前缀就保持稳定。启用或 dispose（资源释放）可能会使从该提示词段起的缓存复用失效。

### 工具 schema

#### 模型看到什么

已生成的 [`ralph` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ralph) 公开一个必填 `objective` 字符串与一个可选 `maxRounds` 数字。提供方选择、交接大小、报告 schema、工作流脚本与编排行为均由部署侧控制，不在调用 schema 中。

#### Token 影响

工具可见时，每个请求都会产生少量固定的 schema token 开销。

#### KV Cache 影响

只要定义与可见性不变，前缀就保持稳定。

### 子 agent 请求与父级结果

#### 模型看到什么

每个子 agent 都会看到独立的固定 Round 提示词与结构化输出捕获契约。父级只看到原始调用与一个终态结果，其中包含 worker 报告的状态、Round 数量与美化打印的最终报告；中间子 agent 消息与报告不会进入父级对话。普通子 agent 失败时改为产生错误，其中包含对应 Round 编号；从第二个 Round 起，还会包含上一次成功交接。

#### Token 影响

每个 Round 都会支付全新子 agent 上下文的成本。`maxHandoffChars` 限制跨 Round 状态，`maxResultChars` 独立限制完整的父级成功文本；子 agent 工作留在父级上下文之外。

#### KV Cache 影响

每个全新子 agent 都有独立的请求缓存。父级结果追加在可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该工具尚未支持什么。它们是当前约束，不是任务积压。

- **完成由 worker 自行声明**——没有独立评估器或验证器判断目标是否完成；评估器策略与评估器驱动的延续均暂缓。
- **仅支持前台**——没有 job id、后台收集、进程恢复检查点、调度器或基于挂钟时间的启动策略。
- **工作区是唯一的跨 Round 长期记忆**——一份有界报告作为显式交接，每个子 agent 结束后，未提交的对话推理都会消失。
- **一个 Round 对应一个全新子 agent**——Round 内没有扇出、模型或提供方切换、fork 上下文或由模型调用选择的提供方。
- **普通子 agent 失败会终止运行**——固定脚本报告失败的 Round 与上一次成功交接，但不会重试；致命的工作流基础设施失败可能在该状态返回前结束。
- **聚合工作量仅受 Round 数量限制**——token、价格与耗时预算均暂缓。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码与相关 Agent Note 为准。

开放方向：带评估器驱动延续的独立评估器；Round 内扇出与提供方选择；以及 Round 上限之外的 token、价格与耗时预算。

</details>
