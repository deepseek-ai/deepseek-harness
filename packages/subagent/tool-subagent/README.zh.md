---
description: "面向模型的 subagent 委派工具，供用户与维护者配置、组合或排查基于 subagent 提供方的委派。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent

[English](README.md) | 中文

## 概述

`dsh-tool-subagent` 是面向模型的委派工具：它把一个已配置的 `ctx.subagents` 提供方变成 agent 可以调用来启动子 agent（智能体）的工具。更换提供方只会改变传输，不会改变执行约定，因此一个组合可以暴露多个委派工具，各自绑定不同的后端。`one-shot` 策略下，调用默认在前台等待子 agent；`continuable` 策略下，调用默认在后台启动工作，并返回模型之后可以发消息的持久化子 agent id。合适的实例还可让模型发现并选择子 agent 的 LLM 提供方、模型与推理等级。工具的描述会随子 agent 是否继承父级已完成轮次而调整，失败的运行以出错的工具结果呈现，而非部分成功。

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

每个委派目标挂载一个实例，且每个实例的 `toolName` 必须不同。工具与其提供方同时存在、同时消失，因此同级加载顺序与提供方重新加载都不会让工具悬空。

### 最小配置

先加载 subagent 服务、一个进程内或远程后端与本工具，然后指定提供方名称。此组合暴露一个委派给 `spawn` 后端的 `subagent` 工具：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 必填 | `ctx.subagents` 上的提供方名称（如 `spawn`、`fork`、`acp`） |
| `toolName` | `subagent` | 面向模型的工具名称；每个已加载实例必须不同 |
| `modelSelectionSettings` | `false` | 为每个新顶层 Session 读取宿主的精确路由授权偏好；只在 Agent 作用域内有效，并要求提供方支持 `agentOptions` |
| `enableRunInBackground` | `true` | 公开 `run_in_background`；禁用时也会拒绝强制后台调用 |
| `backgroundMode` | `one-shot` | 后台策略：`one-shot` 默认前台调用；`continuable` 默认后台调用，并要求提供方具备 `prepareContinuable` 能力 |
| `agentOptions` | — | 配置的子级 `provider`、`model`、适配器所有的 `reasoningEffort` 与正整数 `maxTokens` 默认值；要求提供方支持 `agentOptions`，并会覆盖提供方持有的路由默认值 |
| `persona` | — | 每个子 agent 独立的 persona；要求提供方具备 `persona` 能力 |
| `toolFilter` | — | 每个子 agent 独立的全局工具限制；要求提供方具备 `toolFilter` 能力 |
| `maxDepth` | `3` | 绝对委派深度上限（`0` 禁止委派）；`'provider-managed'` 不向进程外提供方发送上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-subagent)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 前台与后台模式

`one-shot` 策略下，省略 `run_in_background` 会在前台等待并返回子 agent 的最终文本；`run_in_background: true` 会启动一个归父级所有的普通后台任务，并返回 `started background subagent job <id>`，可用 `job_output` 收集、用 `job_kill` 停止。

`continuable` 策略下，省略或为 `true` 的 `run_in_background` 会启动一个持久化子 agent，并返回 `started subagent <childId>`，不等待结果；子 agent 的 Activation 结束时，运行时投递一条结算通知，可选的 `send_message` 工具会向它发送更多工作。把 `run_in_background` 设为 `false` 可在前台等待结果。

`maxDepth` 限制递归深度（默认 `3`；`0` 禁止委派），并要求提供方具备 `depthLimit` 能力；`'provider-managed'` 把预算留给进程外提供方。当提供方支持时，`persona` 与 `toolFilter` 会配置每个子 agent；工具在达到上限时仍然可见——每次尝试启动都会检查调用 agent 的当前深度，被拒绝时返回出错的工具结果。

### 选择子级 LLM

设置 `modelSelectionSettings: true`，即可在组合每个全新顶层 Session 时读取宿主的 `subagent-model-selection` 偏好。没有已记录策略的恢复 Session 会保持禁用，包括显式为空的恢复。启用后，非空的精确 provider/model 路由列表会记录进 Session、由子 Session 继承，后续设置编辑不会改变它。工具随后公开可选的 `provider`、`model` 与 `reasoning_effort` 字段，并注册共享的 `list_subagent_models` 工具。此模式要求后端声明 `agentOptions`；两个进程内后端和 DSH SDK 支持该能力，而 ACP、Codex 与 Claude Code 会拒绝它，而不是忽略它。

