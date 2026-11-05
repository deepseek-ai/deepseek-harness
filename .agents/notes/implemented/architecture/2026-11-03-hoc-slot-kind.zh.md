# Agent Note: 新增 `hoc` 插槽类型，让插件层层包裹宿主内容

Status: implemented

[English](2026-11-03-hoc-slot-kind.md) | 中文

## 问题

首页鲸鱼需要在空白处被点击时播放。canvas 必须画在内容下面，`.scrollBody` 铺满整个 body，所以 canvas 自己收不到点击；能收到点击的只有内容的祖先节点。

现有插槽类型都不能让插件成为内容的祖先：

| 类型 | 行为 | 为什么不够 |
|---|---|---|
| `single` / `list` / `keyed` | 在宿主指定位置渲染 occupant | occupant 和内容是兄弟节点 |
| `chain` | 选中的 entry 替换 fallback；`overlay` 时与 fallback 并排 | 不包裹 |
| Factory 局部 slot | 调用方按次替换局部组件 | 只有调用方能选，插件无法叠加 |

此前的做法是由 Conversation 在 body 上判定空白点击，再通过 `onBlankClick(listener) => dispose` 通知背景插件。这让 Conversation 维护一套只服务于装饰插件的点击分类和订阅转发。

## Decision

[Markdown fence keyed hoc slot 的 Note](2026-11-05-markdown-fence-hoc-slot.zh.md) 记录了 hoc 层为何接受可选的分派 `key`、可以不渲染 `children`、为何按 key 共享编译好的层链，以及为何崩溃后仍保持注册。

新增第五种 kind：`hoc`。

| 项 | 约定 |
|---|---|
| 声明 | 父 entry 的 `children` 写 `{ kind: 'hoc', scope }`；`SlotMap` 中 `kind: 'hoc'` |
| 渲染 | `renderSlot(key, owner, { children, entryKey })`；`only` / `fallback` / `hookContext` 不可用；省略 `children` 时各层包裹空内容；省略 `entryKey` 时只叠加通配层 |
| 注册 | 必填 `id`，可选 `key`、`order`、`priority`；不带 `key` 的层是通配层，服务所有分派，带 `key` 的层只服务该 `entryKey`；cell 为 `(key 或通配, id)`，同一 `id` 下精确 key 的层替换该 key 的通配层；同 cell 同 `priority` 抛错，不同 `priority` 遮蔽 |
| 嵌套顺序 | 依次按 `order`、`priority`、注册顺序升序，最小者在最外层 |
| 层的 props | 每层收到同一份 owner props，加上框架注入的 `children`（内一层，最内层是宿主内容）；`children` 不属于 owner props，类型由 `HocShare` 提供，owner props 不得使用这个名字 |
| 层的义务 | 至多渲染一次 `children`；不渲染 `children` 的层替换其内部全部内容；包裹 `children` 的层自身不产生盒子（其 slot 另有说明的除外）；不能修改传给内层的 props |
| 无 entry | 原样渲染 `children` |
| 层崩溃 | 每层有独立 error boundary；崩溃时错误照常上报，该层在出错的那一处渲染自己的 `children`，直到该处本次挂载结束，owner props 变化也不恢复；该层不 abdicate，因此其他出现处（包括分派同一 key 的出现处）仍保留它，重新挂载的出现处会再次渲染它 |
| 内容出错 | 被包裹内容抛出的错误以原始错误穿过所有层，不记到任何层名下 |
| 重新挂载 | 增减一个对本次分派生效的层会让其内部内容重新挂载，为其他 key 注册的层不会；`session` 或 `session-maybe` 作用域的层在 Session binding 变化时也会让内部内容重新挂载 |

### 实现

