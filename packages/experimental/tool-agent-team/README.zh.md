---
description: "九个让模型创建、发消息与协调 teammate 的工具，供组合实验性 Team 插件的部署方阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

## 概述

`dsh-experimental-tool-agent-team` 在团队领域包之上给模型一套团队工具：创建具名 teammate、向它们 Steer 消息、查看谁在线、等待进展、中断卡住的 teammate，以及管理共享任务板——共九个工具。每个成员的提示词中都有一段简短策略，教模型何时组建团队（只有你要求时）以及如何在共享工作区协作。挂载它会用同名的团队工具取代旧版 subagent 控件，因此想同时使用两者的组合必须禁用旧定义。它是实验性的：不进入正式发布、不承诺稳定性，并且只有你明确要求组建团队时才会创建 teammate。

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

当模型应该通过工具运行一支团队时，在 `@deepseek-ai/dsh-experimental-agent-team` 之上挂载本包。挂载后，每个团队成员——Lead 与每个 teammate——都会获得相同的九个工具，外加一段说明自身角色与名字的策略段落。

### 何时选择

当模型应该自行创建与协调 teammate、而不是由人来操作 subagent 控件时，选择它。当同名的旧全局 subagent 工具必须继续可用时，请不要选择：团队工具会为团队成员取代它们，因此想同时使用两者的组合必须禁用旧定义。固定策略只在明确要求团队或 teammate 时创建成员，因此普通任务永远不会自行触发委派。

### 最小工作示例

对现有组合的最小增量是 [agent-team README](../agent-team/README.zh.md#smallest-working-setup) 中的两包片段：持久会话存储、团队领域包与本包。插件本身只有两个可选设置：

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `freshProvider` | `spawn` | 启动 fresh teammate 的 provider |
| `forkProvider` | `fork` | 启动 fork teammate 的 provider |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

试试这样要求 Lead 模型：「创建一个名为 reviewer 的 teammate 检查 diff，再把变更摘要发给 reviewer」。模型会调用创建工具，然后调用消息工具。

### 模型能做什么

九个工具分为四类能力：

- **创建 teammate**——`spawn_teammate` 接收名字、描述与初始任务；只有 Lead 可以调用它。
- **发送消息**——`send_message` 在最近的步骤边界 Steer running member、启动 idle member，并冷恢复 inactive teammate。
- **查看与等待**——`list_agents` 显示带实时状态的 roster；`wait_agent` 等待下一次团队变化；`interrupt_agent` 停止 teammate 的当前轮次（仅限 Lead）。
- **管理任务板**——`team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update` 添加、浏览、读取与更新共享任务。

任何成员都可以给任何其他成员发消息并使用任务板；只有 Lead 可以创建与中断 teammate。任务更新保留领域的 owner 与 revision 校验，因此过期的编辑会被拒绝，而不是覆盖更新的成果。

### 成功与失败的表现

发送消息在安全存储后即成功：结果为 `accepted`（已送达）或 `queued`（等待中），排队的消息绝不能重发。当没有其他成员 running 或 provisioning 时，`wait_agent` 会立即返回 `noProgress`，提示调用方先唤醒 teammate；否则它会等待下一次变化，调用方随后重新读取状态。基于过期 revision 的任务编辑会被拒绝，而不是覆盖更新的成果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在三项承诺之上：

- **按作用域，而非全局。** 每个注册都位于成员 Agent 自己的 `ctx` 上；非 Team subagent 或宿主不会安装任何内容。
- **声明式结果，紧凑 JSON。** 每个工具都声明完整结果 schema，并把该值渲染为紧凑 JSON，因此编译器会对照模型被承诺的值检查 `execute`，任何结果都不会在缩进上消耗 token。
- **领域拥有权限。** 工具委托给 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；适配器不添加更弱的路径。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责模型侧与 scoping 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、固定策略文本与九个 scoped 工具注册 |
| — | 不发布运行时不变式伴生入口；Team 服务拥有持久化与授权关系。 |

### 策略与工具

member scope 上的一个 `team:policy` 段落教每个成员自己的角色与协作规则；固定文本与九个工具注册都声明在 [`src/index.ts`](src/index.ts)。九个工具 schema 只出现在 Team member scope 中，因此非 Team subagent 保持默认目录。与旧全局 continuable-subagent 控件同名的 scoped 注册只会为团队成员覆盖这些全局控件。

### 按作用域注册与拆除

`maybeInstall` 对每个 live Agent 运行，并订阅 `agent/created`；它跳过没有 Team 成员关系的 Agent。Agent dispose 会运行已安装的 disposer，插件 HMR 会在重新安装前处置每个已安装的 scope。每个 disposer 按逆序展开注册，因此失败的安装不会留下残缺 scope。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从领域服务逐步进入精确 schema 与设计背后的决策。

- [agent-team 包](../agent-team/README.zh.md)——这些工具背后的 `ctx.agentTeams` 领域服务。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与服务 API。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)——模型接收的每个工具 schema。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——模型侧、scoping 与隔离决策。

-----

<a id="model-experience"></a>
## 模型体验

### Team 策略与工具

#### 模型看到什么

一段稳定策略会说明确切 Team role／name／id、显式 delegation 要求、共享 cwd 行为、文件 stale-version 恢复、Bash／formatter／codegen 风险、task／write-scope 协调、Steer 投递、mailbox 不重试规则，以及 Lead 必须在回答前等待。`spawn_teammate` 到 `team_task_update` 的九个 Team schema 只出现在 Team member scope。

#### Token 影响

每次 Team member 请求都有固定策略与 schema 成本。工具调用会增加紧凑 JSON roster、task、wait 或 receipt 结果。Peer 内容由 Team 领域保留在 target 历史中。

#### KV Cache 影响

Team 插件 generation、配置、member role／name 与 schema 不变时，前缀保持稳定。每个成员的身份行不同。工具结果与 peer 消息追加在可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明策略与工具无法为一支团队保证什么。它们是当前包约束，不是与其他协作表面的对比。

- **提示词策略只负责协调，不负责 confinement**——它无法阻止 Bash 或外部进程写入重叠文件。
- **不会自主创建 Team**——除非用户明确要求，普通任务不会触发 delegation。
- **没有 Web 控制功能**——浏览器 roster 与任务板呈现不属于该运行时包。
- **实验原型，无稳定性承诺**——本包为私有、不进入正式发布，孵化期间 schema 可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
