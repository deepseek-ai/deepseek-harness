---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-20-unknown-child-catalog

[English](2026-09-20-unknown-child-catalog.md) | 中文

## 概述

在 subagent/catalog 中使用 unknown 模式保留不可读的历史子会话。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-20-unknown-child-catalog
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-11-initial"
    after: "3abae7324356f155cb42450c00b806d134ec93bd6439d2063b8d724162d58604"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

Catalog 载荷 v0 保持不变。载荷 v1 增加 unknown 模式，当前读取器支持 v0 和 v1。完整事实继续使用 v0；迁移为未知子会话写入 v1。已有日志无需改写，Session header 保持 V4。旧读取器拒绝 v1。分类器仅在所有旧载荷分支保持不变时允许增加更高的事件载荷版本；同版本扩展和移除旧版读取支持仍属于破坏性变更。

<a id="verification"></a>
## 验证

迁移、恢复、投影和 Web 回归覆盖未知成员保留与子会话局部报错。分类器测试接受保留前代的更高载荷版本，并拒绝同版本新增、无效版本、旧分支修改或删除，以及 header/model-surface 变更。

<a id="dev-note"></a>
## 开发备注

无。
