---
description: "dsh Web 客户端的 slot 注册表纯核心：SlotMap 声明合并、单一 register 组合 API、四 share props 类型、store 席位与渲染器安装约定。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-slots

[English](README.md) | 中文

## 概述

`dsh-client-ui-slots` 是 Web 客户端 slot 系统的纯核心：每个 UI 功能都经由它组合的类型级约定。一次 `register({ name, children?, store?, inject?, ...kind }, Component)` 调用会向已声明 slot 贡献一个组件，同时声明子 slot、store 席位与注册方的业务表层。组件会在调用点依据 `ComposedProps` 接受类型检查——该类型是四个 share 的交集，每个 share 都从各自的唯一真源派生——因此错误的组合在编译期就会失败。chain-kind slot 会反转键控路由：条目通过纯 selector 自行提名，而不是由分发点选择 `entryKey`。本包在运行时与 Cordis 无关（仅使用 React 类型）；`ui-renderer` 拥有引擎实现与 React 绑定。

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

### 四个 props share

每个已注册组件都会收到由四个 share 组合而成的 props：运行时 share（父级 renderSlot 调用点的 `owner`，加上会话标准工具包与全局席位）、child render share（静态缩窄到已声明 children key 的 `renderSlot`）、store share（已声明 handle 的 selector 钩子与移除 draft 的 actions），以及业务 share（从 `inject` factory 返回值推断）。组件引用 `ComposedProps`；它们绝不在本地重新输入任何 share。

### Store 席位

register 调用可以用 `store: defineStore(...)` 声明 store 席位：`init` 推断状态 schema，`actions` 是完整的 draft-transform 写入集合。组件经 selector 钩子读取、经烘焙回调写入；`defineStore` 的引擎实现位于 runtime 包，并满足这里导出的 `DefineStore` 约定。

### 声明纪律

声明即认领：注册条目成为唯一被允许渲染该键的条目；注册未声明 slot、声明已声明过的子项、在两个 scope 下挂载同一个共享 handle、或注册缺少 `select` 的 chain，都会在加载时抛出。条目的 disposer 会递归移除其声明的子 slot——账本行、贡献与 store 挂载都随同一生命周期结束而移除。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

设计就是一张表：声明 = 渲染授权 = 运行时规范。`SlotMap` 在这里声明为空，由消费方通过 `declare module` 增补合并，标准工具包接口（`SessionStandardProps`、`GlobalStandardProps`）也是如此，由 runtime 包以真实成员合并。

### 注册与路由

`SlotCore` 在构造时预置 `'root'` slot，并强制执行加载时验证。`ChainSelect` selector 按升序 `priority` 运行（相同值按注册顺序）；第一个非 null 返回值选中其条目，并成为组件的 `matched` prop；全部返回 null 时使用 owner 的 `renderSlotChain` fallback（`ChainRenderOpts`）。每个 key 都携带一个 declaration epoch，它只在声明与移除时递增；`ui-renderer` 将其用于 `ctx.slots.inject`，且与普通条目版本相互独立。

### 渲染器约定

`renderer.ts` 携带安装约定（`SlotRenderer`、`SlotRendererHost`）以及 `StaleAuthorizationError`/`SlotOwnershipError`；ui-renderer 同时持有实现及其插件生命周期安装。引擎产物与渲染器宿主约定携带裸快照 source（`getSnapshot`/`subscribe`），绝不携带 React 钩子——钩子绑定属于渲染机制。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖引擎、渲染器与组合模型。

- [ui-renderer](../ui-renderer/README.zh.md)——实现本包安装约定的 React slot 渲染器。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——权威组合模型。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——本注册表接入的加载链与对象层。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 接线层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义注册表的扩展行为与已接受的类型噪声；它们是当前包约束。

- **`isLive` 会线性扫描所有记录**：在 UI 插件的注册规模（数十项）下没有问题；如果账本变得频繁访问，再使用条目→记录反向引用改进。
- **`__renders` 幻象锚点在 `PropsRenderSlots` 上可见**：这是与类型链设计的 `__accepts` 相同且已接受的噪声；泛型方法签名在 key 联合之间比较宽松，因此必须依靠逆变标记强制执行「组件 key 集合 ⊆ children 声明」。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是零依赖纯 registry core，本身不发出 Cordis 事件；`ui-renderer` SlotRegistry 负责事件桥及其不变式。
