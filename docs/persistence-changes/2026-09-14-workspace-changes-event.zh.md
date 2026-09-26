---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-14-workspace-changes-event

[English](2026-09-14-workspace-changes-event.md) | 中文

## 概述

新增仅写日志的 workspace/changes 事件，记录顶层轮次改动的文件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-14-workspace-changes-event
baseline: false
changes:
  - root: "event:workspace/changes"
    previous: null
    after: "e308ccf867a5398e316e0af8cb6ce238a8d33a63b9b384c8250a686786285f72"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同一 Session 格式版本内的新根类型。已有日志没有该事件，保持有效；早于它的读取方遇到它会拒绝该日志，与所有读取时必需的事件一致。该事件只由 Web bundle 的 workspace-changes 插件追加，模型永远看不到；Web 的改动文件卡片是唯一消费者，读取每轮最新的一条。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/deliverables/workspace-changes packages/client/ui-deliverables：165 个测试通过；snapshots/web/changed-files-turn 通过 Web profile 回放了记录的事件。

<a id="dev-note"></a>
## 开发备注

无。
