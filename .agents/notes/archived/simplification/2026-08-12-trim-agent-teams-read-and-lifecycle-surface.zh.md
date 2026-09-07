# Agent Note: Trim the Agent Teams read and lifecycle surface

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-trim-agent-teams-read-and-lifecycle-surface.md) | 中文

## Problem

Agent Teams 合理地拥有持久 roster、peer mailbox 与共享任务策略，subagent continuation manager 则拥有 continuable child Activation。但第一版仍在这两类角色之间重复了数据和生命周期机制。

读取表面发布了 `TeamSnapshot`，其中包含没有生产调用方读取的 pending mail。Web `team.get` 为 Team identity 与全局 revision 调用该 snapshot，丢弃其中的集合，再调用 `listMembers()` 和 `listTasks()`；浏览器既不用已经寻址过的 Team id，也不用全局 revision。公开 member 与 task view 还重复内部字段：member `error` 与 `diagnostics` 重复，task `ownerId` 与模型／UI 使用的 owner name 重复，task 时间戳没有读取方。`SpawnTeammateResult.initialMessageId`、`TeamDeliverySource` 和公开的 resolved config type 同样没有消费者。

持久 member、task、message 与 acknowledgement payload 复制了 Session event envelope 已拥有的时间戳。message `targetName` 重复不可变 roster lookup。fold 只拿这些值与其旧副本互相校验，因此额外字段增加格式与校验代码，却不决定行为。

`waitForChange()` 返回长度为零或一的 `changes` 数组，携带领域 kind 与 Lead-log revision，但所有调用方都会立即重新列出权威状态。配套 `team/changed` event 没有生产 listener。Team interrupt 绕过 subagent 授权与取消语义，直接调用 `Agent.cancel()`。Team teardown 又自行组合 cancel、descendant drain、`whenIdle()` 与 Agent registry 轮询，尽管只有 continuation manager 拥有 Activation release。

## Decision

Team 服务保留独立的产品职责：持久具名 roster、Lead-log mailbox 与 task DAG。它不会与通用 subagent catalog 或 task service 合并。

在 `@deepseek-ai/dsh-experimental-agent-team` 内，`TeamService` 是面向 Cordis 的 façade 与 disposal 协调者。`TeamJournal` 负责每个 Lead 的 transaction 顺序以及 append-plus-flush 发布；`TeamRoster` 负责 membership 与 provisioning；`TeamMailbox` 负责 target-local dispatch、acknowledgement 与 retry 状态；`TeamTaskBoard` 负责 task 授权、DAG transition 与派生 view；`TeamActivity` 负责当前 waiter；`TeamRuntimeLifecycle` 负责唯一的准入截止与有界 settlement。这些包内 collaborator 共享现有 service capability，不发布额外 Cordis service。

删除未使用的 snapshot API 与全局 Team revision。Host 读取只返回 roster 与 task view，不重复已经寻址的 Team id。member failure 只在 `diagnostics` 出现一次。task view 暴露 `ownerName`，把 `ownerId` 留在持久服务实现内部。spawn 只返回 member view，已校验 config 改为私有。

持久 Team value 只保留回放 Team 行为所需字段。Session event 的 `seq` 与 `time` 负责顺序和时间；roster membership 负责不可变名字。member／task／message 时间戳、message `targetName` 与 acknowledgement `deliveredAt` 均删除。task CAS 保留 task-local `revision`，因为它是行为字段，而非观测元数据。

`waitForChange()` 现在返回 `{ timedOut }`。已提交 Team append 或 live member-status edge 会在所属 flush 后唤醒当前 waiter，调用方随后重新列出状态。未使用的 `team/changed` event、change kind、change revision 与 disposal sentinel 一并删除。

