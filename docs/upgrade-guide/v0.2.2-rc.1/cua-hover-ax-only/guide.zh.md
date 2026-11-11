---
kind: upgrade-guide
description: "macOS 的 mouseMove 默认要求控件支持 AX 备用界面，否则返回 HOVER_UNAVAILABLE，保留用户的光标位置。"
---

# macOS 悬停默认保留系统光标位置

[English](guide.md) | 中文

## 变更

在 macOS 上，`win.mouseMove(target)` 会查找已启用且同时声明 `AXShowAlternateUI` 和 `AXShowDefaultUI` 的控件或祖先。找不到时，旧版会移动系统光标，新版默认在发送输入前返回 `HOVER_UNAVAILABLE`。默认配置下，显式请求移动系统光标时会询问用户是否授权当前会话。

## 迁移

1. 对已经可用的控件，可执行它声明的动作或直接点击。需要网页悬停时可用浏览器工具。
2. 如果 profile 设置了 `helperPath`，请重新构建该 helper，使其支持按请求读取 `useSystemPointer` 字段，然后重启 profile。
3. 任务确实需要移动鼠标时，在前台未受遮挡的目标上调用 `win.mouseMove(target, { useSystemPointer: true })`。用户同意后，本次移动返回 `systemPointerMoved: true`。之后每次移动系统鼠标仍需显式传 `useSystemPointer: true`。关闭会话或重启 DSH 后需要重新授权。