| 包 | 实现 |
|---|---|
| `ui-slots` | `SlotKind` 包含 `'hoc'`；`HocRenderOpts`（可选 `children` 与 `entryKey`）、`HocKeysOf`、`HocShare`；`RenderSlotFn` 为 hoc key 提供接受可选 `{ children, entryKey }` 的重载；`KindOptions` 的 hoc 分支含可选 `key`；`SlotCore.register` / `entriesOfSlot` 按 `(key 或通配, id)` 划分 hoc cell |
| `ui-renderer` | `HocOutlet` 从 `hocChainFor` 取渲染函数，该缓存按 host、存活声明与分派 key 划分，分派同一 key 的所有 outlet 共享。每个 ledger 版本它只用 `hocLayersFor` 重新选出一次该 key 的层（通配胜者加精确 key 胜者，精确 key 的层替换同 id 的通配层，按 `order` 排序），仅当这一有序列表按 entry 身份比较发生变化时才调用 `composeHocLayers` 把各层组合成一个嵌套渲染函数。每层是一个组件，在组合时固定按 scope 选定的 Entry（`StrictSessionEntry` / `SessionMaybeEntry` / `RootEntry`）、entry、slot inject 与崩溃上报，渲染时只接收 `owner` 与内一层。没有层时 outlet 直接返回宿主内容。`HocContentBoundary` 包住每层的内层内容，把其中的错误包装为 `HocContentError` 重新抛出；层的边界放行这种错误，`HocOutletBoundary` 再解开为原始错误。Entry 链以 JSX children 把 `children` 交给注册组件；非 hoc entry 收到 `undefined`。`SlotErrorBoundary` 接受 `crashed` 替换节点，层的边界在本次挂载内一直渲染该节点；层的崩溃上报传 `abdicate: false` |
| `scripts/gen-client-catalog.ts` | hoc 插槽的注册选项、渲染 `children` 的示例，以及 `wraps-owner-content` 替换风险 |

### 首个使用者

| 位置 | 实现 |
|---|---|
| `ui-conversation` | `conversation.hero.frame`（hoc，root），owner props 为 `{ hero: boolean }`，在所有阶段包裹 `.scrollBody`，首页结束时输入框不重新挂载。首页阶段（`.root[data-phase='hero']`），绘制背景的 Conversation 根元素设置 `isolation: isolate`，这是 frame 契约的一部分：层中负 `z-index` 的装饰画在该背景之上、所有 Conversation 内容之下。Conversation 不为层做任何点击判定 |
| `ui-brand-official` | `PixelWhale` 是 frame 层：`display: contents` 外框上的 React `onClick` 在主按钮点击留白时播放，排除 portal 浮层（`currentTarget.contains(target)`）、控件（选择器）和结束外框内文字选择的点击。`hero` 为 true 时以负 `z-index` 绘制 canvas。帧图经包 asset 路由加载；渲染器返回 `{ play, dispose }` |

## Alternatives considered

- `onBlankClick` 订阅转发：Conversation 承担只为装饰插件服务的点击分类。
- canvas 放底下、`.scrollBody` 设 `pointer-events: none`：首页溢出时空白处无法滚动。
- 不设 `z-index` 的 canvas：不需要层叠上下文，但会画在 `z-index: 1` 的首页输入区以外的所有非定位 Conversation 内容之上（例如输入区接管面板），并依赖那条无关的规则。
- 由层自己的盒子建立层叠上下文：层必须复刻 body 的 flex 列布局。
- 单独的 `renderNestedSlot` / JSX 组件 `<HocSlot>`：多一套绑定；`hookContext` 已证明可以按 key 约束 `renderSlot` 的第三个参数。
- 按 ledger 版本预编译所有插槽类型：端到端测不出耗时差异，见 #7838。

## Consequences

- 增减一层会让其内部所有内容重新挂载，包括首页的输入框。
- 所有非 hoc 的注册组件都会收到 `children: undefined`，会覆盖同名的 owner prop。
- 每层在组件树中多一个组件和两个 error boundary；有层的 hoc 插槽另多一个 outlet 边界。
- outlet 的 `[data-slot]` 元素位于 owner 与内容之间，owner 侧选择器不能假定内容是直接子元素。
- React 18 会在错误被重新抛出的位置重新采集组件栈，因此有层的 hoc 插槽之上的边界收到的内容错误，组件栈从 `HocOutletBoundary` 开始。
- 层如果自己在 `children` 外包错误边界，捕获到的是内部的 `HocContentError`，而不是原始的内容错误。
- frame 契约只在首页阶段成立：其他阶段根元素不参与层叠隔离，未经 portal 的 Conversation 浮层仍能盖住悬浮在中栏上方的 AppFrame 元素；首页阶段它们只在根元素内部比较层级。
- `HocOutlet` 把层组件保存在按 host、存活声明与分派 key 共享的编译缓存中，而不是 outlet 实例状态里，因此不依赖 React 保留 memo 缓存；这些组件是其内部内容的重新挂载边界，重新声明的插槽从空缓存开始。
- 其他 kind 仍以 [slot 体系标准](2026-07-22-slot-type-chain-implementation.zh.md) 为准；本 Note 新增第五种。
