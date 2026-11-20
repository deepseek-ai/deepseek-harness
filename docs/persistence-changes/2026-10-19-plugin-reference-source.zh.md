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
    previous: "2026-11-18-cua-activity-context"
    after: "ade14698ae6a3d3b0887fa99e4e372c55f6055ed3adee76d6caf00c8904d9980"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-cua-activity-context"
    after: "5a203a0157538ebed5a470dfa959663dcfc183fcd970eae4dff2a019dfa3d07f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-cua-activity-context"
    after: "044055f8b6ff3c8dbb6d8211d3f29aa226e0410d2cffa9b33342a36bec8c1941"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-cua-activity-context"
    after: "49528c3ac96101a8ed51d419f0320d47a35e8ca6b9f8ed1277240ec66d445ff0"
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
