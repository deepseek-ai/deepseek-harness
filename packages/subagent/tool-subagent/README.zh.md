---
description: "面向模型的 subagent 委派工具，供用户与维护者配置、组合或排查基于 subagent 提供方的委派。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent

[English](README.md) | 中文

## 概述

使用本包可为 agent 提供具名工具，把工作委派给配置的后端。每次调用都会启动受管理的 activation 并返回子任务 id；运行时负责完成通知与清理。本地子任务支持消息和恢复，外部后端执行一次任务，并通过完成通知返回最终回答。受支持的后端可以公开获准的子级 LLM 路由。每个实例可选择子级 preset 和深度限制。

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

可选参数 `cwd` 选择子级的初始工作目录。相对路径以调用者当前目录解析；省略时继承该目录。调用者切换目录时，已有子级保留自己的目录。

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
| `modelSelection` | `false` | 公开可选子级路由字段；要求提供方支持 `agentOptions` |
| `modelDiscovery` | `false` | 注册 `list_subagent_models`；每个工具作用域仅在一个实例上启用 |
| `agentOptions` | — | 配置的子级 `provider`、`model`、适配器所有的 `reasoningEffort` 与正整数 `maxTokens` 默认值；要求提供方支持 `agentOptions`，并会覆盖提供方持有的路由默认值 |
| `agentPreset` | — | 独立子级 preset 的默认 id；要求进程内 spawn |
| `allowedAgentPresets` | — | 非空 preset-id 白名单，作为模型可选的 `agent_preset` 枚举；与 `agentPreset` 同时配置时必须包含后者 |
| `maxDepth` | Host 设置（`1`） | 绝对委派深度上限（`0` 禁止委派）；`'provider-managed'` 不向进程外提供方发送上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-subagent)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 受管理的委派

运行时接受子任务后，每次调用都会返回 `started subagent <childId>`，不等待子任务结果。activation 独立于已完成的工具调用拥有这项工作；运行时发送完成通知并释放执行资源。

所有后端的完成通知都会附带最终回答。本地 Spawn 和 Fork 子任务还可以发送消息，在活跃期间通过 `send_message` 接受更多工作，或在结束后恢复。Codex、Claude Code、ACP 与 DSH SDK 后端不接受后续消息。

`maxDepth` 限制递归深度（`0` 禁止委派）；省略时，每次委派读取 Host 当前的 `subagent.maxDepth` 设置，初始值为 `1`。数值深度要求提供方具备 `depthLimit` 能力；`'provider-managed'` 把预算留给进程外提供方。工具在达到上限时仍然可见；每次尝试启动都会检查调用 agent 的当前深度，被拒绝时返回出错的工具结果。

<a id="selecting-a-child-preset"></a>
### 选择子级 preset

设置 `agentPreset`，为每个子级指定默认的独立 preset。设置 `allowedAgentPresets`，允许模型通过 `agent_preset` 选择 id；没有此白名单时，模型不能覆盖配置中的选择。只有进程内 spawn 支持这些选项；fork 与外部后端会拒绝它们。

重复或空 preset id 在加载时被拒绝。调用启动子级时解析选中的 preset；未知或无法加载的 preset 返回出错的工具结果，不会启动子级。创建父 Agent 或切换其 preset 时不解析子级引用。两个选择字段都省略时，工具不要求 preset 服务。模型省略选择时使用配置的 `agentPreset`；若也没有默认值，则加入父方当前 preset 代际。任何显式 id 都挂载当前可用代际，即使与父方 id 相同。

