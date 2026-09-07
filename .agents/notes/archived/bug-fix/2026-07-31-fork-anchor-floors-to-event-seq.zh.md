# Agent Note: fork 锚点向下取整到事件 seq

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-fork-anchor-floors-to-event-seq.md) | 中文

## 问题

在已停止的助手消息上点 fork 毫无反应——没有子会话，没有报错，也没有任何可见变化。

这条消息背后的冻结节点并不是日志事件。实时投影和历史回放都用 `turnEnd.seq - 0.9` 这个排序坐标来生成它，让它严格落在被中断轮次的所有事件之后、下一轮之前，而 chat 视图原样把这个节点 seq 交给 fork 入口。`session.fork` 在 wire 上只接受非负整数，因此分数锚点在抵达 host 之前就被判为 invalid-params，而 chat 入口的 fork 调用又吞掉了失败。于是被拒绝和按钮失灵在表现上毫无区别。

host 的切分规则从来不是障碍。被中止的轮次会记录一条 reason 为 `aborted` 的 `turn/end`，它和其他轮次一样是可切分的完整前缀——只是锚点根本没送到。

## 决策

`SessionRuntime.fork` 在发起 RPC 前对 `atSeq` 向下取整。分数 seq 这个约定属于 `dsh-client-runtime`，实时投影和回放投影都由它生成，因此也由同一个包在跨出 wire 边界时把它换回真实事件 seq，而不是要求每个 UI 调用方各自记得转换。整数锚点不受影响。

向下取整落在锚点自身所在的轮次内，不会回退：每一轮都以 `turn/start` 开头，所以 `turnEnd.seq - 1` 不可能是上一轮的 `turn/end`。host 随后按「首个位于锚点或其之后的 `turn/end`」收口，命中的正是读者点击的那一轮，与消息级 fork 按钮在已完成轮次上一贯承诺的整轮语义一致。

apiproxy 的 fork 用例固定了 host 这一侧的约定：落在被中止轮次内的取整锚点会切穿该轮，并把它种进子会话。

## 备选方案

**让 wire 接受分数 `atSeq`。** 否决：host 约定要的是事件 seq，而不是连续坐标上的某个位置；分数形式只是某一个客户端的渲染约定，一旦放行，`atSeq` 会成为所有携带 seq 的载荷中唯一容忍非整数的字段。

**在已中断的消息上隐藏 fork 按钮。** 否决：从读者主动叫停的那一轮分叉，恰恰是最需要 fork 的场景之一，而 host 侧这个能力一直是好的。

**在 chat 入口的 `forkAt` 适配器里取整。** 否决：`ui-conversation` 只是分数约定的消费方，并不拥有它；将来任何第二个 fork 入口都得把同样的转换重新发现一遍。

## 影响

从已停止的轮次 fork 会得到一个种子切到该轮 `turn/end` 的子会话。被冻结的残缺文本是从 chunk 事件重建出来的，从未成为 `assistant/message`，因此它不会进入子会话的模型上下文——正如源会话恢复时它也不会进入一样，子会话拿到的上下文与源会话一致。

fork 失败在 chat 入口仍然是静默的。这个 bug 能存活至今，正是因为该调用点丢弃了自己的 rejection；把 fork 错误呈现到 UI 上是另一件事。
