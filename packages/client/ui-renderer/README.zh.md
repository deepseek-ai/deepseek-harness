---
description: "浏览器 UI 渲染器：React slot 绑定、ctx.uiRenderer 与 dsh Web 客户端组装后的应用根。"
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

本包属于基础设施：Web 外壳与启动内核是它仅有的直接消费方。只要组合需要 React 渲染的 GUI，就需要它——`dsh-client-web` 加载名册，等待每个 entry 激活，然后调用 `ctx.uiRenderer.mount(container)`。

### 挂载做什么

`mount(container)` 会安装 slot 渲染器、在存在时 hydrate 现有启动 DOM、在下一次绘制前把组装后的应用渲染进容器，并返回一个卸载 React 根的 disposer。渲染器执行全程序唯一一次上下文级 `renderSlot('root')` 调用；注册的根占用方拥有产品布局与文档元数据。

### 对业务插件

业务插件通过 slot 系统注册组件；渲染器在 outlet 处把运行时的会话与 Workspace observable source 绑定为 selector 钩子。插件通过其组合 props 收到标准会话 props（session id、对话快照钩子）——它绝不导入渲染器，也不触碰 React 内部机制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包实现一条边界：对象层（运行时，无 React）拥有业务状态；这里是 ctx 到 React 集成唯一发生的位置——slot 渲染器、`SessionProvider` 与 `useSyncExternalStore` 适配器。

### 激活与挂载

插件在 `slots`、`sessions` 与 `layout` 就绪后激活；它安装 `createSlotRenderer()` 并 reflect `uiRenderer` 服务。`mountApp` 会查找启动内核的 `[data-dsh-boot]` 元素：存在时经 `BootHandoff`（一个保留加载 DOM 的单帧透传）hydrate，否则创建全新的根节点并同步提交渲染。

### Slot 绑定

`createSlotRenderer` 把 slot 注册表连接到 React：条目列表成为响应式 source，每个 outlet 经已安装的渲染器渲染。业务插件通过带类型的 slot `hooks` 传递裸 observable source；渲染器经 uSES 适配器在 outlet 处完成绑定。

### 身份

React、React DOM、Cordis、ui-slots 与 ui-primitives 通过 Web 外壳的静态模块表保持同一浏览器身份；本包则以动态客户端 bundle 的形式加载。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖周边机制与组合模型。

- [ui-slots](../ui-slots/README.zh.md)——本渲染器绑定到 React 的 slot 注册表纯核心。
- [web](../web/README.zh.md)——加载名册并调用 `mount` 的外壳。
- [ui-session](../ui-session/README.zh.md)——提供本渲染器所绑定标准会话 source 与钩子的适配器。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——加载链、对象层与分层红线。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——权威组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端渲染组装层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明应用首帧何时出现、按区域就绪能走多远；它们是当前包约束。

- **应用首帧会等待全部客户端 entry**：启动内核只在 loader 名册稳定后交出挂载点；按区域就绪仍属暂缓事项。
- **slot 渲染没有 Suspense 集成或逐 entry 惰性加载**：完整插件名册稳定后，渲染器才挂载根节点。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
