---
description: "供拥有跨包标识符的包使用的名义字符串类型与无状态构造函数。"
kind: "package-library"
---

# @deepseek-ai/dsh-brand

[English](README.md) | 中文

## 概述

`dsh-brand` 让结构相同的字符串在类型层面不可互换：即使 `SessionId` 与 `ToolCallId` 在运行时都是普通字符串，前者也无法传给期望后者的位置。`brandString<T>()` 为领域拥有的字符串应用名义品牌且不持有共享运行时状态，让能力包可以拥有自己的具体 id 类型，而无需导入不相关的能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当包拥有的 id 跨越包边界、并可能与其他包的 id 混淆时，为其添加品牌；并非每个字符串都需要品牌。品牌化 id 是给 TypeScript 调用方的约定：它只会进入期望它的函数，来自其他包的 id 会在编译期被拒绝。

### 为字符串添加品牌

在所属包中声明品牌化类型，并在该包准入字符串的位置应用品牌：

```ts
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>

const sessionId = brandString<SessionId>('session-1')
```

`brandString()` 只改变静态类型，不执行运行时校验。所属类型若有领域文法，应在调用前完成校验。添加品牌后，该 id 与普通字符串一样比较、记录日志、序列化为 JSON 和跨 wire 传输。

### 何时添加品牌

为跨包边界且可能被混淆的 id 添加品牌——`dsh-llm` 中的 `ToolCallId`、`dsh-session` 中共享的 agent/会话 `SessionId`、`dsh-jobs` 中的 `JobId`、`dsh-lsp` 中的 `LspProviderId`。从不离开所属包的字符串不需要这种抽象。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该原语是一个交叉类型：`string & { readonly [BRAND]: B }`，其中 `BRAND` 是模块私有的 `unique symbol`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 品牌化字符串类型及其无状态构造函数 |
| — | 不发布运行时不变量伴生入口；擦除由编译器保证。 |

### 值为何可移植

私有 symbol 在运行时不存在：TypeScript 会将其擦除，因此品牌化值没有标签或 prototype。`brandString()` 原样返回输入。因此，彼此独立安装的副本无需共享注册表或 constructor identity，也会生成可互换的值。

### 为何保持无依赖

把这些 helper 放在独立包中，意味着 `dsh-jobs` 可以为 `JobId` 添加品牌，而无需导入不相关的能力包；每个能力仍然拥有其具体 id 的含义与校验。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要本原语所品牌化的 id 或围绕它的类型约定时，阅读以下页面。

- [核心子系统](../../../docs/subsystems/core.zh.md)——共享 `SessionId` 品牌与类型规则的记录位置。
- [LSP 子系统](../../../docs/subsystems/lsp.zh.md)——构建在本原语之上的品牌化提供方 id `LspProviderId`。
- [jobs 包](../../jobs/jobs/README.zh.md)——由 jobs 能力拥有的 `JobId` 品牌。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
