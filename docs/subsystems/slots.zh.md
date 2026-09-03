# Web Client Slots

[English](slots.md) | 中文

Slots 是 Web Client 的类型化 React 组合系统。[`dsh-client-ui-slots`](../../packages/client/ui-slots/README.zh.md)定义不依赖 React 的注册表与类型代数；[`dsh-client-ui-renderer`](../../packages/client/ui-renderer/README.zh.md)把可观测源绑定成钩子、渲染整棵树，并在内部拥有 React context。功能插件通过 `ctx.slots.register()` 贡献 UI，绝不导入其他功能插件的组件。

本文记录 slot 的所有权、组件输入、扩展 API 与当前层级。外围的启动、Remote、Client model 与 Conversation 数据通路见 [Web Client 架构](web-client.zh.md)。

## 声明与生命周期

`SlotMap` 是编译期注册表。包通过声明合并写入 key、cardinality（基数）、scope、owner props、keyed props 与可选的 slot 级 inject face。运行时声明则是拥有该渲染位置的组件在 `children` 中给出的对应条目。

声明一个 child 会同时产生三种效果：令该 child key 生效、授权 parent entry 调用 `renderSlot` 或 `renderSlotChain`，以及记录运行时 dispatch 规格。每个声明只能有一个存活 owner。向未声明 slot 注册，或重复声明其他 entry 已拥有的 child，都会在插件激活时失败。

`root` 是唯一内建声明，也是唯一由 Cordis service 自身渲染的 key。`ui-renderer` 调用 `ctx.slots.renderSlot('root', {})`；其余每个后代都通过声明它的 entry 所收到的 `renderSlot` 或 `renderSlotChain` prop 渲染。

注册和声明遵循 Cordis effect 生命周期。销毁一个 entry 会移除其贡献，并递归折叠它声明的 child slots。因此，向其他包的 slot 贡献功能时使用 `ctx.slots.inject(key, callback)`：callback 会在每段声明生命周期内运行，owner 折叠时其 effect 随之移除，owner 再次挂载时则重新运行。

