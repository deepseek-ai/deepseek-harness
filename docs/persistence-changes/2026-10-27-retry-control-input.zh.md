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

更新后的读取方继续接受没有重试控制输入的旧日志。旧读取方会拒绝未知必读 agent/retry 事件，不会将重试当作普通用户内容。retry 判别标签也将排队控制输入与普通空用户消息区分开。API 与两套 SDK 消费方同步更新；事件及来源判别标签可阻止不安全解释，因此保留当前 Session 格式版本。

<a id="verification"></a>
## 验证

源码审查确认控制输入保留现有 inbox 和轮次生命周期，agent/retry 不携带模型表面操作。回归用例覆盖连续重试、输入身份关联、轮次闭合、普通空消息、拒绝非空重试、去重、检查点回放、浏览器行为及两套 SDK 恢复录制。执行验证将在 push 后进行。

<a id="dev-note"></a>
## 开发备注

无。
