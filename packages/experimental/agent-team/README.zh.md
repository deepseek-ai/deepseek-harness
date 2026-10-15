---
description: "在实验性 Team 组合中，通过持久共享任务板和变更等待协调子代理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team` 将代理及其子代理组成共享持久任务板的 Team。标准 subagent 工具负责创建队友并按 id 发消息。Team 增加比较并设置的任务所有权、进度等待和 Web 面板成员列表。模型工具由 `dsh-experimental-tool-agent-team` 提供。该包为实验性功能，成员共享同一工作树。

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

当子代理需要共享工作目录、持久任务板和变更等待时使用此包。与 `@deepseek-ai/dsh-experimental-tool-agent-team` 一起挂载以提供模型工具。

### 何时选择

当被委派的 agent 必须在同一个 checkout 中划分并跟踪共享工作时，选择本包。被委派的工作不需要共享任务板时，普通 subagent 就足够。不支持独立工作目录、跨进程协调和自动释放任务 owner。

### 最小工作配置

<a id="smallest-working-setup"></a>

在已经提供 continuable subagent、其消息工具、持久会话存储和 `sessionQuery` 的组合（例如基于 `@deepseek-ai/dsh-base` 的 profile）中挂载两个 Team 包：

```yaml
# smallest Team addition over a composition with continuable subagents
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

例如，让模型启动子代理审查差异，并在任务板上跟踪工作。唯一的限制是可选项，在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTasks` | `256` | 任务板上最多的未删除任务数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。设置 `maxMembers`、`maxMessageBytes` 或 `disposalTimeoutMs` 的配置行不会激活，dsh 会在启动警告中指出该键；[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.3/agent-team-subagents/guide.zh.md)列出替代方式。

### Teammate

让 Lead 使用 `description` 描述工作并启动子代理：`subagent` 从全新上下文开始，`subagent_fork` 继承已完成轮次。返回的 Session id 用于寻址队友；描述用于展示，可以重复。

每个根代理领导自己的 Team，其下任意深度的每个在线子代理都收到 Team 工具。每个会话的成员列表包含 Lead、直接可继续子代理和历史 `team/member` 记录。Web 面板合并这些会话列表，显示所有已发现的后代。

### teammate 之间的消息

成员使用标准 `send_message` 按 Session id 发消息：Lead 联系直接子级，驻留的可继续子级联系父级和可继续同级。Steer 投递到目标收件箱，并可冷恢复子级或同级。Team 不存储消息；已接受消息遵循普通 Agent 持久化。

### 共享任务板

任何成员都可以添加任务，包含标题、详情、对其他任务的可选依赖，以及可选的文件触及提示。只有其全部依赖完成后，任务才可 claim。

成员认领任务后开始工作，可以完成、释放或重新打开任务。Lead 可按 Session id 将任务重新分配给自身、任意深度的可继续后代或活跃的历史成员。其他成员自行认领任务。每次变更都使用比较并设置，防止过期更新覆盖新工作。

当两个 in-progress 任务计划触及重叠路径时，文件提示会产生警告——它们绝不阻止任何操作。已删除任务保留在历史中，但从活动列表中消失。

### 等待与中断

成员可以等待下一次 Team 变化——任务更新、成员状态变化，或成员 inbox 接收的消息——而不必反复轮询；等待只报告是否超时，调用方随后重新读取当前状态。

祖先使用标准 `interrupt_agent` 工具停止 teammate 的当前轮次，因此只有 Lead 能中断其直接 teammate。中断保留尚未领取的排队消息，任务归属不变。

### 成功与失败的表现

成功返回更新后的任务修订或等待结果。未知成员 id、未就绪任务、过期修订、未授权变更和任务上限耗尽均报告 `TeamError`，例如 `TEAM_TASK_STALE_REVISION`。不属于在线 Team 的调用方收到 `TEAM_NOT_MEMBER`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在四项承诺之上：

