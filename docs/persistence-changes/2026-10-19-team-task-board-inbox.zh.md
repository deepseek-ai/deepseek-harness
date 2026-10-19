---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-team-task-board-inbox

[English](2026-10-19-team-task-board-inbox.md) | 中文

## 概述

新增 team-task-change 消息来源，用于持久化收件箱和模型历史中的共享任务板通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-team-task-board-inbox
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "4496bd99940ad6dec32f1a181c218c0b9f67a80c2b5c50bcb4ce52e2b4518f18"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "f1709ece9b0e182d8976e81f3bea0ba84fd050ea4636aa75f005cb173e429267"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "267ed256d5fa601fe0a09e9a3a791a7127d9159e5b6caec9f4c075af50dd51b4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b2e4a6ee169963de0dae2a5b6a0855f3a0366e858fa68910a297f035e7ae0a13"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

当前读取器继续接受所有已有来源。旧 V4 读取器保留生产者自有的来源 kind，不要求已知判别值；team-task-change 保留普通用户消息文本，并使用带 summary 的既有 notice 形式。通用通知渲染器无需解释 rootSessionId 即可显示它。共享 MessageSource 联合使该来源出现在 agent/inbox/spliced、user/message、developer/message 和 session/title-llm-request 中。不改变事件判别值、任务载荷或写入器版本。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team/tests packages/experimental/tool-agent-team/tests：67 个测试通过。pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t "team-task-inbox|team-targets|team-tree-messages"：3 个场景通过，覆盖任务持久提交、合并通知恢复和立即返回的收件箱等待。

<a id="dev-note"></a>
## 开发备注

无。