Team `interrupt()` 先解析持久 roster name，再以确切 ancestor authority 委托 `SubagentService.interrupt()`。Team teardown 选择 roster 中确切的 live direct-child id，并调用新的 continuation 操作 `drainContinuableChildren(parent, childIds)`。该操作验证确切直接所有权，同步开启所选 Activation 的 disposal，递归以 child-first 释放后代，不影响 sibling 与 parent-wide admission，缺席目标视为 no-op。完整 teardown 会清空 pending inbox；只有 interrupt 承诺 `keepInbox`。

创建与 dispatch 继续使用分离的 in-flight set，因为 dispose 必须先等待创建，再等待创建 recovery 可能注册的 dispatch。mailbox 的持久 enqueue／acknowledgement、target-side 去重、FIFO dispatch 修复、provisioning 对账与 Host fold fallback 保持不变。

## Alternatives considered

**把 Team messaging 合并进 subagent follow-up。** 否决。subagent follow-up 按 Session id 寻址 child 并负责 Activation 投递；Team messaging 额外提供不可变名字、peer 授权、先持久 enqueue 再投递、quiet inactive 行为、acknowledgement、retry 与 sender framing。

**用通用 task service 替换 Team task。** 否决。Team board 是带 CAS revision、member owner、dependency、tombstone 与 advisory write scope 的 Lead-log DAG。这些是产品语义，不是重复存储 plumbing。

**为未来消费者保留公开字段。** 在首次 tag 发布前否决。每个删除字段都没有生产读取方；若未来有具体产品需要 pending mail 或时间，可从权威日志投影。

**在 Team teardown 中订阅 `agent/disposed`。** 否决。teardown 运行时 Team fiber 已在解绑，新 event registration 无效。更重要的是，observer 仍会重复 continuation manager 的所有权，而不是要求 owner 释放确切 child。

**对 Lead 使用 `drainContinuableDescendants()`。** 否决，因为它会停止非 Team continuable child，并关闭整个 Lead 谱系的准入。对每个 teammate drain descendants 又只会停止孙级，把 teammate Activation 本身留给 Team 轮询。exact-child 操作直接表达所需集合。

**在完整 teardown 时保留 teammate inbox。** 在真实 handle lifecycle 测试后否决。`AgentHandle.dispose()` 是完整 release，会清空未 claim 的 inbox 工作。把它描述成可恢复 parking 是错误的；interrupt 仍是保留 pending input 的非 disposing 操作。

**把全部 runtime 职责保留在一个 `TeamService` class 中。** 否决，因为该 class 会同时拥有互不相关的 task policy、roster provisioning、mailbox delivery queue、waiter 与 shutdown settlement。包内 state owner 在保留单一公开 service 的同时，让每组异步状态与 lifecycle controller 归属于负责结算它们的 operation family。

## Testing

Subagent 测试覆盖 exact-child selection、重复 id、sibling 隔离、递归 descendant release、错误 parent 授权与 manager 缺席时的 no-op。Team 测试覆盖委托 interrupt、有界 exact-child teardown、provisioning cleanup、mailbox recovery、wait 的 wake／timeout／dispose，以及缩减后的 view 与持久记录；白盒 failure injection 直接访问包内 roster、mailbox 与 journal owner，不扩宽 `TeamService`。Host、tool 和 client 测试覆盖缩减后的 wire 与模型可见结果。typecheck 覆盖 Host 与浏览器表面的公开删除。

## Consequences

Team 与 subagent 仍是独立 capability seam，但只有一个生命周期 owner。Team 选择哪些 roster child 属于其运行时；subagent 执行 interrupt 与 Activation teardown。Team 表面更小，持久记录不再镜像 Session envelope，wait 消费方也不会把提示性的 change kind 或 revision 误当作一致 snapshot。包内 state ownership 让 `TeamService` 专注于公开 operation、Cordis event wiring、recovery 顺序与 disposal 顺序；该拆分增加内部 module，但不改变公开 API 或持久格式。

Web `team.get` 仍为 member 与 task 各折叠一次。消费方不要求一致的组合 snapshot，而增加增量 cache 会引入独立一致性机制，不是对该 seam 的简化。
