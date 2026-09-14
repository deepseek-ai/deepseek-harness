---
description: "面向选择、配置或排查同会话持久 goal 服务的用户与维护者：每会话一个持久的完成目标。"
kind: "package-reference"
---

# @deepseek-ai/dsh-goal

[English](README.md) | 中文

## 概述

`dsh-goal` 让一个长期完成目标在多轮、会话恢复、fork 与进程重启后持续存在。用户与 agent（智能体）可以 create、edit、pause、resume、complete、block 或 clear 该目标；比较并设置的更新会拒绝陈旧视图。可配置的 Round 上限（默认 256）约束自动续行，被阻塞的 goal 会保留稳定的策略代码和面向人的说明。本包存储 goal 状态但不调度工作，续行权限是进程本地的而非持久状态。单个目标需要横跨多轮时选择本包；常规单轮工作或并行目标不要使用。

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

当会话需要在多轮与多次重启之间记住一个长期完成目标时，挂载 `dsh-goal`。本包是服务：模型工具、`/goal` 命令与续行驱动器都是消费同一 goal 状态的独立包，因此只挂载本包只会存储和提供 goal，不会启动任何工作。

### 何时使用

goal 适合一个需要跨自动 Goal Round 持续的长期完成目标——例如完成一次迁移，或修复所有失败的文档门禁。常规单轮工作不应创建 goal。服务每会话至多保留一个当前 goal：未完成的 goal 必须先 edit、pause、resume、block 或 clear，才能被另一个替代；已完成的 goal 可以直接被替换。

### 配置服务

通过组合配置项加载本包；唯一的部署选择是默认 Round 上限，应用于未自行指定上限的 create。

```yaml
- name: '@deepseek-ai/dsh-goal'
  config:
    defaultMaxGoalRounds: 256
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultMaxGoalRounds` | `256` | 当 create 请求省略上限时应用的 Round 上限 |

`defaultMaxGoalRounds` 必须是正的安全整数；指定了自身上限的 create 请求会覆盖它。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-goal)是每个受支持字段的穷尽式真源。

### 会话投影

`GoalService` 要求组合提供 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.zh.md)），并在启动时注册 `goal` 投影单元；未组合投影注册表的组合无法激活 `ctx.goals`。该单元版本为 6，其宿主状态保留最新的有效当前 goal、所有曾使用的 goal id，以及第一次严格回放失败。客户端视图提供当前 goal；首次 create 前与 clear tombstone 后为 `null`。该键同时合并到 `SessionProjectionStateMap` 与 `SessionProjectionMap`；载体通过历史尾页和 `session/projection` 推送帧提供客户端值。

### 驱动生命周期

goal 经历四种持久 phase——`active`、`paused`、`blocked`、`complete`——外加一个进程本地标志，表示自动续行是否已启用。动词如下：

| 操作 | 作用 |
|---|---|
| `create` | 以目标和 Round 上限启动一个 active goal |
| `edit` | 修改目标和/或 Round 上限，不改变 phase |
| `pause` | 停止自动续行并保留状态 |
| `resume` | 重新开始续行；也用于会话恢复或 fork 后重新启用 active goal |
| `complete` | 标记 goal 已完成并停止续行 |
| `block` | 记录稳定的 blocker 代码与说明 |
| `clear` | 移除当前 goal；其历史保留在会话日志中 |

pause、complete、block 和 clear 都会停用续行。block 是唯一保留策略自有 lower-kebab-case 代码与自由文本说明的 phase，因此提供方限制、预算耗尽、执行错误与请求人工输入共用一种持久 phase，而不是扩增生命周期状态。resume 只在 Round 上限仍有剩余容量时接受已停止的 goal，或 active 但已停用续行的 goal，并清除任何先前的 blocker reason。

### 什么会保留，什么不会

每项被接受的变更都会持久记录到会话日志——goal 状态的唯一存储——因此 goal 状态绝不依赖临时消息投递。会话恢复或 fork 后，goal、其 phase、其 revision 与已准入 Round 数量都仍然存在。自动续行是例外：任何会话开始边界之后，`active` 的 goal 都会被停用续行——在有人显式 resume 之前，agent 不会自行继续。

### 观察 goal

消费方用 `ctx.goals.get(agent)` 读取当前 goal，获得脱离内部状态的视图：目标、phase、已开始与上限 Round 数量、被阻塞时的 blocker reason，以及续行是否已启用。变更必须携带该视图中的精确 `{ id, revision }`，因此持有旧状态的消费方会收到清晰的陈旧 revision 错误，而不是静默覆盖更新的状态：

