---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

[English](2026-10-16-tree-wide-agent-names.md) | 中文

## 概述

在现有 subagent catalog 和 descriptor 记录中保存不可变的树内唯一名字。

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
    after: "8521c4e8b3ddb8a7835fe8e707061bf4a9a52b9e4c2e98e5fc5fef2ac4998ff3"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "194530445ad15cc68b8a708321a4d8d118dfe54600864fcb965ffca9b1afb8cc"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受早期不含名字的 catalog 和 descriptor，并公开稳定的旧地址。旧 catalog 读取方通过严格事件 schema 拒绝新增的 name 字段；旧 descriptor 读取方拒绝未知字段，无法冷恢复该子级。两种读取方都不会静默分配其他身份。Session id、事件判别字段与写入格式不变。现有投影检查点通过状态版本递增失效。执行结束后名字仍被占用；采用 caller 交付的外部执行现在也发布 catalog 条目。

<a id="verification"></a>
## 验证

聚焦的 catalog、descriptor、continuation 与 Team 测试通过。命名与继续执行测试覆盖并发 catalog 重建、冷恢复名字、不可读历史分支、启动失败释放、分叉隔离与重复 child-id 拒绝；names.ts 的语句、分支、函数和行覆盖率均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
