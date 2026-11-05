---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-02-subagent-catalog-names

[English](2026-11-02-subagent-catalog-names.md) | 中文

## 概述

为父 Session 拥有的 subagent/catalog 载荷增加 version 3，记录每个 continuable 子代理或父级交付的 external 子代理在其创建者子代理中唯一的名称。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-subagent-catalog-names
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-19-external-subagent-catalog"
    after: "d49164d37eab0f0f70fa787c65d887abbea869c010ccb103d717fab3519c3a41"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

version 0、1、2 载荷的 schema 和含义保持不变；当前读取方将其恢复为按 Session id 寻址的无名子代理。新的本地创建和父级交付的 external 创建写入 version 3。投影 stateVersion 保持为 6：无名检查点仍可复用，后缀回放与包含具名事件的全量回放一致。较早版本在原生 V4 准入和目录投影恢复时拒绝未知载荷版本，而不会误读条目，因此记录了具名子代理的父 Session 会明确失败，而不是丢失子代理。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/subagent/tests：495 个测试通过，覆盖具名目录恢复、无效 version 3 事实、同级唯一预留、冷恢复路径还原以及父级交付 external 子代理的名称。pnpm exec vitest run packages/session/session-format-v3-to-v4/tests：397 个测试通过，覆盖原生 version 3 准入与拒绝。

<a id="dev-note"></a>
## 开发备注

无。
