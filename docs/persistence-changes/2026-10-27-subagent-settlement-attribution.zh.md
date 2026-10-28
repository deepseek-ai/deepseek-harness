---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-subagent-settlement-attribution

[English](2026-10-27-subagent-settlement-attribution.md) | 中文

## 概述

为持久化的子代理结算通知增加可选 stopReason 与 description 归属信息，保持 Session 格式版本不变。

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
    previous: "2026-10-22-action-card-status"
    after: "a26f50177e43e7892b52fed205add6a62a3a0649b93a121443d09e1498e1d865"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "00ee56a8408b42c3988c2cca342ce1b1191357ccbb867113aa74662221e453e8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "898ef1afce2be676fa929a4d4767966a3825eca1afd8aa383111b6540b957a3a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "64a07eec513ce4f40a6ae89d916665abfb4f803a9e9bb801f24005098961e333"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受缺少任一字段的历史通知，不得从英文摘要推断缺失值。写入方始终记录已捕获执行的确切 stopReason，仅在已知结算 activation 的原始任务标签时写入 description。本地 activation 在冷恢复后保留 descriptor 标签，外部 activation 保留提交的标签。旧读取方保留额外的 source 元数据，继续使用已有 kind、notice form、summary、senderSessionId 和未改变的内容；原生 V4 source 准入校验生产方 kind，不拒绝额外归属字段。新元数据只影响展示，不影响回放、权限或恢复。无需迁移或提升 Session 版本。

<a id="verification"></a>
## 验证

定向 Vitest 检查通过：continuation-messages.spec.ts（15 个测试）、external-activation.spec.ts（19 个测试）、continuation-messages-adapter.spec.ts（1 个测试）和 continuation.spec.ts（166 个测试），均位于 packages/subagent/subagent/tests。命令为 pnpm exec vitest run 加上述测试文件路径。覆盖五种终止原因、未知及空描述、不进行推断的历史归属、外部清理失败时保留捕获的执行原因、冷恢复标签保留，以及不变的 DeepSeek Messages 协议内容。持久化分类器报告四个事件根中的八项可选属性新增，均未标记为需要兼容性审查。历史 Session 代际保持不变；受影响的当前格式快照预期包含新增元数据。

<a id="dev-note"></a>
## 开发备注

无。
