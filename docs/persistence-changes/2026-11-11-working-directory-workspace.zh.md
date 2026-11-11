---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-working-directory-workspace

[English](2026-11-11-working-directory-workspace.md) | 中文

## 概述

为 working-directory/change 增加可选的 workspace 标记：带标记的变更让 Session 的工作区根随目录一起移动。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-working-directory-workspace
baseline: false
changes:
  - root: "event:working-directory/change"
    previous: "2026-09-13-working-directory"
    after: "d9faba79a3513ba57fb26dde8fe980b2adfe01bb6be5bab05c3d64f5017c356a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不带标记的既有事件按原样折叠：当前目录投影忽略该属性，新的 workspaceRoot 投影对它们把根留在原始项目，也就是已存储的 Session 原本使用的根。从这个版本起，服务为它记录的每次变更设置该标记。旧读者保留事件类型及其 cwd；它们忽略这个可选属性，也从未推导过工作区根，因此它们解释的内容没有变化。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/working-directory/tests：33 个测试通过，包括回放带标记与不带标记的日志，以及 Host 移动到由不带标记的变更记录的目录。

<a id="dev-note"></a>
## 开发备注

无。
