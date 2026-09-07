# Agent Note: Agent 作用域事件 dispatch 单个 payload 对象

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-agent-event-payload-objects.md) | 中文

## 问题

Agent 作用域事件历来采用位置参数：开头的 `agent` 主体、事件专属字段，以及末尾用于 waterfall（瀑布式事件）/serial 事件的 `next`。新增字段或退役上下文类型（如 `PreStepContext` 与 `RequestFailureContext`）都会迫使跨包重写每个监听器和 emitter，约定也一直分散在参数列表中，而不是集中在一个具名 payload 中。

## 决策

每个 agent 作用域事件都将恰好一个 payload 对象作为其第一个参数。payload 始终携带主体（`agent`）、事件的字段，以及事件有取消信号时的取消 `signal`；`next` 仍然是 waterfall/serial 事件的最后一个参数。受影响的事件是十二个 `agent/*` 事件、`agent-loop/config-start-failed`（唯一没有主体的事件）以及 `goal/changed`。

`PreStepContext` 与 `RequestFailureContext` 已退役；它们的字段直接存在于 `agent/pre-step` 与 `agent/request-error` 的 payload 中。

dispatch 是融合的：`agentEvents(ctx, agent)`（以及一次性 `emitAgentEvent`）注入主体，使作用域载体键与 payload 的 `agent` 不可能分叉；即使某个结构上可接受的 payload 恰好携带 `agent` 字段，注入的主体仍然优先。`ReactLoopAgent` 在构造函数中构建一次 dispatcher，并将每个 emit、serial 和 waterfall 都经由它路由，因此热路径上的 dispatch 不产生任何分配。

## 考虑过的替代方案

**保留位置签名。** 新增字段或退役上下文类型依旧会重写每个监听器和 emitter，约定也会继续分散在参数列表中，而不是集中在一个具名 payload 中。

**在每个 dispatch 位置手工构造主体。** loop 的中间设计调用 `ctx.waterfall(this.carrier, …)`，传入手工构造的 `{ agent: this, … }` payload；它避免了每次 dispatch 的分配，却重复了主体注入，并让作用域键与 payload 主体分叉。融合的 dispatcher 是每种 dispatch 模式的唯一注入点。

## 后果

监听器签名一次性命名完整 payload，因此扩展 payload 或退役上下文类型，对所有监听器和 emitter 都是一次形状变更。主体/作用域耦合由 dispatcher 在每种 dispatch 模式下强制执行，且 loop 的热路径保持零分配。
