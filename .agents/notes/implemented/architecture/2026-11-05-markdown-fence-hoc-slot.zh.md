# Agent Note: Markdown fence 按语言分派到 keyed hoc slot

Status: implemented

[English](2026-11-05-markdown-fence-hoc-slot.md) | 中文

## 问题

Markdown fence 指围栏代码块：开头一行是三个或更多反引号（或波浪号），后接 info string，例如 `ts title=demo`；随后是正文和闭合围栏。info string 的第一个词表示 fence 的语言。

会话流要按语言渲染 fence，插件需要能注册、替换或装饰某一种语言的渲染。primitives 在固定分支里选择 fence 的渲染方式：[render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx) 的 `renderCode` 把 `math` 交给 KaTeX，[CodeBlock.tsx](../../../../packages/client/ui-primitives/src/markdown/CodeBlock.tsx) 给 `diff` / `patch` 画行着色，其余语言走 shiki。[ui-primitives](../../../../packages/client/ui-primitives/README.zh.md) 不依赖 Cordis，组件拿不到 slot；其他 `MarkdownText` 调用方的渲染必须保持不变。

## 决定

### 面向开发者的 API

API 分两部分：把每个 fence 交给 owner 的 delegate，以及插件按语言注册渲染器的 keyed hoc slot。

| 部分 | 约定 |
|---|---|
| Delegate | `MarkdownDelegate.renderCode?(fence: MarkdownDelegateFenceInfo): ReactNode`。在 `MarkdownDelegateProvider` 上提供它的 owner，负责渲染该范围内每个带语言且有内容的 fence |
| Fence 信息 | `lang`（info string 语言词开头的字母、数字、`_`、`-` 部分转小写，`c++` 得 `c`）、`code`（正文）、`streaming`（文档是否仍在流式输出）、可选的 `meta`（语言词之后的原文） |
| Keyed hoc slot | owner 用 `entryKey: fence.lang` 把每个 fence 分派到自己的 hoc slot，并把普通代码块作为 `children` 传入；插件按语言 `key` 注册层 |
| 会话流 | ChatView 提供 delegate 并声明 `conversation.chat.markdown.fence`（hoc，session scope），owner props 为 `MarkdownDelegateFenceInfo`；覆盖 `conversation.chat.flow` 内的全部 `MarkdownText` |

插件为一种语言注册一层：

```text
ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register(
  { name: 'conversation.chat.markdown.fence', key: 'mermaid', id: '@acme/plugin/mermaid' },
  ({ code, streaming, children }) => (streaming ? children : <MermaidDiagram source={code} />),
))
```

API 保证：

- `renderCode` 第一次运行时 `lang` 与 `meta` 已经定稿：内容出现之前 info string 那一行已经结束，没有内容的 fence 走空 fence 分支。
- 普通代码块是每次分派最内层的 `children`。没有对应层的语言、渲染 `children` 的层、崩溃的层，显示的都是它。
- 每个流式 chunk 以新的 owner props 送到同一个层实例，流式由层自己处理。处理不了不完整内容的层，在 `streaming` 期间渲染 `children`。
- 不渲染 `children` 的层替换代码块，渲染 `children` 的层装饰代码块。层可以自行解析 `meta`，根元素不设外边距。
- 没有 `renderCode` 的文档保持内建渲染：diff 行按 `lang` 自动选择，`math` 落定后渲染为 KaTeX。
- Chat 以字面量包路径 id 注册 `math`（流式显示源码，落定后显示 display TeX）与 `diff` / `patch`（统一 diff 行，不渲染 `children`）。

### 带分派 key 的 hoc slot

| 项 | 约定 |
|---|---|
| 注册 | 可选 `key`；不带 `key` 的层是通配层，作用于每次分派 |
| 格子 | `(key 或通配, id)`；同一格子同一 `priority` 重复注册报错，更低的 `priority` 遮蔽 |
| 分派 | `renderSlot(name, owner, { entryKey, children })` 叠加通配层与 `key === entryKey` 的层；不传 `entryKey` 时只叠加通配层 |
| 精确 key 优先 | 同一 `id` 下，精确 key 的层替换通配层 |
| 嵌套 | 依次按 `order`、`priority`、注册顺序升序，`order` 最小的在最外层 |
| children | 至多渲染一次；不渲染即替换该层内部的全部内容 |
| 崩溃 | 出错的那一处在本次挂载内渲染 `children`，错误照常上报；层保持注册（`abdicate: false`），其他出现处保留该层；该处重新挂载时重试 |
| 编译 | 每个 `(host, slot 声明, entryKey)` 一条层链，所有 outlet 共享；每个 ledger 版本重新选取该 key 的层，只有层变化时才重编，因此为其他 key 注册的层不会让已挂载内容重新挂载，outlet 切换 `entryKey` 则换到另一条层链 |

