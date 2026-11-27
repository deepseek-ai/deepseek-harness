---
kind: upgrade-guide
description: "读取期间有后代元素消失时，Windows getState 返回部分辅助功能树，并标记未读到的位置。"
---

# Windows 辅助功能读取可能返回部分树

[English](guide.md) | 中文

## 变更

在 v0.2.3-alpha.2 中，只要读取期间有后代元素消失，Windows `getState` 就会返回 `STALE_SNAPSHOT`。现在调用会成功返回已读到的行。如果窗口的辅助功能根节点在读取前已经消失，调用会返回 `STALE_SNAPSHOT`。

Windows `getState` 每次成功返回的原始结果都包含布尔字段 `hasUnreadableElements`。值为 `true` 时，`tree` 用 `[One child could not be read.]` 标记单个未读到的元素，用 `[Child list incomplete.]` 标记子项列表中剩余未读到的部分。两种标记都没有元素 ID。读取过程中没有产生标记时，该字段为 `false`。另一个字段 `truncated` 单独表示因元素数量或深度上限而省略了内容。

## 迁移

1. 转发原始结果时保留 `hasUnreadableElements`，并将标记行显示为普通文本。如果控件可能位于有标记的分支，先重新读取树，或用 `window.getScreenshot()` 查看窗口，再判断控件是否存在。
2. 启用 `showDiff: true` 后，遇到不可读元素时，本次读取会返回所有已读到的行。用这些行替换当前显示的树。只有一次完整读取才能为后续通知建立比较基准。
3. 验证时，在一次带标记的读取后，用相同选项完整读取同一窗口。确认两次响应都显示当次读到的所有行，且第二次返回 `hasUnreadableElements: false`。
