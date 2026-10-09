---
description: "在实验性 Team 组合中运行具名 teammate，使用直接 inbox 消息和持久共享任务板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team` 为一个会话提供 Lead、具名 teammate、直接消息和持久共享任务板。发送使用目标 agent（智能体）的 inbox，并可冷恢复已存储的 teammate。Team 保留 roster 与任务状态，消息持久化遵循目标 Agent 的常规策略。挂载 `dsh-experimental-tool-agent-team` 可提供模型工具。本包为实验性功能，需要持久会话存储。

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

当一个 agent 需要共享工作目录中的具名助手、直接 peer 消息以及持久 roster 与任务状态时，加入本包。与 `@deepseek-ai/dsh-experimental-tool-agent-team` 一起挂载可提供模型工具。

### 何时选择

适用于在同一共享工作区协作并保留持久 roster 和任务状态。不支持独立工作目录、跨进程协调和自动释放任务 owner。需要持久会话存储。

### 最小工作配置

<a id="smallest-working-setup"></a>

对现有组合的最小增量是持久会话存储加两个 Team 包：

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

工具安装后，模型会按请求完成其余工作——例如先「创建一个名为 reviewer 的 teammate 检查 diff」，再「把变更摘要发给 reviewer」。所有限制都是可选的，并在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMembers` | `16` | 一支团队最多可创建的 teammate 数，包括失败的 |
| `maxTasks` | `256` | 任务板上最多的活动任务数 |
| `maxMessageBytes` | `65,536` | 单条发送消息的最大尺寸 |
| `disposalTimeoutMs` | `5,000` | 关闭清理允许的时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

### Teammate

请 Lead 创建 teammate：给它一个唯一的小写名字（例如 `reviewer`）并描述其职责。teammate 可以 fresh 启动（不携带 Lead 对话的任何记忆），也可以作为 fork 启动（继承 Lead 已完成的轮次）；创建请求决定用哪种。teammate 名字是永久的——即使创建失败的 teammate 也保留其名字，任何名字都不会被复用。

roster 显示每个成员的职责（`lead` 或 `teammate`）与当前状态：`running`、`inactive`（当前没有执行轮次，包括已加载和仅存储的成员）、`provisioning` 或 `failed`。未加载的成员会在唤醒后收到其消息。

只有 Lead 可以创建 teammate 或中断它们。

### teammate 之间的消息

任何成员都可向其他成员或 Lead 发送消息。每次尝试要么返回目标 inbox 的 `MessageId`，要么抛出错误。Team 不保留尚未接收的发送意图，不在重启后重试新消息，也不对显式重发去重。

Steer 让 running target 在最近的步骤边界接收消息，并启动或冷恢复 inactive target。成功表示 inbox 接收，不表示模型已处理或已完成单独的同步存储 flush。获准消息遵循普通 Agent 的持久化和 inbox 恢复策略。

### 共享任务板

任何成员都可以添加任务，包含标题、详情、对其他任务的可选依赖，以及可选的文件触及提示。只有其全部依赖完成后，任务才可 claim。

任务有 owner：成员 claim 任务开始工作，完成后标记完成、释放回板或重新打开；Lead 可以把任务分配给任意成员。每次变更都是 compare-and-set：基于过期副本的更新会被拒绝，因此两个成员不会悄悄覆盖彼此的成果。

当两个 in-progress 任务计划触及重叠路径时，文件提示会产生警告——它们绝不阻止任何操作。已删除任务保留在历史中，但从活动列表中消失。

### 等待与中断

成员可以等待下一次团队变化——teammate 的状态、新消息或任务更新——而不必反复轮询；等待只报告是否超时，调用方随后重新读取当前状态。

Lead 可以停止 teammate 的当前轮次，而不会删除其排队的消息；任务归属不变。

### 成功与失败的表现

成功会返回 teammate roster 行、获准 inbox 消息 id 或更新后的任务 revision。无效成员名称、未就绪任务、过期 revision、上限耗尽和消息准入失败均报告错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在一个分离与三项承诺之上：

- **持久日志，派生状态。** Lead 日志拥有 roster 与任务，各目标 Agent 拥有其接收的消息。
- **进程内归属。** Continuation 投递拥有目标锁、冷恢复和生命周期授权。
- **显式权限。** 每个服务方法都接收确切的实时调用方 `Agent`；只有 Lead 可以 spawn、reassign 或 interrupt。
- **超出上限时明确失败。** 每个限制都是经过校验的部署值，耗尽时报告类型化错误，而不是复用 id 或名字。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、任务与共享 checkout 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、服务注册、恢复调度 |
| [`src/roster.ts`](src/roster.ts) | Team 身份、成员关系解析、provisioning 与 roster 拆除 |
| [`src/task-board.ts`](src/task-board.ts) | 任务 CAS 命令、DAG 校验与派生视图 |
| [`src/journal.ts`](src/journal.ts) | 串行化的 Lead 日志事务与提交通知 |
| [`src/projection.ts`](src/projection.ts) | 解码并校验 Team 事件、发布 `agentTeam` 客户端视图的严格回放投影 |
| [`src/task-view.ts`](src/task-view.ts) | 任务板与客户端视图共用的纯任务派生：就绪状态、owner 名称与写入范围重叠 |
| [`src/activity.ts`](src/activity.ts) | 一次性变更等待者与 dispose（资源释放）时的等待解除 |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 共享准入截止与有界结算 |

### Team 身份与 roster

每个普通运行时 root 都是一个隐式 Team 的 Lead，其 `TeamId` 等于 `SessionId`；不存在创建事件，持久 Team 状态从第一条成员或任务记录开始。`spawnTeammate()` 先追加并 flush 一条 `provisioning` 成员记录，再要求配置的提供方创建预留 child；提供方失败会追加一条持久的 `failed` 成员。fresh child 不携带 Lead 历史；fork child 只捕获一次 Lead 的已完成 turn 前缀。恢复把未终结的 provisioning 记录对照 child 独立持久化的会话进行对账：直接 parent 与 continuable descriptor 匹配、且初始用户消息已记录则产生 `active`，其他任何情况都产生 `failed`。如果恢复在同进程竞争中先完成，creator 会接受终态，或报告 `TEAM_PROVISIONING_CONFLICT` 并 drain 该 child。名字由第一条 provisioning 记录保留，且永不复用。

### 直接消息与历史兼容

`sendMessage()` 检查确切调用方的成员身份，拒绝自发消息，并限制包含发送者前缀的完整 UTF-8 内容大小。它返回现有 inbox 身份，并仅在接收后发出 Team activity。目标保存带真实 `senderSessionId` 的 `agent-message` source；首个内容块为 `Team message from <name>:`。这些发送不写入新的 `team/message/queued` 或 `team/message/delivered` 记录。Team 不额外保证同目标发送顺序；投递顺序由目标 inbox 管理。客户端使用普通 Agent 消息标题和图标展示这些消息；正文保留发送者名称。

投递给 Lead 时直接调用 `Agent.steer()`。投递给 teammate 时使用 continuation owner 的 host-only Steer 路径；该路径会保留 Team 发送者 source，同时授权 Lead-to-child edge 并冷恢复 inactive target。sibling 消息绝不会通过公开的相邻 Agent 消息操作伪装成 Lead。

### 共享任务板

任务是完整版本化快照；每次变更都携带 `expectedRevision`，陈旧调用方会收到 `TEAM_TASK_STALE_REVISION`，而不会覆盖更新的值。数字 `task-<n>` id 的后缀必须是安全整数，id 空间耗尽时报告 `TEAM_TASK_LIMIT`，而不是复用最后一个 id。已删除任务作为 tombstone 保留以供回放与维持 id 稳定，但不占用 `maxTasks`，也不出现在 `listTasks()` 中。`writeScopes` 是规范化后的 workspace 相对前缀；视图会对与 in-progress 任务的重叠发出警告，但绝不阻止 claim 或授予写权限。

### 等待与中断

`waitForChange()` 等待注册之后发生的下一条 roster、task、消息接收或实时状态边，时长从 10 秒到 1 小时，并且只报告是否超时；运行时 dispose 会释放当前等待。取消会保留 Error reason；非 Error reason 则通过 `TEAM_WAIT_ABORTED` 报告。`interrupt()` 仅限 Lead，委托 continuable-subagent 的 interrupt 路径，以 `keepInbox` 只取消 live teammate 的当前 turn；它既不释放任务 owner，也不删除持久 mail。

### 持久性模型

roster 与任务变更将 `team/member` 和 `team/task` 追加到精确的 live Lead 会话，并在报告成功或唤醒等待者之前 flush。历史 `team/message/queued` 与 `team/message/delivered` 记录仍可读取；Team 不再写入这两种记录。这四种事件仅存在于日志：它们从不进入会话表面，因此派生模型历史不受协作记录影响。顺序与时间由会话事件的 `seq` 与 `time` 负责，快照不重复保存。

历史 mailbox 事件与 `team-message` source 仍可读取，投影仍报告 queued-minus-delivered 记录。Team 不会投递或确认这些记录：目标尚未记录的历史消息保持未投递。

Mailbox 投影与 checkpoint 准入保留本地声明的校验器之外获准内容中全部已解码 JSON 字段，包括自有 `__proto__` 键。本地字段检查覆盖 `text`、`reasoning`、`image` 和 `tool-call`；获准的未知标签保持不透明。Team 投影缓存版本 4 从 Session 日志重建较早缓存版本的 checkpoint；Session 格式版本保持不变。

### Dispose

运行时生命周期用同一个操作集合跟踪发送和完整创建事务。dispose 关闭准入，中止并等待这些操作，然后释放 roster 中的 live child 及其后代。非 Team child 不受影响。已获准操作共享一个 `disposalTimeoutMs` 等待期限；随后每个 Team 的 child drain 各有独立期限。此值不是整个服务关闭的总时限。清理失败会明确报告。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统类型逐步进入工具表面与设计背后的决策。

- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [tool-agent-team 包](../tool-agent-team/README.zh.md)——让模型创建 teammate、向其发送消息并进行协调的工具。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——身份、mailbox、任务与共享 checkout 决策。
- [实验包参考](../AGENTS.md)——位置、公开发布与依赖隔离。

-----

<a id="model-experience"></a>

### 浏览器投影

`agentTeam` Session 投影发布 Lead Session 的持久成员身份与阶段、成员错误、未删除任务视图，以及最后有效状态旁的 `failure`。其 `apply` 只替换被触及的集合；仅邮箱的变化保留客户端视图引用，不产生 frame。[子系统参考](../../../docs/subsystems/agent-team.zh.md#web-projection) 定义传输类型。

[Web UI](../client-ui-agent-team/README.zh.md) 读取共享 Session 投影，并从 Session 状态叠加活动信息。任务创建与更新由 Team agent 通过服务和模型工具完成。`./client` 导出可供浏览器使用的 roster、任务与投影类型。

## 模型体验

### Peer 消息

#### 模型看到什么

每条 peer 消息都是以发送者名称为前缀的用户角色消息，后接原始内容块。roster、task 和历史 mailbox 记录仍仅存在于日志。

#### Token 影响

每次 peer 投递都会把发送者前缀与消息内容加入 target 历史。任务与 roster 变更不增加模型 token；其面向模型的呈现属于 `@deepseek-ai/dsh-experimental-tool-agent-team` 结果。

#### KV Cache 影响

Peer 消息追加在 target 可复用历史前缀之后。冷恢复会先复用持久对话，再追加新消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明一支团队目前不能做什么、或哪些方面需要特别的运维关注。它们是当前包约束，不是与其他协作机制的对比。

- **完整视图广播** — 每次 roster 或任务变化都会把完整 roster 和未删除任务板（含描述）发给所有已连接浏览器，即使它正在查看其他 Session。
- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间约定仍可自由变更。
- **单进程、共享 checkout**——成员共享 cwd，修改立即可见；本包不提供 worktree、远端成员、merge 或文件锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **扁平且不可变的 roster**——只有 Lead 可以创建直接 teammate；不支持嵌套 Team、重命名、删除或名字复用。
- **不会自动释放 owner**——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner。
- **无发送重试保证**——Team 不保留新尝试，也不对其去重；不支持多个进程同时操作一个 Team。从未到达目标的历史排队消息不会被投递。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### Promotion

promotion 到产品角色组需要按[实验子树规则](../AGENTS.md)审查公共约定、限制、测试证据、发布载荷、运行时依赖与具名稳定 owner。

#### 未来方向

尚未决定的探索方向包括嵌套 Team、自动释放 owner 的策略、跨进程 mailbox 事务，以及通过 worktree 实现文件系统隔离；这些都没有承诺。

</details>
