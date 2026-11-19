---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-21-system-section-admissions

[English](2026-10-21-system-section-admissions.md) | 中文

## 概述

系统消息按来源 ID 标记规范文本及可选通知。活跃记录包含 order 和 contentIndex，包括空文本；退役记录省略这两个字段。压缩后，下一次模型尝试通过普通单节点替换清空后续系统消息并重置初始系统消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-system-section-admissions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "2719cd69e8ef5794adcb6ff3df522c33eff0b2677a122a0568d207a8e0147498"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "ce9404e050df94628d8c18d9dbae6e26503a072a7a3ddcff0a43e87f0ec8b6f4"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "1127571148780ee147ee31292fb43e0637b8e035e88f8759036458dfaae06545"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "ed3b0ee800e0ef9ab6ddd10cb18ac8ea2e866f624e599a5201ff7ddc74780c5d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-sdk-prompt-time-zone"
    after: "8fc8f70451996be0a0d33a548f23562ccb258fd7fed18c8e51b380e8d6777950"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有未归属消息仍可读取。不解释来源归属的读取方仍可保留段元数据对应的模型可见文本。延迟重建使用开放步骤内已有的 system/message 事件和已有的单节点替换操作。不需要额外事件、消息投影或关系校验例外；已发布的 V4 读取方可以接受这些写入。Session 格式版本仍为 V4。系统准入投影状态版本递增，以从日志恢复待执行的压缩重建及当前头节点。 退役记录按名称移除来源，不读取 order；包含 order 的旧退役记录仍可读取。

<a id="verification"></a>
## 验证

[规范信封测试](../../packages/core/session/tests/canonical-envelopes.spec.ts)覆盖来源元数据校验。[JSONL 准入测试](../../packages/session/session-persistence-jsonl/tests/system-rebuild-admission.spec.ts)验证普通及压缩原生读写、已发布 V4 的关系校验、中断的清理前缀，以及拒绝开放步骤之外的系统替换。这些专项测试已在本地通过。

<a id="dev-note"></a>
## 开发备注

无。
