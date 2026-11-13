---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-13-workspace-root-change

[English](2026-11-13-workspace-root-change.md) | 中文

## 概述

新增 workspace-root/change 事件，它让 Session 的当前目录和工作区根一起移动。working-directory/change 的内容不变，不再有写入方。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-workspace-root-change
baseline: false
changes:
  - root: "event:workspace-root/change"
    previous: null
    after: "025f11632cd02aaecc23a46c3b5bf43b9009d88293ed9b35ccbc1139d73334dc"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读者折叠两种事件：workspace-root/change 同时设置当前目录和工作区根，working-directory/change 只设置当前目录，因此已存储的 Session 仍以原始项目为根。从未移动工作区的 Session 不含这两种事件，旧读者照常读取。旧读者不认识 workspace-root/change，它不带 ignorable 标记，所以旧读者在解码该行时拒绝含有它的日志，不会重建出缺少这次移动的目录。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/working-directory/tests：33 个测试通过，包括回放含 workspace-root/change 的日志、把根留在原始项目的已存储 working-directory/change，以及 Host 移动到由 working-directory/change 记录的目录。pnpm exec vitest run packages/session/session-format-catalog/tests/catalog.spec.ts：23 个测试通过，包括拒绝读者词汇表之外的必需事件类型。

<a id="dev-note"></a>
## 开发备注

无。
