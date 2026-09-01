---
description: "为必须限制返回上下文量的工具提供有界的面向模型输出：项与文本 retainer，以及标准化的省略页脚。"
kind: "package-library"
---

# @deepseek-ai/dsh-output-retention

[English](README.md) | 中文

## 概述

`dsh-output-retention` 限制工具返回给模型的上下文量：调用方把项或文本分片送入 retainer，然后取回保留的内容与精确的省略元数据。`ItemRetainer` 以头部预算限制有序逻辑单元列表（路径、匹配项、来源）；`TextRetainer` 以 head、tail 或 head+tail 窗口限制面向字节的文本流，并在每个切割处保持 UTF-8 边界有效。标准化的省略子句与通知格式化器让工具获得一致的「结果已达上限」页脚，而恢复指引由工具自己提供。该库只回答「保留了什么、省略了什么」这个机制问题——分组、行号、spill 文件与提供方错误状态都留在工具侧。它是轻依赖库，由工具包直接导入；`cordis.yml` 无法加载它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

凡是工具必须限制其结果到达模型的数量、并如实报告丢弃内容的地方，都使用 retainer。有序逻辑单元选 `ItemRetainer`，面向字节的流选 `TextRetainer`。

### 限制项列表

```ts
import { ItemRetainer } from '@deepseek-ai/dsh-output-retention'

declare const globMaxResults: number
declare const candidates: AsyncIterable<{ path: string }>
const retainer = new ItemRetainer<{ path: string }>({ kind: 'head', maxItems: globMaxResults })
for await (const entry of candidates) {
  retainer.push(entry)          // keep draining past the cap for an exact count
}
const { items, truncated, omitted } = retainer.finish()
```

`push()` 逐项报告该项是否被保留，`finish()` 返回保留的项与 `omitted`——当调用方持续送入每个已观察单元时，这是一个精确计数。搜索工具可以收集完整结果集用于 spill 文件，同时只为模型保留第一页。

### 限制文本流

```text
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'

const out = new TextRetainer({ kind: 'headTail', headBytes: headCap, tailBytes: tailCap })
child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
const { text, omittedBytes } = out.finish()
```

`head`、`tail` 与 `headTail` 按字节而非字符或行计数：子进程管道与 HTTP 正文都是字节流。`finish()` 会在每个切割处修剪不完整的码点，因此返回的文本绝不会携带由切割引入的替换字符，码点也绝不会跨被省略的中间部分重建。

### 构建省略页脚

```ts
import { formatRetentionNotice } from '@deepseek-ai/dsh-output-retention'

declare const grepMaxMatches: number
declare const items: { length: number }
import type { Omitted } from '@deepseek-ai/dsh-output-retention'

declare const omitted: Omitted

const footer = formatRetentionNotice(
  { scope: 'grep', strategy: 'head', unit: 'items', limit: grepMaxMatches, kept: items.length, omitted },
  ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
)
```

库负责标准化省略子句（`Omitted 3 items.`）并把它与工具自有的恢复指引拼接；只有工具知道恢复动作，因此这些措辞由工具提供。

### `truncated` 意味着什么

`truncated` 是预算事实：retainer 因上限而省略了本可获得的内容。它绝不表示上游不完整——权限失败、跳过二进制文件、提供方部分失败与不可读候选项都留在工具领域字段中，绝不并入 `truncated`。

### 当前工具如何使用它

| 工具 | Retainer | 工具仍负责什么 |
|---|---|---|
| `glob` | `ItemRetainer`，`head` | spill 文件收集、路径映射、已跳过候选项、`incomplete` |
| `grep` | `ItemRetainer`，`head` | spill 文件收集、逐匹配预览截断、分组、排序 |
| `bash` | `TextRetainer`，`tail` 或 `headTail` | spill 文件、退出状态、信号、超时、后台任务 |
| `web_fetch` | `TextRetainer`，`head` 或 `headTail` | 提供方与资源上限、错误状态 |
| `web_search` | `ItemRetainer`，`head` | 「来源已达上限」通知措辞与提供方事实 |

`read` 不属于本库：它的行窗口分页（`offset`/`limit`、行号、`totalLines`）是文件专属渲染器，单个省略计数无法表示该窗口的两侧。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本库建立在一个分离之上：它负责「保留了什么、省略了什么」这个机制问题；业务含义全部归工具包所有。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ItemRetainer`、`TextRetainer`、`describeOmitted` 与 `formatRetentionNotice` |
| — | 不发布运行时不变式伴生入口；保留运算由单元测试覆盖。 |

### 两个 retainer，两种资源模型

`ItemRetainer` 限制有序逻辑单元，只保留前 `maxItems` 个；调用方持续送入每个已观察单元，因此省略计数是精确的。`TextRetainer` 用同一个前缀/后缀累加器限制字节：`head` 只留前缀，`tail` 只留后缀，`headTail` 两者都留；累加器在内存中至多持有 `headBytes + tailBytes + 一个分片`，因此大流不会无界累积。

### 预算事实如何保持诚实

`push()` 返回 `kept`（该单元或分片是否完整保留）与 `truncated`（是否已丢弃任何内容）。`finish()` 按实际返回的字节报告省略，因此丢弃部分码点字节的 UTF-8 边界修剪也会被计入——仅按预算推导的通知会高估保留文本。`describeOmitted` 只为 `exact` 打印计数；`unknown` 不打印计数，因为调用方没有提供。

### read 渲染的排除

`read` 的 `offset`/`limit` 分页是行窗口渲染器，对所选窗口有自己的字节上限；单个 `Omitted` 值无法表示该窗口两侧，因此它不属于本库。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要消费方或库背后的边界决策时，阅读以下页面。

- [工具结果保留库 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-tool-result-retention-library.zh.md)——库围绕工具语义划定的边界。
- [spill 策略](../../spill/spill-policy/README.zh.md)——组合 `TextRetainer`，围绕 spill 文件通知构建有界预览。
- [spill 子系统](../../../docs/subsystems/spill.zh.md)——本库预览机制所服务的 spill 词汇。
- [文件搜索工具](../../fs/tool-fs-search/README.zh.md)——为 spill 收集完整结果的 `ItemRetainer` 消费方。

-----

<a id="model-experience"></a>
## 模型体验

通过渲染保留内容与省略元数据的保留消费方间接影响模型。

#### KV Cache 影响

不会直接导致失效；请求前缀的任何变更由保留消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 retainer 刻意不覆盖什么。它们是当前包约束，不是任务积压。

- **项保留只支持 `head`**——tail、head/tail、分页、分组与提供方完整性语义仍归工具所有。
- **文本保留面向字节**——`read` 分页等行窗口与字符窗口需要单独的渲染器；切割可能丢弃部分 UTF-8 边界字节，以保持返回文本有效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
