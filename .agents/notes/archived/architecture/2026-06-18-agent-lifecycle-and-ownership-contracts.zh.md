# Agent Note: Agent 生命周期与所有权约定

Status: implemented
Archived: 2026-09-04

[English](2026-06-18-agent-lifecycle-and-ownership-contracts.md) | 中文

## 问题

ACP（Agent Client Protocol）与 tool-bash 的若干限制是同一个所有权约定缺失的症状：插件可以通过 `ctx.agents` 创建或恢复 agent（智能体），但无法独立拥有和 dispose（资源释放）单个 agent，而长时间运行的 bash 任务在执行器中也没有稳定的所有者。ACP 在断连时中止并等待 agent，却无法仅注销该会话的 agent；`session/cancel` 无法取消已入队但尚未开始的工作；`tool-bash` 将任务所有权保存在插件本地的 `Map` 中，因此一次 HMR（热模块替换）重载就可能让旧任务看起来无主。

## 决策

三项约定变更：队列感知的取消、`AgentHandle` 释放器，以及 bash 所有者令牌。

### 1. 队列感知的 `Agent.cancel(cause?)`

`Agent` 接口新增 `cancel()` 动词——唯一的公开停止原语。（它最初与范围更窄、仅作用于步骤的 `abort()` 一同交付；后者后来因无人使用而移除，使 `cancel()` 成为唯一公开的停止工作方式。）它清空 inbox 的 queued + steering FIFO，在存在活跃轮次时中止它，并保留一个不带 cause 的 pre-run 标记，使在被领取前被取消的提示词永不运行，而后来的提示词仍保持独立。有效调用会在清空或中止前发出 `agent/cancel-requested`，携带类型化的 `user | parent` cause；空闲取消不发出任何事件，也不会使下一条提示词搁浅。`whenIdle()` 会在取消后达到完全停稳，ACP 的 `session/cancel` 映射到 `user`。[显式轮次取消决策](2026-07-16-explicit-turn-cancellation.zh.md)规定了当前的 cause、signal 生命周期与协作式结算约定。

### 2. `AgentHandle` 异步释放器

`ctx.agents.create`/`resume`（以及 `AgentFactory` 接口）返回 `AgentHandle = { agent: Agent; dispose(): Promise<void> }`。释放器是一种**消费方能力**——仅持有裸 `Agent` 的注册表观察者无法将其拆除。调用方 fiber 和已注册的 factory 提供方是结构上的共同所有者：调用方卸载强制结构化所有权，而提供方卸载必须停止旧实例，因为其实例作用域的依赖 surface 通过该提供方解析。三条路径都会进入同一个记忆化的拆除过程：停止循环、等待其退出与空闲刷写完成（完全停稳，而非仅把状态翻转为 `disposed`）、分离 agent、分离其会话，然后解除其 scope。每个公开 ID 在其精确注册表条目分离时变得可复用；不存在独立的保留释放阶段。由配置创建的 agent 已归 `AgentLoop` fiber 所有（handle 被丢弃）。ACP 在其 `SessionRecord` 中保存每个全新会话的释放器，并在断连或插件拆除时运行它，因此单纯的客户端断连不会留下已注册 agent 或会话存储条目。在与关闭的竞态中落败的创建流程会 dispose 其尚未发布的 handle。

**拆除顺序对持久性至关重要**，实现将会话生命周期折叠进 agent 的单个复合 Cordis effect（`SessionStore.prepare`/`enter`/`announce`，取代兄弟 effect 拆分）。fiber 卸载会并发释放兄弟 effect（`Promise.all`），这会让会话存储的 append 发布钩子移除与循环关闭时的 `session/flush` 竞争，从而丢失关闭的 `turn/end`；在一个 effect 内，释放器作为有序的 LIFO 链运行（停止循环 + `await agent.done` 在会话分离之前），因此无论 handle 的 `dispose()` 还是 fiber 卸载，都会捕获循环的最终刷写。被隔离的 `agent/disposed` 和 `session/disposed` 通知无法拒绝该链或跳过后续拆除。

