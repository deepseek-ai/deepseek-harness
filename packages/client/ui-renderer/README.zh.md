---
description: "浏览器 UI 渲染器：普通 Slot 与可复用 Component Factory 的 React 绑定、ctx.uiRenderer 与组装后的 dsh Web 应用根。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-renderer

[English](README.md) | 中文

## 概述

`dsh-client-ui-renderer` 挂载组装完成的 dsh Web 客户端 GUI：完整客户端插件名册稳定后，启动内核调用 `ctx.uiRenderer.mount(container)`，它会 hydrate 不依赖框架的启动页，并在下一次绘制前切换到完整的 React 应用。业务插件仍是接收类型化 props 的普通 React 组件，通过 props 获取会话与 Workspace 数据，永远不需要自行接线订阅——渲染器在 slot outlet 处把运行时的裸 observable source 绑定为 selector 钩子。Web 外壳与启动内核是它仅有的直接消费方，因此只要组合需要 React 渲染的 GUI，就需要它。

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

本包属于基础设施：Web 外壳与启动内核是它仅有的直接消费方。只要组合需要 React 渲染的 GUI，就需要它——`dsh-client-web` 加载名册，等待名册稳定且启动审计通过，然后调用 `ctx.uiRenderer.mount(container)`。

### 挂载做什么

`mount(container)` 同步安装已物化模块的样式，在存在启动 DOM 时 hydrate，然后渲染应用。返回的 disposer 先卸载 React 再释放样式。每个 renderer 实例持有一个活动挂载；同时第二次挂载会被拒绝，旧 disposer 不会移除后续挂载。插件销毁也会释放活动挂载。渲染器执行唯一的上下文级 `renderSlot('root')`，根占用方拥有产品布局。

### 对业务插件

挂载后的 Slot 无需额外注入服务就能使用 `useDocumentPortal()` 和 `useDocumentViewport()`。`const Portal = useDocumentPortal()` 返回稳定的组件：`<Portal onKeyDownCapture={onKey}>{children}</Portal>` 将内容渲染到应用文档的 `body`，保留来源位置最近的 `data-plugin` 标记。内容位于没有布局盒子的 `body > [data-document-portal]` 包裹层中，壳层针对 body 直接子层的规则（如 macOS 窗口拖拽扣除）作用于该包裹层的子元素。子节点与 Portal 在同一次提交中挂载，此时已位于 `body` 下并带有来源标记，因此子节点的 layout effect 与调用方的 effect 都能测量和聚焦它们；`<Portal>` 应与它展示的内容一同渲染。即使焦点在 Portal 外，`onKeyDownCapture` 和 `onKeyDown` 也能收到文档的原生事件；卸载时会移除监听器。视口钩子以 CSS 像素返回 `{ width, height }`，不含滚动条，并随窗口尺寸变化更新。两个钩子都不依赖插件脚本所在的窗口。

业务插件注册普通 Slot entry 或可复用 Component Factory；渲染器在渲染位置把运行时的会话与 Workspace observable source 绑定为 selector 钩子。插件通过推导出的 Component props 收到标准 scope props——它绝不导入渲染器，也不触碰 React 内部机制。每个由 renderer 创建的 Component 都能渲染 Factory occurrence，Factory 也能暴露由调用方选择的局部 Component，而无需在包之间共享实现值。

<a id="package-style-isolation"></a>
### 单独限制一个包的样式范围