```text
const view = ctx.goals.get(agent)      // undefined when no goal is current
view.phase                             // 'active' | 'paused' | 'blocked' | 'complete'
view.roundsStarted, view.maxGoalRounds // continuation progress
view.activation                        // 'armed' | 'disarmed' — not persisted
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计

- **事件溯源状态。** 每次变更都追加持久的 `goal/change` 事件（版本 1），携带变更后的完整快照；clear 写入带 revision 的 tombstone。会话日志是唯一的持久权威。
- **比较并设置的变更。** `ctx.goals` 只接受以对应 id 注册的完全相同的活跃 `Agent` 实例。`get()` 返回脱离状态的 `GoalView`；变更携带 `GoalRef { id, revision }` 并拒绝陈旧引用。创建在提交前于内部解析部署默认值。
- **续行启用状态是进程本地的。** `armed` 与 `disarmed` 保存在每会话缓存中，绝不持久化。新缓存与每次 `agent/created` 边界都会停用续行，即使回放发现持久 phase 为 active；`disarm()` 移除续行权限，不写入 revision 也不发出变更事件。
- **严格回放。** 折叠只从 `goal/change` 派生生命周期变更，并拒绝形状错误、不连续 revision、非法 phase 转换、每目标时间戳非单调，以及不连续的已准入 Round。只有已准入的来源为 goal 的 `user/message` 事件会推进正数 Round；挂钟时间倒退时，变更时间戳会限制在不早于上一次更新的值。
- **投影单元。** 本包要求提供投影注册表，并注册一个严格的 `goal` 单元。其宿主状态保留回放校验数据与第一次失败，客户端视图提供最新有效的完整 goal 或 `null`；保留回放失败后，`GoalService` 会拒绝访问。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`GoalService`、配置 schema、变更、续行启用缓存、投影单元 |
| [`src/domain.ts`](src/domain.ts) | 持久变更载荷、`goal/changed` 事件、goal 消息来源归属 |
| [`src/types.ts`](src/types.ts) | 纯客户端安全类型：`GoalView`、`GoalSnapshot`、`GoalActivationChanged`、投影键声明 |
| [`src/fold.ts`](src/fold.ts) | 持久 goal 变更的严格回放折叠与解码器 |
| [`src/runtime.ts`](src/runtime.ts) | `GoalId` 品牌、`GoalError` 代码、变更版本常量 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式配套模块：对每个已挂接会话的独立增量折叠 |

### 事件与归属

`goal/changed` 在持久事件提交后触发，监听器失败会被隔离；载荷携带操作、精确 ref 与最新视图（clear tombstone 时省略）。`goal/activation-changed` 在不改变持久状态的情况下，转发携带精确当前 ref 的进程本地 `armed`／`disarmed` 边界；clear 后则不携带 goal。已准入的续行 Round 通过 `user/message` 事件上的 `GoalMessageSource { goalId, revision, round }` 归属，严格折叠会将其验证为当前 goal 的下一个已准入 Round。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要了解周边领域与设计理由时阅读以下页面。

- [goal 子系统](../../../docs/subsystems/goal.zh.md)——goal 类型、持久的变更载荷与生成的服务 API。
- [goal 组地图](../README.zh.md)——goal 各包及其组合方式。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-goal)——每个受支持配置字段及其源声明。
- [goal 领域 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.zh.md)——领域设计、备选方案与决策。

-----

<a id="model-experience"></a>
## 模型体验

### 目标状态变更

#### 模型看到什么

Goal 变更不会注入模型上下文。`get_goal` 等工具返回当前状态；续行消费方可以在调度模型工作时渲染目标与 Round 状态。

#### Token 影响

Goal 变更事件本身不增加模型 token。工具结果与续行调度提示词各自暴露的状态会分别计入 token 用量。

#### KV Cache 影响

在其他组件把 goal 状态暴露为模型可见输入之前，不会影响 KV Cache。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 goal 服务何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **只负责状态，不负责任务调度**——本包不决定已启用续行的 goal 何时继续，不重试异常失败，也不取消活跃轮次；这些策略属于 `dsh-goal-round-driver` 等消费方包。
- **只有 Round 数量预算**——`maxGoalRounds` 不计量 token、货币、挂钟时间或提供方配额。
- **没有独立评估器**——记录完成或阻塞的调用方拥有最终决定权；由评估器支持的认证暂缓到独立策略层。
- **只有一个当前 goal**——系统有意不支持并行目标或独立 goal 数据库；替换或清除后，历史仍可在会话日志中读取。
- **信任进程内生产方**——能直接访问 `Session` 的插件可以追加伪造的 `goal/change` 数据。严格回放会检测格式错误或不一致的记录，并使 goal 访问从该记录起失败，直到日志修复；这是完整性检测，不是插件隔离。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。开放且未决的方向：为需要在每个模型请求中看到目标的部署提供始终可见的 goal 上下文插件，以及由评估器支持的完成与阻塞认证。

</details>
