# Web Client Slots

[English](slots.md) | 中文

Slots 是 Web Client 的类型化 React 组合系统。[`dsh-client-ui-slots`](../../packages/client/ui-slots/README.zh.md)定义不依赖 React 的注册表与类型代数；[`dsh-client-ui-renderer`](../../packages/client/ui-renderer/README.zh.md)把可观测源绑定成钩子、渲染整棵树，并在内部拥有 React context。功能插件通过 `ctx.slots.register()` 贡献 UI，绝不导入其他功能插件的组件。

本文记录 slot 的所有权、组件输入、扩展 API 与当前层级。外围的启动、Remote、Client model 与 Conversation 数据通路见 [Web Client 架构](web-client.zh.md)。

`plugins.bundle.config` 以 npm 包名为 key，提供 Bundle 详情配置。`plugins.bundle.activation` 在用户显式启用后渲染可选引导，由拥有者提供关闭引导和打开该 Bundle 详情的回调。`conversation.input.activity` 提供模型选择器与发送按钮之间的单个活动控件，可展开工具栏并在卸载时释放展开状态。

插件目录声明 `plugins.add.actions`，它是 root 作用域的 list，在添加插件菜单的安装项之后提供 `MenuItemButton` 行。owner 提供 `onDismiss()`，用于开始动作前关闭菜单。该 slot 遵循所属插件页面声明的生命周期。

root 作用域的 list `sidebar.panellist.actions`、`conversation.session.header.views.actions` 和 `sidebar.right.tab.guide.actions` 提供面板行、View 标签和右侧栏引导卡片之后“更多”菜单的菜单行。区域只在其 list 有注册项时画“更多”按钮与菜单，并传入可自定义的入口及其 Pin 状态、`onOpen`、`onPinnedChange` 与 `onDismiss`。面板和 View 入口还通过可选的 `active` 状态标识当前选中项，该状态独立于 Pin 状态。root 作用域的 `sidebar.panel.icon` factory 拥有 `sidebar.panellist` list，按 `id`、`size` 与 `active` 为侧栏行和更多菜单入口渲染已注册图标。各区域在内存中维护已收起的入口 id；[`ui-entry-customization`](../../packages/client/ui-entry-customization/README.zh.md) 注册随产品提供的菜单行。

