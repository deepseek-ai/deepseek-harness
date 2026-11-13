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
    previous: "2026-11-05-timeline-priority-notice"
    after: "1730344fc2b73b282bc8065cd729388c3454a1966ffc2557bda89c177162f05e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "0f8fa34035bd1a85ca754bafa2471820f0960d6560b9682a3a703f61932f322f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "9bd33bff02f1b5a1fe4b55c2e26210631f03b78f3e641f56cc72d27d59b911f2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "8a21956a397f18ddf306b055e199fa9818e102eaf67a82348e7a0e18633287dd"
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
