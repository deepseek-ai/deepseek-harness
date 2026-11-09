---
kind: upgrade-guide
description: "macOS 的 mouseMove 默认要求控件支持 AX 备用界面，否则返回 HOVER_UNAVAILABLE，保留用户的光标位置。"
---

# macOS 悬停默认保留系统光标位置

[English](guide.md) | 中文

## 变更

在 macOS 上，`win.mouseMove(target)` 会查找已启用且同时声明 `AXShowAlternateUI` 和 `AXShowDefaultUI` 的控件或祖先。找不到时，旧版会移动系统光标，新版默认在发送输入前返回 `HOVER_UNAVAILABLE`。

## 迁移

1. 对已经可用的控件，可执行它声明的动作或直接点击。需要网页悬停时可用浏览器工具。
2. 要恢复可见光标移动，在 profile 的 `cordis.patch.yml` 中，给 macOS 提供方条目（`id: cua`）的 `config` 添加 `systemPointerHover: true`。保留该条目的其他设置。如果指定了 `helperPath`，先重新构建自定义 helper，使其在建立连接时能读取 `systemPointerHover`，然后重启 profile。
3. 对前台未受遮挡且不提供 AX 备用界面的控件调用 `win.mouseMove`。启用配置时，结果为 `hoverRoute: "system-pointer"` 和 `systemPointerMoved: true`。要保留用户的光标位置，使用默认配置。
