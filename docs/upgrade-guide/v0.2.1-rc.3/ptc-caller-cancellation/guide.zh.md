---
kind: upgrade-guide
description: "调用方取消的 run_code 结果使用 ABORTED，取代 CODE_RUN_FAILED。"
---

# PTC 调用方取消使用标准工具错误码

[English](guide.md) | 中文

## 变更

运行中的 `run_code` 被调用方取消且运行时报告 `abort` 时，其 `tool/result` 错误从 `CodeRunFailedError` / `CODE_RUN_FAILED` 变为 `AbortError` / `ABORTED`。结果内容为 `Error: tool call aborted`，取代运行时诊断、捕获输出和沙箱摘要。按这些结果分类的 SDK 客户端和 Session 消费方受到影响。

Agent 继续在 `turn/end` 中记录具体取消原因，包括 hook 的 `reason`。超时、清理失败等运行时失败，以及没有调用方取消的运行时内部取消，保留 `CODE_RUN_FAILED`。取消仍等待清理完成；它不会回滚已完成的工具操作，保留的运行时变量可能被清空。

## 迁移

1. 在新 `tool/result` 事件的消费方中，通过 `data.error.code === 'ABORTED'` 识别调用方取消。当对应 `turn/end` 事件的 `data.reason.kind === 'aborted'` 时，从 `data.reason.reason` 读取 Agent 取消原因。
2. 读取历史 PTC 取消结果时，继续支持 `CODE_RUN_FAILED`。已有 Session 日志不会被重写。
3. 取消运行中的 `run_code`，确认其结果错误码为 `ABORTED`，随后的 `turn/end` 事件包含原始 Agent 取消原因。确认普通运行时失败仍报告 `CODE_RUN_FAILED`。
