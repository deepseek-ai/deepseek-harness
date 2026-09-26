# Agent Note: 带局部 slot 的可复用组件 Factory

Status: implemented

[English](2026-09-10-component-factories-and-local-slots.md) | 中文

## 问题

浏览器 Slot 系统从 parent-owned 扩展位置开始。parent entry 通过 `children` 声明 child，之后互不相关的插件可以向该位置注册实现。声明固定 child Slot 的 kind、scope、渲染权限与生命周期。

可复用组件装配采用相反的所有权方向。一个包定义装配，互不相关的 parents 渲染独立 occurrence，并且每个 parent 可以为具名内部区域选择不同 Component。普通 Slot 无法表示这种关系，因为它的 definition 属于全局 Slot 树中的一个 parent 位置。

定义包与消费包独立编译。TypeScript 无法从另一个包中的运行时 registration 推导所选 Component 的 props，另行维护的扁平 props 类型则会重复 store、injection、locale、child-render 与 scope 声明。

## 决策

`ui-slots` 与 `ui-renderer` 在[普通 Slot 体系](2026-07-22-slot-type-chain-implementation.zh.md)之外提供具名 Component Factory。`registerFactory()` 安装一个可复用 definition，`renderFactorySlot()` 渲染一个 occurrence，definition 通过 `useFactorySlot()` 读取调用方选择的局部 Component。

### 相反的注册方向

普通 Slot 与 Component Factory 保留不同的所有权模型。

| 属性 | 普通 Slot | Component Factory |
|---|---|---|
| 首个声明 | Parent 声明 child Slot | Definition owner 声明 Factory |
| 后续操作 | Child 注册进 parent 位置 | Parent 渲染 occurrence |
| 静态权威 | `SlotMap` 描述位置 | `SlotFactoryMap` 描述完整 definition |
| 有效 definitions | 多个 entries 可以占据 cells | 一个 definition 独占一个 Factory 名 |
| Parent 输入 | `renderSlot()` owner 与 keyed props | `renderFactorySlot()` occurrence props |
| Parent 选择的 Component | Registry routing 选择 entries | 调用方为每个局部 slot 选择一个 Component |
| 后代扩展点 | Entry-owned 普通 `children` | Definition-owned 普通 `children` |

`SlotFactoryMap` 通过声明合并给出完整静态 definition：

```text
interface SlotFactoryDef {
  scope: SlotScope
  props?: object
  children?: ChildrenDecl
  store?: StoreDecl
  inject?: object
  locale?: keyof LocaleNamespaceMap & string
  slots?: Record<string, { scope: SlotScope; props?: object }>
}
```

该 map 是唯一类型权威。`registerFactory()` 根据对应 map 条目检查运行时 definition 与主 Component。Store 声明通过 `HandleOf` 规范化，因此 registration 只接受一个共享 handle 或一个生成该 handle 的 factory，绝不接受嵌套 factory。`FactoryComponentPropsOf<F>` 和 `FactoryLocalComponentPropsOf<F, N>` 从同一条目推导完整 Component props；definition owner 与消费方无需重述扁平共享类型。

### Definition 与 occurrence 生命周期

每个 Factory 名在独立于普通 Slot cells 的 registry ledger 中只有一个有效 definition。registration 遵循调用方的 Cordis effect。dispose 会移除 definition、折叠其普通 child 声明、通知已挂载 outlets，并令保留的 child-render 或局部 Component 权限失效。

每次 `renderFactorySlot()` 调用都会创建 occurrence，其 identity 由 React 位置和 `key` 决定。替换 definition 会重新挂载 occurrence。Definition Component 及其 fallback 局部 Component 的失败归属 definition，调用方所选局部 Component 的失败归属调用方 registration；嵌套 Factory 渲染保留同一 owner。所有失败都限制在当前 occurrence 内，不会移除共享 definition。装配错误继续向外传播，所有权与陈旧授权错误则像普通组件失败一样上报。外层错误边界随 Factory scope incarnation 重置，每个局部边界随自身局部 slot 的 scope incarnation 重置。

Factory scope 跟随 occurrence 所在 React 位置的 scope binding。`renderFactorySlot()` 不接受 Session id 或 scope target。严格 `session` Factory 要求当前 binding 存在，并在 identity 变化时重新挂载；`session-maybe` Factory 保留首次从空状态采纳 Session 的过程，并在后续 identity 变化时重新挂载，与普通 Slot 行为一致。

共享 store handle 保留普通模式的 handle-by-scope 行为，包括两个非 root scope 均要求 Session binding。独占 store factory 在 occurrence 首次物化时创建一个 handle；若该 handle 声明 `spec.persist`，renderer 会拒绝它，因为 registration 必须保持 lazy，且多个同时存活的独立 occurrence 无法安全共享一个 persistence key。渲染期记录在幂等 effect setup 保留已 commit occurrence 前只持有弱引用；effect cleanup 会移除 mounted 强引用，而 occurrence-keyed WeakMap 在 React effect replay 期间保留 identity，并允许实例在卸载后被回收。

