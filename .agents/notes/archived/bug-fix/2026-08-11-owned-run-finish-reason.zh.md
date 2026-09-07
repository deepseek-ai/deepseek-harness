# Agent Note: 自有运行的结束原因报告

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-owned-run-finish-reason.md) | 中文

## 问题

Python SDK 消费方需要简洁地判断自有活动区间如何进入 idle。要求每个消费方扫描原始 `turn/end` 事件会重复协议知识，而通用的成功状态会丢失 token 上限与模型错误之间的区别。

## 决策

`RunResult.finish_reason` 是从已提交消息进入持久 inbox 的回执开始、到整个 agent 下一次进入 idle 为止所收集的根会话最后一个 `turn/end` 的字符串 `kind`。如果该区间没有 `turn/end`，字段为 `None`。缺少字符串 `data.reason.kind` 的 `turn/end` 会抛出 `SdkProtocolError`，而不会报告为区间内没有轮次结束。该字段描述自有运行区间；它不会把这个结束原因归属于已提交的提示词。[自有运行边界决策](../architecture/2026-07-30-followup-enqueue-and-owned-runs.zh.md)仍禁止提示词级结果归因。

该字段只公开 kind，因为调用方需要稳定的分类，完整的结构化原因仍可从 `RunResult.events` 取得。传输丢失、超时和协议故障仍会抛出异常，而不会生成结束原因。

## 考虑过的替代方案

**恢复 `status`。** 由部署映射的 `ok` 或 `error` 状态会混淆不同的持久结束情况，而且看起来像传输成功状态，因此无法回答区间为何结束。

**公开模型 `FinishReason`。** 一次运行可能包含多个模型步骤，中间的 `tool-calls` 结束并不代表运行结束。agent 最后一个 `turn/end` 才是相关的运行级观测。

**将字段命名为 `stop_reason`。** ACP 和 subagent seam 会把轮次结束原因映射到各自的 `stopReason` 取值集合。Python 字段保留原始的 agent 原因 kind，因此沿用它们的名称会让人误以为该接口也执行了这种映射。

**公开完整的结构化轮次原因。** 原始事件流已经保留错误与取消的详细信息。在 `RunResult` 上复制这个对象会产生两种需要 Python 调用方协调的表示。

## 验证

Python SDK 测试覆盖选择最后一个轮次结束、区间内没有轮次结束，以及拒绝畸形轮次结束原因。SDK README 记录字段取值、`None` 情况、失败行为和运行级范围。

## 后果

调用方无需解析事件列表，即可按 `completed`、`max-tokens`、`error` 和未来的原因 kind 分支。该字段可能描述区间内加入的 steering、注入上下文或排队工作，因此不能将其表述为初始提示词的因果结果。仓库内的 TypeScript SDK 只通过类型化事件提供结束原因观测；其调用方可以直接从 `SessionEvent[]` 读取该观测。
