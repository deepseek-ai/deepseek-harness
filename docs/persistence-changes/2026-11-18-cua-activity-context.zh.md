---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-cua-activity-context

[English](2026-11-18-cua-activity-context.md) | 中文

## 概述

记录模型请求前收到的 macOS 窗口活动提醒。

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
    previous: "2026-10-21-system-section-admissions"
    after: "41586248fbed6edc749e789f57533377519bb1f5941f8a53149a31e4a3a984d7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-21-system-section-admissions"
    after: "54588f397f0f084fbde634df6be453defaf348a21fdbec869031951f2d9974d8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-21-system-section-admissions"
    after: "9a8fdf1cc2efb1e06832a5191db0636146cd6f073cc4acc61d6ff8fa813def9f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-21-system-section-admissions"
    after: "94e41fc6c2fc24fb9dd979f52c2842d385a89ea92ad9ae52315b6420f523f00d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

cua-activity 增加来源判别值，不修改已有消息载荷。已发布的 V4 读取器保留未知来源的元数据和消息正文，当前读取器继续接受已有来源。活动提示属于 user 角色的参考上下文，不增加控制事件，因此 Session 格式版本保持不变。

<a id="verification"></a>
## 验证

已发布的 V4 来源测试覆盖 user 和 developer 消息。cua-native 和 cua-ptc 回放覆盖模型请求前记录的活动提醒。

<a id="dev-note"></a>
## 开发备注

无。
