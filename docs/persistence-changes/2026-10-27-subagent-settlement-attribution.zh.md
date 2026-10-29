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
    previous: "2026-10-22-action-card-status"
    after: "5f92518a550044ad3ff53f03999a6ed8ae4764e0f015566b455c2f12a0e41dd5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "e70de3d63264af6361a5a4aa05e5e3b135beb18c2d10570591351a49c7e4459a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "081bd58df6366694fc756ec83b60f50d74e480961d8b704d2cce1d78ebe61767"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "d38ac42ecf965f34848ccb4f04e21e79455e1478685b916a152392e74ca5b62b"
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
