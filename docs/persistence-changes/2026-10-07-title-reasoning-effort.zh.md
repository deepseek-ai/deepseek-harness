---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-title-reasoning-effort

[English](2026-10-07-title-reasoning-effort.md) | 中文

## 概述

记录辅助会话标题请求选择的具体推理强度。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-title-reasoning-effort
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-10-05-working-directory-attribution"
    after: "b33545b3244861bcbf73b407d24b53402710f5acacab7ae939537e5504a68dc6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增 reasoningEffort 字段为可选。现有 V4 记录仍有效，继续保留其未记录强度的事实。路由提供可选推理强度时，已准备的标题请求写入解析后的强度；无需提升 Session 格式版本。

<a id="verification"></a>
## 验证

LLM、适配器、标题提供方与回放的定向测试通过：50 个文件、1960 个测试。session-title-after-turn SDK 快照通过，记录从默认 high 的路由中选出的 low 强度。

<a id="dev-note"></a>
## 开发备注

无。
