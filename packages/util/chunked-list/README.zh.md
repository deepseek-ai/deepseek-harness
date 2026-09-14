---
description: "用于 projection state 的不可变的仅追加列表，提供有界追加复制、按插入顺序迭代和 Zod 检查点校验。"
kind: "package-library"
---

# @deepseek-ai/dsh-chunked-list

[English](README.md) | 中文

## 概述

`dsh-chunked-list` 让调用方追加值并保留早期列表版本，无需复制整个集合。调用方可以按插入顺序迭代所有值，并使用自己的值 schema 校验 JSON 检查点。subagent 目录用它保存不可变的 projection state。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

当仅追加集合需要不可变版本和兼容 JSON 的存储时，使用此列表。空列表用 `undefined` 表示；追加返回新的头节点，不修改已有节点。列表按引用共享所存的值，因此调用方必须将这些值视为不可变。

```ts
import { appendChunkedList, iterateChunkedList } from '@deepseek-ai/dsh-chunked-list'

const first = appendChunkedList(undefined, 'first')
const second = appendChunkedList(first, 'second')
console.log([...iterateChunkedList(second)])
```

示例输出 `['first', 'second']`；`first` 仍只包含原来的值。`chunkedListSchema(valueSchema)` 校验 JSON 检查点并拒绝未知字段、无效值和空分片或超大分片。当外层字段也允许空列表时，在 schema 上使用 `.optional()`。各操作详见[源码约定](src/index.ts)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

最新的分片最多存储 64 个值。追加最多复制该分片并共享较旧的节点，工作量为有界 O(1)。容量控制存储布局，不限制列表总长度。迭代以 O(N) 时间访问全部 N 个值，并使用 O(N / 64) 临时空间按从旧到新的顺序访问各分片。追加换片与递归 Zod 校验共用一个容量常量。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 持久化列表操作与检查点校验 |
| [`tests/chunked-list.spec.ts`](tests/chunked-list.spec.ts) | 版本隔离、顺序、结构共享与检查点接受条件 |

此库没有独立变化的观测值，因此不发布运行时不变式伴随模块；其操作返回调用方拥有的不可变值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包映射](../README.zh.md)——共享原语。
- [Subagent 目录决策](../../../.agents/notes/implemented/architecture/2026-09-01-parent-owned-subagent-catalog.zh.md)——projection state 使用分片的原因。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此集合不注册任何面向模型的内容。

#### KV Cache 影响

本包没有内容进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅追加访问**——需要删除或随机访问的调用方应使用其他集合。
- **递归检查点**——JSON 序列化与 schema 校验仍受运行时嵌套深度限制。所存的值本身必须支持调用方的序列化格式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
