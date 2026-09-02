---
description: "供拥有易混淆领域值的包使用的名义字符串与数字类型及无状态构造函数。"
kind: "package-library"
---

# @deepseek-ai/dsh-brand

[English](README.md) | 中文

## 概述

`dsh-brand` 让结构相同的字符串或数字在类型层面不可互换：`SessionId` 无法传给期望 `ToolCallId` 的位置，事件序号也无法传给需要日志偏移量的位置。`brandString<T>()` 与 `brandNumber<T>()` 在不持有共享运行时状态的情况下应用名义品牌，让所属包可以定义领域类型，而无需导入不相关的能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当领域值跨越包边界，并可能与使用同一原语表示的另一个值混淆时，为其添加品牌；并非每个字符串或数字都需要品牌。品牌化值是给 TypeScript 调用方的约定：它只会进入期望该领域的函数，不同品牌会在编译期被拒绝。

### 为字符串添加品牌

在所属包中声明品牌化类型，并在该包准入字符串的位置应用品牌：

```ts
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>

const sessionId = brandString<SessionId>('session-1')
```

`brandString()` 只改变静态类型，不执行运行时校验。所属类型若有领域文法，应在调用前完成校验。添加品牌后，该 id 与普通字符串一样比较、记录日志、序列化为 JSON 和跨 wire 传输。

### 为数字添加品牌

在所属包中声明数字品牌，并且仅在该包准入数字之后应用品牌：

```ts
import { brandNumber, type BrandedNumber } from '@deepseek-ai/dsh-brand'

export type SessionSeq = BrandedNumber<'SessionSeq'>

const seq = brandNumber<SessionSeq>(7)
```

`brandNumber()` 原样返回数字，不执行校验。所属包会在添加品牌前校验非负安全整数范围等要求。比较、算术、日志、JSON 序列化与 wire 传输保留普通数字行为；算术会产生未品牌化数字，所属包必须重新准入该数字，才能让它再次进入领域。

### 何时添加品牌

为跨包边界且可能被混淆的值添加品牌——`dsh-llm` 中的 `ToolCallId`、`dsh-session` 中共享的 agent/会话 `SessionId`、`dsh-jobs` 中的 `JobId`，以及 `dsh-session` 中的 `SessionSeq` 与 `SessionLogOffset`。保持局部或无法混淆的值不需要这种抽象。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该包定义两个交叉类型：`string & { readonly [BRAND]: B }` 与 `number & { readonly [BRAND]: B }`，其中 `BRAND` 是模块私有的 `unique symbol`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 品牌化字符串与数字类型及其无状态构造函数 |
| — | 不发布运行时不变量伴生入口；擦除由编译器保证。 |

### 值为何可移植

私有 symbol 在运行时不存在：TypeScript 会将其擦除，因此品牌化值没有标签或 prototype。`brandString()` 与 `brandNumber()` 都原样返回输入。因此，彼此独立安装的副本无需共享注册表或 constructor identity，也会生成可互换的值。

### 为何保持无依赖

把这些 helper 放在独立包中，意味着 `dsh-jobs` 可以为 `JobId` 添加品牌，而无需导入不相关的能力包；每个能力仍然拥有其具体 id 的含义与校验。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要这些原语所品牌化的值或围绕它们的类型约定时，阅读以下页面。

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
