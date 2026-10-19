---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

[English](2026-10-16-tree-wide-agent-names.md) | 中文

## 概述

在现有 subagent catalog 与 descriptor 记录中保存不可变的同级名字路径段。完整 agent 路径由父级 catalog 与在线谱系派生。

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

新读取器接受此前无名的 catalog 与 descriptor 记录，为这些子级使用带 Session id 的 legacy 路径段。此前严格的 catalog 与 descriptor 读取器会拒绝新增的 name 字段，避免错误解释名字。移除尚未合并的仅用于根登记的 catalog v3 变体；已发布的 catalog v0–v2 变体与 Session id 保持不变。Session 写入版本不变。通过递增状态版本使 catalog 投影检查点失效。只有直接父级记录子级；命名子级缺少匹配的父级 catalog 条目时无法恢复。

<a id="verification"></a>
## 验证

定向 subagent、控制工具、Team 与 V3-to-V4 读取器测试套件共 1,109 个测试通过。选定的 10 个变更实现文件语句、分支、函数和行覆盖率均为 100%。用例覆盖同级局部预留、不同分支重复路径段、历史路径解析、父级 catalog 失败与冷恢复拒绝、fork 隔离，以及拒绝不支持的仅含名字的 catalog 行。

<a id="dev-note"></a>
## 开发备注

无。
