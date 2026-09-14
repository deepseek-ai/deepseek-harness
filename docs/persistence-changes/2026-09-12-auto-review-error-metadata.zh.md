---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-12-auto-review-error-metadata

[English](2026-09-12-auto-review-error-metadata.md) | 中文

## 概述

为持久化的 PTC dispatch 增加可选的结构化错误元数据，并为持久化的原生工具错误增加可选的用户可见理由。两项新增字段均保持 Session 格式版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-12-auto-review-error-metadata
baseline: false
changes:
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-11-initial"
    after: "b5d66eaebed4da391b13498623b11142222149fbf5e025975dbc6d94f0d06796"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-11-initial"
    after: "3a803805bdeb805f32b229e399fb7258be8e32a89f89063a7c99957cfea942f7"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 tool/ptc-dispatch 事件可以省略 error，已有 tool/result 错误可以省略 reason。PTC dispatch 事件不进入模型历史；原生工具结果回放只投影 data.message，不包含错误元数据。旧读取方可以忽略新增字段，不改变模型回放。当前 Web 读取方接受缺失的理由，并且只有记录中的错误标识匹配时才显示 Auto review 拒绝详情。权限模式在已有事件中仍为字符串；选择 auto 不引入已声明持久化类型的变更。Session header、事件信封和已有值类型均未改变，无需相邻迁移。

<a id="verification"></a>
## 验证

pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts 通过 64 个测试。权限、Auto review、工具执行、agent loop（智能体循环）、subagent 继承和 TypeScript SDK 的定向测试共 10 个文件、390 个测试通过，覆盖原生与 PTC 拒绝元数据。uv run --python 3.10 --group test --project python/sdk pytest python/sdk/tests/test_client.py -k preserves_auto_review_errors 通过 1 个测试。持久化预览仅识别出这两项可选字段新增，均无需提升版本。

<a id="dev-note"></a>
## 开发备注

无。