- **成员关系来自谱系。** live Agent registry 与 Lead 的 subagent catalog 定义 Team；Team 自己不存储成员记录。
- **持久日志、派生状态。** Lead 日志拥有任务和子级目录事实；每个目标 Agent 拥有已接受的消息。
- **显式权限。** 每个服务方法都接收确切的 live 调用方 `Agent`；任务 owner 或 Lead 可以变更任务，只有 Lead 可以 reassign。
- **超出上限时明确失败。** `maxTasks` 是经过校验的部署值，耗尽时报告类型化错误，而不是复用 id。

[subagent teammate Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.zh.md)负责成员关系、roster 与消息决策。[runtime-context 身份决策](../../../.agents/notes/implemented/architecture/2026-10-13-team-identity-runtime-context.zh.md)负责面向模型的身份。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、已移除键的拒绝、服务注册、变更通知 |
| [`src/membership.ts`](src/membership.ts) | 通过 live Agent registry 解析 Lead 与 teammate，以及查找任务分配对象 |
| [`src/task-board.ts`](src/task-board.ts) | 任务 CAS 命令、DAG 校验与派生视图 |
| [`src/journal.ts`](src/journal.ts) | 串行化的 Lead 日志事务与提交通知 |
| [`src/projection.ts`](src/projection.ts) | 严格回放 Lead 的可继续子级和 Team 事件，发布 `agentTeam` 客户端视图 |
| [`src/task-view.ts`](src/task-view.ts) | 任务板与客户端视图共用的纯任务就绪性和写入重叠推导 |
| [`src/activity.ts`](src/activity.ts) | 一次性变更等待者与 dispose（资源释放）时的等待解除 |

### Team 身份与成员关系

自身日志不含子代理描述符的根 Agent 领导以其 Session id 标识的 Team。`tryMembership()` 沿在线注册表中的 `parentSession` 查找根；父级缺失时，子代理不属于任何 Team。普通分叉最多携带继承的描述符，因此领导新的 Team。成员身份仅记录根、Team id 和角色。

### Roster

投影将 Lead 自有的 `subagent/catalog` 事实转为按子级 id 标识的行，目录标签作为描述。可继续子级被纳入；继承的事实和其他模式被跳过。描述不要求唯一。历史 `team/member` 记录保留阶段和描述，仅补充目录中不存在的 id。Team 不写入成员记录。

### 消息与历史 mailbox

Team 不发送消息。`send_message` 的路由、Steer 投递、冷恢复和发送者前缀都属于 subagent 运行时。历史 `team/message/queued` 与 `team/message/delivered` 记录以及 `team-message` source 仍可解码；Team 从不投递或确认它们，因此目标尚未记录的历史消息保持未投递。

### 共享任务板

任务是完整版本化快照；每次变更都携带 `expectedRevision`，陈旧调用方会收到 `TEAM_TASK_STALE_REVISION`，而不会覆盖更新的值。数字 `task-<n>` id 的后缀必须是安全整数，id 空间耗尽时报告 `TEAM_TASK_LIMIT`，而不是复用最后一个 id。已删除任务作为 tombstone 保留以供回放与维持 id 稳定，但不占用 `maxTasks`，也不出现在 `listTasks()` 中。`writeScopes` 是规范化后的 workspace 相对前缀；视图会对与 in-progress 任务的重叠发出警告，但绝不阻止 claim 或授予写权限。Lead 按 Session id 将任务分配给根、任意深度的 continuable 后代或活跃历史成员。深层指派读取实时或持久观察，并逐层核对孩子自己的 descriptor 与直接父代理的 catalog。普通 fork、其他 Team、缺失祖先和循环关系报告 `TEAM_MEMBER_NOT_FOUND`；存储读取失败原样报告。

### 等待

`waitForChange()` 等待注册之后发生的下一次任务提交、成员 `agent/status` 变化或成员 `agent/inbox/inserted` 边，时长从 10 秒到 1 小时，并且只报告是否超时；卸载服务会释放当前等待。取消会保留 Error reason；非 Error reason 则通过 `TEAM_WAIT_ABORTED` 报告。`hasActivePeer()` 报告是否有另一个 live 成员正在运行轮次，`wait_agent` 据此跳过没有成员能结束的等待。

### 持久性模型

