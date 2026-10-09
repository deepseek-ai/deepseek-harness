---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-ptc-operation-metadata

[English](2026-10-05-ptc-operation-metadata.md) | 中文

## 概述

为持久化的嵌套 PTC 工具结果增加可选的纯展示元数据，使历史保留操作时的目录和文件目标。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-ptc-operation-metadata
baseline: false
changes:
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-16-session-format-v4"
    after: "d66e11dddf5dfa3c71547e2cbd7b0608824cd8d6243fc16f532017ff28e8fba5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有 meta 的已有 tool/ptc-dispatch 记录仍然有效。可选 JsonValue 字段不改变程序读取的规范值、模型可见内容、工具标识或消息顺序。没有记录相对文件目标的历史调用仍安全地禁用导航。写入版本和已接受基线保持 V4。

<a id="verification"></a>
## 验证

963 个定向测试通过，六个受影响 runtime/UI 源文件逐文件覆盖率 100%；实际嵌套 shell 与相对文件操作回归、冻结元数据控制、TypeScript SDK 45 个测试、Python SDK 29 个测试及三个 owning keyless refresh/replay 通过。

<a id="dev-note"></a>
## 开发备注

无。
