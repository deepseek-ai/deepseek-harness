# Agent Note：Web 可折叠块的钉住标题 —— Think 与压缩标记的折叠按钮在滚动时钉住

Status: implemented

[English](2026-08-03-web-sticky-collapsible-headers.md) | 中文

## 问题

会话里有两个块的展开正文不封顶，随整页滚动，而不是在有界的表面内部滚动：Web Think 行（`.thinkBody`）和压缩标记（`.compactionBody`）。其他每个工具行都给正文封顶并在自己的卡片内部滚动，所以折叠标题始终可见。这两个不封顶的块做不到。一段很长的思维链或很长的压缩摘要会把自己的折叠标题顶出视口上方，想再次折叠该块的读者必须把整段正文滚回顶部才能够到折叠按钮。

## 决策

每个不封顶块的折叠标题在块展开时钉在会话滚动容器的顶部。折叠时标题保持在正常文档流中，所以折叠的块会像其他行一样滚走。

这两个块本来就是相对共享的会话滚动容器（`[data-conversation-scroll]`）滚动，而非某个内层框，所以在标题上加 `position: sticky; top: 0` 就把它钉在该容器上。一个 base token 背景遮住在钉住的标题下方滚过的正文。

钉住的标题的层叠级别按块而异，因为两者正文不同。Think 正文是纯文本、无 sticky 后代，`z-index: 1` 就够。压缩正文渲染 markdown，摘要里的围栏代码块会把自己的 banner 钉在 `z-index: 6`（`packages/client/ui-primitives/src/markdown/CodeBlock.module.css`），banner 里带一个 Copy 控件；因此压缩标题用 `z-index: 7`，并让那个 banner 停在自己的标题带下方，这样标题永远不会盖住 Copy 控件，banner 也不会盖住折叠按钮。标题带高度是一个组件局部量（`.compactionRow` 上的 `--dsh-compaction-header-height`），由折叠按钮的 `height` 与 banner 的 `top` 共用；banner 规则靠特异性压过 CodeBlock 的 `top: 0`，因为两张样式表分属不同的包。钉住的标题还把 hover 底覆盖为不透明的 `--dsw-alias-interactive-bg-hover-solid` token，并在整行展开期间都保持直角：默认的半透明 hover token 会在指针落到折叠按钮准备折叠的瞬间让滚动的正文透出，而基础的 6px 圆角会让同样的正文在四角露出来。`:hover` 把该规则的特异性抬到文件更靠后的 hover 基础规则之上，所以胜负不由声明顺序决定。另外还有两个元素为了避开同一批代码 banner 取 `z-index: 7`：输入框座与轮次导航轨道槽（`TurnNavigator.module.css`，ui-chat）。同级之间的先后顺序只写在一处：`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css` 中输入框座的注释。

规则被限定作用域，只影响这两个不封顶的块；封顶的工具行保持原有行为，因为让一连串工具行的 sticky 标题层层堆叠会把它们全挤在顶部。Think 规则是 `packages/client/ui-chat/src/client/chat/ReasoningRow.module.css` 的 `.root[data-expanded] [data-open] [data-disclosure-row]`，用 `DisclosureRow` 的 `data-open` 门控，折叠的 Think 行绝不钉住，并限定在 Think 行自己的 root 之下，不触及任何工具调用 variant。压缩规则是 `packages/client/ui-chat/src/client/chat/MessageItem.module.css` 的 `.compactionRow:has(.compactionBody) .compactionButton`，正文兄弟节点只在展开时存在于 DOM，所以 `:has()` 就以展开状态门控钉住。

不改动任何 session、wire、durable event 或 model-visible 契约；这是一处纯展示层的 CSS 改动，由既有组件拥有。

## 曾考虑的替代方案

**用 `max-height` 加内部滚动给这两个正文封顶，与工具卡片一致。** 否决：Think 正文是刻意不封顶的，好让推理读起来像普通消息正文（[web-thinking-tail-scroll](../../archived/feature/2026-08-02-web-thinking-tail-scroll.md) 和 `.thinkBody` 注释拥有这一意图），压缩摘要是一个阅读表面。内层滚动框会引入嵌套滚动，滚轮在光标下从整页切换到框内，并把很长的技术性正文压进一个更难读的小窗口。钉住标题保留了流式正文的阅读模型，同时让折叠按钮依然够得着。

