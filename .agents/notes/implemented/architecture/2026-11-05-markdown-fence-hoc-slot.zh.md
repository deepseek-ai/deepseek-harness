# Agent Note: Markdown fence 按语言分派到 keyed hoc slot

Status: implemented

[English](2026-11-05-markdown-fence-hoc-slot.md) | 中文

## 问题

会话流需要按语言渲染 Markdown 代码块（fence），并让插件按语言注册、替换或装饰渲染。fence 分支写死在 primitives 内部时——[render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx) 的 `renderCode` 对 `math` 走 KaTeX，[CodeBlock.tsx](../../../../packages/client/ui-primitives/src/markdown/CodeBlock.tsx) 对 `diff` / `patch` 走行着色，其余走 shiki 高亮——新增一种语言（例如 mermaid）只能继续往这两个文件里加分支，插件既无法按语言注册渲染器，也无法在某一处替换或装饰已有的渲染。

[ui-primitives](../../../../packages/client/ui-primitives/README.zh.md) 零 cordis，组件拿不到 slot；`MarkdownText` 有十几个调用方，大多数不需要扩展，它们的渲染结果必须保持原样。

## 决定

### 分派入口

- `MarkdownDelegate` 有可选的 `renderCode(fence: MarkdownDelegateFenceInfo): ReactNode`。`MarkdownDelegateFenceInfo` 有四个字段：`lang`（info string 语言词开头的字母、数字、`_`、`-` 部分转小写，如 `c++` 得 `c`）、`code`（fence 内容）、`streaming`（所在文档是否仍在流式输出）、可选的 `meta`（info string 语言词之后的原文，与 lang 同在第一行，内容出现时已经定稿）。
- `renderCode` 只在 lang 已定时调用：fence 有 lang 且内容非空。流式输出中，内容出现时 info string 那一行已经结束，lang 不会再变，触发后不会回退；info string 未写完的 fence 内容为空，走空 fence 分支。
- 没有提供 `renderCode` 的地方走 primitives 内建默认：diff 按 lang 自动渲染，`math` 在 settle 后渲染为 KaTeX。
- 提供了 `renderCode` 的地方自己负责全部语言规则：自己声明 slot、自己注册需要的层。primitives 不替它兜 diff 或 math。
- primitives 把 `renderCode` 的输出包进一个块级外框 `fenceSeat`，由外框承担该 fence 与相邻块之间的上下间距；外框内的代码块与 display 公式不带外边距，层的根元素也不设外边距。没有 `renderCode` 时不包外框。

### primitives 预设

| 项 | 内容 |
|---|---|
| `CodeBlock` 的 `diff` 开关 | 不传时按 lang 自动；`true` / `false` 对任意 lang 显式开关 |
| `FenceCodeBlock` | fence 预设：把 fence 交给 `CodeBlock`，内部补 Markdown 渲染器需要的结尾换行，透传 `diff` |
| `FenceMathBlock` | fence 预设：display KaTeX，内部补结尾换行 |
| 内建默认 | `render.tsx` 的 `MarkdownFenceSeat` 在组件内读取 delegate，缓存的流式元素因此也跟随 Provider 变化；没有 `renderCode` 时用上面两个预设渲染 |

### hoc 分派（ui-slots / ui-renderer）

| 项 | 内容 |
|---|---|
| 注册 | hoc 注册有可选 `key`；不写为通配，匹配所有 entryKey |
| 格子 | `(key 或通配, id)`；同格子同 priority 重复注册报错，不同 priority 遮蔽 |
| 分派 | `renderSlot(name, owner, { entryKey, children })`；只叠加 `key === entryKey` 的层与通配层；不传 entryKey 只叠加通配层 |
| 精确优先 | 同一 id 下，精确 key 的层替换通配层 |
| 嵌套顺序 | order → priority → 注册顺序，order 小的在外 |
| children | 层至多渲染一次 children，可以不渲染（替换内层）；适用于所有 hoc |
| 崩溃 | 层崩溃时错误照常上报，但不 abdicate（`abdicate: false`）：只有出错的那一处渲染 children（内层内容），层保持注册，同 key 的其他出现处不受影响；出错处在本次挂载内不重试（props 变化也不重试），重新挂载时恢复；适用于所有 hoc |
| 编译 | 按 `(host, slot 声明, entryKey)` 编译一次，所有 outlet 共享；每个 ledger 版本重新选出该 key 生效的有序层列表，逐项比较 entry 身份，不变复用，变化才重编；注册其他 key 不让已挂载的内容重新挂载，同一 outlet 换 entryKey 会换链并重新挂载内容；重新声明的 slot 从空缓存开始 |

`conversation.hero.frame` 的层没有 key，全部是通配层，ui-conversation 不传 entryKey；它的层也可以不渲染 hero 内容。

本 note 部分取代 [hoc slot kind](2026-11-03-hoc-slot-kind.zh.md) 的四处决定：层"恰好渲染一次 children"的义务、hoc 不接受 `entryKey`、按 outlet 实例 `useMemo` 组合层、崩溃层 abdicate。该 note 的其余决定仍然有效，它记录的 hoc 事实与本 note 一致。

### 会话流（ui-chat）

