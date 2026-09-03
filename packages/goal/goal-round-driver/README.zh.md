---
description: "面向选择、组合或排查自动 Goal Round 的用户与维护者的同会话续行驱动器说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-round-driver

[English](README.md) | 中文

## 概述

`dsh-goal-round-driver` 会在同一会话中自动继续 active 的 goal：每当 agent 空闲且存在 active、已启用续行并有剩余容量的 goal 时，驱动器就会启动下一个 Goal Round。每一轮都是朝目标前进的一次模型轮次，由保留的 goal-round 提示词驱动；只有来源为 goal 的 Round 会计入 goal 的 Round 上限，上限耗尽时 goal 会记录一个 blocker。驱动器没有自己的配置——Round 上限属于 goal 定义，面向模型的阻塞阈值属于 `dsh-tool-goal`，策略因此只保留在一处。当任务应跨多轮自行推进时，与 `dsh-goal` 和 `dsh-tool-goal` 一起挂载它；当每一步都需要人工 steering（中途引导）时，不要挂载。

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

当 active 的 goal 应在无人干预的情况下持续推进时，挂载 `dsh-goal-round-driver`。它与 goal 服务和 goal 工具组合使用：服务拥有状态，工具让模型控制状态，本包负责调度轮次。

### 组合方式

把驱动器挂载在 goal 服务与 goal 工具旁边；驱动器本身不需要任何配置。

```yaml
- id: goal
  name: '@deepseek-ai/dsh-goal'

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'
```

`maxGoalRounds` 属于 goal 定义，面向模型的阻塞阈值属于 `dsh-tool-goal`；在驱动器中重复任一数值都可能产生分歧策略。

### 每轮做什么

当对应的活跃 agent 处于 idle，且存在 active、已启用续行、仍有容量的 goal 时，驱动器会排入一条 goal-round 提示词。它点明以 JSON 引用的目标、Round 编号与上限，并告诉模型以当前工作区、工具结果和持久状态为准。被接纳的 Round 会开启独立请求序列，因此 Chat 会在 goal 消息之前渲染其自包含请求 header。该 Round 以 goal 来源的用户消息进入历史；只有进入步骤的 goal 消息消耗上限，人类消息和陈旧预留不会消耗。goal 生命周期变更仍必须通过 `dsh-tool-goal` 的独立权限检查。

### 何时停止续行

Round 只在整个 agent 进入 idle 时启动；完成、暂停和阻塞会阻止续行；宿主发起的暂停还会中止正在运行的轮次，而模型在自己轮次内发起的暂停会正常结束。编辑只会通过修订栅栏使进行中的 Round 失效，驱动器会继续新修订。驱动器也会在以下情况自行停止：轮次因 max tokens 结束、持久性写入失败、agent 被取消、插件卸载，或 Round 上限耗尽——上限耗尽时它会以稳定代码 `round-limit` 记录一个 blocker。取消绝不会自动重启 Round：Round 已在进行或已排入队列的 goal 会在下一次 idle 时被暂停；与 goal 尝试无关的取消只会停用续行。

### resume、fork 或卸载之后

把驱动器挂载到现有 agent 上绝不会启用任何 goal 的续行；会话 resume 或 fork 后，active 的 goal 会保持停用续行，直到用户明确授权 resume——驱动器绝不会自行复活工作。卸载插件会取消进行中的 Round，并确保不再启动后续 Round。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释驱动器如何在无竞态的情况下调度 Round；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计

- **先预留，后准入。** idle 时驱动器为当前 `{ goalId, revision }` 预留 `roundsStarted + 1`，排入一条携带 goal 消息来源的 `<goal_round>` 提示词；只有进入步骤的 `user/message` 才会增加 `roundsStarted`。因陈旧而被拒绝的预留不会消耗 Round 编号。
- **竞态防护。** `agent/pre-step` 监听器会在下游监听器前后验证完整的已领取记录与当前 goal，因此陈旧、已取消或竞争中的提示词会在其步骤进入前被拒绝。在预留前到达的人类工作会让自动工作让行，直到 agent 重新进入 idle。
- **持久性检查点。** `goal/changed` 会产生持久性义务：排队工作前，驱动器会等待 `ctx.sessions.flush()`，并在等待后重新检查 goal revision 与竞争输入。通过 `agent/error` 到达的 flush 失败会停用续行，避免另一 Round 启动。
- **默认关闭的 teardown。** Teardown 会关闭准入、停用所有活跃 goal 的续行、以 `parent` 原因取消进行中的工作，并在事件防护仍生效的情况下等待驱动器和 agent 完全停稳。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：驱动器状态机、竞态防护、teardown |
| [`src/prompt.ts`](src/prompt.ts) | 保留的 `<goal_round>` 续行提示词 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生：goal-round 消息必须与包自有提示词一致 |

### Round 提示词

保留的提示词是一个文本块：前几行为 JSON 引用的目标与 `round/maxGoalRounds`，其后是工作指令。不变式伴生会从持久前缀重建 goal，并拒绝内容与该提示词不完全一致的任何 goal 来源消息。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

驱动器消费 goal 状态并把策略交由 goal 工具处理；需要了解周边约定与设计理由时阅读以下页面。

- [goal 服务](../goal/README.zh.md)——本驱动器继续推进的 goal 状态与生命周期。
- [goal 工具](../tool-goal/README.zh.md)——面向模型的工具及其执行时权限检查。
- [同会话驱动器 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-same-session-goal-round-driver.zh.md)——竞态与生命周期理由。

-----

<a id="model-experience"></a>
## 模型体验

### Goal Round 提示词

#### 模型看到的内容

每个已准入 Round 都是一段保留的用户角色 `<goal_round>` 块，其中点明完整目标与正数 Round 编号。更早的用户消息、goal 状态快照、assistant 输出与工具记录仍保留在同一会话历史中。

#### Token 影响

每个已准入 Round 会增加一个固定指令块和目标。后续请求会重新发送保留的 Round，直到压缩（compaction）将其遮蔽；不会创建新 agent，也不会复制对话前缀。

#### KV Cache 影响

在一个 epoch 内仅追加：每个已准入 Round 都会在可复用前缀后扩展现有对话。压缩可能替换派生历史后缀，并移动可复用边界。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明驱动器何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **没有独立评估器**——面向模型的 goal 策略会判断证据是否足以完成，以及 blocker 在语义上是否未变；评估器支持的认证仍保持暂缓。
- **只在同一会话执行**——此包有意不 spawn 新 agent、不 fork 会话前缀，也不实现 Ralph 风格的独立尝试；该工作流属于单独的插件层。
- **已接受队列的卸载竞态**——Cordis 插件卸载是异步的。已经被 agent inbox 接受的 goal 提示词可以在卸载开始前启动并消耗其 Round；teardown 随后会取消请求、停用 goal 的续行并等待完全停稳。不会再启动后续 Round。
- **只有 Round 上限，不是资源预算**——token、货币、时间与提供方配额策略保持独立。对应的会话事件不会归属于 goal 消息，也不会映射为 goal 阻塞代码。
- **异常情况不自动重试**——暂时性的提供方与持久化失败需要之后由用户授权 resume，而不会采用隐式重试策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。开放且未决的方向：异常失败重试策略与逐轮评估器认证；两者按设计都留在本包之外。

</details>