### 3. Service Definition 中的 Bash 所有者令牌

后台任务所有权从 `tool-bash` 插件本地的 `Map<string, Agent>` 移入执行器。`ShellExecRequest` 新增可选的 `owner?: string`；解析后的 `ShellExecSpec` 将其作为必需但可空的 `owner: string | undefined` 携带（被遗忘的 owner 是可见的 `undefined`，而非静默缺失的属性）。执行器把 token 存在任务上，并通过新的 `ShellExecutor.ownerOf(id): string | undefined` 方法暴露它（不放在公开的 `BashTask` 上——只有一条读取路径，没有冗余 API）。`tool-bash` 完全删除其 `Map`：它在 `start` 时将 `exec.agent?.id`（共享的注册表/会话 id）盖章为 owner，`bash_output`/`bash_kill` 则以 `!== undefined` 语义把 `ctx.shell.ownerOf(id)` 与调用方 token 比较（空字符串 token 仍是真实 owner）。完成通知通过扫描 `ctx.get('agents')?.list()` 查找 `agent.id === ownerToken` 的存活 agent（经 `ctx.get` 读取——`onJobDone` 运行在 bash fiber 这一外部 fiber 上，直接使用 `ctx.agents` proxy 会抛异常）。由于所有权现在保存在执行器的任务上（随 `dsh-shell` fiber dispose），它能跨越 `tool-bash` HMR 重载，关闭旧的 `XXX(tool-bash-owner-hmr)` 缺口。（`onJobDone` 监听器仍受 `tool-bash` 的 `apply` effect 约束，因此落在重载间隙的完成仍会丢失一条通知——既有的重载间隙丢失——但所有权隔离本身已经不受 HMR 影响。）

## 验证

以下不变式已经成立，并由测试固定：

- ACP 断连或插件拆除后，任何由桥接层拥有的会话都不留下已注册 agent 或会话存储条目，包括与连接关闭竞争的创建流程。
- 已入队的提示词启动前执行 `session/cancel`，能阻止该提示词运行；后来接受的提示词仍是独立的已入队轮次。
- `tool-bash` HMR 重载不会使另一个会话能够读取或终止已有的后台任务（所有权保留在执行器上）。
- 既有的非 ACP 演示无需显式管理 handle 仍能工作；由配置创建的 agent 仍归 `AgentLoop` 插件 fiber 所有。

## 会话所有者令牌在存活 agent 中唯一

bash 所有者 token 比较依赖共享的 `Agent.id`/`SessionId` 在存活 agent 中唯一。并发的同 ID 操作可以都私下准备，但发布时会依次登记会话和 agent；`SessionStore.enter()` 拒绝重复的存活会话 id，每个失败事务都回滚自己的私有状态。因此程序化调用方无法发布两个共享同一会话 token 的存活 agent。访问*策略*（token 比较）留在 Consumer `tool-bash`；bash 能力只存储不透明的 `owner` 字符串且从不解释它——这是正确的 Service Definition / Service Provider / Consumer 拆分。

## 曾考虑的替代方案

- **公开的 `BashTask.owner` 字段**而非 `ShellExecutor.ownerOf(id)` Service Definition 方法：否决。一条读取路径即可，无需冗余 API。
- **为 agent 的会话生命周期使用兄弟 Cordis effect**：否决。fiber 卸载时并发释放兄弟 effect（`Promise.all`），store 拥有的 append 发布钩子的移除与循环的关闭 `session/flush` 产生竞争；单一复合 effect 的有序 LIFO 链才能在两条释放路径上都捕获关闭的 `turn/end`。
- **在 `cancel()` 之外另设一个仅中止步骤的 `abort()`**：最初发布过，后因无人使用而移除；`cancel()` 是唯一的公开停止原语（见[公开停止接口 Agent Note](../simplification/2026-06-20-public-agent-stop-api.zh.md)）。

## 后果

本变更有意触及公开接口（`Agent`、`AgentFactory`、bash seam），而非作为 ACP 的局部补丁。同步 agent 交付仍然简单；异步生命周期路径是增量添加的，供需要它的所有者使用。
