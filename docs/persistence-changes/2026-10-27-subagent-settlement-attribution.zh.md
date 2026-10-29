---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-subagent-settlement-attribution

[English](2026-10-27-subagent-settlement-attribution.md) | 中文

## 概述

为持久化的子代理结算通知增加可选 stopReason 归属信息，保持 Session 格式版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-subagent-settlement-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "ddce54a3873dc57113b0cd38ad9b23b3c259186139e8847e5e5f415d86f52482"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "70ea8e7943c5e2d76905bcc2e694e8c3d5b138aaae3609f3e261b8d369a6e35a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d95c624eddecdacf1ee74356196c09d2f3fcd625714be5e852a6b643fa12a7ca"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "dcb07e04496586d2664d72dab0e94312917da56927b2a0dc3ee53d6a33e32450"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受缺少 stopReason 的历史通知，不得从英文摘要推断该字段。写入方始终记录已捕获执行的确切 stopReason。旧读取方保留额外的 source 元数据，继续使用已有 kind、notice form、summary、senderSessionId 和未改变的内容；原生 V4 source 准入校验生产方 kind，不拒绝额外归属字段。新元数据只影响展示，不影响回放、权限或恢复。无需迁移或提升 Session 版本。

<a id="verification"></a>
## 验证

定向 Vitest 运行通过：continuation-messages.spec.ts（14 个测试）、external-activation.spec.ts（19 个测试）、continuation-messages-adapter.spec.ts（1 个测试）和 continuation.spec.ts（166 个测试），均位于 packages/subagent/subagent/tests。命令为 node node_modules/vitest/vitest.mjs run，后接上述测试文件路径。覆盖全部五种终止原因、历史归属信息不作推断、外部清理失败保留已捕获的执行原因、冷恢复，以及不变的 DeepSeek Messages 线协议内容。历史 Session 代际保持不变；受影响的当前格式快照预期包含 stopReason。

<a id="dev-note"></a>
## 开发备注

无。