一次调用需同时提供 `provider` 与 `model`；当配置值、父 agent 值或提供方持有的默认值能提供路由时，也可只提供推理等级。静态的 `provider.agentRouteDefaults` 在存在时构成提供方／模型基线；工具配置与模型字段会在路由相关强度合并和确切路由预检前覆盖它。没有这些默认值的提供方会使用父 agent 最新已记录请求中的兼容值，再使用父级首次请求前的创建选项，并保留配置的 `maxTokens`。更改路由但未显式提供推理等级时，会清除继承的路由自有等级，使所选模型解析自己的默认值。实时 LLM 适配器在创建子 agent 前校验有效路由。目录成员资格只提供建议，因此适配器接受时，模型可以使用未列出的 id。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具如何镜像提供方生命周期并结算运行；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

一个实例就是一个提供方加一个工具名称。插件镜像提供方生命周期：具名提供方出现时注册工具，提供方离开时释放工具，因此同级加载顺序与 HMR 替换不会让工具悬空。提供方无法执行的数值型 `maxDepth` 或已配置 LLM 选择会在挂载时失败，而不是在首次委派时失败。每个工具作用域内最多一个实例可以拥有模型选择，因为 `list_subagent_models` 使用全局名称。

### 前台结算

前台调用会等待 `run.result`，把每个非完成终止原因映射为错误标题，追加提供方诊断与任何保留下来的部分 assistant 文本，并在返回前始终等待 `run.dispose()`；当结果收集与 dispose（资源释放）都 reject 时，出错结果会保留两项失败。

### 后台路由

一次性后台模式会注册一个归父级所有的普通 Task，其 done 通道结算启动，并在 detail 中保留终止原因与可选提供方诊断。可继续后台模式调用 `ctx.subagents.startContinuable()`，该调用在 inbox 接受时结算：子 agent 自此拥有自己的轮次，因此该调用既不等待也不收集结果。

### 随上下文变化的措辞

工具描述源自 `provider.inheritsParentContext`：全新子 agent 得到「it does not see this conversation」措辞，fork 子 agent 得到「it does not see the current in-flight turn」措辞，因此模型既不会复述、也不会省略并不存在的上下文。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具注册、生命周期镜像、模式解析、结果结算 |
| [`src/model-selection.ts`](src/model-selection.ts) | 请求／配置合并与实时 LLM 路由预检 |
| [`src/model-selection-settings.ts`](src/model-selection-settings.ts) | 为新 Session 读取的宿主所有 opt-in 设置 |
| [`src/model-selection-state.ts`](src/model-selection-state.ts) | 记录并继承已读取决定的 Session 事件 |
| [`src/list-models.ts`](src/list-models.ts) | `list_subagent_models` 运行时发现工具 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从工具运行时行为进入它所委派其上的 seam，以及相邻的子 agent 工具。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——提供方、一次性启动请求、可继续子 agent 与 Activation。
- [dsh-tool-subagent-control](../tool-subagent-control/README.zh.md)——可继续子 agent 的消息、中断与列表工具。
- [dsh-tool-subagent-report](../tool-subagent-report/README.zh.md)——子到父的上报通道。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent)——默认 schema 与各模式的措辞。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-subagent)——每个受支持配置字段。
- [后台 subagent 任务](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.zh.md)——一次性后台路由。
- [后台优先的可继续委派](../../../.agents/notes/implemented/feature/2026-08-11-background-first-continuable-delegation.zh.md)——可继续工作为何默认在后台运行。
- [模型选择 subagent 路由](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.zh.md)——选择策略、继承、发现与 fork 限制。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

当提供方存在时，以当前实例配置的名称公开已生成的默认 [`subagent` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent)。启用的 Session 策略会添加 `provider`、`model` 与 `reasoning_effort`，以及继承和选择指引；提供方必须支持 `agentOptions`。提供方是否继承上下文会改变工具描述和提示词描述。启用后台模式会添加 `run_in_background`：可继续模式会记录其默认值为 `true`、运行时结算通知与显式前台覆盖；一次性模式会记录其默认值为 `false`，以及用 `job_output` 收集或用 `job_kill` 停止的 job id。当工具在本次组装的作用域中可见时，一个 `tool:<toolName>` 系统提示词 section 会指示模型同时启动相互独立的可继续委派、在它们运行时继续工作，并且仅当下一步动作依赖结果时选择前台；工具限制会同时移除其 schema 和这段指引。

