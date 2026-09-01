---
description: "面向选择、组合或排查 get_goal、create_goal 与 update_goal 的用户与维护者的模型侧 goal 工具说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-goal

[English](README.md) | 中文

## 概述

`dsh-tool-goal` 为模型提供基于持久 goal 服务的三个工具：`get_goal` 读取当前 goal，`create_goal` 创建新 goal，`update_goal` 编辑、暂停、恢复、完成或阻塞它。模型可以从人类直接请求中推断长期目标并创建 goal；更新必须携带先前读取到的精确 id 与 revision。权限在执行时强制：create、edit、pause 和 resume 要求顶层 agent 的当前轮次中存在人类直接消息；complete 和 blocked 在自动续行期间还接受当前 Goal Round。可配置的阈值（默认 3）约束自主 Round 多快可以自行报告 `blocked`。当模型需要自行管理 goal 时，与 `dsh-goal` 一起挂载它。

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

当模型需要自行创建和更新持久 goal 时，把 `dsh-tool-goal` 挂在 goal 服务旁边。这些工具是 goal 表面面向模型的一半；`/goal` 命令是面向人类的一半，续行驱动器在自主 Round 结束时使用同一套工具完成或阻塞 goal。

### 工具

三个工具都返回相同的紧凑 JSON——没有当前 goal 时为 `{ goal: null }`，否则返回 goal 的 id、revision、目标、phase、已开始 Round、Round 上限、可选的 blocker reason 与续行是否已启用——与 Native 调用方已经渲染的内容一致。

| 工具 | 作用 |
|---|---|
| `get_goal()` | 读取当前 goal；没有当前 goal 时返回 `null` |
| `create_goal(objective, max_goal_rounds?)` | 根据人类直接发起的顶层轮次创建一个 goal |
| `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)` | 对精确 goal revision 执行 `edit`、`pause`、`resume`、`complete` 或 `blocked` |

在 `update_goal` 之前调用 `get_goal`，并复制精确的 `goal_id` 与 `revision`；所有调用都互斥，因此模型排序的批次能观察到更早变更及其新 revision。替换值只属于 `edit`；`blocked_reason` 只有在 `blocked` 时才必填，并以稳定代码 `model-reported` 持久化。严格 schema 下的空字符串和零填充值视为省略，而有意义的值仍限定到各自 action。

### 配置

```yaml
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
  config:
    blockedAfterConsecutiveRounds: 3
```

该值必须是正的安全整数。它既提供模型自行报告阻塞的硬下限，也决定模型指引中指明的数值。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-goal)是每个受支持字段的穷尽式真源。

### 权限规则

工具只为活跃驱动器内、处于开放轮次中的精确活跃调用 agent 执行。`create`、`edit`、`pause` 和 `resume` 还要求运行时根 agent（智能体）的当前轮次中存在人类直接消息——subagent 或非人类生产方不能创建或编辑 goal。`complete` 和 `blocked` 还接受完全一致的当前 Goal Round：来源为 goal 的 Round 可以立即完成 goal，但 blocked 调用在达到配置的连续 Round 数量之前会被机械拒绝——模型判断同一条件是否确实持续，并必须在 `blocked_reason` 中说明。人类直接请求可以立即停止 goal。

成功报告 `complete` 或 `blocked` 的自主 Round 还会在该步骤后结束物理轮次，模型会收到一条结束指令，要求向用户写出最终消息。人类直接变更绝不会触发这种停止：assistant 可以确认变更，循环仍可接收并发的人类 steering（中途引导）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具如何强制执行权限并渲染输出；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计

