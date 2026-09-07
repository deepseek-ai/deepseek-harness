# Agent Note: Web 单轮次精确 token 用量

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-web-per-turn-token-usage.md) | 中文

## Problem

Web Chat 在编辑框附近显示会话累计 token 用量，但该值无法解释一个已完成轮次的消耗。分页历史窗口可能从轮次中间开始，重试可能消耗多次模型调用，流式事件与最终事件可能重复携带同一次 attempt 的用量，而可选 cache 字段也不能证明精确总量。将局部小计显示成轮次用量，会让已记录的提供方事实显得比实际更完整。

## Decision

共享 `TokenUsage` 值为一次模型调用携带可选的 `totalTokens`。适配器只从提供方精确总量，或权威的提示词与输出聚合计数发布该字段。DeepSeek 会将提示词加输出的聚合值与协议提供的总量核对，pi-ai 则保留其提供的总量。

token-meter 拥有一份可安全用于浏览器的纯轮次局部 fold，并与其具备重试感知能力的累计用量投影共享记账所有权。`step/start` 与 `llm/retry-started` 打开真实 attempt；最终 assistant 消息替换同一 attempt 的流式样本；终止失败、重试与步骤边界关闭 attempt，且不会重复计数。每个已开始的 attempt 都必须以安全的非负整数用量和精确总量关闭。只有每个参与聚合的 attempt 都报告时，才会显示可选的 cache、推理与路由聚合值；推理仍是输出的子集。

Web Chat 只选择已加载匹配窗口包含 `turn/start` 的 Turn，将该完整的持久事件窗口交给 token-meter fold，再渲染结果。完整且精确的结果通过现有 actions 上方、仅保留本地状态的 `DisclosureRow` 显示；证据不完整或矛盾时不显示该行。Chat 不拥有 token 记账状态机。

## Alternatives considered

**对相邻的会话累计值做减法。** 不采用，因为分页、压缩、重试覆盖范围与投影完整性可能让相邻值无法比较；减法会推断任何调用都未报告的数据。

**通过新的客户端会话投影发布历史单轮次值。** 不采用，因为已加载的单轮次视图已经拥有所需的持久 attempt 事件，而随历史增长的投影会增加传输、持久化与版本成本。复用 token-meter 的纯 fold，可以在不新增 wire 值的前提下保持唯一记账所有方。

**缺少精确总量时仍显示已知 bucket。** 不采用，因为在已完成轮次 footer 中展示的下界小计与完整账单无法区分。

## Consequences

新的提供方记录无需新增传输接口或持久化 UI 状态，即可显示精确的单轮次记账。证据不足的旧会话与适配器只会省略 disclosure。任一计费 attempt 缺少归属时，模型路由会整体消失，可信 token 总量仍可显示。

定向的适配器、token-meter fold／投影、组件、分页与组装 Web 回放测试固定了总量保留、重试 attempt 分离、fail-closed 校验、可选字段省略、交互与完整窗口发布。累计投影与精确 Turn fold 现在同归 token-meter 所有；投影仍是完整日志的 bucket 视图，只有 fold 会作出 disclosure 所需的更严格精确性与完整性声明。
