---
description: "五个任务板与等待工具及协作指引，供实验性 Team 组合中的每个成员使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

## 概述

本包让每个 Team 成员协调共享工作：在共享任务板上创建、claim 并完成任务，并等待 teammate 而不必轮询。每个成员还会收到共享 checkout 的协作策略以及一条角色声明。创建 teammate、向其发消息、列出与中断 teammate 仍使用标准 subagent 工具，因此本包只增加五个工具 schema。本包以实验性名称公开发布，但不提供稳定性保证。

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

当 Team 成员应通过工具协调时，在 `@deepseek-ai/dsh-experimental-agent-team` 之上挂载本包。挂载后，Lead 及其下每个 subagent（无论 fresh 或 fork）都会获得相同的五个工具、相同的策略段落，以及一条声明其角色的必需 runtime context。

### 何时选择

只要挂载了 Team 领域包且模型需要使用任务板，就选择本包；没有它时，只能通过 `ctx.agentTeams` 访问任务板。teammate 通过标准 `subagent`、`subagent_fork`、`send_message`、`list_agents` 与 `interrupt_agent` 工具创建和联系，因此组合还需要 `@deepseek-ai/dsh-tool-subagent` 与 `@deepseek-ai/dsh-tool-subagent-control`。

### 最小工作示例

本插件不接受配置；按照 [agent-team 配置](../agent-team/README.zh.md#smallest-working-setup)，把它挂载在 Team 领域包旁边：

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

设置 `interrupt`、`freshProvider` 或 `forkProvider` 的配置行不会激活，dsh 会在启动警告中指出该键。[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.4/agent-team-subagents/guide.zh.md)把已移除的工具与键对应到替代方式，生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)记录空配置。

让 Lead 启动子代理审查差异、创建审查任务并等待结果。`description` 说明子代理的工作；返回的 id 用于寻址。

### 模型能做什么

五个工具覆盖两类能力；第三类由标准 subagent 工具提供：

- **管理任务板**——`team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update` 添加、浏览、读取与更新共享任务。
- **等待 teammate**——`wait_agent` 等待调用开始后的下一次任务、成员状态或 inbox 变化。
- **创建和联系队友**——`subagent`、`subagent_fork`、`send_message`、`list_agents` 和 `interrupt_agent` 来自子代理工具包，本包不修改它们。

任务 `owner` 参数与 `ownerName` 结果使用 agent 名字；根名为 `lead`。描述可以重复。任何成员均可使用任务板；只有 Lead 能重新分配任务。更新校验所有权和修订，拒绝过期编辑。

### 成功与失败的表现

任务工具返回紧凑 JSON 任务视图或任务分页。过期的 `expected_revision`、未授权操作或未就绪任务会作为工具错误报告，而不是覆盖更新的成果。`wait_agent` 在发生变化后返回 `{ "timedOut": false }`，超时时返回 `{ "timedOut": true }`；当没有其他成员 running 时，它会立即返回 reason 为 `no-active-peer` 的 `noProgress`，提示调用方先用 `send_message` 唤醒 teammate。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在四项承诺之上：

- **按作用域，而非全局。** 每个注册都位于成员 Agent（智能体）自己的 `ctx` 上；安装依据 Agent 发布时可用的 Team 成员关系。
- **一个工具族。** Team 不注册消息、列表或中断工具；标准 subagent 工具同样服务 Lead 与 teammate。
- **声明式结果，紧凑 JSON。** 每个工具都声明完整结果 schema，并把该值渲染为紧凑 JSON，因此编译器会对照向模型承诺的结果检查 `execute`，任何结果都不会在缩进上消耗 token。
- **领域掌握裁决权。** 工具委托给 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；适配器不添加更弱的路径。

[subagent teammate Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.zh.md)负责模型侧与 scoping 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：已移除键的拒绝、固定策略文本、身份 context 与五个 scoped 工具注册 |

### 策略与工具

member scope 上的一个 `team:policy` 段落和一个必需的 `team:identity` runtime-context 条目承载共享协作规则与成员角色；固定文本与五个工具注册都声明在 [`src/index.ts`](src/index.ts)。五个工具 schema 注册在发布时被识别为 Team 成员的每个 scope 中，包括 fork 子级，因此父请求与 fork 请求列出相同的工具和 system prompt。没有任何注册与 subagent 控件同名，因此在每个成员 scope 中，`send_message`、`list_agents` 与 `interrupt_agent` 都解析为全局 subagent 工具。