- **执行时权限。** 每次调用都解析精确活跃 agent、其继承的 `AgentRegistry` initiator、running 状态与开放轮次；`create`、`edit`、`pause` 和 `resume` 还要求运行时根 agent 的当前轮次中存在已接受的 `{ kind: 'user' }` 消息或 steering 事件。持久 fork 谱系不会降低已恢复根 agent 的等级；活跃 subagent 所有权会降低。
- **人类输入的宿主证明。** `Agent.followup()` 与 `steer()` 会在调用方省略 source 时分配 `{ kind: 'user' }`，因此插件、调度器与其他非人类生产方必须传入自己的 source，不能继承人类权限。
- **带配置阈值的系统提示词指引。** 本包注册一个 `tool:goal` 系统提示词章节，其固定文本插入 `blockedAfterConsecutiveRounds`；同一数值就是执行时强制执行的硬下限。
- **终局 Round 的结束上下文。** 成功的自主 `complete` 或 `blocked` 会延后一条 `<goal_complete>` 或 `<goal_blocked>` 结束指令，让模型在轮次结束前向用户做一次交代；人类直接变更绝不会延后该上下文。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、配置、系统提示词章节、结果渲染 |
| [`src/authority.ts`](src/authority.ts) | 执行时权限检查与 Goal Round 接受 |
| [`src/wrapup.ts`](src/wrapup.ts) | 终局自主更新的结束消息指令 |
| — | 不发布运行时不变式伴生入口；已接受的变更由 goal 领域负责。 |

### 工具输出

三个工具共用一种规范输出：紧凑 JSON `{ goal: null }`，或 `{ goal: { id, revision, objective, phase, roundsStarted, maxGoalRounds, blockedReason? }, activation }`。结果中的 `activation` 是实时观察值，绝不会成为回放权限依据。UI 客户端收到纯通用卡片——`get_goal` 为 read，变更使用 other。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些工具是 goal 表面面向模型的一半；需要了解它们变更的状态与它们交由的策略时阅读以下页面。

- [goal 服务](../goal/README.zh.md)——工具变更的 goal 状态与生命周期。
- [goal 组地图](../README.zh.md)——goal 各包及其组合方式。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-goal)——模型接收的精确 schema。
- [goal 工具 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.zh.md)——权限拆分与 UX 决策。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

固定 goal 策略说明何种用户语义意图值得创建 goal，要求更新前先精确读取 ref，解释会话 resume／fork 后如何重新启用续行，并限制完成／阻塞声明。配置的阈值会插入该指引。

##### Goal 策略

```markdown
Use goal tools for one long-running completion objective in the current session. create_goal may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work. Call get_goal before update_goal and copy its exact goal_id and revision. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.
```

#### Token 影响

此插件的提示词注册位于请求范围内时，每次请求都会产生少量固定输入成本。

#### KV Cache 影响

插件范围、配置阈值和指引文本不变时，前缀保持稳定。启用、dispose（资源释放）或配置变更可能使此提示词章节的复用失效。

### 工具 schema 与结果

#### 模型看到的内容

生成的 [`get_goal`、`create_goal` 和 `update_goal` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-goal)。成功结果是紧凑 JSON。变更会追加 goal 领域的持久 `goal/change` 事件，而不会将模型上下文加入队列。结果中的 `activation` 是实时观察值，绝不会成为回放权限依据。

#### Token 影响

固定 schema 成本，加上每次调用的一条紧凑结果。持久变更不会增加单独的模型可见上下文。

#### KV Cache 影响

schema 的定义与可见性不变时，前缀保持稳定。调用和结果会追加到可复用请求前缀之后，不会使更早条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 goal 工具何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **语义意图仍由模型判断**——执行只能证明当前轮次包含一条人类直接发送的消息，无法证明请求是否足够重大而值得创建 goal。
- **阻塞条件是否相同仍由模型判断**——运行时强制统计互不重复的已准入 Goal Round，而不判断障碍在语义上是否等价；独立评估器的实现暂缓。
- **不负责调度或直接面向人类呈现**——这些工具只变更状态；同会话驱动器与 `dsh-command-goal` 是同一领域的独立消费方。
- **Goal Round 权限需要驱动器**——除非续行驱动器准入 goal 来源的用户轮次，否则自主 `complete`／`blocked` 路径不会启用；只挂载这个包不会创建这些轮次。
- **提示词注册与过滤相互独立**——某个范围可能隐藏工具，却保留指引，除非部署将两项注册限定在同一范围。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。开放问题：goal 策略章节是否应与工具注册独立限定范围，避免某个范围隐藏工具却保留指引。

</details>
