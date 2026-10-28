---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-deepseek-search-thinking

[English](2026-10-13-deepseek-search-thinking.md) | 中文

## 概述

为记录的 DeepSeek 搜索请求体新增可选成员 `thinking`，记录辅助搜索回合关闭了思考模式。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-deepseek-search-thinking
baseline: false
changes:
  - root: "event:web/deepseek-search-llm-request"
    previous: "2026-09-11-initial"
    after: "0c556c9b9f2a96238a6b9bbb99e748206cbff2ed6203041c9571f04ae5802f52"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：缺失表示请求省略了该字段，由 DeepSeek 使用默认值。该事件仅用于日志；没有读取方为行为回放或解释请求体，提供方在每个新请求中写入该成员。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/web/web-search-deepseek/tests/deepseek.spec.ts：59 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
