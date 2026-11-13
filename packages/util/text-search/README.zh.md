---
description: "面向为内存列表添加搜索框或过滤器的维护者，说明多语言模糊搜索索引。"
kind: "package-library"
---

# dsh-util-text-search

[English](README.md) | 中文

## 概述

Web 客户端中的所有内存搜索列表，以及为其提供数据的 Host 列表（例如 `@` 会话候选项），都使用同一个搜索索引。它实现[客户端搜索规则](../../client/AGENTS.md#search-and-filter)：结果按当前语言显示，匹配覆盖所有已声明的语言以及用户可用来识别条目的每个字段，并且匹配是模糊匹配。名称匹配使用 [fuzzysort](https://github.com/farzher/fuzzysort)，并固定到精确版本。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务也不是插件**：无 `ctx`，也不注册任何东西。每个索引由调用方持有；浏览器打包产物会内联本包。

```ts
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { localizedValues, TextSearchIndex, type SearchKeys } from '@deepseek-ai/dsh-util-text-search'

interface Row { readonly id: string; readonly meta?: { readonly title?: LocalizedText; readonly description?: LocalizedText } }
const keys = (row: Row): SearchKeys => ({
  fuzzy: [row.id, ...localizedValues(row.meta?.title)],
  substring: localizedValues(row.meta?.description),
})

const rows: readonly Row[] = [{ id: 'plugin-filter', meta: { title: { en: 'Plugin filter', zh: '插件筛选' } } }]
const index = new TextSearchIndex(rows, keys)
const shown = index.search('筛选')

const next = index.update([...rows, { id: 'session-search' }], keys)
```

列表变化时构建索引，每次按键时调用 `search`；React 组件在 `useMemo` 中基于列表构建索引。列表频繁变化时（例如回复运行期间侧边栏的会话列表），保留上一个索引，并用完整的新列表调用 `update`。把简短的标识文本（名称、标题、标签、可读 id）放进 `fuzzy`，把较长的文本或不透明 id（描述、提示词、路径、UUID）放进 `substring`。本地化值要传入它的所有语言，而不是解析后的显示字符串。

-----

<a id="api"></a>
## API

| 导出 | 角色 |
|---|---|
| `new TextSearchIndex(items, keys)` | 对每个条目调用一次 `keys`，并预处理每个键字符串。索引按引用持有 `items`；调用方不得修改该列表及其中的条目。 |
| `index.search(query)` | 查询为空白时直接返回构建时的列表本身。否则按空白字符拆分查询，保留每个查询词都能匹配至少一个键的条目，并先按总分、再按构建顺序排序。 |
| `index.update(items, keys)` | 基于完整的新列表返回一个新索引；新增、删除、重排和键的变化都由这份列表表达。本索引已预处理的键字符串会被复用，不再被任何条目使用的字符串会被丢弃，本索引仍然有效。 |
| `localizedValues(text)` | `LocalizedText` 的所有语言值；参数为 `undefined` 时返回 `[]`。 |
| `SearchKeys` | `{ fuzzy?, substring? }`；`undefined` 和空值永远不会匹配。 |

匹配规则：

- 两类键和查询都先经过 NFKC 规范化、去除拉丁式变音符号（U+0300–U+036F）和字母笔画、转为小写，再进行比较，因此 `web` 匹配 `ＷＥＢ`，`lodz` 匹配 `Łódź`。在其他文字中会改变字母的附加符号（如假名浊音符号）保持不变。只由被去除的附加符号组成的查询词会被忽略。
- 查询词是某个 **`fuzzy`** 键的子串，或是该键的 fuzzysort 子序列且该子序列从词首开始（分隔符之后、驼峰命名的大写字母处，或任一 CJK 字符处）时，该键匹配，因此 `cpt` 匹配 `compact`，但 `fab` 不匹配 `Refactor build`。
- 只有查询词是某个 **`substring`** 键的连续子串时，该键才匹配。分散在一句话中的子序列不算匹配，因此 `invoice` 不会匹配无关的任务提示词。
- 每个查询词按档位计分，依次为：`fuzzy` 键前缀、`fuzzy` 键子串、模糊子序列（按 fuzzysort 分数）、`substring` 键命中；分数相同时保持构建顺序。

<a id="model-experience"></a>
## 模型体验

无，因为这个包为搜索框过滤调用方拥有的列表，不注册任何面向模型的内容。

#### KV Cache 影响

无；任何请求内容都由消费方拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不容忍拼写错误**：字母调换或写错（`pluign`）时不会匹配；fuzzysort 只匹配子序列。
- **字典文案只匹配一种语言**：客户端语言字典通过 `t()` 只解析当前语言，因此标签来自这些字典的列表（例如内置 `/` 命令和快捷键名称）只能按当前语言匹配这些标签。这些条目的名称仍可按所有语言匹配。
- **插件市场和文件 `@` 搜索各自独立**：插件市场在 Host 上维护自己的 MiniSearch 索引，文件引用保留自己的路径排序；两者处理的列表都比本包面向的列表更大。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

fuzzysort 固定到精确版本，因为它的分数决定所有搜索列表的顺序；升级会改变用户可见的排序，必须同时更新受影响的测试。

</details>
