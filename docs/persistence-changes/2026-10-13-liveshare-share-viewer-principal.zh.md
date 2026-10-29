---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-liveshare-share-viewer-principal

[English](2026-10-13-liveshare-share-viewer-principal.md) | 中文

## 概述

为分享读者提交的提示词，在 user-rpc 消息来源中加入 LiveShare 的 share-viewer principal；Relay 断言了显示名时一并保存。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-liveshare-share-viewer-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "cdf988172b589b230f2bce868489def1bb575eb0501076ac757a8f369ac5c64e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "70d2acdec1ebcfea56d02f7233ebb9ec0f7f494447fb952884c22c3afdc01d6f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "2e505098f9209e52eebd577f1a6f9d4e773ec4d78987aff28a7c786442b9f54c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-25-skill-catalog-incomplete"
    after: "5bb231bc5afdb532a6898a20604e76bf0c1db438bfcdc17d4847dceaddc02451"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

只有 LiveShare 分享读者的 Peer 提交提示词时才写入 share-viewer 变体；所有者的提示词仍不写 principal，因此其来源与所有已有会话日志都不变。该值含分享 ID 和 Relay 断言的 provider、tenant、subject ID；Relay 断言了显示名时还包含可选的 displayName，仅供展示。凭据与头像永不持久化，授权仍只使用身份三元组；不认识该可选字段的读取方继续显示持久化的 subject id。LiveShare Host 在两个地方消费它：`agent/pre-step` 准入校验会为每条带分享查看者 principal 的进入消息重新读取 Relay 授权，授权不再成立时拒绝该步骤；同一步骤还会在当前轮次的内存状态中记录该轮次由查看者发起，使该轮次只运行共享工具面，而所有者自己发起的轮次保留会话原生工具。该标记不写入会话日志，并从下一个准入步骤重新计算。未装 LiveShare 的构建因 kind 仍为 'user' 而照常把它当作普通用户消息；本包不驱动的 principal 种类交由驱动它的插件处理。当前读取方读取旧日志时找不到 share-viewer principal，与以往一样把这些提示词当作普通输入放行。该字段不进入任何模型请求。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/liveshare/tests/relay-target-admission.host.spec.ts packages/experimental/liveshare/tests/relay-pre-step-admission.host.spec.ts packages/experimental/liveshare/tests/share-host-listeners.spec.ts packages/experimental/liveshare packages/experimental/liveshare-protocol：分享读者的提示词在 agent/inbox/spliced 中持久化 source.principal，恢复的读者输入在 `agent/pre-step` 准入校验中被拒绝，已准入的输入进入模型，本包不驱动的 principal 种类不受影响；可选 displayName 仅用于展示，只接受非空字符串，缺失或非法值回退 subject id；35 个测试通过，另有 LiveShare 与协议两个包的全量测试。

<a id="dev-note"></a>
## 开发备注

无。
