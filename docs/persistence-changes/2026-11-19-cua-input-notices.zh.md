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
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "0c815ede184e032dbe04cf80acef1b69805eec6dc80fad2ab8ecc78dd12d89b5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "a7de6bf0f2e865cb8b3c3cd28b0e1b68682fc546eb182cbea7312a0552d2e267"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "85ffc622d03785ad37dae842e9c8ae04c1b6630faafa03e646e4cbbb3a972497"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "ce12331e75676e8b9b8b979fb867278ce772c51e2c23e038c14745379efb89fb"
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
