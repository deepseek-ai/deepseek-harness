---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-20-side-session-origin

[English](2026-11-20-side-session-origin.md) | 中文

## 概述

为 Session 头部的 `origin` 增加 `side` 取值，记录在 `/side` 分支出的侧边对话上。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-side-session-origin
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "80182de7c81ace88aba710f01dd7c66e10412a5e42645fe11d647c8eb237f3b2"
    decision: same-version
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "5bd0c9671b79261f42e5a47a308f7e5c7e15926a80e4a6e137a8bc66e70db09c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：缺失 `origin` 与 `origin: "subagent"` 的含义不变；只有当前写入方会产生 `side`，迁移得到的头部不会带有它。V4 编解码器让 `side` 绕过冻结的 V2 头部编解码器，真实 V2 日志中的 `side` 仍被拒绝。已发布的 JSONL 读取方（包括 `dsh-v0.2.0-rc.2` 与 `dsh-v0.2.2-rc.5`）在头部校验时拒绝 `side` 头部：格式目录将其报告为格式错误，列表跳过该 Session，打开时在读取任何事件前抛出损坏错误，因此旧读取方不会执行、修改或截断侧边对话，其事件与字节保持不变，供较新的读取方读取。`dsh-v0.2.3-alpha.2` 中发布的 SQLite 后端在严格的头部 schema 中把 `origin` 解码为字面值 `subagent`，因此其 `parseHeader` 遇到 `side` 头部会抛出 `SessionPersistenceCorruptionError`：列表省略该会话，打开它会在读取任何事件之前失败。按 `origin === "subagent"` 分支的头部读取方把侧边对话当作普通 Session。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/codec.spec.ts packages/session/session-persistence-sqlite/tests/codec.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/core/session/tests/session.spec.ts packages/api/session-controller/tests/session-fork.host.spec.ts：全部测试通过，包括 `side` 经过 V4 编解码器、格式目录、JSONL 头部行与 SQLite 编解码器的往返。

已发布的 SQLite 读取方：`git show dsh-v0.2.3-alpha.2:packages/session/session-persistence-sqlite/src/codec.ts` 在 `.strict()` 头部 schema 中声明 `origin: z.literal('subagent').optional()`，同一 tag 的 `src/sqlite.ts` 把解码失败包装为 `SessionPersistenceCorruptionError`，其列表路径会省略该会话。

<a id="dev-note"></a>
## 开发备注

无。
