---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-19-cua-input-notices

[English](2026-11-19-cua-input-notices.md) | 中文

## 概述

新增 cua-held-inputs 和 cua-inputs-released 来源标识，使用现有 notice 形式和文本内容。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-19-cua-input-notices
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "0880996d224033d9a668528f51edf5f229d9b07dda42fb65f7d1cc1150c12836"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "3a6f3e4354a90287bb3a1fb19e7a2f643cdbd7c6472c865abd11f8fa2d3358d5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "4e81b0490558b80c87cd09b214cd958ce0df1bf2bb431c930ff8fd441a8d1df5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "507043f63e859f272ce78f6bc65a7361ee087e5e06301f9c100302230bc887a7"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持 Session 格式 V4。新读取器保留此前所有来源种类和事件字段。已发布的 V4 读取器允许用户或开发者消息使用非空的未知来源种类，保留其元数据和文本，并已支持 notice 摘要。收件箱排队消息和已记录的标题请求消息使用相同的来源对象。这两个种类描述输入状态；恢复或派生 Session 不会重放原生输入，也不会重新建立持有状态。事件判别字段、文件头、消息角色和既有来源含义均不改变。

<a id="verification"></a>
## 验证

pnpm run test packages/session/session-format-v3-to-v4/tests/attribution.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts：12 项测试通过。7 个定向 headless/TypeScript SDK CUA 快照、发行配置 cua-mcp 的预期输出、Web CUA 回放及 Python SDK 回放通过。CUA 行为测试覆盖持有提醒入日志、暂停后确认的释放提醒，以及迟到旧提醒的移除。

<a id="dev-note"></a>
## 开发备注

无。
