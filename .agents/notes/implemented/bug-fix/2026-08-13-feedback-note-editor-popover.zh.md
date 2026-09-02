# Agent Note：反馈备注编辑器以浮层悬浮在对话记录上方

Status: implemented

[English](2026-08-13-feedback-note-editor-popover.md) | 中文

## Problem

消息反馈的 Web 界面（[#2262](https://github.com/deepseek-harness/deepseek-harness/pull/2262)）把控件贡献给 `conversation.chat.assistant-actions`，该槽位渲染在已定稿助手消息共享的 IconActions 行内。那一行是单条固定高度的 `flex` 线，`flex-wrap` 保持初始值 `nowrap` 且 `height: 28px`，按 28px 图标加一个时钟来定尺寸。备注编辑器作为一个内联组挂进去，内含 `width: 260px` 的 textarea 加 Save 与 Cancel。

一个 260px 输入框加两个按钮在任何窗口尺寸下都装不进那条线。对着已构建产物实测，编辑器打开时该行的可滚动溢出在 1680px 视口下是 168px，在 600px 下是 444px——这个缺陷从来不是窄窗口的边缘情况，在全屏桌面下就已存在。flex 溢出会溢出到线的末端之外，因此按 flex 顺序排在编辑器之后的项被挤出会话列：branch 操作在 600px 时离开列，时钟及其运行时长/TTFT/吞吐读数在 900px 时离开列。这些控件在不可见的同时仍可命中测试，所以没有任何行为断言发现它；已交付的 e2e 覆盖评分、备注、reload 与撤回，而 24 个 UI 快照是与宽度无关的 DOM。

同一张样式表还引用了四个主题并未定义的 `--dsw-alias-*` token：`border-secondary`、`bg-primary`、`interactive-bg-primary` 与 `label-inverse`。未定义的自定义属性会让其所在的整条声明在 computed-value 阶段失效，因此 textarea 交付时既无边框也无底色，Save 既无填充也无可读标签——编辑器读起来像是浮在对话记录里的散落文本，而不是一个输入框。

## Decision

备注编辑器完全不进入行的 flex 布局。它是一个浮层：一张固定定位的面板，portal 到 `document.body`，其坐标来自备注触发按钮的矩形。行保持其单行图标与备注触发按钮，因此没有任何东西需要围绕编辑器收缩、换行或回流，任何地方都不需要 `order` 或换行。portal 出会话列也逃出了列的 `overflow` 裁剪，因此面板不会被滚动边缘裁掉，并且当对话记录滚动时会随它所批注的消息一起移动。这里复用 `ui-primitives/Menu` 为锚定菜单所用的同一套 portal 机制（`ui-subagent` 的 catalog popover 就构建在它之上）：面板 `position: fixed`，打开时从 anchor rect 定位，钳制在视口内，并在滚动（捕获阶段）与缩放时重新定位。`ui-primitives/useAnchoredPosition` 负责共享的「测量—偏移—钳制—跟随」行为。`Menu` 保留自己的 effect，因为它的定位还要解析 `side`/`align` 变体与可选的调用方 anchor rect，而本界面不需要这些；该 hook 覆盖的是两边本来都要各写一遍的「锚点正下方」这一简单情形。

**操作条。** 点赞/点踩按钮与备注触发按钮保持原样留在行内。触发按钮是普通 `button`（`aria-haspopup="dialog"`，打开时 `aria-expanded`），在没有备注时显示「补充说明」，已有备注时显示备注文本。

**浮层。** 打开时，面板内含 textarea、Save 与 Cancel，以及任何备注保存失败提示，作为 `role="dialog"`，其标题与 textarea 自身的标签不同，以便两者都能按名称寻址。它在触发按钮下方打开（4px 间距），钳制到距视口边缘 12px，自动聚焦 textarea，并在 Escape 或外部 pointer-down 时关闭。关闭时仅当面板确实曾经打开才把焦点还给触发按钮，绝不会在初始挂载时（新渲染出的一条已评分消息不得把焦点拉进其操作条）。编辑器打开时进行评分操作会关闭面板。四个未定义 token 换成主题确实定义的那些，与 primitives 的既有做法一致：输入框用 `border-l2` 与 `bg-layer-1`，Save 用 `button-primary-fill` 配 `label-primary-foreground` 并加 `button-primary-hover` 状态；面板表面复用 Menu 卡片的表面配方（`--dsw-specific-menu`、`--dsw-elevation-prominent` 投影配 `--dsw-alias-border-l1` 描边重绑与 `border: 0`），圆角取 `border-radius: 12px`。

**失败提示按人的视线所落之处拆分。** 评分或列表加载失败显示在按钮旁的图标行里，无论浮层是否打开都清晰可读。备注保存失败显示在浮层内、Save/Cancel 旁，且面板保持打开，以便草稿留存待修正。

## Alternatives considered

**行内展开：编辑器通过整行 flex basis 独占一行，并让行允许换行。**否决：这种做法能修正几何（行在 1680px 到 600px 报告零溢出），但会让 branch 操作与末尾时钟在编辑器打开时换行到编辑器下方，使行占据三行，并让交互与行本就占满的横向条带争空间。[Issue #2561](https://github.com/deepseek-harness/deepseek-harness/issues/2561)记录了由此产生的错位，并要求采用 chat 界面已有的浮层模式。浮层把编辑器完全移出行，因此无论编辑器是否打开，操作条与键盘 Tab 顺序都不受影响。

**不 portal 出列的绝对定位浮层** — 否决：会话列是 `overflow-y: auto` 的滚动容器，因此在列内布局的面板会被滚动边缘裁掉，且不随列滚动而跟住消息。portal 到 `document.body` 并从触发按钮矩形做固定定位，才让浮动面板可行，正如 `Menu` 的 portal 模式与 subagent catalog popover 已然做到的那样。

**在 `MessageIconActions` 上新增 `belowActions` 接缝，把编辑器作为该行的兄弟节点渲染在下方** — 否决：slot 契约明确记载 `assistant-actions` 渲染在消息 IconActions 行**内部**，且单个条目无法在不为一个展示细节拓宽 Host 契约的前提下提供两个渲染点，而 portal 出的浮层无需触碰 Host 就表达了该细节。

## Consequences

编辑器打开时，操作行保持单条 28px 线，在 1680px 到 600px 的每一档视口都零溢出、零项落在列外——因为编辑器本就不在行里。面板悬浮于对话记录之上、位于视口内，并保持锚定其触发按钮，逃出列溢出裁剪。编辑器在两种主题下都能被辨认为输入框。

`apps/web/tests/message-feedback-layout.e2e.ts` 在编辑器打开时扫描六个视口，并在每一档钉住：行报告单行零溢出、面板位于会话列之外（证明它逃出裁剪）、面板落在视口内（证明钳制有效）、面板紧贴其触发按钮。已提交的 golden 记录这些关系；回退到行内（或去掉 portal）会让几何断言失败。`packages/client/ui-message-feedback/tests/styles.client.spec.ts` 校验 token 与主题已提交的源一致、面板为 `position: fixed`、且不带任何 flex sizing（因此不会重新加入行），并校验大括号平衡，沿用 `ui-settings-models` styles spec 的先例。单元 spec 覆盖评分、备注、reload、撤回，外加浮层的 portal 到 body、Escape/外部点击关闭、以及浮层内部点击保持打开。

`ui-message-feedback` 包新增 `@types/react-dom`，使 `createPortal` 用法能通过类型检查，与 `ui-primitives` 一致。

有若干已知限制在此接受而非修复。面板打开时点击评分会关闭它，而关闭路径把焦点归还给备注触发按钮，而不是留在用户刚按下的评分按钮上；外部点击落在另一个可聚焦控件上时同理——浏览器先把焦点给该控件，随后关闭路径又把它拉回触发按钮。指针用户对两者都无感，键盘用户会察觉焦点移动。钳制假定面板放得下：面板高于视口时，上界 `innerHeight - height - margin` 会小于 `margin`，于是 `top` 变为负值、被裁掉的是面板顶部而非底部。面板里的三行 textarea 带 `resize: vertical`，用户可以拖过这个尺寸，因此 `.notePanel` 把自身高度限制在 `calc(100vh - 24px)` 并自行滚动内容——这是既有 `max-width` 的对应项，用的是与钳制相同的 12px 边距。编辑器打开时若评分消失，面板会因 `rating !== undefined` 守卫卸载，但 `noteOpen` 仍为 true，因此 document 级的 Escape 与 pointer-down 监听继续挂着；若该 item 之后经 resync 重新出现，浮层会带着上一次的草稿回来且不重新聚焦 textarea。该窗口只有一次点击或一次 Escape 那么宽，而它可能遮住的保存失败已经有行内回退，因此保持现状。若失败在面板关闭并重开后才到达，不会写入新会话的面板：其草稿已按已存备注重新播种，旧尝试的错误会误标新草稿，而未提交的内容本就不存在——该失败被丢弃而不展示。以及，定位虽然会在滚动、窗口缩放与面板自身尺寸变化时重放，但 jsdom 没有布局，因此真实几何由浏览器场景证明，单测则通过 `ResizeObserver` stub 覆盖其接线。

520px 以下仍残留仅来自时钟字符串的窄视口溢出，与本界面无关。`ui-agent-preset`、`ui-conversation`、`ui-jobs`、`ui-settings-plugins` 与 `ui-tool` 仍引用未定义的 design token；仓库没有拒绝此类引用的门禁。
