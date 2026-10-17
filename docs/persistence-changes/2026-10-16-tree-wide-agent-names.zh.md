---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

[English](2026-10-16-tree-wide-agent-names.md) | 中文

## 概述

在现有 subagent catalog 与 descriptor 记录中保存树内唯一名字，并以 catalog v3 在根登记后代名字。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-16-tree-wide-agent-names
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-19-external-subagent-catalog"
    after: "c97a3640f72bd16b03b788c27630c9423483175b3da4e4e2f22c215c0756d789"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "194530445ad15cc68b8a708321a4d8d118dfe54600864fcb965ffca9b1afb8cc"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受早期无名 catalog 与 descriptor 记录。旧 catalog 读取方通过严格 schema 拒绝新增 name 字段和 v3 名字登记变体；旧 descriptor 读取方拒绝未知 name 字段。catalog 版本判别字段阻止将登记条目解释为直接子级。Session id、事件类型与 Session 写入格式不变。catalog 投影检查点通过状态版本递增失效。根登记在执行结束后仍保留名字；登记失败可能留下父级发现事实，命名发现与冷恢复会排除此类记录。

<a id="verification"></a>
## 验证

聚焦的 subagent 与 Team 测试覆盖并发预留、历史分支不可读时仅查根、父级发布后根登记失败、使用新 child id 重试、发现过滤、冷恢复拒绝、分叉隔离与重复 child-id 拒绝。catalog 测试检查新增变体、检查点解析及直接子级视图排除；Team 投影测试排除仅登记名字的条目。

<a id="dev-note"></a>
## 开发备注

无。
