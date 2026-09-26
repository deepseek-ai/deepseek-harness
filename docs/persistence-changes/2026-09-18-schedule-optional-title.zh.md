---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-schedule-optional-title

[English](2026-09-18-schedule-optional-title.md) | 中文

## 概述

将持久化的 schedule/change create 记录中 after、at、every 三个变体的已存 title 改为可选。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-schedule-optional-title
baseline: false
changes:
  - root: "event:schedule/change"
    previous: "2026-09-11-initial"
    after: "a0a2e5c42e1c929445ecd1cd70f49be6b66441894ec72c08e8ae332821d4a3cb"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

在 title 出现之前写入的版本 1 Session 事件没有 title 成员，因此这些日志可以在没有该成员的情况下解码与折叠，而不会被拒绝。需要名称的读取方将缺失的 title 视为未命名任务。宿主任务记录仍然要求该成员：存储解码器拒绝没有它的已存任务，创建、更新与 schedule 工具也仍然要求它。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/schedule/schedule/tests：18 个文件、789 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
