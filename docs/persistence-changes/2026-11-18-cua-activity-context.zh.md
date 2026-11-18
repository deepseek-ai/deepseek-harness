---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-cua-activity-context

[English](2026-11-18-cua-activity-context.md) | 中文

## 概述

将 macOS 计算机操作活动记录为带来源的工具后续上下文。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-cua-activity-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "80d7a49ed6017af1a023488430fc8e9b7679f7af50c8b5ad6c843ae3a90719af"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "cb5e0389ac2f78305e882f895e4e55d31f44e48c28292ed44adff6193354fc67"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "696c7e4bb21e7754a5546078c1b45a82c4a7f0fbeab860bacf89070266d6a16c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "8bac8ab331c25847ac29a4852578098b8684e44c6bcdfecb8f507db3cfed7402"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

cua-activity 增加来源判别值，不修改已有消息载荷。已发布的 V4 读取器保留未知来源的元数据和消息正文，当前读取器继续接受已有来源。活动提示属于 user 角色的参考上下文，不增加控制事件，因此 Session 格式版本保持不变。

<a id="verification"></a>
## 验证

近期活动的工具执行链测试通过。已发布 V4 的来源测试覆盖 user 和 developer 消息并通过；cua-native 和 cua-ptc 快照刷新通过，包含未调用 inspect 的程序。

<a id="dev-note"></a>
## 开发备注

无。