### 按作用域注册与拆除

`maybeInstall` 对每个 live Agent 运行，并订阅 `agent/created`；它跳过没有 Team 成员关系的 Agent。Agent 的 dispose（资源释放）会运行已安装的 disposer，插件 HMR（热模块替换）会在重新安装前对每个已安装的 scope 执行 dispose。每个 disposer 按逆序撤销注册，因此失败的安装不会留下残缺 scope。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从领域服务逐步进入精确 schema 与设计背后的决策。

- [agent-team 包](../agent-team/README.zh.md)——这些工具背后的 `ctx.agentTeams` 领域服务。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与服务 API。
- [子代理控制工具](../../subagent/tool-subagent-control/README.zh.md)——按 agent 名字 发消息、列举和中断。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)——模型接收的每个工具 schema。
- [subagent teammate Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.zh.md)——模型侧、scoping 与工具族决策。

-----

<a id="model-experience"></a>
## 模型体验

### Team 策略 system prompt

#### 模型看到什么

每个 Team 成员的 system prompt 都包含一个 `team:policy` 段落；Lead 与每个 teammate 看到相同的文本：

##### Team 策略

```markdown
Agent Teams is available in this session. Teammates are subagents. Use agent names with send_message to reach your direct continuable children or, as a continuable subagent, your parent and continuable siblings. Descriptions explain responsibilities and may repeat.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use agent names as task owners; the root agent is named lead. The Lead can reassign to itself, its direct continuable children, or historical members; other descendants claim tasks themselves. list_agents shows direct contacts and all reachable continuable descendants; discovery does not grant message or assignment authority. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, make sure another required member is running; use send_message first for an inactive direct contact, or coordinate through its parent for a deeper member. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member is running. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.
```

#### Token 影响

该段落是每个 Team 成员每次请求的固定成本。

#### KV Cache 影响

该文本对 Lead 与每个后代都相同，并且在插件保持加载期间不会变化，因此它保持稳定的 system prompt 前缀，包括父级与其 `subagent_fork` 子级之间。加载或卸载插件会改变每个成员的 system prompt，并使其已缓存前缀失效。

### Team 身份 runtime context

#### 模型看到什么

必需的 `team:identity` runtime context 对根声明 `You are the Team Lead. Your name is lead.`，对子代理声明 `Your name is "<name>". You are a teammate in the Team led by "lead".`。它跟随当前成员关系，不受可选上下文抑制影响，压缩后会恢复。队友的普通分叉是新的根，收到 Lead 声明。

#### Token 影响

身份是完整 runtime-context 快照的一部分。保留的快照未变化时不追加消息；context 变化或被移除时，loop 追加包含身份的完整快照。

#### KV Cache 影响

身份通过请求前缀之后的 runtime-context 快照到达，因此 `subagent_fork` 子级保留父级的 system prompt、工具与继承消息，并在其后追加 teammate 声明。提供方实际缓存命中仍为尽力而为。

### 任务与等待工具 schema

#### 模型看到什么

每个 Team 成员都收到相同的五个 schema，列在[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)中。结果是紧凑 JSON 任务视图、任务分页或等待值。当没有其他成员 running 时，`wait_agent` 返回 reason 为 `no-active-peer` 的 `noProgress` 以及消息 `No other Team member is running. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake a required inactive direct contact before waiting again; coordinate deeper members through their parent.`。仅限 Lead 的 `reassign` 在执行时落实，而不是通过不同的 schema。

#### Token 影响

五个 schema 是每个 Team 成员请求的固定成本。工具调用会增加紧凑 JSON 结果；`team_task_list` 每页最多返回 100 个任务。

#### KV Cache 影响

这些 schema 对 Lead 与每个后代（包括 `subagent_fork` 子级）都相同，因此 fork 的工具列表与父级请求前缀一致。工具结果追加在可复用前缀之后。加载或卸载插件会改变每个成员的工具列表，并使其已缓存前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明策略与工具无法为一支团队保证什么。它们是当前包约束，不是与其他协作方式的对比。

- **提示词策略只负责协调，不负责 confinement**——它无法阻止 Bash 或外部进程写入重叠文件。
- **安装取决于发布时刻**——发布时不是 Team 成员的 Agent（例如 parent 未加载的 subagent）不会获得 Team 工具、策略或身份，即使其 parent 之后加载也是如此。
- **没有 Web 控制功能**——浏览器 roster 与任务板呈现不属于该运行时包。
- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间 schema 仍可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
