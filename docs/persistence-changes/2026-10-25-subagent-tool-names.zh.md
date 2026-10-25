---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-25-subagent-tool-names

[English](2026-10-25-subagent-tool-names.md) | 中文

## 概述

增加由根 Session 持有的 subagent-name/bound 事件，持久保存名字到 ID 的绑定。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-subagent-tool-names
baseline: false
changes:
  - root: "event:subagent-name/bound"
    previous: null
    after: "2073e98f0c214cc431b1a9a027efe75d22190a8ed8fed2791b47c2b52dd32a57"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 V4 Session 仍可读取，未命名的 catalog 子节点保留其 Session id。新事件使用独立判别符，不改变 subagent/catalog。事件词汇表中没有这一必读事件的旧读取器会在接管前拒绝包含它的 Session，不会静默丢弃名字或将其误解为其他事件。写入格式仍为 V4。

<a id="verification"></a>
## 验证

subagent-names 包测试覆盖绑定回放、排除 fork 继承事件、checkpoint 恢复及拒绝冲突绑定。storage-contract.spec.ts 与 V4 codec.spec.ts 测试覆盖在接管前拒绝未知必读事件。

<a id="dev-note"></a>
## 开发备注

无。
