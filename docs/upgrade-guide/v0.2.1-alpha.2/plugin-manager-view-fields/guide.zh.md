---
kind: upgrade-guide
description: "@deepseek-ai/dsh-plugin-manager/operations 的 viewProfilePackage 需要传入它打印的清单字段。"
---

# `viewProfilePackage` 接收它打印的字段

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-plugin-manager/operations` 的 `viewProfilePackage(dir, spec, options)` 原先打印固定的字段列表：`name`、`version`、`description` 与 `dsh`。`PackageViewOptions` 现在要求 `fields`，即 `pnpm view` 打印的清单或注册表字段，使同一查询可以读取版本列表和各版本的 peer。直接调用 `viewProfilePackage` 的代码缺少 `fields` 时无法通过类型检查，省略它的 JavaScript 调用方会让 `pnpm view` 不带字段运行。

## 迁移

1. 传入调用原先打印的字段：

   ```ts
   import { viewProfilePackage } from '@deepseek-ai/dsh-plugin-manager/operations'

   declare const dir: string, spec: string, timeoutMs: number
   await viewProfilePackage(dir, spec, { fields: ['name', 'version', 'description', 'dsh'], timeoutMs })
   ```

2. 运行类型检查；缺少 `fields` 属性的每处调用都会被报告。
