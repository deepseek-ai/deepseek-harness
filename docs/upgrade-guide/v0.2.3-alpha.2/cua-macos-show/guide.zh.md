---
kind: upgrade-guide
description: "macOS CUA 的 show() 区分显示应用和恢复指定窗口。"
---

# 显示 macOS 应用或窗口

[English](guide.md) | 中文

## 变更

`app.show()` 用于显示运行中的应用。如果没有已显示或可恢复的最小化窗口，就请求应用重新打开一次。应用可以复用原窗口，也可以创建新窗口。`window.show()` 只操作原窗口 ID，原窗口不可用时返回错误。窗口已经显示时，两者都返回 `dispatched: false`。台前调度侧栏中的窗口加入当前组并实际展开后，才算显示成功。

## 迁移

1. 最后一个窗口关闭后，使用 `app.show()` 显示应用，再用 `app.getWindow(id)` 选取返回的 `windowId`。
2. 需要恢复指定窗口时，使用 `window.show()`。原窗口已关闭且可以使用同一应用的其他窗口时，调用 `app.show()`。需要让应用持续接收键盘输入时，使用 `app.activate()`。
