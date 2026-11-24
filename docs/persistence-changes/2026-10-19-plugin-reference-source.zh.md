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
    previous: "2026-10-28-im-message-source"
    after: "ede7c9c353068b1f761f75715f6f841f4a34493debeb54b79f5848b06a3a744d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-im-message-source"
    after: "cf503956dd1c5565f479a550432145645a7254976433dbd9a908e03db71e1772"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-im-message-source"
    after: "34354693fcf6237a2c5c308a36e81a4b9eb3d4fca4f868b84007dc5fc006e43a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-im-message-source"
    after: "c03b621ad0efe814b17f12908d209eba79c250c03b0ceabea0a706496553b564"
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
