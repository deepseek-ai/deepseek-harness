---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-19-external-subagent-catalog

[English](2026-09-19-external-subagent-catalog.md) | 中文

## 概述

为父级目录中没有本地 Session 的子级添加 external 模式。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-19-external-subagent-catalog
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-20-unknown-child-catalog"
    after: "53750b9abf61efb7992b0aadc3e247ec927449c63266df28230fd1139f5590ac"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 version-0 和 version-1 的 one-shot 与 continuable 事实仍然有效；version 1 还保留 unknown 模式。新外部执行写入 payload version 2 和 external 模式，不使用单独的标记。创建时写入一次成员事实，执行和清理不更新它。重复的子 id 仍然无效。这不改变已发布的代际或 Session 格式版本。

<a id="verification"></a>
## 验证

定向 catalog、外部 activation、原生 V4 恢复、客户端导航和控制工具测试通过，覆盖外部成员关系、历史本地模式、非法标记拒绝、不可导航的外部叶节点，以及重复子级拒绝。

<a id="dev-note"></a>
## 开发备注

无。
