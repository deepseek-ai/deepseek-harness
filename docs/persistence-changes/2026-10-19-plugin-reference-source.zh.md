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
    previous: "2026-10-21-system-section-admissions"
    after: "816525e396374d897f770cbc701359de2b97d6081187b8ec7f216b8135cf8f34"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-21-system-section-admissions"
    after: "fb1c56df34236fb8f7b3abfba4b58610130fb844434e04fcf5365598a0f88dee"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-21-system-section-admissions"
    after: "52e1ecd19cf855f796b7126e7d2243149b552b3147d7b00a39a1125a63bd60a7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-21-system-section-admissions"
    after: "42a47cf403f16ffc6053a5462469d62b2832d927e6a9db77d12288aad9d5f51c"
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
