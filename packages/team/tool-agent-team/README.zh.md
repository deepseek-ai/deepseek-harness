---
description: "为开启 Team 的 Session提供四个任务板工具和共享任务指导。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-team

[English](README.md) | 中文

## 概述

此包让 subagent（子智能体）树中的每个 agent 创建、认领并完成共享任务。它添加四个任务 schema 和共享任务板指导。普通 subagent 控制工具负责发现、通信、中断和收件箱等待。基础 bundle 加载服务与工具；新 Session 默认关闭 Team 模式。

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

仅当根 Session 开启 Team 模式时，各模型步骤才可使用 Team 工具。提示词提供方在求值时读取同一选择。普通 subagent 控制工具始终可用。

模型需要共享任务板时，将此包与 `@deepseek-ai/dsh-agent-team` 一起挂载。根和后代接收相同的任务 schema 和任务策略。

### 何时选择

只要挂载了 Team 领域包且模型需要使用任务板，就选择本包；没有它时，只能通过 `ctx.agentTeams` 访问任务板。teammate 通过标准 `subagent`、`subagent_fork`、`send_message`、`list_agents` 与 `interrupt_agent` 工具创建和联系，因此组合还需要 `@deepseek-ai/dsh-tool-subagent` 与 `@deepseek-ai/dsh-tool-subagent-control`。

### 最小工作示例

本插件不接受配置；按照 [agent-team 配置](../agent-team/README.zh.md#smallest-working-setup)，把它挂载在 Team 领域包旁边：

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-tool-agent-team'
```

设置 `interrupt`、`freshProvider` 或 `forkProvider` 的配置行不会激活，dsh 会在启动警告中指出该键。[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.zh.md)把已移除的工具与键对应到替代方式，生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-agent-team)记录空配置。

让 Lead 启动子代理审查差异、创建审查任务并等待结果。`description` 说明子代理的工作；返回的 id 用于寻址。

### 模型能做什么

任务工具补充普通 subagent 控制工具：

- **管理任务板**——`team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update` 添加、浏览、读取与更新共享任务。
- **等待收件箱输入** — `wait_agent` 属于 `@deepseek-ai/dsh-tool-subagent-control`，无需此包即可使用。
- **创建和联系队友**——`subagent`、`subagent_fork`、`send_message`、`list_agents` 和 `interrupt_agent` 来自子代理工具包，本包不修改它们。

任务 `owner` 参数和 `ownerId` 结果使用 Session id。根可将任务重新分配给自身或任意可达的可继续执行后代；历史名册记录不授予权限。其他 agent 自行认领就绪任务。更新会检查归属和修订。

### 成功与失败的表现

任务工具返回紧凑的 JSON 任务视图或分页。过期修订、未授权操作和未就绪任务返回错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在四项承诺之上：

- **按 Session 选择工具。** 共享工具注册项根据调用方根 Session 选择可用性；服务在调用时解析树权限。
- **一个工具族。** Team 不注册消息、列表或中断工具；标准 subagent 工具同样服务 Lead 与 teammate。
- **声明式结果，紧凑 JSON。** 每个工具都声明完整结果 schema，并把该值渲染为紧凑 JSON，因此编译器会对照向模型承诺的结果检查 `execute`，任何结果都不会在缩进上消耗 token。
- **领域掌握裁决权。** 工具委托给 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；适配器不添加更弱的路径。

[subagent teammate Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.zh.md)负责模型侧与 scoping 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、已移除键拒绝、Team 策略，以及四个条件任务工具 |

### 策略与工具

一次插件注册提供动态的 `team:policy` 段落和四个条件任务工具。各提供方读取调用者根 Session 的选择，包括 fork 子级。根不可用时禁用 Team 工具与指导。树权限从 `ctx.subagents.rootOf(agent)` 派生；任务负责人保留为 Session id。身份、发现、通信和等待属于 [subagent 控制工具](../../subagent/tool-subagent-control/README.zh.md)，在切换 Team 模式时保持不变。subagent 运行时负责投递最终结果。

### 按作用域注册与拆除

工具的 `when` 条件在步骤准备时求值，包括新建、分叉和恢复的 Agent 的首个步骤。策略文本在提示词组装时求值。已经准备好的步骤保留其工具选择，但任务操作在开始前检查当前模式。插件释放时由各注册所属的 effect 移除全部注册。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从领域服务逐步进入精确 schema 与设计背后的决策。

- [agent-team 包](../agent-team/README.zh.md)——这些工具背后的 `ctx.agentTeams` 领域服务。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与服务 API。
- [subagent 控制工具](../../subagent/tool-subagent-control/README.zh.md) — 通信、列表、中断和收件箱等待。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-agent-team)——模型接收的每个工具 schema。
- [subagent teammate Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.zh.md)——模型侧、scoping 与工具族决策。

-----

<a id="model-experience"></a>
## 模型体验

### Team 策略 system prompt

#### 模型看到什么

每个 Team 成员的 system prompt 都包含一个 `team:policy` 段落；Lead 与每个 teammate 看到相同的文本：

##### Team 策略

```markdown
A shared task board is available in this session. Task owners are agent ids from list_agents. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves.

Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. The root agent must wait for required teammates before giving the final answer.

Task changes do not end wait_agent calls, add inbox messages, or start idle agents. Use send_message when another agent needs to act on a task.
```

#### Token 影响

该段落是每个 Team 成员每次请求的固定成本。

#### KV Cache 影响

该文本对 Lead 与每个后代都相同，并且在插件保持加载期间不会变化，因此它保持稳定的 system prompt 前缀，包括父级与其 `subagent_fork` 子级之间。加载或卸载插件会改变每个成员的 system prompt，并使其已缓存前缀失效。

### 任务工具 schema

#### 模型看到什么

每个成员接收[生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-agent-team)中的相同四个任务 schema。结果是紧凑的 JSON 任务视图或分页。仅根可重新分配的限制在执行时实施，而非通过不同 schema 实施。

#### Token 影响

四个 schema 为每次请求的固定开销。工具结果增加紧凑 JSON；`team_task_list` 每页最多返回 100 个任务。

#### KV Cache 影响

这些 schema 对 Lead 与每个后代（包括 `subagent_fork` 子级）都相同，因此 fork 的工具列表与父级请求前缀一致。工具结果追加在可复用前缀之后。加载或卸载插件会改变每个成员的工具列表，并使其已缓存前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明策略与工具无法为一支团队保证什么。它们是当前包约束，不是与其他协作方式的对比。

- **提示词策略只负责协调，不负责 confinement**——它无法阻止 Bash 或外部进程写入重叠文件。
- **任务权限需要在线根** — 工具可用不保证操作执行时调用者的根仍在线。
- **无 Web 控件** — 浏览器任务板展示不属于此运行时包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
