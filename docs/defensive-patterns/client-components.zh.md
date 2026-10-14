# 客户端组件规则

[English](client-components.md) | 中文

关于客户端组件、其状态与 effect 的规则。详细纪律见 [packages/client/AGENTS.md](../../packages/client/AGENTS.md)；Slot 设计正家是 [slots.zh.md](../subsystems/slots.zh.md)，样式规则正家是 [web-styling.zh.md](../web-styling.zh.md)。以下每一节给出要求、评审判定方式、边界与例外，以及一正一反两个例子。

## 状态经 Injection 到达

Slot 的组件经**自己注册项**的 inject 面获得它渲染所需的一切——普通数据、action 回调，以及渲染器绑定成 `use<Name>` hook 的保留 `hooks` 隔间——而父组件的渲染点经派生的 `renderSlot` 传 owner 数据。它绝不先在顶层读一棵大全局状态再逐层手工传下去。把每个活值都放在那个面上，props 才能在没变时保持引用不变，组件也才能只订阅自己读取的那部分子状态。缺了这条，任何一个无关字段变化都会重渲整棵子树——长会话在流式事件下的掉帧、滚动与输入卡顿就是这么来的。

- 判定方式：在注册项与其渲染点上，作者都必须能回答两件事——被渲染组件订阅了哪些子状态，以及它收到的哪些 props 在多次渲染之间保持引用稳定。要盯住每个 prop 的可变性：每次渲染都重建的值（新对象、新数组、内联回调）即使内容没变也会向下传播重渲。
- 不在范围内：组件自己的局部状态（折叠、悬停、草稿用的 `useState`）不属于注入内容；不订阅 React 之外任何东西的组件也不需要新席位。
- 例外：新增 hook 席位会改动 Slot 契约，因此该改动要在 review 中说明影响面——哪些组件订阅什么；使用既有注入面不需要逐组件批准。
- 修法：把注入收窄到该视图真正渲染的内容，每个读取项经一个 hook 席位暴露一个字段，用窄 action 集合取代 store 或 service 句柄。[组件输入](../subsystems/slots.zh.md#component-inputs) 正家负责 inject 工厂、标准 hook 席位，以及它们各自如何成为 prop。

注册项承载普通数据、一组窄 action 与一个 hook 席位；渲染点只传 owner 数据，组件只读它渲染的那个字段：

```tsx
// The inject factory returns plain data and callbacks; hooks is the reserved compartment.
ctx.slots.register(
  {
    name: 'sidebar.right',
    inject: () => ({
      rename,
      hooks: { info: infoSource },   // bound by the renderer as useInfo()
    }),
  },
  SidebarRight,
)

// The parent's render site passes owner data through the derived renderSlot.
{renderSlot('sidebar.right', { id })}

function SidebarRight({ id, useInfo, rename }: Props) {
  const { title } = useInfo()   // subscribes to title only
  return <button onClick={() => rename(id)}>{title}</button>
}
```

顶层组件读了整个 view store 并把它作为一个 prop 传下去，于是渲染点再也回答不了上面两个问题：

```tsx
function Sidebar() {
  const view = useViewStore()           // one top-level global read
  return <SidebarRight view={view} />   // the whole store travels down
}

function SidebarRight({ view }: { view: ViewStore }) {
  return <span>{view.activePanel.title}</span>
}
```

该 store 里任何字段变化都会重渲整个侧栏子树，而且绑定它的渲染点完全看不到这个组件订阅了什么。

## props 承载数据与回调，不承载 React 节点

prop 是数据或回调；React 节点经声明的 slot 传递。把元素作为 prop 值或注入成员传下去，会藏起一条 Slot 契约没有描述的第二条组合路径，把渲染控制权从注册面挪到调用点，并让一个包去拼装另一个包的标记。新增的节点型 prop 或注入成员一律禁止；需要宿主提供标记的位置，改为声明一个 child slot。

- 判定方式：组件的 props 类型、inject 工厂的返回值、或渲染点的 owner props 对象里出现 `ReactNode`、`ReactElement` 或 `() => JSX.Element`。
- 不在范围内：已经发布的节点型字段继续可用。规则在改动波及它时触发，该改动把它改掉，而不是继续扩展它。
- 例外：同一改动内无法完成改造时，由对应领域专家确认延期，且改动中记录该确认；作者不得自行确认。
- 修法：在父级注册的 `children` 中声明该位置，用 `renderSlot` 渲染它，数据经子组件的 props 传入。[扩展规则](../subsystems/slots.zh.md#extension-rules) 正家负责哪个包可以声明和渲染哪个 slot。

头部位置是一个声明的 child slot，因此宿主只传数据，标记由注册组件自己决定：

```tsx
// The card declares the header location; the host passes data only.
ctx.slots.register(
  {
    name: 'tool.call.toolview',
    children: { header: { kind: 'single', scope: 'session' } },
  },
  ToolCard,
)

function ToolCard({ title, renderSlot }: Props) {
  return <article>{renderSlot('header', { title })}</article>
}
```

React 节点作为 prop 值越过边界，于是它所走的组合路径没有任何地方声明过：

```tsx
type ToolCardProps = {
  header?: React.ReactNode
  footer?: React.ReactNode
}

// The call site assembles another package's markup.
<ToolCard header={<ArchiveBadge />} />
```

卡片的 Slot 契约不再描述它渲染什么，调用点继续握着渲染控制权，而徽章所在的包变成了传节点方的运行时引用。

## slot 注册物是稳定的 function component

注册进 slot 的值是在模块作用域声明的稳定 function component。渲染期创建的组件函数每一轮都是新的组件类型，而 React 把变化的类型当作另一个组件：它卸载这棵子树并挂载一棵新的，展开的行、输入焦点与滚动位置随之重置。注册期参数经 props 到达组件，而不是靠闭包捕获渲染期变量。

- 判定方式：注册物在哪里创建。注册调用或渲染调用里的内联箭头、渲染函数体内定义的组件、以及用 `useCallback` 包住内联组件的写法都不合格；模块作用域的 `function` 声明合格。
- 不在范围内：本条约束的是注册物的身份，不是它的复杂度。稳定组件照样可以读取注入的 props、hooks 与回调。
- 例外：只有调用方确实想要这次重挂载时，渲染期创建组件才是对的，普通改动无需单独批准；Slot 契约形态的变更按「状态经 Injection 到达」一节描述的注入面 review 走。
- 修法：把组件移到模块作用域，用注册面的各个 share 给它的 props 定型，让变化的值经 inject 面传入而不是走闭包。

注册项持有对模块作用域组件的稳定引用，变化的值经注入到达；局部组件由渲染点传入：

```tsx
function PanelTitle({ title, count }: Props) {
  return <span>{title} ({count})</span>
}

// Registration: the local slot's scope is declared, never a component.
ctx.slots.registerFactory(
  {
    name: 'panel',
    scope: 'root',
    slots: { title: { scope: 'root' } },
    inject: () => ({ title: 'Sessions', count: 3 }),
  },
  Panel,
)

// The render site passes the local component, keeping its identity stable.
renderFactorySlot('panel', { /* owner data */ }, { slots: { title: PanelTitle } })
```

渲染调用里的内联箭头会在该次渲染运行时产生新的组件类型：

```tsx
// A new component type each time this render runs.
renderFactorySlot('panel', { /* owner data */ }, { slots: { title: (p) => <span>{p.title}</span> } })
```

React 看到的类型与上一次注册不同，于是重挂载该席位，并在一次无关更新中重置它的局部状态——展开态、焦点或滚动位置。

## 组件绝不接收 Cordis context

`ctx` 属于 apply 世界：插件主体与闭包持有它的 `inject` 工厂。组件不接收 Cordis context、不导入 service 类去戳它、也不读 React context，因为业务组件看不到任何 context——渲染器的 binding context 是它内部的。裸 observable 只有在 Injection 把它包成 hook 之后才到达组件；直接自行订阅的组件持有一份 Injection 面上无人释放的生命周期。

- 判定方式：组件的参数或 props 类型里出现 `ctx` 或 `Context`；组件体内读 `observable.value`、调用 `subscribe`、或接 `useSyncExternalStore`；feature 的 `.tsx` 模块里导入 service 类。
- 不在范围内：组件内部、不订阅 React 之外任何东西的行为 hook（计时器、媒体查询）不是注入内容，留在组件里。
- 例外：无。`TabSlot` 里现存的直接订阅是该席位 owner 的整改工作，不是新代码的先例。
- 修法：把该事实移进注册的 `inject`——纯数据与回调，裸 observable 放进保留的 `hooks` 隔间——或移进声明的 store，再经派生的席位读取。

Injection 绑定 observable，组件读一个派生的 hook，订阅生命周期由渲染器持有：

```tsx
// The inject factory is the only place that closes over ctx.
const inject = () => ({
  hooks: { tab: tabStore.observable },
  action: { openTab },
})

function TabView({ useTab, action }: Props) {
  const { loaded } = useTab()   // the renderer owns the subscription
  return <button hidden={loaded} onClick={() => action.openTab('files')} />
}
```

组件持有 `ctx` 并自己读源，于是订阅及其生命周期都归组件：

```tsx
function TabView({ ctx }: { ctx: Context }) {
  const store = ctx.get('tabStore')                     // component holds the container
  return <span>{store.observable.value.title}</span>    // raw observable read in render
}
```

没有人释放这个订阅，重渲在 React 的调度之外触发，组件也就此绑死在某一个 store 实现上。

<a id="context-comes-from-the-current-scope"></a>

## 上下文由当前 scope 给出

`session`、`panel`、`tab` 一类上下文由当前 scope 给出——Provider、注入成员或框架 hook。新增全局 `current`、`active`、`selection`、`viewId` 都不是取用它们的通道，因此同一 session 下的多个 composer、多个 conversation 才能各自独立工作。

判定条件是：组件经 scope 取得上下文，还是经全局字段取得。多实例行为就是检验：同一 session 下两个 composer 不得串台。确实全局唯一的对象由服务或实例承载，调用方显式 `inject`。

```ts
// The injected factory closes over the scope's own session and panel.
interface Scope { readonly session: string; readonly panel: string }
const inject = (ctx: Scope) => ({ session: ctx.session, panel: ctx.panel })
```

```ts ignore-check
const activeTabId = globalThis.__activeTabId   // every tab reads the same value
```

反例让实例之间互相串台，状态的归属也无法审计。

## 资源消费方走 `useResource`

展示资源的元素经注入的 `useResource` hook 读取它，地址由资源的协议与地址给出。领域包装——一个 Tab、一个面板——在 `useResource` 之上组合自己的 hook，返回结构自由，但底下的取数、缓存与订阅不得重做。每个协议各来一条读取路径会把缓存与失效策略劈成两半，同一个地址可能在一处是活的、在另一处是旧的。

- 判定方式：读取路径。`useResource<Protocol>(address)`，或内部调用它的业务 hook，合格；自建订阅加缓存、复制提供方的流处理、或 `useTabStream` 这类压平式通用 hook 不合格。
- 不在范围内：与资源无关的局部 UI 状态——折叠、悬停、草稿——留在 `useState`，不给它资源地址。[客户端资源](../subsystems/client-resources.zh.md) 正家负责各个 status 的含义以及什么让资源保持打开。
- 例外：重塑快照自由，但把协议差异藏进条件分支的包装要在 review 中说明归属；新协议的 hook 由该协议的拥有者提供。
- 修法：在领域 hook 内调用 `useResource`，把结果映射成组件要渲染的内容，删掉自建缓存。

领域包装接收注入的 hook 作为参数，并且只重塑其结果，底层因此保持唯一：

```tsx
// The bottom layer is the standard hook, reached through the component's inject face.
function useChatMessages(useResource: UseResource, id: string) {
  const resource = useResource<'chat'>(`dsh-resource://chat/${id}`)
  return resource.status === 'live' && resource.value !== undefined
    ? { messages: resource.value.messages, loading: false }
    : { messages: [], loading: true }
}

function ChatBody({ id, useResource }: Props) {
  const { messages } = useChatMessages(useResource, id)
  return <ol>{messages.map((message) => <li key={message.id}>{message.text}</li>)}</ol>
}
```

包装以自己的名义重做了订阅、缓存与失效，于是提供方的生命周期与共享缓存都不再适用：

```tsx
export function useTabStream(id: string) {
  const [value, setValue] = useState<TabData>()            // bespoke cache
  useEffect(() => {
    const subscription = tabProtocol.open(id).subscribe(setValue)   // bespoke subscription
    return () => subscription.close()                              // bespoke teardown
  }, [id])
  return value
}
```

每个协议各长出一套取数与失效逻辑，缓存条目与刷新策略无法统一，同一地址的消费方对当前值各执一词。

## Store 用法窄而明确

前端 store 承载共享的查看或交互状态。它的 spec 声明初始状态、改动这些状态的 action，以及在值需要跨重载存活时由框架机械执行的持久化键——session 作用域的实例会在该键上追加 scope key，因此每个会话的实例各自独立持久化。store 的属性与改动这些属性的 action 被封装成窄接口注入，组件只拿到这些以及它需要的选择器，绝不拿整个 view store。业务数据住在对象层而不是 store 里，设置变更走设置接口，不走 store 状态。

- 判定方式：注入面是窄接口还是 store 对象本身，以及句柄是在 `apply` 内构建还是在模块级构建。
- 持久化：spec 的 `persist` 键就是全部机制，由框架执行；引擎实例暴露 `getSnapshot`、`subscribe`、烘焙好的 actions 与 `clearPersisted`，没有任何一方手工 hydrate。
- 不在范围内：不改设置时，渲染状态放 store 没问题；组件局部状态也不是 store 内容。[Store 契约](../subsystems/slots.zh.md#component-inputs) 正家负责声明的 store 如何变成 props，[Web 客户端架构](../subsystems/web-client.zh.md) 正家负责业务数据住在哪里。
- 例外：在模块级导出 store 句柄一律禁止——模块缓存的身份在插件重载之间是一个伪装的单例；把注入面收窄成窄接口不需要单独批准。
- 修法：把 inject 返回值里的 store 句柄换成组件渲染所需的字段与 action 回调，句柄留在 `apply` 内。

一个句柄在 `apply` 内构建并传给注册项，inject 面只带视图渲染所需的字段与 action：

```tsx
// The handle is built in apply; persistence is the spec's own key.
const sidebarStore = createSidebarStore()   // defineStore({ init, actions, persist: 'sidebar' })

ctx.slots.register(
  { name: 'sidebar.header', store: sidebarStore, inject: () => ({ onSelect: selectPanel }) },
  SidebarHeader,
)

// The component reads through the framework-bound seat and writes through the actions.
function SidebarHeader({ useStore, actions, onSelect }: Props) {
  const { title } = useStore()
  return <button onClick={onSelect}>{title}</button>
}
```

整个 view store 被注入给组件自行挑选字段，模块级句柄则把实例生命周期从框架手里拿走：

```tsx
// The component receives the store itself and picks its own fields.
const inject = () => ({ viewStore })

function SidebarHeader({ viewStore }: Props) {
  return <button onClick={viewStore.select}>{viewStore.activePanel.title}</button>
}

// Module-level handle: one identity shared by every plugin load.
export const paneStore = createPaneStore()
```

组件的依赖面不再可审计，而共享的模块身份活得比任何一次 scope 清理都久：两个 pane 会落到同一个实例上，而不是各自一个。

## 身份与初始状态都是刻意的

状态切换不重建控件、也不替换其 DOM 节点：实例与其 DOM 身份在状态变化之间保持同一，焦点、选中与进行中的草稿因此得以保留。初始状态在首个流程运行时即就绪——同一条路径既准备数据也建立状态——而不是之后由 effect 回填。组件接收 hooks、选择器与 action 回调，而不是整个 service。

- 判定方式：状态变化之后，控件实例与其 DOM 节点是否保持同一身份；出现卸载再挂载即违反。初始化路径同样判定：状态在首个流程内建立合格，从 effect 写入不合格。
- 依赖面：hooks 读取、选择器选中子状态、action 回调写回。整个 service 作为 prop 或注入成员传入即不合格。
- 范围：带内部实例与本地状态的输入与命令控件，以及由 factory 创建的业务视图。
- 例外：确需重挂载（切换的数据集其实例状态不可迁移）时，在 review 中连同状态迁移方案一并说明；由评审该控件实例生命周期改动的评审者接受。
- 修法：在首个流程建立状态的地方派生初始值，保持布局节点挂载、只变化其 props，并用三个窄 share 取代 service prop。

草稿随会话一起建立，composer 节点保持挂载，只有 props 随状态变化：

```tsx
// The draft is built by the first flow; nothing fills it in later.
const draft = useDraftState(sessionId)
const { canSend } = useComposerSelectors(draft)

// The node stays mounted; state changes reach it as props.
return (
  <div className={s.composer} data-ready={canSend || undefined}>
    {draft.text}
  </div>
)
```

初始状态迟一个提交到达，带 key 的控件在每次会话切换时被重建：

```tsx
// The draft is filled in after the first commit.
useEffect(() => { setDraftState(initialDraft) }, [])

// The keyed composer unmounts on every session switch.
<Composer service={composerService} key={sessionId} />
```

首帧渲染出空草稿，每次会话切换都会丢掉焦点、选中，以及用户已经输入的内容。

## `useLayoutEffect` 不是默认选项

`useLayoutEffect` 默认不用，换成 `useEffect` 也不算修好，因为二者的差别在时序，而不在代码在做什么。布局测量先回答三个问题——为何在此处发生、为何 CSS 无法表达、为何必须是像素测量；只有回答完，才收进注入的测量 hook 并取得对应领域专家的确认。两类 effect 都不承担状态记录或逻辑绑定，那是 Injection 的职责。

- 判定依据是用途而不是 hook 名字：这个 effect 为哪次测量或哪次绑定而存在。状态记录或逻辑绑定的 effect 回到 Injection——Provider 或注入 hook；只有通过三问的测量才留下，其结果作为声明式布局参数消费。
- 不在范围内：两个 effect 的时序差异（`@types/react` 记载 `useLayoutEffect` 在 DOM 变更后同步触发、绘制前刷出）是背景事实，不是把其一改写为另一的许可。
- 例外：任何保留下来的 `useLayoutEffect` 都要经对应领域专家确认，改动中记录该确认。
- 修法：用 CSS 表达布局——grid、`aspect-ratio`、容器查询——或把测量收进注入 hook 并暴露一个值。

布局用 CSS 声明，唯一通过三问的测量住在注入 hook 里：

```tsx
// Fix 1 — express the layout in CSS and delete the measurement.
// .card { display: grid; grid-template-columns: minmax(0, 1fr) auto; aspect-ratio: 16 / 9; }

// Fix 2 — the approved measurement is injected and returns one value.
function CardBase({ useLayoutMeasurements }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { gutterWidth } = useLayoutMeasurements(ref)
  return <div ref={ref} className={s.card} style={{ '--gutter': `${gutterWidth}px` }} />
}
```

下面前两个 effect 回答的是错的问题——该用哪个 effect——第三个把绑定停在 effect 里：

```tsx
// A synchronous pixel measurement the design did not need.
useLayoutEffect(() => { setHeight(ref.current.getBoundingClientRect().height) }, [])

// The same measurement with the hook name swapped.
useEffect(() => { setHeight(ref.current.getBoundingClientRect().height) }, [])

// Logic binding parked in an effect instead of Injection.
useEffect(() => { bindShortcut(handler) }, [])
```

改名并不能解决布局问题，量到的高度从此取决于选了哪个 effect，而快捷键绑定迟一轮渲染生效，没有回到 Injection。

## effect 绝不把渲染期可派生的数据推给父层

effect 体内绝不调用经 props 或 slot props 传来的 setter，把本可在渲染期由组件已有的 props / state 决定的数据推回父层。这种推送要多付一轮渲染、让父层首帧拿不到值，并把之后任何一次状态抖动放大成渲染级联。该值在渲染期决定，宿主经渲染期通道取得，或由用户手势在其处理器内更新自己的状态。

- 判定方式：effect 体内调用了 props 或 slot props 传来的 setter，其入参由当前 props / state 派生，且没有外部事件或订阅回调驱动它。清理函数 `return () => setX(undefined)` 属于同一违规。
- review 中要点名的后果：多一轮渲染；父层首帧缺值；依赖数组漏项即 stale；effect → 父 state → 再渲染的级联；子组件生命周期与父层状态纠缠。
- 不在范围内：响应真实外部事件的 effect——订阅回调、socket 帧、用户手势——不是本形态；事件处理器可以直接更新状态。
- 例外：默认无例外；任何例外都要经对应领域专家确认。
- 修法按顺序：状态在哪里就让 UI 在哪里渲染；必须由宿主渲染时，在渲染期把值交出去；跨条目共享的状态移进注入面或声明的 store。

控件在状态所在处渲染，共享的开关在渲染期读取，写回只发生在手势处理器里：

```tsx
// 1. Render it where the state already lives; no channel is needed.
return <Button onClick={() => setShowOriginal((v) => !v)}>{label}</Button>

// 2. The host renders it: the flag is declared state, read during render
//    and written only from the gesture handler.
const { showOriginal } = useStore()
const { toggleOriginal } = actions
return <Button onClick={toggleOriginal}>{showOriginal ? rendered : source}</Button>
```

`label` 与 `disabled` 都是渲染期可派生的，从 effect 调用父层 setter 让父层渲染两轮、首帧仍然没有头部动作：

```tsx
useEffect(() => {
  setHeaderAction({ label, disabled, onClick })   // render-derivable data pushed up
  return () => { setHeaderAction(undefined) }
}, [label, disabled, setHeaderAction])
```

父层为本来第一轮就能拿到的数据渲染两轮，头部迟一帧出现或闪烁，而发布时间由手写的依赖数组决定。

## 构建与样式各归其主

客户端包的每项构建调整都经该包的 tsdown 插件完成，包内不新开自己的构建分支。样式走 CSS Module，只有图像、GIF 与 SVG 需要内联——且内联到 CSS 而不是 JSX。TSX 里绝不内联大文本，`style` 对象只放运行期计算的值，因为静态值与多样式切换属于 CSS Module 的 class name。

- 判定方式：包内新开构建分支而不是走 tsdown 插件；feature 样式里出现字面颜色、组件库或 Tailwind；TSX 里出现 base64 数据或大文本；`style` 对象承载静态值或样式切换。
- 不在范围内：运行期计算的值（量到的 gutter、进度百分比）可以进 `style`，组件局部自定义属性也可以承载布局值。[组件规则](../web-styling.zh.md#component-rules) 正家负责 token、CSS Module 与 class name 规则。
- 例外：新增构建分支或新的内联形态在落地前于 review 中说明理由，由所属包的规则决定是否保留。
- 修法：把样式切换移进用 `className` 切换的 CSS Module class，base64 交给构建链写进 CSS，并从 TSX 模块里删掉大文本常量。

组件切换 class name 与 data 属性，呈现由 CSS Module 负责：

```tsx
import s from './card.module.css'

// Style variants are class names, not style-object branches.
export function Card({ active, tone, children }: Props) {
  return (
    <div className={clsx(s.card, active && s.active)} data-tone={tone}>
      {children}
    </div>
  )
}
```

大文本与内联二进制数据进了模块，`style` 对象还编码了主题无法覆盖的样式切换：

```tsx
const HUGE = '...several KB of text...'   // large text inline in the module

// A variant switch and an inlined asset both sit in the style object.
<div style={{ color: toneColor, backgroundImage: `url(${AVATAR_DATA_URL})` }} />
```

包里带上了本该属于 CSS 与资源的文本和二进制数据，diff 里躺着无法阅读的 blob，主题覆盖也再够不到那个颜色。

## 传 key 就要说明它标识什么

只有当 `key` 指明元素代表哪个实体或实例时才传它，并把这份身份说清楚——例如 `turnId` 在一个 session 内唯一。多数列表本就有稳定的业务 id，不需要额外的 key。为消除警告或编码渲染顺序而造的 key，声明的是一份数据并不具备的身份；数组下标从来不是这份身份，因为插入或删除会把后面每一项挪到另一个元素上。

- 判定方式：条目的身份能否由位置或稳定 id 表达。传 key 时，改动要说明它因何唯一，而可变列表上的 `key={index}` 不合格。
- 不在范围内：React 要求列表项带 key 这条规则依然成立；那个 key 就是条目的稳定业务 id，不是它旁边的第二个 key。
- 例外：无。普通改动无需批准，公共组件的 key 语义要在 review 中说明。
- 修法：使用实体的稳定 id；两行确实共用一个 id 时，修 id 的来源，而不是往 key 里掺下标。

key 就是 turn 自己的 id，它在 session 内唯一，正是元素所代表的身份：

```tsx
// turnId is unique inside a session; the id is the identity.
export function TurnList({ turns }: Props) {
  return (
    <ol>
      {turns.map((turn) => <TurnRow key={turn.turnId} turn={turn} />)}
    </ol>
  )
}
```

下标冒充身份，于是列表一变，后面每一行的身份都跟着变：

```tsx
// The index stands in for identity.
{items.map((item, index) => (
  <Row key={index} data={item} />
))}
```

插入或删除之后，后面每一行都会把先前的状态带到新数据上，展开的行或编辑中的内容会出现在错误的条目上。

## 每层共享代码各有自己的隔离度

功能把诉求吸收在自己的包里；它需要与共享代码保持多大隔离，取决于那段代码属于哪一层共享。要盯的违规形态是把业务专属概念放进共享层，因为此后每个使用方都得理解一个不属于自己的概念，而这个分支很难撤回。

| 共享代码 | 功能应保持的隔离度 |
|---|---|
| `ui-primitives`，目录中的控件 | 消费目录中的控件。新控件先在功能包内落地，只有出现第二个使用方时才提升进共享目录。 |
| `ui-layout` 与 shell 布局 | 消费它；在功能包内通过 wrapper、覆盖样式或加一层来适配。 |
| `ui-renderer` 及其他渲染机制 | 业务代码不产生值依赖；只经文档化的注册面扩展——slots、provide/inject 绑定的 hooks、声明的 store。 |
| 另一个功能插件 | 不运行时导入、也不重新导出它的值。UI 经 slots 跨越，行为经注入的服务跨越；共享运行时代码住在窄的静态正家，如 `client/store`、`ui-primitives` 或浏览器安全的工具包。 |
| 数据对象层（`client/connection`、`session-controller/client`、`client/store`） | 经文档化接口读取；功能自己的概念不进入这些对象及其 store。 |
| 功能自己的包 | 不受限——诉求在这里被吸收，包括它自己的行、排序与呈现。 |

- 判定方式：diff 是否把业务专属的分支、字段或概念放进了功能自己包以外的任何一层。
- 不在范围内：功能自己拥有的代码；以及确实属于通用需求、而不是某一个功能需要的共享层改动。
- 例外：共享层的改动要带上所属领域专家的确认，并回归所有使用方；GUI 改动按 [packages/client/AGENTS.md](../../packages/client/AGENTS.md) 的最低检查自验。
- 修法：把诉求吸收进功能包；确属通用需求时，在独立改动中连同 owner 的确认一起提升到共享层。

功能自己拥有行渲染与排序规则，基座组件按原样消费：

```tsx
// The feature owns its rows; the base is consumed, not edited.
// packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx
export function WorkspaceBrowser({ rows, onArchive }: Props) {
  const ordered = [...rows].sort((a, b) => Number(b.archived) - Number(a.archived))
  return (
    <ul>
      {ordered.map((row) => <WorkspaceRow key={row.id} row={row} onArchive={onArchive} />)}
    </ul>
  )
}
```

基座组件学会某一个功能的排序规则，于是每个使用方都继承了一个不属于自己的概念：

```tsx
// ui-layout: the base learns one feature's ordering rule.
export function BrowserList({ rows, ...rest }: Props) {
  const ordered = [...rows].sort((a, b) => Number(b.archived) - Number(a.archived))
  return <ul {...rest}>{ordered.map((row) => <Row key={row.id} row={row} />)}</ul>
}
```

`ui-layout` 的每个其他使用方从此都要理解只有那一个功能才有的归档概念，撤回该分支意味着把它们全部审一遍。
