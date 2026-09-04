# Agent Note: 持久化 seed 边界以确保 fork 子会话回放正确路由

Status: implemented

[English](2026-06-22-fork-child-replay-seed-boundary.md) | 中文

## 问题

[逐会话快照回放 Agent Note](2026-06-22-subagent-snapshot-replay.zh.md)使快照层能够表达嵌套 agent（智能体）形状：一个父项加上每个进程内 subagent 的一份记录日志，每份日志都按调用会话作为键，以独立脚本回放。它曾指出（§ 范围，最后一个项目符号），fork 快照「只是未来很容易添加的一项，并非键控缺口」。这一判断对 fork 子会话而言是错误的——问题不在键控，而在*脚本派生*。

subagent 脚本由 [`deriveReplayScript`](../../../../packages/test-support/llm-replay) 从已录制 Session log 推导：它把每个持久 `assistant/message` 或 `assistant/attempt` settlement 展开为每次 `stream()` 调用对应的一条 replay entry。对 **spawn** 子 Session 而言这是正确的，因为其 log 只包含自身模型调用。

**fork** 子 Session 不同。fork backend 用*父 log 的一段平衡已完成 turn 前缀*（[`dsh-subagent-in-process-driver`](../../../../packages/subagent/subagent-in-process-driver)）播种子 Session，该 seed 会成为子 Session 持久化的 `log`（`Session` 构造函数把 seed 复制进 `this.log`）。因此 fork 子 Session 的 `.jsonl` 以**父 Session** event 开头——包括其 Assistant settlement——之后才是子 Session 自己的 turn。

从 fork 子会话的完整日志推导脚本，会把**父会话**的已录制响应当作**子会话**的模型调用来回放：实际运行的 fork 子会话第一次调用 `stream()` 时，会收到父会话的第一段分片序列而非自身的。所有已录制场景都使用 spawn，所以这从未触发——但 fork 快照会静默地错误路由，恰好属于快照层存在的意义所要捕获的那类 bug。

## 决策

记录会话**继承**前缀的结束位置，将其持久化，并让回放 harness 仅从子会话**自身**的事件推导脚本。

### 1. 谱系 metadata 与正文拥有的精确 cut

`SessionHeader.isSeeded` 记录 Session 是否具有继承谱系，而不向仅 header 的 reader 暴露正文坐标。精确的前导事件数量是单独品牌化为 `SessionLogOffset` 的 `inheritedEventCount`；fork 同时提供 `isSeeded: true` 与复制前缀的长度，全新的 spawn 则提供 unseeded header 与零 cut。该 cut 经 `CreateSessionOptions`、`CreateAgentOptions`、持久化 inspection 与恢复后的 Session 状态传递。

`inheritedEventCount` 是**显式**的，绝不从 `seed.length` 推断。恢复／加载时用会话的完整已存储日志作为 seed，此时 `seed.length` 是全长而非原始边界——恢复路径改为在 logical header 之外传递解码后的 cut。

### 2. JSONL 完整往返

v2 JSONL header 携带 `isSeeded`，而 `session/end-seed { inherited: true }` 会在正文中标记精确 cut；解码使用最后一个 tagged marker。冻结的 v0 header 为保持字节兼容而继续携带可选数值 `seedLength`，其 codec 会把该历史字段转换为相同的逻辑值对。

### 3. 回放从边界之后推导子会话脚本

`dsh-llm-replay` 通过静态格式 catalog 解析选定 generation，并保留解码后的 `inheritedEventCount`。`loadSessionScripts` 从 `fixture.events.slice(inheritedEventCount)` 推导子 Session entry——即 boundary 及之后的 event，也就是子 Session 自己的模型调用。对 spawn 子 Session 而言 cut 为 0，因此此操作为空操作。

这弥补了路由正确性的缺口，两个已录制的 fork 场景对其进行端到端验证——见[记录 fork 与混合 spawn+fork 快照场景](../../archived/testing/2026-06-22-fork-snapshot-scenarios.md)。

## 曾考虑的替代方案

- **在 `llm-replay` 中启发式推导边界**（播种前缀是连续的父事件，止于子会话第一条 `user/message` 之前的最后一个 `turn/end`）。否决：在测试 harness 中用脆弱的启发式重新推导一个生产者已经知道的事实。在源头（fork 后端）持久化边界，是「在包边界处显式优于隐式」这条规则跨越持久化边界的应用——子会话 fixture（测试前置数据）的读取者永远不需要重建继承在哪里结束。

## 后果

- 谱系 bit 横跨 logical Session metadata，精确 cut 则只横跨含正文的 core、持久化、query 与 replay 值；v0 物理 header 保持不变。
- spawn 回放不变（cut 为 0）。fork 回放将子会话路由到自身的脚本；由 `llm-replay` 测试中的一个回归用例覆盖（一个子会话 fixture，其播种前缀包含父会话的分片——推导出的子会话脚本必须排除它，不做 slice 时该用例会失败），以及通过共享 coordinator 约定执行的 JSONL 持久化往返测试。
