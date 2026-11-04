---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-plugin-reference-source

[English](2026-10-19-plugin-reference-source.md) | 中文

## 概述

为 Host 注入的插件上下文新增 plugin-reference 用户消息 source kind。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-plugin-reference-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "b07af8f880b773b29eed29990eeedd84f8fccdcae7225b1c2b5cc61e9ff85e49"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "8ae60ac78f577885d613bd4e0d626eacee5a264173157ffd916a4eab9634740f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "658270d5960087ef3794fa4988838203446b7a57c129d8f7786736487cb48f92"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "897e77386649c13194b34430ffe352a51916a6bbbb7dacf8461044a4926aef15"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。消息 source 是开放映射；不认识 plugin-reference 的读取方按角色和内容处理该消息，不需要读取其元数据。写入方只在引用插件的用户消息后追加一条上下文消息，不改变任何已有记录的含义。

<a id="verification"></a>
## 验证

npx vitest run packages/boot/plugin-manager/tests/plugin-reference.spec.ts：12 个测试通过；npx vitest run packages/client/ui-plugin-manager/tests/plugin-reference.client.spec.tsx：10 个测试通过；pnpm run test:gui：10799 个测试通过；pnpm run typecheck：5 个 gate 通过。

<a id="dev-note"></a>
## 开发备注

无。
