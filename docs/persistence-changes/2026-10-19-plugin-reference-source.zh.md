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
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "ec2dee2e721b44b81c89fe32a39be6b1c1961eb790a0dbe2e40069793460f893"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "3eed4e5f38b6da32f004fb5f3728d7a60cf825af00d0578a6cb4c3cbf2ac820a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "1a44706a633848c4fcd0a32d82546c3519b746817358429d1f919c97a1ddc8aa"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "f61013ef7874a2cc06f4134274e07a3b0491c04a72e36373ec3f85c9bf094eb0"
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