```tsx ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

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
| scope | `root` | 一个 root 作用域组件和 store 实例。 |
| scope | `session-maybe` | 跟随当前选择，但没有 Session 时仍可渲染；Session 值是可选的。 |
| scope | `session` | 要求可解析的 Session binding，并收到确定存在的 Session 值。 |

对于 `single`、`list` 和 `keyed` cell，`priority` 是遮蔽优先级；对于 `chain`，它是选举顺序。数值越小越先运行或渲染。普通增量贡献应选用新的 list `id` 或 keyed `key`；复用已有 cell 表示有意替换其展示。

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

当 entry 声明 strict Session child 时，`PropsRenderSlots` 还会提供 `SessionProvider`。它把子树绑定到当前 Session identity，并在 identity 改变时重新挂载 body。

组件绝不会收到 `ctx`。父组件在某次渲染时已经知道的值通过 `renderSlot` 的 owner 参数进入；共享视图状态使用声明的 store；service 与 model object 留在 `apply` closure 中，只向组件投影 callback 或 observable source。

## 框架提供的 hooks

当前组合中的 adapter 会添加以下标准 props。它们按目标 slot 的 scope 提供，与注册组件来自哪个包无关。

| 可用范围 | Props | Owner |
|---|---|---|
| 所有 scope | `useSessions`、`useSessionPendingInteraction` | `ui-session` |
| 所有 scope | `useWorkspaces` | `ui-workspace` |
| `session` | `sessionId`、`useSession`、`useProjection` | `ui-session` |
| `session-maybe` | 结果可选的 `sessionId`、`useSession`、`useProjection` | `ui-session` |
| `session` | `useConversation`、`useInput`、`inputActions` | `ui-conversation` |
| `session-maybe` | 结果可选的 `useConversation`、`useInput`、`inputActions` | `ui-conversation` |
| `session` | `useChat` | `ui-chat` |
| `session` | `useTrajectory` | `ui-trajectory` |

Renderer 还会根据声明的 store 创建 `useStore`，并根据声明的 locale namespace 创建 `t`。这些是由注册项推导的 props，不属于全局标准 props。

框架与领域 adapter owner 可以通过 `ctx.slots.provideRoot()` 或 `ctx.uiSession.provide()` 扩展标准集合，同时提供对应的 `GlobalStandardProps`、`SessionStandardProps` 或 `SessionMaybeStandardProps` 声明合并。普通功能组件不应自行创建 React hook prop，也不应为 entry 私有数据添加全局标准 prop。

## 开发者提供的 injection

注册项的 `inject` 选项是通常使用的功能私有注入点。它的 factory 在插件的 `apply` 世界中运行，可以闭包捕获已经注入的 Cordis service，并且只返回组件所需的数据与 callback。对于 `session` slot，它会收到 `sessionId`；对于 `session-maybe`，它收到 `sessionId | undefined`；声明 store 后，它还会收到该 store 绑定后的 actions。

返回值中保留的 `hooks` 对象接收裸 `getSnapshot`／`subscribe` source。Renderer 把 `hooks: { status }` 转换为组件 prop `useStatus(selector)`，并按 source identity 缓存绑定。组件不会收到 source 本身，也不直接调用 `useSyncExternalStore`。

当每个 occupant 都需要同一种能力时，slot owner 可以在 child 声明里放置 `inject` face。普通成员会原样交给所有 occupant；其 `hooks` 对象中的函数成员是 hook factory，它会收到 slot 的标准 props 与可选的逐次渲染 `hookContext`，再返回提供给 occupant 的受限 hook。`conversation.chat.node` 正是通过这种机制，为当前渲染的 node 提供 `useTurnData(key)`。

一次渲染时 owner 已知的值走 owner props；单个 entry 的 callback 与私有 observable 走注册项 `inject`；由 slot owner 控制、所有 occupant 共享的能力走 slot 级 `inject`；需要跨 entry 共享或跨重新挂载保留的可变视图状态走声明的 store。React node 通过 child slot 组合，不通过注入值传递。

## 当前层级

下图是当前发布组合的声明树。只有具名 parent entry 已挂载时，其 child 才存在；因此可选功能 entry 可以作为一个生命周期单元让整棵子树出现或消失。

```text
root
├─ sidebar
│  ├─ sidebar.brand.mark
│  ├─ sidebar.brand.name
│  ├─ sidebar.footer.action
│  ├─ sidebar.workspaces
│  │  └─ sidebar.workspaces.directoryFlow
│  └─ sidebar.settings
│     ├─ settings.trigger
│     ├─ settings.header
│     ├─ settings.action
│     ├─ settings.close
│     ├─ settings.onboarding
│     └─ settings.section
│        ├─ settings.general.item
│        ├─ settings.models.provider-card
│        ├─ settings.models.footer
│        └─ settings.plugins.tab
│           └─ settings.plugin.item
├─ conversation
│  ├─ conversation.session
│  │  └─ conversation.view
│  │     ├─ conversation.chat.node
│  │     │  ├─ conversation.chat.assistant-actions
│  │     │  ├─ conversation.chat.commandview
│  │     │  ├─ conversation.chat.turnTail
│  │     │  └─ tool.call.toolview
│  │     │     ├─ tool.call.images
│  │     │     └─ tool.view.cordis
│  │     ├─ conversation.message.images
│  │     └─ conversation.trajectory.images
│  ├─ conversation.session.header
│  │  ├─ conversation.session.header.lineage
│  │  ├─ conversation.session.header.actions
│  │  └─ conversation.session.header.utilities
│  ├─ conversation.composer
│  │  └─ conversation.approval.detail
│  ├─ conversation.composer.bar
│  │  ├─ conversation.input.attachments
│  │  ├─ conversation.input.plan
│  │  └─ conversation.input.model
│  ├─ conversation.input.overlay
│  ├─ conversation.input.dock
│  ├─ conversation.composer.dock
│  ├─ conversation.input.left
│  ├─ conversation.input.right
│  ├─ conversation.hero.brand.mark
│  ├─ conversation.hero.workspace
│  │  └─ conversation.hero.workspace.directoryFlow
│  └─ conversation.hero.agentPreset
├─ details
│  └─ conversation.details.tool
└─ shell.overlay
```

生成的 Client inspect catalog 是每个 key 的完整参考，包含 cardinality、scope、owner props、标准 props、当前 occupant、声明 owner 与替换风险。运行中的动态包可以用 `cordis_inspect what:"client"` 查询实时树与某个精确 key；源码 catalog 由 `pnpm run gen-client-catalog` 根据 `SlotMap` 声明和 `slots.register()` 调用点生成。

## 扩展规则

- 另一个功能包只能通过 `import type` 引入声明；绝不导入或转发它的运行时值。
- 只在拥有并渲染某个位置的组件中声明新的 child slot。其他包通过 `ctx.slots.inject()` 等待，再通过 `ctx.slots.register()` 贡献内容。
- 业务与传输状态留在所属 Cordis service 或 Client model 中。Slot store 只承载共享的视图与交互状态。
- 可观测 source 及其 snapshot identity 在值变化前保持稳定；值变化时通过同一个 source 发布。
- UI domain 之间只传 JSON 兼容数据和 callback。`hooks` compartment 是裸 observable 的唯一例外；React 内容通过 slot 传递。
- 将 `single` 和已有 occupant 的 keyed cell 视为替换点。增量扩展使用 list id 或尚未占用的 key。
