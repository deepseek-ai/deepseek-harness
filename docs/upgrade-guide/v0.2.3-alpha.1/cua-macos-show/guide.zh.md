---
kind: upgrade-guide
description: "macOS CUA 的 show() 会在窗口恢复可能抢占焦点时返回错误。"
---

# 在前台恢复已最小化的 macOS 窗口

[English](guide.md) | 中文

## 变更

过去在 macOS 上调用 `app.show()` 或 `window.show()`，即使选中的窗口没有最小化，也会取消应用隐藏。现在这种窗口保持原状，调用返回 `dispatched: false`。恢复最小化窗口可能抢占键盘焦点，此时调用返回 `FOREGROUND_REQUIRED`。

## 迁移

1. 任务需要将隐藏的应用切到前台时，使用 `app.activate()`。
2. 需要在后台恢复窗口时，对选中的窗口调用 `window.show()`。如果返回 `FOREGROUND_REQUIRED`，且任务允许切到前台，调用 `app.activate()` 后重新读取目标窗口状态。
