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
    previous: "2026-11-18-cua-activity-context"
    after: "41b562e6d6c59ac22c023d14fa1ae878bfb4573fe1b1dcb021e58ac2ee6bf049"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-cua-activity-context"
    after: "8ecc75abd481f9eadd4bbe834120662d870e07d0ecc889e8631b03be5089e710"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-cua-activity-context"
    after: "64b6ec45d21f5aed32624819c44ba5c918bbe11ca9c464496d9dbe0606dcb829"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-cua-activity-context"
    after: "b9bcecf9562bc66102dad311fff56c8c0e694d39afa17b39f87a7b88992011c8"
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
