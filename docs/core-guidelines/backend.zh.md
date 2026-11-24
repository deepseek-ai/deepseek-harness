# B：后端

[English](backend.md) | 中文

适用于 Host 端包的规则：agent（智能体）运行时、服务、工具和进程管理。

<a id="b1"></a>
## B.1：用生命周期事件驱动插件工作，而不是用轮询 Agent 状态的循环

### 原因

- 检查时间与使用时间之间的竞态。从 `whenIdle()` 落定或状态读取返回，到循环据此行动之间，输入可能启动一个轮次，Agent 也可能开始 dispose（资源释放）。每次修复都要再加一次复查和一个 `continue`。
- 状态重复。循环通过读取状态和比较序号来重建一次状态转换，而 agent loop（智能体循环）本身已经知道这次转换，并能恰好报告一次。
- 生命周期没有拥有者。脱离的循环在插件的 effect 之外运行，因此 dispose 不会停止它，它的失败也不会传给任何拥有者。
- 设计上的提示。需要这种循环的插件，通常缺少它所依赖的生命周期事件或 API。

### 反例

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'

declare function publishSummary(agent: Agent): Promise<void>

/** Publish a summary after each completed turn. */
export function watchSummaries(agent: Agent): void {
  void (async () => {
    let published = agent.session.seq
    while (true) {
      await agent.whenIdle()
      if (agent.session.seq !== published) {
        published = agent.session.seq
        await publishSummary(agent)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  })()
}
```

后续输入可能在 `whenIdle()` 与读取 `seq` 之间启动一个轮次，于是摘要覆盖的是一个尚未结束的轮次。在一个间隔内结束的多个轮次只产生一份摘要。dispose 之后，循环仍在持续轮询。`publishSummary` 失败时，循环以一个未处理的 rejection 结束。

### 示例

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

declare function publishSummary(session: Session, turn: number): void

/** Publish a summary after each completed turn. */
export function watchSummaries(agent: Agent): void {
  agent.ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      publishSummary(session, event.data.turn)
    }
  })
}
```

`turn/end` 事件指明它结束的轮次及原因。监听器是 Agent 上下文的一个 effect，因此它只接收该 Agent 的 Session，dispose 也会移除它。会话事件监听器的失败会被记录并隔离。`session/event` 监听器不能向正在发布该事件的 Session 追加事件，这样的追加会抛出异常。

### 替代方案

- 在轮次或消息边界执行的工作：在 `session/event` 上监听记录该边界的会话事件，例如 `turn/start` 或 `turn/end`。
- 在轮次结束时需要向 Session 追加事件的工作：监听 `agent/turn-stopping`，它在追加 `turn/end` 之前运行。
- 在模型请求之前执行的工作：注册 `agent/pre-step` 监听器。
- 在 Agent 变为空闲或开始运行时执行的工作：监听 `agent/status`。
- 清理单个 Agent 拥有的资源：用 `agent.ctx.effect()` 注册清理，Agent scope 展开时会执行其 disposer。注册在 `agent.ctx` 上的监听器在 `agent/disposed` 发出之前就已移除，因此只有寿命更长的上下文（例如插件上下文）才能观察到 `agent/disposed`。
- 必须在 Agent 空闲时运行并阻止新轮次开始的工作：在观察到空闲的监听器中同步调用 `runMaintenance()`，例如 `status` 为 `idle` 的 `agent/status`。其他工作已占用该 Agent 时，它会抛出异常。
- 没有事件报告所需的状态转换：在拥有该状态的包中添加对应的生命周期事件或 API，并更新其文档，而不是从外部观察该状态。

### 例外

- 不重复执行的单次 `await agent.whenIdle()`，例如在测试中。
- 实现 Agent 空闲状态本身的包，例如 `dsh-agent-loop` 中的 `whenIdle()`。

### 注解

轮询 Agent 状态的循环，是指 `while`、`for` 或自我重新调度的回调，其每次迭代都等待或读取 Agent 或 Session 的运行时状态，例如 `whenIdle()`、`status`、`session.seq` 或待处理的输入，并据此决定是行动、再次等待还是停止。

### 检查方式

审查：在包源码中，标记新增或修改的、每次迭代都 await `whenIdle()` 或读取 Agent 或 Session 运行时状态以决定是否行动的循环。