在 [preset 插件列表](../../preset/agent-preset-registry/README.zh.md)中配置 persona 与工具。包含 `persona` 或 `toolFilter` 的工具配置在加载时会报迁移错误。本地子级采用共享的 [preset 恢复规则](../subagent/README.zh.md#restoring-child-composition)。

### 选择子级 LLM

设置 `modelSelection: true` 后，该实例公开可选的 `provider`、`model` 和 `reasoning_effort` 字段；未设置的实例拒绝选择字段。在每个工具作用域的一个实例上设置 `modelDiscovery: true`，以注册 `list_subagent_models`；该选项独立于 `modelSelection`，默认关闭。同一作用域的第二个发现工具所有者会注册失败。发现工具随其所属插件实例存续，在委派提供方缺席时仍然可用，并在该实例卸载时移除。Web 与 Desktop preset 为 spawn 启用发现和路由字段，为 fork 保持两者关闭。Host 的 `/model-selection-settings` 服务在 Agent 创建时读取用户偏好，与工具安装无关。创建监听器在投影注册完成前订阅并等待句柄；注册失败或所属插件卸载会使 Agent 发布失败。启用时，精确路由列表记录在每个新顶层 Session 中，由子 Session 继承，并在恢复时保留；之后的设置编辑只影响新 Session。没有已记录 Session 策略时，发现和显式选择只允许父 Agent 当前生效的 provider/model 及其支持的强度。路由字段要求后端公布 `agentOptions`；进程内 Spawn、Fork 和 DSH SDK 满足条件，ACP、Codex 和 Claude Code 会使挂载失败。

一次调用需同时提供 `provider` 与 `model`；当配置值、父 agent 值或提供方持有的默认值能提供路由时，也可只提供推理等级。静态的 `provider.agentRouteDefaults` 在存在时构成提供方／模型基线；工具配置与模型字段会在路由相关强度合并和确切路由预检前覆盖它。没有这些默认值的提供方会使用父 agent 最新已记录请求中的兼容值，再使用父级首次请求前的创建选项，并保留配置的 `maxTokens`。更改路由但未显式提供推理等级时，会清除继承的路由自有等级，使所选模型解析自己的默认值。实时 LLM 适配器在创建子 agent 前校验有效路由。目录成员资格只提供建议，因此适配器接受时，模型可以使用未列出的 id。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具如何镜像提供方生命周期并结算运行；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

一个实例对应一个提供方和一个工具名。插件在提供方存在时向所属组合注册定义，并在提供方离开时释放它。每个 preset 代际拥有一份共享注册，配置了 preset 选择的工具也相同。Agent 继承其定义；切换 preset 只改变作用域的继承关系，不重新安装工具。发现工具属于配置了 `modelDiscovery` 的实例，与委派执行器读取同一份持久 Session 策略。提供方不支持的数字 `maxDepth` 或配置的 LLM 选择会使挂载失败。同一作用域中可以有多个名称不同的委派工具公开模型选择。

### Activation 所有权

工具调用 `ctx.subagents.startActivation()`，并选择向父任务交付。运行时拥有启动取消、执行、结果汇报与清理。启动失败产生出错的工具结果；发布后的失败通过完成通知到达，运行时保留诊断和部分输出。

### 结果确认

规范工具结果为 `{ kind: 'activation', subagentId }`。其中没有执行 Promise 或最终输出；需要等待结果的程序调用方直接使用 subagent 服务。

### 随上下文变化的措辞

工具描述源自 `provider.inheritsParentContext`：全新子 agent 得到「it does not see this conversation」措辞，fork 子 agent 得到「it does not see the current in-flight turn」措辞，因此模型既不会复述、也不会省略并不存在的上下文。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具注册、提供方生命周期镜像、activation 请求 |
| [`src/preset-selection.ts`](src/preset-selection.ts) | preset 默认值、模型白名单与选择引导 |
| [`src/model-selection.ts`](src/model-selection.ts) | 请求／配置合并与实时 LLM 路由预检 |
| [`src/model-selection-settings.ts`](src/model-selection-settings.ts) | 为新 Session 读取的宿主所有 opt-in 设置 |
| [`src/model-selection-state.ts`](src/model-selection-state.ts) | 记录并继承已读取决定的 Session 事件 |
| [`src/list-models.ts`](src/list-models.ts) | `list_subagent_models` 运行时发现工具 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从工具运行时行为进入它所委派其上的 seam，以及相邻的子 agent 工具。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——提供方、activation、结果与继续执行。
- [dsh-tool-subagent-control](../tool-subagent-control/README.zh.md)——可继续子 agent 的消息、中断与列表工具。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent)——默认 schema 与后端相关的措辞。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-subagent)——每个受支持配置字段。
- [历史模型选择 subagent 路由](../../../.agents/notes/archived/feature/2026-08-18-model-selected-subagent-routes.md)——选择策略、继承、发现与 fork 限制。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

生成的默认 [`subagent` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent) 在提供方存在时以配置的工具名公开。设置了 `modelSelection` 的实例在每个 Session 中都会增加 `provider`、`model`、`reasoning_effort` 及路由指导。`allowedAgentPresets` 增加 `agent_preset` 枚举及默认或继承选择的引导。上下文继承和继续执行能力决定任务与后续工作描述。Agent 限制同时作用于继承自 preset 的委派工具的 schema、执行入口和指导文本，恢复历史 `toolFilter` 覆盖时也相同；同级 Agent 不受影响。preset 选择提示仅依赖工具配置，因此不依赖其他 preset 的声明顺序。

#### Token 影响

每次父级请求承担固定 schema 成本；`modelSelection` 会增加三个可选路由字段，preset 选择则增加一个枚举参数及默认值引导。每个工具实例增加一份 schema；可见委派工具共享一个简短系统提示词段。

#### KV Cache 影响

只要提供方实例及其配置不变，前缀就保持稳定。适配器目录变化不会改变定义。随附 fork 工具省略模型选择字段，以保留对继承的父级前缀的复用。自定义 fork 工具可以启用选择；更改其路由可能使前缀无法复用。

### 模型选择与发现

#### 模型看到什么