客户端样式表默认全局生效。要让某个内置或外部插件的选择器只匹配它自己提供的内容，在 `cordis.yml` 中该插件的 [Loader 配置项](../modules/README.zh.md#script-isolated-packages)上设置 `__unstable_enable_client_isolation: style`。已加载的包在重新加载时采用新的样式设置；刷新页面也会采用已发布的设置。`scriptandstyle` 还会开启脚本隔离；只选 `script` 时 CSS 仍然全局生效。依赖包的样式表遵循各自的设置，未隔离的主题仍可作用于该插件。

检查 [slot 根元素](../../../docs/subsystems/slots.zh.md#slot-style-ownership)上的 `data-plugin` 可确认内容由哪个包提供。要确认某张样式表是否隔离，查看文档 head 中对应的 `<style data-plugin="…" data-path="…">` 是否包含 `@scope` 规则。渲染器负责标记每个胜出的[列表项](../../../docs/subsystems/slots.zh.md#list-item-roots)及 [hoc 层转发 `children` 的位置](../../../docs/subsystems/slots.zh.md#hoc-layers)，组件不必添加包装元素或透传属性。若选中包的样式依赖根元素以外的祖先，可改用继承的主题变量，或在包自己的内容上标明相关状态。

开启隔离后若缺少一张样式表，可在浏览器控制台查看出错的包名与路径。浏览器必须能将整张表作为一条原生 `@scope` 规则来解析。若包依赖顶层 `@import` 或 `@namespace`，请在启用隔离前通过编译消除这些指令。解析失败时只跳过受影响的样式表，不会将其改按全局样式安装。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包实现一条边界：对象层（运行时，无 React）拥有业务状态；这里是 ctx 到 React 集成唯一发生的位置——slot 渲染器、`SessionProvider` 与 `useSyncExternalStore` 适配器。

### 激活与挂载

插件注入 `modules`，安装 Slot 渲染器，并提供 [`UiRenderer`](src/client/renderer.ts)。调用 `mount()` 时，[`DocumentStyles`](src/client/styles/document-styles.ts) 在 React 挂载前安装 CSS，随后通过模块记录的订阅保持同步。模块物化、依赖变化或模块失效都会同步更新已安装的资源。仅当 `record.isolation.style` 为真时，安装器才把 `record.meta().stylesheets` 生成的文本包进原生 `@scope`。替换后的记录提供新的元数据、文本和隔离标志。

每个已安装的 `<style>` 都带有 `data-plugin`（包名）和 `data-path`（该表在 `meta().stylesheets` 中的键）。已加载依赖包的样式排在使用方之前。同一个包的同一路径共用一个样式节点；若文本冲突，保留已安装的文本。`meta()` 执行失败时，该模块记录不提供样式表；`text(context)` 失败则只跳过对应的表。渲染器通过 `console.error` 报告一次错误，照常安装其余样式。生成函数失败后，仅在模块记录被替换时重试。实时替换期间，旧样式保留到旧插件卸载完成，与组件挂载无关。

### Slot 绑定

`createSlotRenderer` 把 slot 注册表连接到 React：普通 entry list 与 Factory definition 成为响应式 source，每个 outlet 或 occurrence 经已安装的渲染器渲染。业务插件通过带类型的 `hooks` 传递裸 observable source；渲染器经 uSES 适配器在渲染位置完成绑定。Factory Store factory 保持 lazy，直到 occurrence 首次物化时才创建 handle；其 exclusive handle 拒绝持久化，渲染期记录保持弱引用，幂等 effect 仅强引用 mounted occurrences，同时在 effect replay 期间保留 identity。Factory 错误使用普通监督通道且不会 abdicate 共享 definition：definition 及其 fallback 局部 Component 的失败归属 definition，调用方所选局部 Component 的失败归属调用方 registration，每个边界随自身 scope incarnation 重置。

### 身份

React、React DOM 与 Cordis 通过 Web 外壳的静态模块表保持同一浏览器身份，ui-slots 与 ui-primitives 则通过各自的 `immediately` row 保持；本包以动态客户端 bundle 的形式加载。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖周边机制与组合模型。

- [ui-slots](../ui-slots/README.zh.md)——本渲染器绑定到 React 的 slot 注册表纯核心。
- [web](../web/README.zh.md)——加载名册并调用 `mount` 的外壳。
- [ui-session](../ui-session/README.zh.md)——提供本渲染器所绑定标准会话 source 与钩子的适配器。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——加载链、对象层与分层红线。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——权威组合模型。
- [Component Factory](../../../.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.zh.md)——可复用 definitions、局部 Component 选择与 occurrence 生命周期。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端渲染组装层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明应用首帧何时出现、按区域就绪能走多远；它们是当前包约束。

- **应用首帧会等待整个客户端名册**：启动内核只在 loader 名册稳定且启动审计通过后交出挂载点；按区域就绪仍属暂缓事项。
- **样式安装在主文档中。** 原生 `@scope` 限制选择器匹配，但不阻断属性继承。React 的 `createPortal` 和在 props 中任意移动的 JSX 不会自动携带来源包的样式作用域；`useDocumentPortal()` 会保留来源标记。没有单独的展示文档或 Shadow DOM；样式遵循模块而不是组件的生命周期。
- **slot 渲染没有 Suspense 集成或逐 entry 惰性加载**：完整插件名册稳定后，渲染器才挂载根节点。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
