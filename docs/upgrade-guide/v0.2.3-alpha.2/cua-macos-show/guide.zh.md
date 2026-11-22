---
kind: upgrade-guide
description: "macOS CUA 的 show() 会报告窗口是否已经显示，并在恢复窗口后归还焦点。"
---

# 恢复最小化的 macOS 窗口

[English](guide.md) | 中文

## 变更

过去即使窗口没有最小化，`app.show()` 和 `window.show()` 也会取消应用隐藏。现在已经显示的窗口返回 `status: "already_visible"`。对最小化窗口，优先在后台恢复。如果恢复过程拿走了键盘焦点，helper 会将它还给原窗口。用户主动切到第三个应用时，保留用户的选择。

## 迁移

1. 需要显示指定窗口时，调用 `window.show()`。返回 `status: "restored"` 表示同一窗口已经解除最小化并显示在屏幕上。遇到错误时先重新观察窗口，再发送输入。
2. 需要目标应用持续接收键盘输入时，调用 `app.activate()`。
