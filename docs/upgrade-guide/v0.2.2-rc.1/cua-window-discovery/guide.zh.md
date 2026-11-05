---
kind: upgrade-guide
description: "CUA 默认窗口清单省略离屏和尺寸为零的窗口。"
---

# 查找隐藏的 CUA 窗口

[English](guide.md) | 中文

## 变更

`listWindows`、`app.getWindows()` 和 `getState` 的窗口清单默认只显示当前桌面上尺寸大于零的在屏窗口。窗口级观察还会保留显式选中的窗口。通过默认枚举查找最小化、隐藏或位于其他 Space 的窗口时，脚本可能找不到目标。

## 迁移

1. 调用 `app.getWindows({ includeHidden: true })`，或在原始 `listWindows` 操作中同时传入应用句柄和 `includeHidden: true`。
2. 在完整清单中确认目标窗口的 ID，调用 `app.getWindow(windowId)` 选中它，需要恢复窗口时调用 `show()`。
