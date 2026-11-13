---
kind: upgrade-guide
description: "PTC 输出超限使用 CODE_OUTPUT_LIMIT，不再使用 CODE_RUN_FAILED。"
---

# PTC 输出超限错误码

[English](guide.md) | 中文

## 变更

`run_code` 和通过 `createRunCodeTool` 创建的程序工具将运行时 `output-limit` 失败报告为 `CodeRunFailedError` / `CODE_OUTPUT_LIMIT`，不再使用 `CODE_RUN_FAILED`。它们仍是失败的工具结果。其他失败错误码和历史 Session 记录不变。

显式 inspect 的输出或日志可能在执行过程中超限，因此该错误不确认程序已经完成。此前动作不会回滚；已保留的输出和已结束的子调用记录仍可用。诊断提示调用方先观察当前状态，再减少输出，避免重复已完成的动作。

## 迁移

1. 更新匹配 `tool/result.error.code` 的消费者，识别 `CODE_OUTPUT_LIMIT`。不要据此认定此前动作失败或可安全重复。
2. 重试前先观察当前应用状态。减少传给 `inspect(...)` 的内容或日志文本量，不要重放已完成的动作。要展示 CUA 截图，使用 `inspect(await window.getScreenshot())`。
3. 验证先派发动作再超过输出预算的程序报告 `CODE_OUTPUT_LIMIT`，保留已结束的子调用记录，且动作只生效一次。验证诊断不宣称程序完成。
