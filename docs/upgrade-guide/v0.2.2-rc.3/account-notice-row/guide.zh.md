---
kind: upgrade-guide
description: "账号通知从 `settings.launcher.notifications` 改为位于账号入口上方新行中的 `settings.notice.notifications`。"
---

# 账号通知 slot 重命名

[English](guide.md) | 中文

## 变更

设置外壳新声明 `settings.notice` slot，并在账号入口行上方的独立满宽行中渲染它；折叠窄栏时隐藏该行。账号设置填充该行，并在其中声明账号通知 slot。该 slot 从 `settings.launcher.notifications` 重命名为 `settings.notice.notifications`；owner props `active` 和 `openAccount` 不变。账号入口不再渲染通知。

## 迁移

1. 在 `ctx.slots.inject`、`ctx.slots.register` 和 `PropsRuntime` 引用中，把 `settings.launcher.notifications` 改为 `settings.notice.notifications`。
2. 删除用于把通知内容定位到入口上方的绝对定位；该行已经以满宽位于入口上方。
3. 重新构建扩展，确认通知在展开侧栏时显示在账号行上方，并在折叠窄栏时隐藏。
