---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-13-workspace-root-change

[English](2026-11-13-workspace-root-change.md) | 中文

## 概述

新增 workspace-root/change 事件，它记录 Host 对 Session 目录的一次移动。working-directory/change 的内容不变，不再有写入方。

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

新读者把两种事件折叠成一个目录。workspace-root/change 设置该目录。已存储的 working-directory/change 只在其目录位于 Session 的原始项目之内时设置该目录，这样曾在工作树或项目子目录中工作的 Session 保留它的目录和相对路径。这收窄了目录位于原始项目之外的已存储 working-directory/change 的含义：早期读者把它保留为当前目录，本读者让 Session 回到项目，因为该目录可能由模型选择，而消费方以 Session 的目录限定写入。下一次请求的上下文向模型报告该目录。从未移动的 Session 不含这两种事件，旧读者照常读取。旧读者不认识 workspace-root/change，它不带 ignorable 标记，所以旧读者在解码该行时拒绝含有它的日志，不会重建出缺少这次移动的目录。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/working-directory/tests：30 个测试通过，包括回放位于项目之内、项目之外、Host 移动之后、没有来源元数据的 Session 中以及 header 为符号链接时的已存储 working-directory/change 事件。pnpm exec vitest run packages/session/session-format-catalog/tests/catalog.spec.ts：拒绝读者词汇表之外的必需事件类型。

<a id="dev-note"></a>
## 开发备注

无。
