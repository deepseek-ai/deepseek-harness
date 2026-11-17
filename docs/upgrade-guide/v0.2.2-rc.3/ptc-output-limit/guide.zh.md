---
kind: upgrade-guide
description: "PTC 展示输出超限后截断输出，程序继续执行。"
---

# PTC 输出截断

[English](guide.md) | 中文

## 变更

Node PTC 运行时在耗尽 `maxOutputBytes` 后丢弃后续展示输出，执行仍遵循原有超时和取消规则。截断本身不再终止进程或清空保留变量，环境初始化也适用。

`PtcRunResult.outputTruncated` 标记捕获输出或诊断被截断，与 `error` 独立。后续异常、超时或取消保留实际失败类型。要求返回的 JSON 完成值优先于捕获输出，并保持无损；无法容纳的完成值仍以 `output-limit` 失败。

`run_code` 和通过 `createRunCodeTool` 创建的工具在程序正常结束时返回成功，携带 `outputTruncated: true` 和可见的截断提示。失败执行保留原有错误码，并说明输出截断。历史 Session 记录保持不变。

## 迁移

1. 将截断视为输出不完整，而非执行停止的证据。需要遗漏信息时读取当前状态；不要仅为恢复日志而重复已完成的动作。
2. 更新运行时消费者，分别检查 `outputTruncated` 和 `error`。即使捕获输出被截断，成功返回的必需完成值仍然完整。
3. 自定义 Node bootstrap 部署需与宿主一起更新：私有协议版本为 5，包含不取消执行的输出抑制操作。声明版本 3 或 4 的 bootstrap 会在程序分发前被拒绝。
4. 验证超限前后的动作均会完成，保留变量仍可使用，且后续异常、超时和取消仍报告原来的结果。展示 CUA 截图时使用 `inspect(await window.getScreenshot())`。
