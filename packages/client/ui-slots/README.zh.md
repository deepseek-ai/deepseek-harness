---
description: "dsh Web 客户端的 slot 注册表纯核心：普通扩展 slots、可复用 Component Factory、推导 props 类型、store 席位与渲染器安装约定。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-slots

[English](README.md) | 中文

## 概述

`dsh-client-ui-slots` 让 Web 客户端插件定义并组合带类型检查的 UI 区域。普通 Slots 提供 parent-owned 扩展位置；Component Factory 提供带调用方所选局部 Component 的可复用装配。两套 API 都从声明合并类型推导 scoped state、injection、locale 与 child-render props，并在插件加载期间报告冲突 definition。客户端需要渲染时，将这个不依赖 React 的包与 `ui-renderer` 配合使用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

编写客户端插件时都通过本包组合 UI：把组件注册进父级已声明的 slot，或声明组件将要渲染的子 slot。四种 kind 覆盖组合形态——`single`（单个占位者）、`list`（有序条目）、`keyed`（按键分派）与 `chain`（条目自行提名）。

### 可复用 Component Factory

当一个包定义装配、而互不相关的 parents 需要独立渲染它时，使用 Component Factory。在 `SlotFactoryMap` 中声明完整类型，通过 `ctx.slots.registerFactory()` 安装 definition，通过注入的 `renderFactorySlot()` 渲染 occurrences，并通过调用的 `slots` 选项选择每个已声明的局部 Component。definition 通过 `useFactorySlot(name, fallback)` 读取该选择。

Factory `children` 仍是普通全局 Slots 且必须与 `SlotMap` 匹配，而局部 `slots` 为每个 occurrence 选择一个 Component。occurrence 继承其渲染位置的 scope；`renderFactorySlot()` 不接受 Session identity。共享 Store handle 使用普通 scope 解析。Store factory 保持 lazy，直到 occurrence 首次物化时才为该渲染位置创建一个 handle；若持久化 Store spec 会让 persistence key 在 occurrences 之间冲突，renderer 会拒绝它。

### 五个框架 props share

每个已注册组件都会收到由五个框架 share 组合而成的 props：运行时 share（父级 render 调用点的 `owner`，加上会话标准工具包与全局席位）、child render share（静态缩窄到已声明 children 的 `renderSlot`）、Factory render share（`renderFactorySlot`）、store share（已声明 handle 的 selector 钩子与移除 draft 的 actions），以及业务 share（从 `inject` 推导）。组件引用推导出的 props 别名；它们绝不在本地重新定义任何 share 的类型。

### Store 席位

register 调用可以用 `store: defineStore(...)` 声明 store 席位：`init` 推断状态 schema，`actions` 是完整的 draft-transform 写入集合。组件经 selector 钩子读取、经烘焙回调写入；`defineStore` 的引擎实现位于运行时包，并满足这里导出的 `DefineStore` 约定。

### 声明纪律

声明即认领：注册条目成为唯一被允许渲染该键的条目；注册未声明 slot、声明已声明过的子项、在两个 scope 下挂载同一个共享句柄、或注册缺少 `select` 的 chain，都会在加载时抛出。条目的 disposer 会递归移除其声明的子 slot——账本行、贡献与 store 挂载都随同一生命周期结束而移除。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

普通 Slot 设计就是一张表：声明 = 渲染授权 = 运行时规范。`SlotMap` 在这里声明为空，由消费方通过 `declare module` 增补合并；`SlotFactoryMap` 和标准工具包接口（`SessionStandardProps`、`GlobalStandardProps`）也采用同一方式。Factory definition 使用独立的单 definition ledger，因为其 occurrences 没有 parent 声明。

### 注册与路由

`SlotCore` 在构造时预置 `'root'` slot，并强制执行加载时验证。`ChainSelect` selector 按升序 `priority` 运行（相同值按注册顺序）；第一个非 null 返回值选中其条目，并成为组件的 `matched` prop；全部返回 null 时使用 owner 的 `renderSlotChain` fallback（`ChainRenderOpts`）。每个 key 都携带一个 declaration epoch，它只在声明与移除时递增；`ui-renderer` 将其用于 `ctx.slots.inject`，且与普通条目版本相互独立。实时检查使用严格的 `type: 'slot' | 'factory'` 节点，并把 Factory-owned child Slots 嵌套在其 definition 下。

### 渲染器约定

`renderer.ts` 携带安装约定（`SlotRenderer`、`SlotRendererHost`）以及 `StaleAuthorizationError`/`SlotOwnershipError`；ui-renderer 负责实现，并在其插件生命周期中完成安装。引擎产物与渲染器宿主约定携带裸快照 source（`getSnapshot`/`subscribe`），绝不携带 React 钩子——钩子绑定属于渲染机制。Factory 崩溃使用普通监督通道，幂等 effect 仅在 commit 后保留逐渲染位置 Store handle。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖引擎、渲染器与组合模型。

- [ui-renderer](../ui-renderer/README.zh.md)——实现本包安装约定的 React slot 渲染器。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——权威组合模型。
- [Component Factory](../../../.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.zh.md)——可复用 definitions、局部 Component 选择与 occurrence 生命周期。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——本注册表接入的加载链与对象层。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 接线层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义注册表的规模扩展特性与已接受的类型噪声；它们是当前包约束。

- **`isLive` 会线性扫描所有记录**：在 UI 插件的注册规模（数十项）下没有问题；如果账本变得频繁访问，再使用条目→记录反向引用改进。
- **`__renders` 幻象锚点在 `PropsRenderSlots` 上可见**：这是与类型链设计的 `__accepts` 相同且已接受的噪声；泛型方法签名在 key 联合之间比较宽松，因此必须依靠逆变标记强制执行「组件 key 集合 ⊆ children 声明」。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是零依赖的纯注册表核心，本身不发出 Cordis 事件；`ui-renderer` SlotRegistry 负责事件桥及其不变式。本包的行为规范直接断言 define/register/dispose 的执行顺序。