### 局部 slots 与普通 children

调用方可以为 Factory `slots` 声明中的每个名称选择一个 Component。Factory 调用 `useFactorySlot(name, fallback)`，取得 identity 稳定的绑定 Component；该 Component 只接受对应局部 slot 的 occurrence props。绑定 Component 渲染时，renderer 提供 Factory 的 store、injection、locale、child renderers 与该局部 slot 自身的标准 scope props。

局部 slots 没有 list、keyed 或 chain routing，也没有独立 registration 生命周期。多贡献方扩展点仍使用 Factory 声明的普通 child Slots。这些 child 声明在 definition 范围内全局共享，而每个 occurrence 都在继承的 scope 下渲染其 registered entries。

实时检查将每个 definition 表示为 `type: 'factory'` 节点，并把其普通 child Slots 嵌套在该节点下。普通节点保留 `type: 'slot'` 与现有 `kind`；调用方通过 `factory:<name>` 选择 Factory 根节点。

每个由 renderer 创建的 Component 都会收到 `renderFactorySlot`，因此 Factory occurrence 不需要 parent-side use declaration。局部选择仍然属于单个 occurrence，并且不会引入对定义包的运行时 value import。

### 首个交付用途

`ui-conversation` 在共享正文与 Composer 外注册 optional-Session `conversation.content` Factory。其 strict-Session `views` 局部位置默认使用一个渲染现有 `conversation.session` Slot 的 adapter；其他 occurrence 可以选择不同的 View Component，且不会挂载主 Conversation Header。

Factory 不拥有 Conversation store。普通 `conversation.session` body 与 `conversation.session.header` 保留同一个 strict-Session handle，在保持草稿与 View 选择 identity 的同时，避免将该 handle 同时挂到 `session` 和 `session-maybe` scope。

### 类型与运行时强制规则

类型链拒绝未知 Factory 名、缺失或多余的 occurrence props、与 `SlotMap` 不一致的 child spec、与 `SlotFactoryMap` 不一致的 definition 字段、嵌套 store factory、未知局部名称、不兼容的选中 Component，以及 input、registration、injection 与 scope props 之间的所有权重叠。

运行时检查覆盖动态装配与纯 JavaScript 调用方：重复 definitions、child 声明冲突、未声明的局部名称、递归渲染、prop 冲突、陈旧权限、严格 scope 缺失与组件失败隔离。类型和运行时测试还固定了各 occurrence 的独占 store、按 scope 共享的 handles、注册前 fallback 行为、definition 替换、局部 scope 投影与普通 child 渲染。

## 考虑过的替代方案

**把普通 Slot 复用为可移植 definition。** 普通 Slot 属于一个 parent 声明以及全局树中的一个位置。在其他位置复用它会借用错误的所有权与生命周期。

**把主 Conversation Header 移进 Factory。** 只有主 host 渲染该 Header。将其留在 Factory 外，使嵌入式 occurrence 无需另一个局部选择即可省略 Header，并保留其现有 strict-Session Slot 生命周期。

**把共享 Conversation store 移到 optional-Session Factory。** Header 与 Session body 共享一个 strict-Session handle。将该 handle 同时挂到 `session-maybe` Factory 和 `session` Header 会违反 one-handle-one-scope 规则。

**在每个 parent 下分别注册同一装配。** 独立 registrations 会重复 definition 及其 child 声明。全局贡献方需要使用平行 child 名称，或造成声明冲突。

**维护扁平共享 props 类型。** 这会重复 `children`、`store`、`inject`、`locale` 与 scope 字段中已有的事实，使声明与 Component props 可以发生漂移。

**把 React node 或 render callback 作为业务 props 传递。** 这些值绕过 renderer 提供的 scope props、store 与 injection 装配、陈旧权限检查和局部 Component 类型检查。

**让局部 slots 具备普通 Slot routing。** 普通 Slots 已经负责多贡献方 routing。局部 slot 表示一次 occurrence 的一个调用方选择。

**向 `renderFactorySlot()` 传递 Session identity。** occurrence 像普通 Slot 一样继承渲染位置的 scope。第二个 identity 参数会产生两个可能不一致的权威；独立定址的 Session provider 属于另一项能力。

## 影响

功能包可以发布一份可复用 UI 装配，而消费方无需运行时导入其 Component。每个 occurrence 可以获得独立选择的局部 Components 与独占状态，同时保留全局普通 child 贡献以及现有 scope、locale、injection 和 store 规则。

新增的 registry ledger 与 occurrence 记录增加了 renderer 复杂度。Factory definitions 必须全局唯一，局部 slots 有意只支持一个选中 Component，并且该 API 本身不会创建可独立定址的 Session scope。

Factory 类型与运行时测试是可执行的兼容性记录。Slots 子系统参考以及 `ui-slots` 和 `ui-renderer` 包参考记录消费方 API。