**为一致性给每个可折叠行都加钉住标题。** 否决：封顶的工具行因为正文在内部滚动，标题本来就一直可见，没有需要解决的问题。让它们的标题相对整页钉住，会在滚过一连串工具调用时把每个展开行各自钉住的标题堆叠在视口顶部，这是视觉噪音，不是一致性。

**把摘要内代码栏的偏移交给 `CodeBlock` 承担。** 否决：可以让 `CodeBlock` 读取使用方设置的 `--dsl-code-block-banner-top` 之类的属性，这样代码块继续拥有自己的几何，也避免用 `:has()` 选择器伸进另一个包的 DOM。代价是把所有使用方的布局都接到一个只有这个块会设置的属性上，而这段偏移是这个块的呈现问题、不是代码块的：局部规则把偏移写在造成它的折叠按钮旁边，而 `[data-code-block-banner]` 本来就是 `CodeBlock` 为使用者样式发布的钩子。

**在 `DisclosureRow` 基元上加一条共享的 sticky 规则。** 否决：`DisclosureRow` 支撑 Think、每个工具调用 variant 以及 context-injection 行；在那里加规则会一并命中封顶行。该行为只属于不封顶的消费者，所以各自把规则限定在自己的块上。

## 后果

很长的 Think 块或压缩摘要的折叠按钮无需把正文滚回起点就能够到，同时两个正文都保持作为整页正文流动。改动是纯 CSS：没有计时器、订阅、durable state、DOM 结构改动或传输流量。压缩规则使用 CSS `:has()` 选择器，Web UI 所面向的各浏览器均支持。

## 测试

单元测试钉住选择器所依赖的 DOM 锚点：`packages/client/ui-chat/tests/reasoning-row.client.spec.tsx` 断言展开的 Think 行在 `[data-variant='think'][data-expanded] [data-open]` 之下嵌套了 `[data-disclosure-row]`，且折叠行没有 `[data-open]`；`packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx` 断言压缩正文只在展开时出现在 `.compactionRow` 之下。`packages/client/ui-chat/tests/sticky-header-styles.client.spec.ts` 把这两条规则当作 CSS 文本读取，逐条固定钉住所依赖的声明：`position: sticky`、`top: 0`、直角圆角、两侧各自的 `z-index` 级别、折叠按钮高度与代码 banner 偏移共用的那一个量，以及不透明的 hover token——因为 jsdom 不计算 sticky 布局，渲染类测试也无法在某条声明被改动时变红。

真实浏览器证据由两条 keyless Chromium e2e 路径承载。`apps/web/tests/lifecycle-chrome.e2e.ts` 展开已结束轮次的 process 行、展开 Think 行，并断言其标题计算出 `position: sticky`、`top: 0px`（折叠时非 sticky）；该 fixture 录制的 reasoning 只有一行，太短不足以溢出，所以它只证明 CSS 解析到了 Think 标题。`apps/web/tests/seeded-history.e2e.ts` 承载「钉住态随滚动」的证据：它种入一个摘要长度由本套件控制的压缩（一个围栏代码块加 40 个列表项），把视口压小以强制溢出，滚动到 marker 的钉住态，断言标题计算出 `position: sticky`、`top: 0px`、`z-index` 大于代码块 banner、滚动后仍停在滚动口顶边、其自身中心是命中测试命中的最上层元素（折叠按钮保持可点击），以及其 hover 底保持完全不透明（alpha 1）。同一用例还把摘要里的代码 banner 滚到它自己的钉住位置，断言 banner 停在标题带下方、且 banner 的 Copy 控件在它的中心点命中自身，使这条偏移不会退化成控件被盖住。同一用例还写出一份 keyless 几何 golden（`snapshots/web/seeded-history/sticky-geometry.expected.md`），把这些与平台无关的语义事实固定下来，因为这是一处用户可见、但不改动 DOM 与无障碍名称的 CSS 行为，无障碍 golden 捕获不到它。PR demo GIF 用真实服务器加真实模型轮次录制，承载视觉证据：钉住的标题在正文滚动时停留在顶部。
