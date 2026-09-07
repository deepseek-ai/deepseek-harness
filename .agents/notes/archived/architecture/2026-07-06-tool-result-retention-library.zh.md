# Agent Note: 工具结果保留库

Status: implemented
Archived: 2026-09-04

[English](2026-07-06-tool-result-retention-library.md) | 中文

## 问题

多个面向模型的工具已经限制其返回的上下文量，但每个工具都拥有不同的局部机制和词汇：bash 保留尾部并提供 spill 文件；web search 限制来源列表；web fetch 限制正文内容；`glob`／`grep` 发现工具需要在行内提供第一页，同时为完整结果集保留精确的省略元数据。单一的 `truncate(text)` 辅助函数无法覆盖这些情况：条目型工具需要条目计数，并在原语之外分组；文本型工具则需要字节预算和 UTF-8 安全的首尾裁切。

这些工具需要共享的抽象是**保留**，而不是通用集合。调用方向一个有界对象输入条目或文本分片，稍后取得保留内容与精确的省略元数据。工具专用代码仍负责业务语义：文件分组、行号、退出码、提供方错误状态、spill 文件和面向模型的说明。公共库只负责一个机械问题：「保留了什么，又省略了什么？」

## 决策

`@deepseek-ai/dsh-output-retention` 位于 `packages/util/` 下，与 `dsh-brand` 和 `dsh-timeout` 同级，负责有界的模型可见输出。它是一组纯类与函数构成的库，**不是** Cordis 服务或插件：不接收 `ctx`、不注册任何内容、不持有跨调用状态，也不发出事件。各工具包需要限制输出时直接导入它。

该库包含两个相互独立的 retainer：

- `ItemRetainer<T>` 处理有序逻辑单元，例如路径、grep 匹配项或搜索来源。它只支持 `head` 保留，同时维持 retainer 形态，以便未来加入其他保留策略。
- `TextRetainer` 处理面向字节的文本流，例如 bash stdout／stderr 或 web 响应正文。它支持 `head`、`tail` 和 `headTail` 保留，并在 `finish()` 时维持 UTF-8 边界。

两个 retainer 都会返回一个小型 `PushDecision`；每次调用 `push()` 后，调用方都能得知该单元／分片是否完整保留，以及累积结果此时是否已被截断。因为调用方会继续输入每一个已观察到的条目／分片，所以省略计数是精确的。

```ts ignore-check
/**
 * How much content the retainer omitted.
 *
 * `unknown` is reserved for callers that omit without a count; the retainers
 * themselves return `none` or `exact`.
 */
type Omitted =
  | { kind: 'none' }
  | { kind: 'exact'; count: number }
  | { kind: 'unknown' }

interface PushDecision {
  kept: boolean
  truncated: boolean
}

/**
 * Final result for ordered logical units.
 */
interface RetainedItems<T> {
  items: T[]
  truncated: boolean
  seen: number
  kept: number
  omitted: Omitted
}

/**
 * Final result for text streams.
 *
 * The returned `text` is safe to send to a formatter; the retainer does not add
 * tool-specific headers, exit markers, XML tags, or recovery instructions.
 */
interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: Omitted
}
```

### 策略

条目保留支持头部窗口。文本保留支持头部、尾部与首尾字节窗口。

```ts ignore-check
type ItemRetentionStrategy =
  | {
      /** Keep the first `maxItems` units. Use for `glob`, `grep`, and web sources. */
      kind: 'head'
      maxItems: number
    }

type TextRetentionStrategy =
  | {
      /** Keep the first `maxBytes` bytes. */
      kind: 'head'
      maxBytes: number
    }
  | {
      /** Keep the final `maxBytes` bytes. Requires reading to the end. */
      kind: 'tail'
      maxBytes: number
    }
  | {
      /** Keep a stable prefix and suffix, omitting the middle. Requires reading to the end. */
      kind: 'headTail'
      headBytes: number
      tailBytes: number
    }
```

### 工具映射

`read` 被有意排除在保留库之外。它的 `read-render` 辅助函数拥有文件专用的分页约定：`offset`／`limit`、行号、`totalLines`、offset 越界错误、逐行预览截断，以及能够在窗口中途停止扫描的所选输出字节上限。这是行窗口渲染器，不是通用保留原语。它未来可以共享中性的提示辅助函数，但不应把已经选定的窗口再传入 `ItemRetainer`。

下文的 `FsGlobEntry` 与 `FlatGrepMatch` 是预期由发现工具使用的条目形态，不是现有保留库的导出。`FsGlobEntry` 是一个由后端派生的路径；`FlatGrepMatch` 是后端将保留匹配项按文件分组之前的一条未分组 grep 匹配。

`glob` 收集完整的排序路径列表后，使用 `ItemRetainer<FsGlobEntry>`，并将其配置为 `{ kind: 'head', maxItems: globMaxResults }`。工具在行内保留第一页，并可以通过 spill seam 保存完整列表。路径映射、跳过的候选项与 `incomplete` 均位于 retainer 之外。

`grep` 在分组前使用 `ItemRetainer<FlatGrepMatch>`，并将其配置为 `{ kind: 'head', maxItems: grepMaxMatches }`。执行器解析 ripgrep 输出、映射路径、应用逐行预览截断，并输入扁平匹配项。调用 `finish()` 后，工具按文件对保留的匹配项分组；如果行内结果达到上限，还可以通过 spill seam 保存完整匹配列表。分组不属于 retainer，因为上限针对匹配总数，而不是文件数；逐匹配项的预览截断和 `incomplete` 也与结果级保留相互独立。