- ChatView 在 `conversation.view` id=chat 的注册里声明 `'conversation.chat.markdown.fence': { kind: 'hoc', scope: 'session' }`，owner props 为 `MarkdownDelegateFenceInfo`；它在已有的 `MarkdownDelegateProvider` 上提供 `renderCode`：`renderSlot('conversation.chat.markdown.fence', fence, { entryKey: fence.lang, children: <FenceCodeBlock diff={false} …/> })`。
- 覆盖范围就是这个 Provider 的范围：`conversation.chat.flow` 以内的全部 `MarkdownText`（正文、reasoning、compaction 摘要、工具详情等）。在这个范围内，`conversation.chat.reasoning.content` 的 `labels` 只作用于脚注与无语言 fence。
- `src/client/fence/` 注册两类层，id 用包名路径并写成字面量，slot 目录据此列出各层 id：
  - `key: 'math'`：流式时渲染 children，settle 后只渲染 `FenceMathBlock`。
  - `key: 'diff'` 与 `key: 'patch'`（同一 id）：渲染 `FenceCodeBlock diff`，不渲染 children。
- 第三方按语言注册层；要在会话流替换某语言的默认渲染，注册该 key 的层并不渲染 children；要装饰，渲染 children。层可以读取 `meta` 自行解析 info string 中的参数。
- 层的契约：根元素不设外边距（间距由 `fenceSeat` 承担）；处理不了不完整内容的层，在 `streaming` 期间渲染 children，否则流式中途的崩溃会让该处在本次挂载内停在代码块；内容相关的错误由层自己接住。

### 样式

outlet 的 `[data-slot]`（`display:contents`）包装位于外框之内，外框才是 `.markdown` 与 `li` 的直接子元素，所以首尾外边距清零、列表项首个子元素清零与 `:not(:last-child)` 的 11px 规则都直接作用于外框：

| 规则 | 外框取值 |
|---|---|
| 默认 | `margin: 16px 0` |
| 后面还有兄弟元素 | `margin-bottom: 11px`（与 `CodeBlock` 的 `.block:not(:last-child)` 一致） |
| compact 变体 | `margin: 4px 0` |
| 列表项最后一个子元素 | 与代码块一样保留外边距（`li > *:last-child:not(.md-code-block, .fenceSeat)`） |
| 外框内的 `.md-code-block`、`.katex-display` | `margin-block: 0` |

slot 锚点保持 hoc 的通用行为。

## 考虑过的替代方案

- **把 `diff` / `math` 留在 primitives 的写死分支里，只为新语言开 slot**：新旧语言两套机制，内建语言的渲染无法被替换或装饰。
- **全局 Provider（AppFrame 安装）覆盖所有 CodeBlock**：引入应用级全局状态；也与"没定义 `renderCode` 就保持内建渲染"的原则冲突。
- **共享 Factory 携带基础 diff / math 注册，各处 slot 包在 Factory 外**：可行但结构更复杂；"定义了 `renderCode` 就自己负责全部语言"更简单。
- **双层 hoc（fence 层 + CodeBlock body 层）**：diff 只需要一个现成的 `CodeBlock` 开关，不需要第二层。
- **给 hoc 增加"无锚点"声明以避免包装元素**：改变 slot 的通用性质；样式问题直接改样式解决。
- **不加外框，用"隔一层"的结构规则补首尾与列表间距**：规则默认外面恰好包一层、层只输出一个根元素，层输出多个根或多包一层即失效，也补不回 11px。
- **崩溃层整体 abdicate（其他 kind 的语义）**：一条内容导致的崩溃会让该语言在所有会话退回代码块，直到重新注册。
- **崩溃后 owner props 变化时重试**：要给所有 kind 共用的错误边界加状态与浅比较；流式期间有问题的层会每个 chunk 报一次错。不重试只需 hoc 层以 `abdicate: false` 上报。
- **html 预览层**：只作为机制演示与安全调研，不在本次范围；浏览器无法禁止脚本发起的 iframe 自导航，需要单独设计。
- **默认实现注册成通配层**：外部必须知道它的 order，order 更大的层会被嵌进不渲染 children 的默认层而永远不挂载；作为 hoc content 传入则外部无需知道任何 id 或 order。
- **`MarkdownDelegateFenceInfo` 携带 `labels` 与原样大小写的语言名**：各层自行决定外观文案；横幅显示小写 lang 可接受。
- **每个 outlet 各自 `useMemo` 组合层**：会话里大量同语言 fence 各自组合同一条层链，且任何一次注册变化都让所有 fence 重新挂载；按 `(slot 声明, entryKey)` 共享编译结果只针对 hoc，不同于 [hoc slot kind](2026-11-03-hoc-slot-kind.zh.md) 否决的"所有 kind 按 ledger 版本预编译"。

## 后果

- 插件按语言新增、替换或装饰会话流中的 fence 渲染，无需改动 primitives；`math`、`diff` / `patch` 与第三方语言走同一套机制。
- 没有 `renderCode` 的 `MarkdownText` 调用方渲染内建块，不加外框，也不经过 slot。
- 一条内容导致的层崩溃只影响出错的那一处，同语言的其他 fence 保留该层。
- 同语言的 fence 共享一条编译好的层链；注册其他语言的层不会让已挂载的 fence 重新挂载。
- 所有 hoc 的层都可以不渲染 children：`conversation.hero.frame` 的层可以隐藏 hero 内容。
- hoc 层崩溃不 abdicate：有 bug 的层每次挂载都会再崩一次、再报一次错，该处始终显示内层内容。
- 会话流内 display 公式的上下间距由外框决定（16px / 11px），不是 KaTeX 默认的 1em。
- delegate 路径每个带 lang 的 fence 多一个块级外框元素。
- 会话流内每个带 lang 的 fence 多一个 slot outlet（一次注册表订阅、一次 locale 订阅、一个 `display:contents` 元素）；编译结果按 key 共享。
- 会话流内 ReasoningContent 调用方传入的自定义 labels 不作用于 fence 外壳；fence 外壳文案统一来自 ChatView 的 locale。
- 会话流内 fence 横幅显示小写 lang。
