---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-timeline-priority-notice

[English](2026-11-05-timeline-priority-notice.md) | 中文

## 概述

记录用户添加或取消紧急优先级时的时间线通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-timeline-priority-notice
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "f5d843edb0eeef61c9f5328599d5f92b61112b7710b0310b043196b15b390d64"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "7ee5a828196d9e4b1672f94f977e68f37125da4297c23029dd682823c09e12fd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "4ee17e4219bd5fab6148ec0a8b3ec0fb939edb8f211374cf779bc8135ef9bed2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "fb6a6e338625067ac582f55dde412a583040cd738bb8fc6820cb0b941c59f05a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息保留原有来源和含义。时间线通知包含普通文本和来源标签。未加载时间线的读取方可保留未知来源并读取文本，无需应用任务更新。时间线将任务树、报告和讨论保存为会话日志中可忽略的 `plugin:timeline/*` 记录。未加载时间线的读取方会跳过这些记录。

<a id="verification"></a>
## 验证

时间线优先级测试验证仅用户修改紧急优先级时才排入通知。进程恢复测试验证写入进程意外退出后仍可恢复时间线状态。

<a id="dev-note"></a>
## 开发备注

无。
