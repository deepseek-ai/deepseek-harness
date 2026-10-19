---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-tree-wide-agent-names

[English](2026-10-16-tree-wide-agent-names.md) | 中文

## 概述

在已有 subagent catalog 记录中保存不可变的同级名字路径段。完整 agent 路径从父级 catalog 与在线祖先关系推导。

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
```

<a id="compatibility"></a>
## 兼容性

新 reader 接受早期无名 catalog 记录，并为这些子级使用 legacy Session-id 路径段。早期严格 catalog reader 拒绝新增 name 字段，不会错误解释名字。已发布的 catalog 变体与 Session id 保持不变，Session writer 版本也保持不变。递增状态版本使 catalog projection 检查点失效。只有直接父级记录子级；继续执行需要该父级 catalog 条目。

<a id="verification"></a>
## 验证

Subagent、控制工具与 Team 测试覆盖同级预留、自动命名、不同分支重复路径段、历史路径查找、父级 catalog 失败、冷恢复及 fork 隔离。原生 V4 reader 测试覆盖 catalog 身份校验与未知扩展保留。

<a id="dev-note"></a>
## 开发备注

无。
