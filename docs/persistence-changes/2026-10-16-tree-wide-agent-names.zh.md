---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

[English](2026-10-16-tree-wide-agent-names.md) | 中文

## 概述

在根 Session 记录整棵树内唯一且不可变的 agent 名字。

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
  - root: "event:subagent/named"
    previous: null
    after: "273f07aea05d56ffbb8b43508bcfb4a20cce230819feadb3fe740bceb8b12ca6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受没有名字分配的旧 Session，并公开稳定的旧地址。旧读取方拒绝新的非可忽略 subagent/named 判别值，避免静默丢失身份；现有目录记录与 Session id 不变。无需提升写入格式版本。

<a id="verification"></a>
## 验证

names.spec.ts 与 tool-team.spec.ts 的 33 个用例通过；names.ts 的语句、分支、函数与行覆盖率均为 100%。Headless 与 TypeScript SDK 回放覆盖按名字创建、消息、发现和完成通知。

<a id="dev-note"></a>
## 开发备注

无。