可选的 `list_subagent_models` 定义读取调用 Session 的路由策略，没有已记录策略时使用当前父级路由。可选的 `ctx.llm` 服务不可用时，调用会被拒绝。有已记录策略时，提供方模型列表取公布目录与 Session 授权路由的交集。没有策略时，只解析当前父级模型，即使目录未列出它。发现工具自身的描述要求模型在选择子级路由前查询选项；未挂载或过滤掉发现工具时，这段指导也不会出现。精确模型查询允许已授权但目录未列出的 ID；未授权的提供方／模型查询会在访问适配器前失败。目录或精确模型查询失败以及取消都会使调用被拒绝。执行过程独立强制同一策略。

#### Token 影响

启用 `modelDiscovery` 的组合中存在一份固定发现 schema，不受 Session 偏好或所属实例的 `modelSelection` 选项影响；随附 Web 与 Desktop preset 包含它，headless、SDK 和 ACP profile 不包含。只有模型调用工具时，路由元数据才进入 transcript。

#### KV Cache 影响

适配器注册与目录变化不会改变 schema 前缀。每个发现结果都追加在可复用前缀之后。

### 系统提示词

#### 模型看到什么

可见的委派工具共享一段指导，列出按名称排序的工具，指示模型一起启动相互独立的委派，并在它们运行时继续工作；当只剩等待它们的结果时，结束本轮，而不是休眠或轮询。结束本轮之所以可行，是因为子代理结束后会通知父级，而通知到达空闲父级会起一次独立的模型请求；在子代理继续推进期间，宿主交替等待 `agent.whenIdle()` 与 `waitForChildren(agent)`（[`dsh-subagent`](../subagent/README.zh.md)、[`session.ts`](../../acp/acp/src/session.ts)）。隐藏或不可用的工具不列入其中；没有可见工具时，不输出指导。`subagent` 和 `subagent_fork` 都可见时，文本为：

##### 工具指导 section

```markdown
Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.
```

#### Token 影响

每个父级请求最多包含一段简短的委派指导，列出该请求可见的工具名。

#### KV Cache 影响

可见工具名不变时，前缀保持稳定；增加或移除可见工具会更改这段指导。

### 运行时深度上下文

#### 模型看到什么

当调用方 agent 达到或超过某个可见工具实际生效的数值深度上限时，可选的运行时上下文快照会提示它直接完成工作。每次请求都会重新解析上限，包括 settings 变更或会话恢复之后。隐藏的工具和 `provider-managed` 上限不贡献深度文本。深度和上限都为一时，子 agent 看到：

##### 深度上限提示

```markdown
Delegation depth for `subagent`: current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.
```

#### Token 影响

每个达到上限的工具向用户角色的运行时上下文快照贡献一小段文本。未变化的快照不会重复追加；未达到上限的 agent 不收到额外文本。`includeRuntimeContext: false` 会抑制这条提示，但不改变运行时对深度上限的强制执行。

#### KV Cache 影响

深度变化不改变系统提示词或工具 schema。更新的运行时上下文追加在已有历史之后；模型尝试委派时，提供方仍会强制执行上限。

### 启动结果

#### 模型看到什么

调用保留任务描述与提示词。成功返回 `started subagent <childId>`；启动被拒绝则返回错误。子任务执行详情独立于这条确认交付。

#### Token 影响

提示词与确认保留在父级历史中，直到上下文压缩；子任务工作上下文留在子任务中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 完成交付

#### 模型看到什么

回答投递遵循上文的受管理委派规则。返回的子任务 id 用于后续控制与目录操作；只有支持继续执行的后端才接受后续消息。

#### Token 影响

消息与完成通知独立于启动确认追加到父级历史。工具结果本身不包含最终输出。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本工具不返回或不强制执行什么；它们是当前包约束。

- **本工具不等待结果**——使用完成通知或子任务消息。程序化结果等待由 subagent 服务提供。
- **预设选项不含描述**——`agent_preset` 只公开 id 及默认或继承提示。schema 不读取候选预设文档，因此注册不依赖它们的声明顺序。请使用能够表达各候选用途的 id。
- **预设引用在委派时检查**——Host 挂载和预设内挂载的工具都在启动子级时解析目标。目标可以在工具注册后声明或替换，因此加载工具无法确定后续调用时目标是否可用。拼错或不可用的 id 在被选中前不会被发现；选中它的调用会返回错误。
- **随附 fork 工具省略模型选择**：其配置保持 `modelSelection` 关闭，以保留对继承前缀的复用。自定义 fork 工具可以启用它，并接受与其他委派工具相同的 Session 授权和适配器校验。
- **深度上限按实例固定** — 更换上限需要另一个不同名称的工具。子级角色和工具由所选 Agent Preset 配置。显式 LLM 选择需要 `modelSelection`，并受 Session 授权路由限制，没有启用策略时只允许当前父级路由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