`bash` 可以使用 `TextRetainer`，配置为 `tail` 或 `headTail`，并读取至进程结束。bash 执行器仍负责 spill 文件、退出状态、信号、超时与后台任务行为；保留辅助函数只在需要该行为时替换临时实现的内存首尾核算。长时间运行任务的所有权与[通用长时间运行工具的运行时](2026-06-20-generic-long-running-tool-runtime.zh.md)相互独立。

`web_fetch` 可以使用 `TextRetainer`，配置为 `head` 或 `headTail`；如果提供方必须在内部读取和解码，也可以保留由提供方负责的正文上限。无论采用哪种方式，fetch 结果中的 `truncated` 仍是提供方／工具事实，该库只提供保留文本与省略元数据。

`web_search` 可以使用 `ItemRetainer<WebSearchSource>`，配置为 `head`。当前提供方通常返回数组，所以这属于事后处理，但仍能统一提示信息。

### 提示

该库公开一个中性的提示结构和一个小型格式化钩子，但面向用户的措辞由工具提供。grep 页脚会提示「缩小 pattern、path 或 include」；web fetch 页脚会提示「获取更具体的 URL 或章节」；bash 则可以指向 spill 文件。retainer 无法得知这些恢复操作。

```ts ignore-check
interface RetentionNotice {
  scope: string
  strategy: 'head' | 'tail' | 'headTail'
  unit: 'items' | 'bytes' | 'chars' | 'lines'
  limit: number | { head: number; tail: number }
  kept: number
  omitted: Omitted
}

const formatGrepNotice = (notice: RetentionNotice): string =>
  formatRetentionNotice(
    notice,
    ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
  )
```

格式化钩子刻意保持精简：工具把 `RetentionNotice` 转换为自己的页脚文本。辅助函数可以统一省略措辞，但不负责恢复指引。

`truncated` 表示 retainer 因预算省略了原本可用的内容，不表示上游结果不完整。工具会为权限失败、跳过的二进制文件、提供方局部失败、不可读候选项、无效 UTF-8，以及其他任何「无法检查」状况保留独立字段。

## 影响

**已交付内容。** `@deepseek-ai/dsh-output-retention` 导出 `ItemRetainer`、`TextRetainer`、结果类型（`RetainedItems`、`RetainedText`）、策略类型（`ItemRetentionStrategy`、`TextRetentionStrategy`）、`Omitted`、`PushDecision`、`RetentionNotice`，以及中性的提示辅助函数 `describeOmitted`／`formatRetentionNotice`，且不依赖 Cordis 或任何工具包。单元测试覆盖具有精确省略计数的条目头部保留、文本头部保留、文本尾部保留、首尾字节保留、零预算、UTF-8 边界处理（2、3、4 字节码位，以及每个裁切位置上的无效起始字节）和未知省略量的措辞。

**已记录但尚未迁移的内容。** `glob`、`grep`、`bash`、`web_fetch` 与 `web_search` 的映射已记录在[包 README](../../../../packages/util/output-retention/README.zh.md) 中，但本次改动并未把每个工具都迁移到该库；迁移工作刻意留作独立的后续任务。`read` 被明确记录为不在范围内：其 `read-render` 行窗口约定（`offset`／`limit`、`totalLines`、offset 范围错误、逐行预览截断，以及针对所选窗口的字节上限）不属于通用保留，而一个 `Omitted` 计数也无法同时表达行窗口两侧。

**该库维持的边界。** `truncated` 表示 retainer 因预算省略了原本可用的内容，绝不表示上游不完整。工具专用状态，包括 `incomplete`、权限失败、提供方局部失败、跳过二进制文件、bash spill 路径恢复和无效 UTF-8，均留在工具领域字段中、位于 retainer 之外。未来改动迁移某项工具时，该包的 README 与测试必须证明，除了有意改变的提示措辞外，模型可见的结果文本没有变化。

**接受的取舍。**接口刻意只支持条目的 `head` 保留，以及文本的 `head`／`tail`／`headTail` 保留；窗口、分组预算、感知排序的上限和上游停止控制，要等第二个消费方证明需求后再引入。文本保留按字节计数，以保障进程／正文安全；字符级和行级预览预算继续由具体工具负责。

## 考虑过的替代方案

**只进行事后 `truncate(text)`。** 不予采纳：它适合 Codex 的历史／工具输出截断场景，却会丢失条目计数、分组边界、UTF-8 安全的字节窗口与精确省略元数据。

**使用一个带可插拔回调的通用 `Collector<T>`。**不予采纳，因为它会掩盖两种重要的资源模式。逻辑条目保留按条目计数；文本保留按字节计数并维持 UTF-8 边界。独立的 `ItemRetainer` 与 `TextRetainer` 名称明确表达这种差异，同时保持 API 精简。

**把 `read` 窗口交给 `ItemRetainer`。**不予采纳：`read` 是唯一已交付的窗口消费方，其语义属于文件分页，而不是通用保留。一个 `Omitted` 计数无法表示行窗口两侧，而且 `read` 还携带 `totalLines`、offset 范围错误、逐行预览截断和针对所选输出的字节上限。让 `read-render` 由工具所有，可以避免共享库围绕一项特例膨胀。

**让截断成为 `ToolExecutionResult` 的一部分。** 不予采纳：工具注册表将不得不理解工具专用的恢复指引、分组、行号、退出状态和提供方语义。保留是由工具的 Native renderer（原生渲染器）使用的库；模型可见投影继续由工具所有，而[规范值](2026-07-20-canonical-tool-output-contract.zh.md)可以保留完整的已采集结果。

**在每个面向模型的工具 schema 中公开上限。** 不作为默认方案：Claude Code 的 grep 公开 `head_limit`／`offset`，但本 harness 会把常规预算保留为部署配置，除非模型确实需要控制分页。未来可以为具体工具增加类似 read 的续传字段；它不属于共享保留原语。
