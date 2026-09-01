---
description: "供运行时包使用的无损 JSON 校验、分离式快照、深度冻结、结构相等与穷尽联合类型辅助函数。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-values

[English](README.md) | 中文

## 概述

`dsh-util-values` 为运行时包提供统一的无损 JSON 值、不可变对象图、JSON 结构相等和封闭联合类型穷尽失败实现。调用方可以校验不受信任的值、分离 JSON 快照、冻结待发布值、比较 JSON 兼容数据，或终止不可达分支，而无需导入某个能力包。这些 helper 不持有共享注册表、constructor identity 或可变模块状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 校验 JSON 数据或创建快照

需要 predicate 时使用 `isJsonValue()`，还需要分离副本时使用 `snapshotJsonValue()`。两者只接受无损 JSON 根值：`null`、布尔值、除负零外的有限数字、字符串、稠密的内建数组，以及只含可枚举字符串键的普通或 null-prototype 记录。循环、稀疏数组、自有 symbol 或不可枚举属性、函数和 class 实例都会被拒绝。

```ts
import { isJsonValue, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

declare const input: unknown

if (!isJsonValue(input)) throw new TypeError('expected lossless JSON')
const snapshot = snapshotJsonValue(input) as JsonValue
```

### 发布或比较值

`deepFreeze(value)` 原地冻结对象图并返回同一个值。它遍历可枚举字符串键的子项，并刻意让活跃 `AbortSignal` 对象保持可变。`deepEqualJson(a, b)` 按结构比较 JSON 兼容数组与记录；调用方必须先校验敌意或无约束输入，再进行比较。

### 封闭可辨识联合类型

在封闭可辨识联合类型的 default 分支中使用 `assertNever(value, context?)`。新增变体会让每个穷尽 switch 在 TypeScript 编译时失败；如果某个运行时值逃过了声明类型，该函数会抛出带可选上下文标签的错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

JSON 校验器使用显式工作栈，并只跟踪当前祖先链，因此深层嵌套值不会消耗 JavaScript 调用栈，重复但无循环的引用仍然有效。快照写入使用自有数据属性，包括 `__proto__` 等名称。其他 helper 的结果只取决于传入参数，不在调用之间保留状态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | JSON 值类型、校验与快照遍历、结构相等、深度冻结和穷尽联合类型失败 |
| — | 不发布运行时不变量伴生入口；这些值操作没有共享运行时状态，其代数行为由单元测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包映射](../README.zh.md)——相邻的无状态 helper。
- [会话子系统](../../../docs/subsystems/session.zh.md)——要求无损 JSON 的持久事件。
- [工具子系统](../../../docs/subsystems/tools.zh.md)——构建于 `JsonValue` 之上的 schema 校验与规范工具结果。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **`deepEqualJson` 假定输入兼容 JSON**——它不是通用对象比较器，不为 prototype、symbol、accessor、循环、map 或 set 定义语义。
- **`deepFreeze` 沿可枚举字符串键遍历子项**——它不会把任意宿主对象变成不可变数据，并会刻意跳过活跃 `AbortSignal` 实例。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