#### Token 影响

每个父级请求支付固定的 schema 成本；模型选择会增加三个参数。每个提供方实例增加一个 schema，每个可继续实例还增加一个简短的系统提示词 section。

#### KV Cache 影响

只要提供方实例及其配置不变，前缀就保持稳定。适配器目录变化不会改变定义；子级路由覆盖可能使 fork 子 agent 无法复用继承的父级前缀。

### 模型选择与发现

#### 模型看到什么

Session 携带策略的 settings 控制实例会公开子级 LLM 选择字段与 `list_subagent_models`。可选 `ctx.llm` 服务不可用时，调用会失败。发现只返回精确路由策略中的已注册提供方与已公布模型；未授权提供方会在调用其适配器目录前被拒绝，精确查询也必须先获准，才会解析模型的推理强度与默认值。执行阶段会独立强制同一策略。

#### Token 影响

启用的组合中存在一个固定发现 schema。只有模型调用工具时，目录内容才进入 transcript。

#### KV Cache 影响

适配器注册与目录变化不会改变 schema 前缀。每个发现结果都追加在可复用前缀之后。

### 系统提示词

#### 模型看到什么

当 `enableRunInBackground` 与 `backgroundMode: continuable` 同时设置时，模型还会读到 `tool:<toolName>` 系统提示词 section，指示它把相互独立的可继续委派一起启动，并在它们运行时继续工作。使用默认工具名 `subagent` 时，section 文本为：

##### 工具指导 section

```markdown
Use subagent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.
```

#### Token 影响

每个可继续实例一个简短固定 section，只要工具在作用域内，就由每个父级请求支付。

#### KV Cache 影响

只要 section 文本与工具存在性不变，前缀就保持稳定；移除工具或更改 section 会建立不同的父级前缀。

### 前台结果

#### 模型看到什么

调用会保留描述与提示词。成功时只包含子 agent 的最终文本；其他结果变为 `Error: <终止原因>`，随后在存在时附上安全的提供方诊断，再附上任何部分 assistant 文本。子 agent 中间步骤不会进入父级。

#### Token 影响

提示词与结果保留在父级历史中，直到上下文压缩（context compaction）；子 agent 工作上下文留在子 agent 中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后台结果

#### 模型看到什么

在配置的可继续模式下，启动时返回内容恰为 `started subagent <childId>`；在配置的一次性模式下，则返回 `started background subagent job <id>`。一次性模式下，通用 Task 接口提供后续状态、最终输出、取消响应与通知；若结果携带提供方诊断，失败状态的 detail 会包含它。可继续模式下，本工具不返回自己的结果：子 agent 的结算以服务负责的通知到达父级，独立加载的 `send_message` 工具投递后续消息，而通过其 id 查看子 agent 的 transcript（文本记录）即是其详细输出来源。

#### Token 影响

确认消息会被保留；一次性最终输出只在收集或注入时进入父级历史，而可继续子 agent 的输出绝不会通过本工具返回——其结算通知独立于任何工具结果到达。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本工具不返回或不强制执行什么；它们是当前包约束。

- **后台运行不通过本工具公开结果**——一次性任务的最终输出通过通用 Task 接口收集，可继续子 agent 的输出留在其自身会话中，按其 subagent id 读取。结算通知会说明该子 agent 如何结束，并携带可能存在的最终 assistant 消息，但它不是本次调用的返回值，也无法在此等待。
- **等待中的一次性实例较晚才发现重复名称**（`TODO(subagent-dup-toolname)`）——可继续实例会在插件应用期间预留提示词 section 名称，但若要阻止等待中的一次性实例回滚提供方注册，仍需要一份预期名称注册表。
- **随附 fork 工具不能选择子级 LLM 路由**——它们继承父级提供方与模型，使复制的对话前缀仍有资格复用 KV Cache。仅当路由变更能保留复用或公开有界重算成本时，才重新启用选择。
- **非路由子 agent 策略按实例固定**——另一个 persona、工具过滤器或深度上限需要另一个名称不同的工具。LLM 选择要求启用逐 Session 偏好，且提供方必须声明 `agentOptions`；两个进程内提供方和 DSH SDK 会声明该能力，而 ACP、Codex 与 Claude Code 会拒绝它，而不是忽略它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
