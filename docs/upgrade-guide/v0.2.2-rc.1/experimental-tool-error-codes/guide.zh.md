---
kind: upgrade-guide
description: "Experimental 与 hook 插件的工具失败带上错误 code，NativeError、OarFailure 与 StagehandDrainError 改为 HarnessError 子类，浏览器清理失败改为以 BrowserSessionError 拒绝。"
---

# Experimental 插件的失败带上错误 code

[English](guide.md) | 中文

## 变更

CUA、browser-use、Cua Driver、worktree、Ralph、终端、OAR 子 agent、Liveshare、Claude Code 与 Codex hook，以及 claude-code-mods 插件的工具失败现在会在 `tool/result` 上记录 `error: { name, code }`；此前这些结果大多没有 `error`。各[包 README](../../../../packages/experimental/README.zh.md) 列出了每个类和 code。

在进程内处理这些失败的代码会看到以下变化：

- `@deepseek-ai/dsh-cua` 的 `NativeError` 与 `@deepseek-ai/dsh-experimental-subagent-oar` 的 `OarFailure` 现在继承 `@deepseek-ai/dsh-error` 的 `HarnessError`。`NativeError` 的 name、code 与 `CODE: message` 文本不变。`OarFailure` 去掉了 `stage` 与 `category` 字段；同样的摘要保留在 `message` 中，`code` 标明阶段。OAR 运行开始前的取消改为以 name 为 `AbortError` 的 `DOMException` 拒绝，不再是 `OarFailure`。
- `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` 的 `StagehandDrainError` 现在继承 `StagehandError`，code 为 `STAGEHAND_CLEANUP_FAILED`。
- `@deepseek-ai/dsh-experimental-browser-use-runtime` 的 `SessionResources.dispose()` 改为以 `BrowserSessionError`（`BROWSER_CLEANUP_FAILED`）拒绝，其 `cause` 是此前直接抛出的 `AggregateError`；`instanceof AggregateError` 不再成立。
- Liveshare 的 guard 函数改为返回 `{ reason, info }`，不再返回原因字符串。
- 改为抛出 `ToolArgsError` 的参数失败，模型看到的 message 前多了 `invalid arguments: `；为不支持图片输入的模型请求 CUA 截图时，message 前多了 `MODEL_DOES_NOT_SUPPORT_IMAGES: `。

## 迁移

1. 如果分析或重试规则读取 `tool/result` 的 `error`，按包 README 补充新的 name 与 code。较早的 Session 日志中这些结果仍没有 `error`。
2. 把对 `SessionResources.dispose()` 拒绝值的 `instanceof AggregateError` 检查改为 `instanceof BrowserSessionError`，并从 `error.cause.errors` 读取各个失败。
3. 把读取 `OarFailure.stage` 或 `category` 的代码改为读取 `error.code`。
4. 如果代码在 `NativeError`、`OarFailure` 或 `StagehandDrainError` 之前捕获 `HarnessError`，在处理方式不同的地方把具体类的检查移到前面。
5. 用 `pnpm run typecheck` 和自己的失败路径测试确认迁移完成。