这些 hoc 语义适用于所有 hoc slot，包括层全部为通配层的 `conversation.hero.frame`。本 note 部分取代 [hoc slot kind](2026-11-03-hoc-slot-kind.zh.md) 的四处决定：恰好渲染一次 `children`、不接受 `entryKey`、按 outlet `useMemo` 组合层、崩溃层 abdicate。

### 代码块

| 项 | 约定 |
|---|---|
| `CodeBlock.diff` | 不传时按 `lang`（`diff` / `patch`）自动选择；`true` 或 `false` 对任意 `lang` 强制开关统一 diff 行 |
| `FenceCodeBlock` | 经 `CodeBlock` 渲染 fence 正文，补上 `CodeBlock` 会去掉的结尾换行，并透传 `diff`；ChatView 分派的 content 传 `diff={false}` |
| `FenceMathBlock` | 把 `math` fence 正文渲染为 display KaTeX |
| `MarkdownFenceSeat` | `render.tsx` 中读取 delegate 的组件，流式缓存的元素因此跟随 Provider 变化；没有 `renderCode` 时渲染上面两个预设 |

### 间距

primitives 把每个经 delegate 渲染的 fence 包进块级外框 `fenceSeat`，外框是 `.markdown` 或 `li` 的直接子元素。外框承担代码块与相邻块之间的间距，所以外框内 slot 的 `display: contents` 锚点不影响文档节奏：

| 规则 | 外框取值 |
|---|---|
| 默认 | `margin: 16px 0` |
| 后面还有兄弟元素 | `margin-bottom: 11px` |
| compact 变体 | `margin: 4px 0` |
| 列表项最后一个子元素 | 与代码块一样保留外边距 |
| 外框内的 `.md-code-block` 与 `.katex-display` | `margin-block: 0` |

## 考虑过的替代方案

- **`diff` 与 `math` 留在 primitives 的固定分支里，只为新语言开 slot**：两套机制，内建渲染无法被替换或装饰。
- **默认代码块注册成通配层**：其他层需要知道它的 `order`，排在它里面的层永远不会挂载，因为默认层不渲染 `children`；作为 hoc content 则不需要任何 id 或 `order`。
- **不加外框，用跳过一层包装的选择器恢复间距**：这些规则默认恰好一层包装、一个根元素，也补不回 11px 间距。
- **像 single、keyed、list 那样让崩溃的层 abdicate**：一次由内容触发的崩溃会让该语言的所有 fence 失去渲染，直到重新注册。
- **owner props 变化时重试崩溃的出现处**：需要在所有 kind 共用的错误边界里加状态与浅比较，有问题的层每个流式 chunk 都会报一次错。
- **按 outlet 组合层**：每个同语言 fence 都要组合同一条层链，任何注册都会让所有 fence 重新挂载。

## 后果

- 插件无需改动 primitives，就能按语言新增、替换或装饰会话流 fence 的渲染；`math`、`diff` / `patch` 与第三方语言共用同一机制。
- 没有 `renderCode` 的 `MarkdownText` 调用方渲染内建块，没有外框也没有 slot。
- 层崩溃只影响出错的那个 fence；有问题的层每次挂载都会再崩一次、再报一次错，该 fence 显示代码块。
- 所有 hoc slot 的层都可以不渲染 `children`，因此 `conversation.hero.frame` 的层可以隐藏 hero 内容。
- 每个经 delegate 渲染的 fence 多一个块级外框和一个 slot outlet（一次注册表订阅、一次 locale 订阅、一个 `display: contents` 元素）；编译结果按 key 共享。
- 在会话流中，display 公式的间距来自外框而不是 KaTeX 默认的 1em，fence 横幅显示小写 `lang`，`conversation.chat.reasoning.content` 的 `labels` 只作用于脚注与无语言 fence。
