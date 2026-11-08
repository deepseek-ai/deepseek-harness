---
description: "无依赖的 HarnessError 基类，其稳定 code 让工具结果、重试与回放能够按失败类别路由。"
kind: "package-library"
---

# @deepseek-ai/dsh-error

[English](README.md) | 中文

## 概述

`dsh-error` 存放 `HarnessError`，即所有预期 Harness 失败的基类。`HarnessError` 在人类可读的 `message` 与可选的 `cause` 之外，携带稳定、可供机器路由的 `code`，其 `name` 为构造它的类名。工具注册表会把抛出的 `HarnessError` 的 `name` 与 `code` 记录到 `tool/result` 上，使重试策略、UI、回放与数据分析按 code 路由，而不必解析文本。本包没有任何依赖，因此依赖图中位于 `dsh-llm` 之下的包也能继承该基类；`dsh-llm` 会重新导出同一个类。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

每个所属包或领域继承出一个 `HarnessError` 子类，并为每种失败指定稳定的 `UPPER_SNAKE_CASE` code：

```ts
import { HarnessError } from '@deepseek-ai/dsh-error'

export class ArchiveError extends HarnessError {}

throw new ArchiveError('archive entry is missing', 'ARCHIVE_ENTRY_NOT_FOUND')
```

打包工具可能重命名类时，在子类构造函数中把 `this.name` 赋为字符串字面量，因为 `name` 会被持久化。可以从 `@deepseek-ai/dsh-error` 导入该类，也可以使用 `@deepseek-ai/dsh-llm` 的重新导出；两者是同一个类，因此 `instanceof` 判断结果一致。[错误类与 code 指南](../../../.agents/skills/dsh-error-handling/references/error-codes.md)规定了类的选择、命名与 code 约定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `HarnessError` 基类 |

### 为什么保持无依赖

`dsh-llm` 依赖 `dsh-attachment`、`dsh-typert-protocol` 等更底层的包，定义在其中的基类无法被这些包继承，否则会形成依赖环。把该类放在没有依赖的包中，所有包都可以继承它；[决策记录](../../../.agents/notes/implemented/architecture/2026-11-05-harness-error-dependency-free-base.zh.md)记录了这次迁移。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具子系统](../../../docs/subsystems/tools.zh.md) — 注册表如何根据抛出的 `HarnessError` 记录 `ToolErrorInfo`。
- [错误处理规则](../../../.agents/skills/dsh-error-handling/SKILL.md) — 何时必须抛出 `HarnessError`。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

无。

</details>
