---
description: "在开启 Team 的 Session 中通过持久化共享任务板协调 subagent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-team

[English](README.md) | 中文

## 概述

`dsh-agent-team` 为现有 subagent（子智能体）树添加持久化共享任务板。成员使用标准 subagent 工具发现和联系彼此。Team 提供比较并交换的任务归属更新。挂载 `dsh-tool-agent-team` 可提供任务工具。成员共享同一检出目录。

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

新 Session（包括普通分叉）默认关闭 Team 模式。参见[会话模式升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/session-team-mode/guide.zh.md)。在根 Session 的模型与推理等级菜单中打开**使用智能体团队**。关闭开关后，整棵树的后续步骤不再显示 Team 工具和提示词，同时保留任务与子代理。选择重启后仍有效；没有保存选择的历史任务板保持开启。

设置 `defaultEnabled: true` 可在首次模型步骤之前启用新根 Session，包括普通分叉。初始化将选择保存为 `team/mode`；保存失败会拒绝 Agent 创建。已有选择优先，恢复 Session 时始终不应用默认值，包括从未保存选择的会话。后代使用其存活根节点的模式。[SDK 配置指南](../../../docs/user/guide/python-sdk.zh.md#enable-team-mode)提供可直接使用的 patch；标准 bundle 保持此选项关闭。

模式切换无需等待排队中的任务修改即可生效。每项修改在开始时检查当前模式：已经进入执行的操作继续完成，仍在排队的操作若开始时 Team 仍关闭则被拒绝。重新开启允许后续操作继续。保存失败时，已经追加的选择仍然有效；重试同一选择会再次保存，不重复记录模式。

当 subagent 需要持久化共享任务归属和依赖关系时，添加此包。与 `@deepseek-ai/dsh-tool-agent-team` 一起挂载可提供模型工具。

### 何时选择

委派 agent 需要划分和跟踪共享工作时选择此包。无需共享任务板时，普通 subagent 已足够。Team 不创建隔离工作目录、不跨进程协调，也不自动释放任务所有者。

### 最小工作配置

<a id="smallest-working-setup"></a>

在已经提供 continuable subagent、其消息工具和持久会话存储的组合（例如基于 `@deepseek-ai/dsh-base` 的 profile）中挂载两个 Team 包：

```yaml
# smallest Team addition over a composition with continuable subagents
- name: '@deepseek-ai/dsh-agent-team'
- name: '@deepseek-ai/dsh-tool-agent-team'
```

例如，让模型启动子代理审查差异，并在任务板上跟踪工作。配置字段均为可选项，在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTasks` | `256` | 任务板上最多的未删除任务数 |
| `defaultEnabled` | `false` | 为没有已有选择的新根会话保存 Team 模式开启状态 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。设置 `maxMembers`、`maxMessageBytes` 或 `disposalTimeoutMs` 的配置行不会激活，dsh 会在启动警告中指出该键；[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.zh.md)列出替代方式。

### Teammate

让 Lead 使用工作 `description` 启动子代理：`subagent` 从全新上下文开始，`subagent_fork` 继承已完成轮次。返回的 Session id 用于寻址队友；描述可以重复。

每个根 agent 及其后代组成一个 Team。任务可分配给根 agent 或 subagent 运行时发现的任意深度的可继续执行后代。历史名册记录仍可读取，但不授予分配权限。

### teammate 之间的消息

成员通过标准 `list_agents` 发现整棵树，并通过 `send_message` 按 Session id 联系另一成员。subagent 运行时负责路由、发送方归属和冷恢复。

### 共享任务板

任何成员都可以添加任务，包含标题、详情、对其他任务的可选依赖，以及可选的文件触及提示。只有其全部依赖完成后，任务才可 claim。

成员可认领任务开始工作、完成任务、释放任务或重新打开任务。根 agent 可按 Session id 将任务重新分配给自身或任意可达的可继续执行后代。其他成员自行认领任务。所有变更均采用比较并交换，过期更新无法覆盖较新的工作。

当两个 in-progress 任务计划触及重叠路径时，文件提示会产生警告——它们绝不阻止任何操作。已删除任务保留在历史中，但从活动列表中消失。

### 等待与中断

标准 `wait_agent` 工具等待当前调用者的下一步收件箱，无需 Team 模式即可使用；参见 [subagent 控制工具](../../subagent/tool-subagent-control/README.zh.md#wait_agent)。任务变化和 Team 模式切换不会结束等待、添加收件箱输入或启动空闲 Agent。需要 Agent 处理更新时使用 `send_message`。

祖先通过标准 `interrupt_agent` 工具停止后代的当前轮次。中断保留尚未认领的排队消息，也不改变任务归属。

### 成功与失败的表现

成功时返回已提交的任务修订。未知所有者、未就绪任务、过期修订、未授权修改和任务数量耗尽会报告类型化错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在四项承诺之上：

- **一棵树、一套身份。** subagent 运行时解析根并发现后代；Team 不维护第二套成员权限来源。
- **持久日志、派生状态。** Lead 日志拥有任务和子级目录事实；每个目标 Agent 拥有已接受的消息。
- **显式权限。** 每个服务方法都接收确切的 live 调用方 `Agent`；任务 owner 或 Lead 可以变更任务，只有 Lead 可以 reassign。
- **超出上限时明确失败。** `maxTasks` 是经过校验的部署值，耗尽时报告类型化错误，而不是复用 id。

[仅等待收件箱的决策](../../../.agents/notes/implemented/simplification/2026-10-29-inbox-only-agent-wait.zh.md)区分任务提交与 Agent 输入等待。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、配置校验和任务服务注册 |
| [`src/task-board.ts`](src/task-board.ts) | 任务 CAS 命令、DAG 校验与派生视图 |
| [`src/journal.ts`](src/journal.ts) | 串行化的 Lead 日志事务与提交通知 |
| [`src/projection.ts`](src/projection.ts) | 回放保存的模式与任务记录，发布 `agentTeam` 客户端视图 |
| [`src/task-view.ts`](src/task-view.ts) | 任务板与客户端视图共用的纯任务就绪性和写入重叠推导 |

### Team 身份与成员关系

subagent 服务通过 `subagents.rootOf()` 解析当前在线调用者的根。中间创建者可以离线。普通 Session fork 会成为一棵新树的根。Team 使用该根 Session 作为任务板所有者，不另设成员对象。

### 任务受让者

重新分配通过与 `list_agents` 相同的发现机制解析根或可继续执行后代。历史 `team/member` 记录保留在 Session 日志中，不能授权分配。

### 消息与历史 mailbox

成员通信、Steer 投递、冷恢复和发送方包装属于 subagent 运行时。历史 `team/message/queued`、`team/message/delivered` 记录和 `team-message` 来源仍可解码，但绝不再投递或确认。

### 共享任务板

任务是完整的版本化快照。修改必须携带 `expectedRevision`；过期更新报告 `TEAM_TASK_STALE_REVISION`。数字形式的 `task-<n>` id 保持在安全整数范围内。删除的任务保留为重放墓碑，但不占用 `maxTasks`，也不出现在 `listTasks()` 中。规范化的工作区相对 `writeScopes` 会警告进行中工作的重叠，而不阻止认领或授权写入。

### 持久性模型

Team 在激活前要求 `sessionPersistence` 可用。`Service.init` 等待 `agentTeam` 投影注册完成后才发布服务就绪状态。日志持有返回的 handle，通过 `stateOf(session)` 读取任务状态；调用者使用 Team 服务，不另行注册 reader。

任务修改在向当前在线根 Session 追加 `team/task` 前响应取消，随后等待刷盘完成。取消不能撤回已追加的记录。刷盘失败或没有监听器参与时，以 `TEAM_TASK_PERSISTENCE_UNCONFIRMED` 报告任务 id 和修订号：任务已可见，但持久性未知。重试前先读取该任务。任务记录仅保留在日志中。不重写已提交任务或历史载荷代次。

投影忽略历史名册与邮箱记录，不校验或保留其载荷。投影仅保存任务板、模式选择和恢复元数据。不兼容的投影检查点从未改写的 Session 日志重建；参见[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.3/team-projection/guide.zh.md)。

### Dispose

卸载服务会注销投影。保留的 handle 仍可读取，并在已获准工作收尾期间按需折叠 Session 事件。Team 不拥有 Agent：队友仍由 subagent 运行时管理，容量、收尾和拆除均由后者负责。

### 浏览器投影

`agentTeam` 投影发布未删除任务视图，并在最后有效状态旁报告失败。历史名册与邮箱记录不会导致任务板投影失败。投影失败后，任务读取和修改均报错，不再追加任务事件。模式选择仍可保存并生效，包括关闭 Team；投影错误持续可见。无效模式载荷保留最后有效选择，并发布投影错误。[子系统参考](../../../docs/subsystems/agent-team.zh.md#web-projection)定义线上的类型。

[Web UI](../../client/ui-agent-team/README.zh.md)仅展示任务。普通 subagent 导航负责成员列表；任务所有者标签显示 Session id。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统类型逐步进入工具表面与设计背后的决策。

- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [tool-agent-team 包](../tool-agent-team/README.zh.md) — 任务工具和共享任务板策略。
- [Subagent 运行时](../../subagent/subagent/README.zh.md)——teammate 使用的可继续子级、消息、中断与生命周期。
- [subagent teammate Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.zh.md)——为何 teammate 是subagent，以及 Team 保留了什么。
- [升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.zh.md)——已移除的 Team 工具、服务方法与配置键的替代方式。

-----

<a id="model-experience"></a>
## 模型体验

### 任务视图与错误

#### 模型看到什么

模型通过任务工具结果读取任务视图。面向模型和 host 的视图均以 `ownerId` 标识所有者；过期更新报告当前修订。任务更新不会结束 `wait_agent`；需要成员处理更新时，发送明确消息。

#### Token 影响

每个任务结果增加一个紧凑任务视图。任务更新不增加收件箱文本。

#### KV Cache 影响

任务记录保持在模型历史之外。任务结果追加在可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明一支团队目前不能做什么、或哪些方面需要特别的运维关注。它们是当前包约束，不是与其他协作机制的对比。

- **全量视图广播** — 每次任务变更向已连接浏览器发送完整的未删除任务板。
- **单进程** — 成员可观察共享文件系统编辑；此包不提供 worktree、远程成员、合并或文件系统锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **任务更新不会恢复成员** — 需要成员继续工作时发送明确消息。

- **通信限定在一棵树内**——成员不能向无关 Team 发消息；只有祖先能中断后代。
- **成员关系需要在线 Team 根**——中间创建者完成或释放后，成员保留 Team 身份；根缺失时不再属于活动 Team。
- **不会自动释放 owner**——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner。
- **历史排队消息保持未投递**——没有对应投递记录的 `team/message/queued` 记录仍可在 Lead 日志中读取，但不会有成员收到它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### 未来方向

尚未决定的方向包括自动释放归属和通过 worktree 隔离文件系统；两者均未承诺。

</details>