任务变更将 `team/task` 追加到精确的 live Lead 会话，并在报告成功或唤醒等待者之前 flush。Team 事件仅存在于日志：它们从不进入会话表面，因此派生模型历史不受协作记录影响。顺序与时间由会话事件的 `seq` 与 `time` 负责，快照不重复保存。teammate id 与描述保存在 Lead 的 `subagent/catalog` 中，由 subagent 运行时写入。

Mailbox 投影与 checkpoint 准入保留本地声明的校验器之外获准内容中全部已解码 JSON 字段，包括自有 `__proto__` 键。本地字段检查覆盖 `text`、`reasoning`、`image` 和 `tool-call`；获准的未知标签保持不透明。Team 投影缓存版本 5 从 Session 日志重建较早缓存版本的 checkpoint；Session 格式版本保持不变。

### Dispose

卸载服务会释放当前等待并注销投影。Team 不拥有任何 Agent：teammate 继续在 subagent 运行时下运行，由后者负责其容量、结算与拆除。

### 浏览器投影

`agentTeam` Session 投影发布 Lead Session 的 roster 行（含 phase 与错误）、未删除任务视图，以及最后有效状态旁的 `failure`。其 `apply` 只替换被触及的集合；仅邮箱的变化保留客户端视图引用，不产生 frame。[子系统参考](../../../docs/subsystems/agent-team.zh.md#web-projection) 定义传输类型。

[Web UI](../client-ui-agent-team/README.zh.md) 读取共享 Session 投影，并从 Session 状态叠加活动信息。任务创建与更新由 Team agent 通过服务和模型工具完成。`./client` 导出可供浏览器使用的 roster、任务与投影类型。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统类型逐步进入工具表面与设计背后的决策。

- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [tool-agent-team 包](../tool-agent-team/README.zh.md)——每个成员获得的任务与等待工具、策略和身份。
- [Subagent 运行时](../../subagent/subagent/README.zh.md)——teammate 使用的可继续子级、消息、中断与生命周期。
- [subagent teammate Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.zh.md)——为何 teammate 是subagent，以及 Team 保留了什么。
- [升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.3/agent-team-subagents/guide.zh.md)——已移除的 Team 工具、服务方法与配置键的替代方式。
- [实验包参考](../AGENTS.md)——位置、公开发布与依赖隔离。

-----

<a id="model-experience"></a>
## 模型体验

### 任务视图与错误

#### 模型看到什么

模型通过任务工具结果查看 Team 状态；协调事件不进入对话。任务视图通过 `ownerId` 标识负责人。失败以携带 `TeamError` 消息的工具错误显示，过期更新错误包含当前修订。

#### Token 影响

本领域包自身不增加任何上下文；每个任务工具结果按返回的任务数，每个任务计一个紧凑任务视图。策略、身份与工具 schema 属于 `@deepseek-ai/dsh-experimental-tool-agent-team`。

#### KV Cache 影响

任务提交只向 Lead 会话追加仅日志事件，因此从不改变任何成员的请求前缀；任务结果追加在前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明一支团队目前不能做什么、或哪些方面需要特别的运维关注。它们是当前包约束，不是与其他协作机制的对比。

- **完整视图广播** — 每次 roster 或任务变化都会把完整 roster 和未删除任务板（含描述）发给所有已连接浏览器，即使它正在查看其他 Session。
- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间约定仍可自由变更。
- **单进程、共享 checkout**——成员共享 cwd，修改立即可见；本包不提供 worktree、远端成员、merge 或文件锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **相邻消息路由**——成员只能联系直接父级、子级和可继续同级，即使任务板覆盖所有深度。
- **成员关系需要 live 谱系**——parent Agent 未加载的 subagent 不属于任何 Team，因此其 Team 调用以 `TEAM_NOT_MEMBER` 失败。
- **不会自动释放 owner**——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner。
- **历史排队消息保持未投递**——没有对应投递记录的 `team/message/queued` 记录仍可在 Lead 日志中读取，但不会有成员收到它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### Promotion

promotion 到产品角色组需要按[实验子树规则](../AGENTS.md)审查公共约定、限制、测试证据、发布载荷、运行时依赖与具名稳定 owner。

#### 未来方向

尚未决定的探索方向包括嵌套 Team、自动释放 owner 的策略，以及通过 worktree 实现文件系统隔离；这些都没有承诺。

</details>
