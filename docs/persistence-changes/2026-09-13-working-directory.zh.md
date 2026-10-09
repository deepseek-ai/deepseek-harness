---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-13-working-directory

[English](2026-09-13-working-directory.md) | 中文

## 概述

增加每个 Session 的持久化工作目录变更。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-13-working-directory
baseline: false
changes:
  - root: "event:working-directory/change"
    previous: null
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session header 和事件继续有效。新事件在读取时为必需：不认识 working-directory/change 的旧版本拒绝包含它的日志。事件词汇扩展不改变 Session 的结构格式。

<a id="verification"></a>
## 验证

工作目录和系统提示词定向套件通过 113 个测试，各源码文件覆盖率达到 100%。无密钥 headless 回放验证变更、恢复、用户上下文通知和稳定的系统提示词。

<a id="dev-note"></a>
## 开发备注

无。
