---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-13-subagent-user-message

[English](2026-11-13-subagent-user-message.md) | 中文

## 概述

增加子 agent 来源提示，标识紧随其后的浏览器用户消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-subagent-user-message
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "7cd1114a345c75f6d68db07a4961f0f09279266e2645f3d5833bcc7f7bae0cf3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "004e48d8009062e92150686eaf56d0581347dc6642984c62b49148adcfba9127"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "1ef3ab54f9530d6d9fbefc188d06716074948057eb2c7c8a7fd65bc2ae362599"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "60263b853fa333f7f550c2b115192ed07ae1e3e22437d3b638a60b0f726d794b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录保持可读，无需改写。新增 subagent-user-message source 仅表示来源：没有生产插件的读取器也保留其元数据和 user-role 正文，现有 notice 展示逻辑即可处理。回放和权限决策不依赖此 kind。旧读取器可投影已记录的提示和真人原消息；新读取器不会在旧历史中补插提示。新增来源分支不改变现有事件载荷和 Session 版本。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/subagent/tests：509 个测试通过，覆盖冷恢复 Queue/Steer 来源落盘、主 agent 与 agent 消息不变，以及驻留输入编辑。手工编写的 Web subagent-human-message 场景已通过正式 Web 组装成功刷新。

<a id="dev-note"></a>
## 开发备注

无。
