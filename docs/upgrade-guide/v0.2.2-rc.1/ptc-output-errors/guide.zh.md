---
kind: upgrade-guide
description: "PTC 输出失败使用独立的结构化错误码，不再统一使用 CODE_RUN_FAILED。"
---

# PTC 输出失败错误码

[English](guide.md) | 中文

## 变更

`run_code` 对无效完成值返回 `CodeRunFailedError` / `CODE_OUTPUT_INVALID`，对输出预算超限返回 `CodeRunFailedError` / `CODE_OUTPUT_LIMIT`。此前两者均使用 `CODE_RUN_FAILED`。它们仍是失败的工具结果。其他执行失败保留 `CODE_RUN_FAILED`；调用方取消保留 `AbortError` / `ABORTED`。历史 Session 记录不变。

完成值无效表示程序已到达结束点，但无法返回无损 JSON。输出超限可能中断执行，不能确认程序已完成。两者都不会回滚此前动作；已结束的子调用记录和已捕获日志仍可用。

## 迁移

1. 更新匹配 `tool/result.error.code` 的消费者，识别这两个输出错误码。不要据此认定此前动作失败或可安全重复。
2. 重试前先观察当前应用状态。修正完成值或减少输出时，不要重放已完成的动作。对于已经输出图片的 CUA 截图，使用 `void await window.getScreenshot()`，不要返回字节数组。
3. 验证先派发动作再返回非 JSON 值的程序报告 `CODE_OUTPUT_INVALID`，保留子调用证据，且动作只生效一次。验证超限报告 `CODE_OUTPUT_LIMIT`，不宣称程序完成。
