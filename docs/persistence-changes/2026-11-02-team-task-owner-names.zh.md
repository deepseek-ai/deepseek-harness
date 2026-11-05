---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-02-team-task-owner-names

[English](2026-11-02-team-task-owner-names.md) | 中文

## 概述

为持久化 Team 任务快照增加可选的 ownerName，在认领或重新分配时与 ownerId 一起记录，并在结束归属时一起清除。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-team-task-owner-names
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "bca0f9cb63d8620b6954bb045b07bb07cb557513a7f0e2e177f5e87f704e7ba7"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

当前读取方接受没有 ownerName 的已有任务载荷，直接显示 ownerId，不改写或回填历史日志。新任务记录保留相同的 ownerId 授权和第 2 版任务语义。旧 Team 投影使用严格任务 schema，会拒绝包含 ownerName 的记录，保留最后的有效任务并报告投影失败，不会静默误读归属。Session 格式版本保持不变。agentTeam 投影状态版本保持为 7：缺少 ownerName 的第 7 版检查点仍可复用，后缀回放保留后续任务事件中的名称。第 6 版检查点仍从事件重建。

<a id="verification"></a>
## 验证

聚焦的 Agent Teams 投影、任务板、工具及 JSONL/SQLite 恢复测试通过，覆盖保存的根与嵌套所有者名称、清除归属、历史 ID 回退、拒绝没有 ownerId 的 ownerName、检查点重建，以及不查询后代目录的任务读取和编辑。

<a id="dev-note"></a>
## 开发备注

无。