[ui-workspace](../../packages/client/ui-workspace/README.zh.md#understand-the-implementation) 记录 Session 行的扩展位置、显示条件和键盘行为。

[ui-settings](../../packages/client/ui-settings/README.zh.md#filling-the-settings-slots) 记录设置页面与导航图标扩展点。

[ui-session-panel](../../packages/client/ui-session-panel/README.zh.md#contribute-a-section) 记录会话面板的分栏、标题控件、行与开关角标扩展位置。

通用设置声明 root 作用域的列表 `settings.general.group`；每个分组条目拥有其设置行子列表的声明。设置底座声明六个内置分组设置行 key，并以 `SettingsGeneralGroupItemSlot` 导出它们的联合类型；自定义分组通过声明合并把确切的 `settings.general.group.<id>.item` key 加入 `SlotMap`。默认「常规」分组拥有兼容的 `settings.general.item` 名称。[ui-settings-general](../../packages/client/ui-settings-general/README.zh.md#the-general-section) 记录分组标题、排序、共享卡片及注册示例。

## 声明与生命周期

`SlotMap` 是编译期注册表。包通过声明合并写入 key、cardinality（基数）、scope、owner props、keyed props 与可选的 slot 级 inject face。运行时声明则是拥有该渲染位置的组件在 `children` 中给出的对应条目。

声明一个 child 会同时产生三种效果：令该 child key 生效、授权 parent entry 调用 `renderSlot` 或 `renderSlotChain`，以及记录运行时 dispatch 规格。每个声明只能有一个存活 owner。向未声明 slot 注册，或重复声明其他 entry 已拥有的 child，都会在插件激活时失败。

`root` 是唯一内建声明，也是唯一由 Cordis service 自身渲染的 key。`ui-renderer` 调用 `ctx.slots.renderSlot('root', {})`；其余每个后代都通过声明它的 entry 所收到的 `renderSlot` 或 `renderSlotChain` prop 渲染。

注册和声明遵循 Cordis effect 生命周期。销毁一个 entry 会移除其贡献，并递归折叠它声明的 child slots。因此，向其他包的 slot 贡献功能时使用 `ctx.slots.inject(key, callback)`：callback 会在每段声明生命周期内运行，owner 折叠时其 effect 随之移除，owner 再次挂载时则重新运行。

```tsx ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'

type HeaderActionProps = PropsRuntime<'conversation.session.header.actions'>

function HeaderAction({ useSession }: HeaderActionProps) {
  const running = useSession(snapshot => snapshot.running)
  return <button disabled={running}>Review</button>
}

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'review',
      order: 100,
    }, HeaderAction))
}
```

## Cardinality 与 scope

Slot 声明固定两个相互独立的维度。

| 维度 | 值 | 含义 |
|---|---|---|
| cardinality | `single` | 单个 cell，渲染当前 priority 胜者；需要并列内容时应声明 child slot，而不是把它当作列表。 |
| cardinality | `list` | cell 由必填 `id` 定址，先按 `order`、再按注册顺序排列。 |
| cardinality | `keyed` | owner 传入 `entryKey`；匹配 cell 以该 key 对应的 props 渲染。 |
| cardinality | `chain` | 每个 entry 提供纯 `select(owner)` 函数；按 priority 顺序遇到的第一个非 null 结果获选，并以 `matched` 传给组件；全部拒绝时渲染 owner fallback。 |
| cardinality | `hoc` | entry 层层包裹 owner 经 `renderSlot(key, owner, { children })` 传入的内容，最小者在最外层；可选的 `key` 按 owner 的 `entryKey` 选层。见 [Hoc 层](#hoc-layers)。 |
| scope | `root` | 一个 root 作用域组件和 store 实例。 |
| scope | `session-maybe` | 继承外围 Provider binding，但没有 binding 时仍可渲染；Session 值是可选的。 |
| scope | `session` | 要求可解析的外围 Provider binding，并收到确定存在的 Session 值。 |

对于 `single`、`list`、`keyed` 和 `hoc` cell，`priority` 是遮蔽优先级；对于 `chain`，它是选举顺序。数值越小越先运行或渲染。普通增量贡献应选用新的 list 或 hoc `id`，或 keyed `key`；复用已有 cell 表示有意替换其展示。

<a id="slot-style-ownership"></a>

### 当前位置渲染的内容由哪个包提供？

`data-slot` 标记位置；`data-plugin` 标出内容由哪个包提供，与该包的 CSS 设置无关。对于[隔离样式](../../packages/client/ui-renderer/README.zh.md#package-style-isolation)，不同包名会截断外层包的作用域；里面再次出现同名包的根时，该包的样式可重新生效。提供方未知或框架显示错误时，使用 `data-plugin=""`。共享出口不带 `data-plugin`，不影响外层作用域。

| 位置 | 哪个已有元素 | `data-plugin` 写谁的包名？ |
|---|---|---|
| `root`、`single`、`keyed` | `[data-slot]` | 胜出的注册项；`single` 或 `keyed` 渲染后备内容时写调用方。匹配项全部失败则显示框架错误。`root` 从未注册属于装配错误。 |
| `chain` | `[data-slot]`；使用 `overlay` 时，后备内容另有 `[data-chain-overlay-fallback]` | 选中的注册项；无匹配或指定 `fallbackOnly` 时写调用方。后备元素始终标记其内容的提供方，即使暂时隐藏也一样。 |
| `list`，包括指定 `only` 时 | 胜出项用 `[data-slot-item]`；后备内容用 `[data-slot]` | 每行写该行胜出注册项的包名。只要有行，出口就不写 `data-plugin`，即使只有一行。没有匹配的 `id` 时，出口标记调用方；某个 `id` 的注册全部失败时，在出口直属的错误元素上写 `data-plugin=""`。 |
| `hoc` | `[data-slot]`；各层转发子内容处的 `[data-slot-children]` | 最外面的适用层；没有适用层则写调用方。每个 `children` 出口标记**里面这份内容**的提供方：有下一层就是下一层，到了最内层就是最初的调用方。 |
| Component Factory | `[data-slot-factory]`；已挂载的局部替换用 `[data-slot-factory-children]` | 本体由定义方提供，局部替换由调用方提供。默认局部组件没有独立的根。缺少定义时直接返回调用方的后备内容，没有 Factory 根。 |

这些属性不增加 DOM 元素，也不赋予额外的渲染权限。[样式作用域的设计说明](../../.agents/notes/implemented/architecture/2026-11-23-slot-module-boundaries-for-css-scope.zh.md)举例说明了按钮如何在另一包的 Factory 中保留调用方的样式，以及 HOC 层如何转发 `children`。

<a id="list-item-roots"></a>

### list 行根

`list` 出口（`[data-slot="key"]`）为每个选中 `id` 的胜出注册项渲染一个直接子元素 `[data-slot-item]`，用 `only` 只选一个 `id` 时也一样。该属性的值为空，不标识注册项或渲染实例。出口和行根默认都用 `div`；list 声明 `inline: true` 时都用 `span`。两者都使用 `display: contents`，自身没有布局盒。

胜出组件返回 `null` 时会留下一个空行根。文本和 React Fragment 在本地渲染的所有节点都在同一个行根内；通过 Portal 渲染的内容仍在目标容器内。行根数量并不代表可见控件数。list 没有注册项或 `only` 未匹配任何 `id` 时，owner 的 `fallback` 直接渲染在出口内（省略时不渲染内容）。若匹配的 `id` 下所有注册项都已渲染失败，`[data-slot-error="key"]` 占位元素会取代行根，成为出口的直接子元素。只要同一注册项仍被选中，重排兄弟行或切换 `only` 都不会重新挂载这一行及其控件，控件状态也会保留。

<a id="hoc-layers"></a>

### Hoc 层

hoc entry 是以必填 `id` 和可选 `key` 寻址的一层。不带 `key` 的层是通配层，作用于每次分派；带 `key` 的层只在 owner 向 `renderSlot` 传入相同 `entryKey` 时生效，省略 `entryKey` 的 owner 只得到通配层。每个 `(key, id)` 组合（通配视为单独的 key）是一个遮蔽 cell；同一 `id` 下，精确 key 的层替换该 key 的通配层。

各层依次按 `order`、`priority`、注册顺序升序嵌套，最小者在最外层。每层收到同一份 owner props。渲染器通过 React 的 `children` 传入下一层；最内层收到的是 owner 的内容。owner 可以省略内容，适用层仍会渲染。每层至多渲染一次 `children`。owner props 不得使用 `children` 这个名字。

外层 `[data-slot="key"]` 标记 slot `key` 的渲染位置。没有适用层时，owner 的内容在其中原样渲染，不产生 `children` 出口。某层渲染 `children` 时，渲染器就在该位置用一个 `[data-slot-children="key"]` 出口包住内层内容，即使内容为空也会生成该出口。多层转发 `children` 时，这些出口相互嵌套。某层省略 `children` 即替换其内部的全部内容：该层的 `children` 出口和内层内容都不会挂载。

`data-slot-children` 的值是向该层提供这份 `children` 的 slot 名。即使该层把 `children` 交给另一个 slot 渲染，这个值也不变。同一 slot 的各层和各次渲染实例都使用同一个值；它不标识层、插件模块或分派用的 `entryKey`。

假设 owner 向 `outer.frame` 传入一个按钮。`outer.frame` 的层将自己的 `children` 和紧随其后的第二个按钮放在同一个 React Fragment 中，传给它声明的 hoc slot `inner.frame`。若 `inner.frame` 的层原样返回自己收到的 `children`，DOM 如下：

```text
[data-slot="outer.frame"]
  [data-slot="inner.frame"]
    [data-slot-children="inner.frame"]
      [data-slot-children="outer.frame"]
        button
      button
```

两个按钮最近的 `[data-slot]` 都是 `inner.frame`，`[data-slot-children] > button` 也会同时选中两者。在目标 `outer.frame` 实例内，`[data-slot-children="outer.frame"] > button` 只选中 owner 传入的按钮；`[data-slot-children="inner.frame"] > button` 只选中 `outer.frame` 的层添加的按钮。

- 重新挂载：增减一个适用于本次分派的层会让其内部内容重新挂载；`session` 或 `session-maybe` 作用域的层在 Session binding 变化时也会让内部内容重新挂载。同一具名 slot 中分派同一 key 的 outlet 共享一条编译好的层链，因此为其他 key 注册的层不会让它们的内容重新挂载；outlet 切换 `entryKey` 时会换到另一条层链，即使生效的层相同，内容也会重新挂载。
- 错误：层自身崩溃时照常上报错误，出错处回退到同一份 `children`（含其出口），直到该处本次挂载结束，owner props 变化也不恢复。该层保持注册，因此其他出现处（包括分派同一 key 的出现处）仍保留它，重新挂载的出现处会再次渲染它。被包裹内容抛出的错误穿过所有层，不记到任何层名下；层如果自己在 `children` 外包错误边界，捕获到的是内部包装错误而不是原始错误。
- 布局：两种出口都使用 `display: contents` 的 `div`（`inline: true` 时使用 `span`）。它们不产生布局盒，但仍参与子元素和兄弟元素选择器的匹配。应按属性识别出口，而非依赖嵌套深度。包裹 `children` 的层自身不得产生盒子，除非该 slot 另有说明。

[右键菜单插件](../../packages/client/ui-context-menu/README.zh.md) 通过 `provideRoot` 贡献 `useContextMenu`；每个作用域接收同一个由插件拥有的触发器工厂。提供方卸载时，注入属性与保留的处理器一并失效。其根作用域 keyed Slot `contextMenu.icon` 根据操作元数据渲染业务方提供的图标。

<a id="component-inputs"></a>

## 组件输入

注册组件会在 binding 位置收到组装后的输入。组件应从这些类型推导 props，不要重新抄写成员。

| 输入 | 声明者 | 组件类型 |
|---|---|---|
| owner 值与标准 scope 值 | `SlotMap` 条目与已安装的 scope adapter | `PropsRuntime<K>` |
| 获授权的 child renderer | 注册项的 `children` keys | `PropsRenderSlots<S>` |
| 共享视图状态的 selector hook 与 mutation callback | 注册项的 `store` | `PropsStore<H>` |
| 私有数据、callback 与 observable hook | 注册项的 `inject` factory | `InjectFace<I>` |
| 本地化 `t` 函数 | 注册项的 `locale` namespace | `PropsLocale<N>` |
| chain 选中的值 | 注册项的 `select` 结果 | 通过 `ComposedProps` 提供的 `matched` |
| 被包裹的 owner 内容 | `SlotMap` 条目的 `hoc` kind | 通过 `ComposedProps` 提供的 `children` |

当 entry 声明 `session` 或 `session-maybe` child 时，`PropsRenderSlots` 还会提供 `SessionProvider`。不传 `session` prop 时，它继承外围 binding；显式传入 `SessionReference` 或 `undefined` 时，只覆盖该子树。Provider 不为整个 body 设置 key。严格 `session` entry 在 binding generation 改变时重新挂载。空白 `session-maybe` entry 接受首个 binding 时不重新挂载，后续 generation 变化或回到缺失状态时才重新挂载。

组件绝不会收到 `ctx`。父组件在某次渲染时已经知道的值通过 `renderSlot` 的 owner 参数进入；共享视图状态使用声明的 store；service 与 model object 留在 `apply` closure 中，只向组件投影 callback 或 observable source。

<a id="framework-provided-hooks"></a>

## 框架提供的 hooks

当前组合中的 adapter 会添加以下标准 props。它们按目标 slot 的 scope 提供，与注册组件来自哪个包无关。

| 可用范围 | Props | Owner |
|---|---|---|
| 所有 scope | `useSessions`、`useSessionRetainInfo`、`useSessionAccess` | `ui-session` |
| 所有 scope | `useSessionStatus` | `ui-session-status` |
| 所有 scope | `useWorkspaces`、`useWorkspaceAccess` | `ui-workspace` |
| 所有 scope | `useRemoteAccess`（`global` 资源） | `api-remote-access` |
| 所有作用域 | `usePanelInfo` | `ui-layout` |
| 所有已挂载的作用域 | `useDocumentPortal`、`useDocumentViewport` | [ui-renderer](../../packages/client/ui-renderer/README.zh.md#use-this-package) |
| 所有 scope | `useMediaQuery` | `ui-responsive` |
| 所有 scope | `useMobile` | `ui-responsive` |
| 所有 scope | `useTheme` | [ui-theme](../../packages/client/ui-theme/README.zh.md#use-this-package) |
| `session` | `sessionId`、`useSession`、`useProjection`、`useAccess`（所绑定 Session 的答案） | `ui-session` |
| `session-maybe` | 结果可选的 `sessionId`、`useSession`、`useProjection`、`useAccess` | `ui-session` |
| `session` | `useConversation`、`useInput`、`inputActions` | `ui-conversation` |
| `session-maybe` | 结果可选的 `useConversation`、`useInput`、`inputActions` | `ui-conversation` |
| `session` | `useChat` | `ui-chat` |
| `session` | `useTrajectory` | `ui-trajectory` |

`useMediaQuery(query)` 回答 CSS 媒体查询当前是否在页面窗口中匹配，结果变化时组件重新渲染；当结果决定渲染结构或行为时使用它，纯样式差异仍写在 CSS `@media` 规则中。`useMobile()` 回答页面是否运行在手机或平板上，在页面生命周期内固定不变；它只用于自动聚焦和软键盘行为，布局按宽度媒体查询选择。组件读取其中任一 prop 的插件要 inject `uiResponsive` 服务，这样它会在两个 props 都存在之后启动，并随它们一起卸载。`useTheme(selector)` 从当前主题快照中选取值；组件读取它的插件要 inject `theme` 服务。

Renderer 还会根据声明的 store 创建 `useStore`，并根据声明的 locale namespace 创建 `t`。这些是由注册项推导的 props，不属于全局标准 props。

框架与领域 adapter owner 可以通过 `ctx.slots.provideRoot()` 或 `ctx.uiSession.provide()` 扩展标准集合，同时提供对应的 `GlobalStandardProps`、`SessionStandardProps` 或 `SessionMaybeStandardProps` 声明合并。普通功能组件不应自行创建 React hook prop，也不应为 entry 私有数据添加全局标准 prop。

## 开发者提供的 injection

注册项的 `inject` 选项是通常使用的功能私有注入点。它的 factory 在插件的 `apply` 世界中运行，可以闭包捕获已经注入的 Cordis service，并且只返回组件所需的数据与 callback。对于 `session` slot，它会收到 `sessionId`；对于 `session-maybe`，它收到 `sessionId | undefined`；声明 store 后，它还会收到该 store 绑定后的 actions。

返回值中保留的 `hooks` 对象接收裸 `getSnapshot`／`subscribe` source。Renderer 把 `hooks: { status }` 转换为组件 prop `useStatus(selector)`，并按 source identity 缓存绑定。组件不会收到 source 本身，也不直接调用 `useSyncExternalStore`。

当每个 occupant 都需要同一种能力时，slot owner 可以在 child 声明里放置 `inject` face。普通成员会原样交给所有 occupant；其 `hooks` 对象中的函数成员是 hook factory，它会收到 slot 的标准 props 与可选的逐次渲染 `hookContext`，再返回提供给 occupant 的受限 hook。`conversation.chat.node` 正是通过这种机制，为当前渲染的 node 提供 `useTurnData(key)`。

一次渲染时 owner 已知的值走 owner props；单个 entry 的 callback 与私有 observable 走注册项 `inject`；由 slot owner 控制、所有 occupant 共享的能力走 slot 级 `inject`；需要跨 entry 共享或跨重新挂载保留的可变视图状态走声明的 store。React node 通过 child slot 组合，不通过注入值传递。

<a id="current-hierarchy"></a>

## Conversation 层级

下面的 Conversation 路径区分声明所有者与可复用 Factory 根，省略无关的外壳位置。条目拥有其声明的子 Slot；Factory 在其定义注册期间拥有子 Slot 声明。方括号标出默认 React 组件，普通 React 后代组件可以渲染其所有者的 Slot。Factory 调用指向独立的可复用定义，不是新的 Slot 声明。

```text
root [AppFrame]
└─ main[key=conversation] [ConversationPanel]
   └─ main.conversation [ConversationRoot / ConversationMainPanel]
      ├─ conversation.header [ConversationHeader]
      │  ├─ conversation.header.leading
      │  └─ conversation.session.header [ConversationSessionHeader]
      │     ├─ conversation.session.header.lineage
      │     ├─ conversation.session.header.actions
      │     ├─ conversation.session.header.utilities
      │     │  └─ id=session-panel [SessionPanelToggle]
      │     │     └─ conversation.session.panel.indicator [list, inline]
      │     ├─ conversation.session.header.views.actions
      │     └─ conversation.session.header.corner
      └─ calls Factory: conversation.content

Factory: conversation.content [ConversationContent]
├─ conversation.session [ConversationSession / DefaultConversationViews]
│  └─ conversation.view
│     ├─ id=chat [ChatView]
│     │  ├─ conversation.chat.text-interaction [list]
│     │  ├─ conversation.chat.markdown.fence [hoc, keyed by fence language]
│     │  ├─ conversation.chat.aside [SessionPanel]
│     │  │  ├─ conversation.session.panel.section [list]
│     │  │  │  └─ id=environment [EnvironmentSection]
│     │  │  │     └─ conversation.session.panel.environment.row [list]
│     │  │  └─ conversation.session.panel.section.actions [keyed]
│     │  └─ conversation.chat.flow [ChatFlow]
│     │     └─ conversation.chat.node [ChatNodeSeat dispatch]
│     │        ├─ key=user [UserMessageNodeView]
│     │        │  ├─ conversation.chat.user.before [chain]
│     │        │  └─ calls Factory: conversation.chat.user.content
│     │        ├─ key=steering [UserMessageNodeView]
│     │        │  └─ calls Factory: conversation.chat.user.content
│     │        ├─ key=assistant-step [AssistantNodeView / AssistantMarkdown]
│     │        │  ├─ conversation.chat.message.images [MessageImages]
│     │        │  └─ conversation.chat.reasoning.body [DefaultReasoningBody]
│     │        │     └─ calls Factory: conversation.chat.reasoning.content
│     │        ├─ key=tool-call [ToolCallTree]
│     │        │  └─ tool.call.toolview
│     │        │     └─ key=read_image [ReadImageRow / ToolRow]
│     │        │        └─ tool.call.images [MessageImages]
│     │        ├─ key=command-input [GoalCommandInputView]
│     │        │  └─ calls Factory: conversation.user.text
│     │        ├─ key=command [CommandNodeView]
│     │        │  └─ conversation.chat.commandview
│     │        └─ key=turn-tail [TurnTailNodeView]
│     │           ├─ conversation.chat.turnTail
│     │           └─ conversation.chat.assistant-actions
│     └─ id=trajectory [TrajectoryView / TrajectoryTable]
│        └─ conversation.trajectory.images [MessageImages]
├─ conversation.composer
│  ├─ conversation.approval.detail
│  └─ conversation.plan-review.actions
├─ conversation.composer.bar [InputBar]
│  ├─ conversation.input.attachments
│  ├─ conversation.input.placeholder
│  ├─ conversation.input.permission
│  ├─ conversation.input.plan
│  ├─ conversation.input.model
│  │  └─ conversation.input.model.label
│  ├─ conversation.input.overlay
│  ├─ conversation.composer.dock
│  ├─ conversation.input.left
│  └─ conversation.input.right
├─ conversation.input.dock
│  └─ id=queue [QueueDock]
│     └─ calls Factory: conversation.user.text
├─ conversation.hero.frame [hoc]
│  └─ id=pixel-whale [PixelWhale]
├─ conversation.hero.brand.mark
├─ conversation.hero.workspace
│  └─ conversation.hero.workspace.directoryFlow
├─ conversation.hero.agentPreset
└─ conversation.hero.options

Factory: conversation.chat.user.content [UserContent]
├─ conversation.chat.user.images [MessageImages]
└─ calls Factory: conversation.user.text

Factory: conversation.user.text [UserText]
└─ conversation.user.text.node [keyed, inline]

Factory: conversation.images.content [MessageImagesContent / ImageGallery]
Factory: conversation.chat.reasoning.content [ReasoningContent / MarkdownText]
```

四个图片 Slot 默认均填入 `MessageImages`，由它携带调用者的图片引用和授权 loader 调用 `conversation.images.content`。用户与输出图片的替换互不影响。`conversation.user.text` Factory 由用户内容、Queue 和 Goal 共用；其 `inline: true` keyed Slot 使用 span 锚点及行内错误占位，而不是块级包装。

生成的 [Client inspect catalog](../../packages/extensions/cordis-client-runner/src/client/slot-catalog.ts) 是包含所有外壳分支及每个 key 的完整参考，包含 cardinality、scope、owner props、标准 props、当前 occupant、声明 owner 与替换风险。运行中的动态包可以用 `cordis_inspect what:"client"` 查询实时树与某个精确 key；源码 catalog 由 `pnpm run gen-client-catalog` 根据 `SlotMap` 声明和 `slots.register()` 调用点生成。

<a id="extension-rules"></a>

## 扩展规则

- 另一个功能包只能通过 `import type` 引入声明；绝不导入或转发它的运行时值。
- 只在拥有并渲染某个位置的组件中声明新的 child slot。其他包通过 `ctx.slots.inject()` 等待，再通过 `ctx.slots.register()` 贡献内容。
- 业务与传输状态留在所属 Cordis service 或 Client model 中。Slot store 只承载共享的视图与交互状态。
- 可观测 source 及其 snapshot identity 在值变化前保持稳定；值变化时通过同一个 source 发布。
- UI domain 之间只传 JSON 兼容数据和 callback。`hooks` compartment 是裸 observable 的唯一例外；React 内容通过 slot 传递。
- 将 `single` 和已有 occupant 的 keyed cell 视为替换点。增量扩展使用新的 list 或 hoc id，或尚未占用的 key。
