---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-retry-control-input

[English](2026-10-27-retry-control-input.md) | 中文

## 概述

新增显式 retry 控制来源与必读 agent/retry 接受事件，关联持久 inbox 身份、轮次和步骤。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-retry-control-input
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "a6d8c25f4b2ca2d137672a8a278ee1398df3f3cb60f5d32d8e3007c68299b664"
    decision: same-version
  - root: "event:agent/retry"
    previous: null
    after: "d8dde9629b7323b03c1c3fb0db75d6b72c73666dc0240ab7d3e41b9c0c40fc7c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "92b82e8b7bbb38b3adeb2c07eb76d0f0e0d18c1729808def7004ac2bc9baa583"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "fb28ad7d7aabceb5bda505cf027e0e22354d7f31757337e7e51a4b592feac172"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "c5bbcb3435908af2036df7105883e0a49c30ecc1fae4420aa5c4cf944066eff5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

更新后的读取方保留旧日志含义和普通空用户消息准入。旧读取方会在追加或尾部修复前拒绝新的必读 agent/retry 事件。接受前的排队控制输入仍采用现有带身份的空 UserMessage 表示；旧 Loop 可按其普通空输入行为消费，保留 inbox 身份且不增加用户文本。API 与两套 SDK 消费方同步识别重试控制输入及接受事件。保留当前 Session 格式版本；更新后的读取方可读取普通消息与重试事件混合的日志。

<a id="verification"></a>
## 验证

AgentLoop、Agent、Session API 与 SDK 服务端定向测试通过：91 个文件、1806 个测试，agent.ts 和 continuation.ts 的语句、分支、函数及行覆盖率均为 100%。浏览器继续回放与 TypeScript/Python SDK scheduler-recovery 回放通过；断言保留一条原始用户消息、关联重试输入身份、保留工具结果且新轮次正常闭合。当前事件与原生来源准入测试覆盖未知必读事件在不修改数据的情况下拒绝，以及保留可扩展来源元数据。构建、聚合检查和类型感知 lint 通过。doc-sync 有 42 项通过；剩余仓库引用失败来自未改动的 python/sdk/uv.lock:113 提交哈希。

<a id="dev-note"></a>
## 开发备注

无。
