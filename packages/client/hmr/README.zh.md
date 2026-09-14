---
description: "仅用于开发环境的浏览器客户端插件热重载：重建插件 bundle 后原地替换运行中的插件，供开发者迭代 web GUI。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-hmr

[English](README.md) | 中文

## 概述

`dsh-client-hmr` 会在浏览器客户端插件的 bundle 重建后原地重载该插件，让编辑插件源码的开发者无需整页刷新即可看到变更。如果没有重建 watcher，整条链路保持空闲：只有 `pnpm run dev:web` 之类的进程重写客户端 bundle 时才会产生它所响应的重建。每次重载只替换一个插件并携带全新组件状态，而数据层（连接、运行时与 Session 对象）保持不变。这里的一切都是浏览器侧的开发机制；模型永远看不到它。

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

为正在编辑的插件启用重建 watcher，然后保存：浏览器会从 dev server 拾取重建后的 bundle，并在不重载页面的情况下替换该插件。在客户端开发期间使用它；在生产构建中没有任何可观察行为，因为没有 watcher 会重写 bundle。

### 启动重载链路

对同一个宿主运行 `pnpm run dev:web`（或任何写入插件 `lib/client.js` 的 tsdown watch 进程）；重建后的插件随后会被自动逐个替换进运行中的浏览器。

### 一次重载做什么

每次重载都会重新执行插件 bundle，并用全新状态重新挂载插件。依赖被重载插件的插件会随之自动重载。失败的重载会以可见方式报告，并在下一次重建时从头重试。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pollIntervalMs` | `500` | bundle stat 轮询间隔，单位为毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-hmr)是所有受支持字段及其 JSDoc 的完整真源。

### 观察成功

成功的替换会立即显示编辑后的 UI，无需页面重载，且插件在替换后继续工作。请记住权衡：被重载插件内的 React 状态会丢失，而会话、工作区与连接状态会保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释重载链路的构建方式；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

链路分为两半，共用一份约定：node 半侧负责 bundle 检测与通知，浏览器半侧负责替换。node 半侧运行一个 interval，从 module host 读取文件前的基线开始 stat 轮询每个图 bundle。未变化的启动 row 无需读取内容或求 hash 即可开始监视；发生变化的 row，或产物恢复后的 dirty row，会进入 `rebuilt()`，且只广播真实 revision 变更。`rebuilt()` 会把当前 source map 与已变化的 bundle 一起读取；仅写入 map 不会重载可执行代码。node 半侧还提供 `/plugins/events`，一个广播 `graph` 与 `rebuilt` 帧的 SSE（Server-Sent Events）通道。

### 浏览器侧替换

收到 `rebuilt` 帧后，帧内 revision 会让 `invalidate` 选择该插件不可变的单资源 combo URL，而不是初始多资源 URL。`prefetch` 在旧 fiber 仍在服务时加载并注册新 factory。其余顺序是：先从注册表删除，再拆卸（在 fiber 的 disposer 发出 `internal/plugin` 之前执行 `registry.delete`，否则 vendored Loader 会把该 entry 标为禁用）、等待旧 fiber 卸载完成、删除 `entry.fiber`、移除自身拥有的 `<style data-plugin>` 标签，然后 `entry.refresh()` 重新导入并挂载，`fiber.await()` 直接把启动失败重新抛出。替换之所以安全，是因为在惰性 CJS 模型下执行只是注册：每个模块副作用都位于 factory 闭包中，在物化时运行。

### 级联与自重载

fiber 的激活 epoch 会串联其服务提供方的 uid，因此替换提供方 fiber 会通过 Cordis 自身级联重载所有依赖方，无需 HMR（热模块替换）侧维护任何簿记信息。本插件本身也是一个图 entry，因此 `rebuilt` 帧可能点名它；进行中的重载在旧 bundle 的闭包中继续运行，新 bundle 的 apply 会打开全新通道。

### 失败策略

不回滚：导入失败会让 entry 失去 fiber（下一个 `rebuilt` 帧从头重试），apply 失败则会在外壳的状态投影中留下 FAILED fiber。两者都会输出醒目的错误日志。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | node 半侧：bundle stat 轮询、`rebuilt` 上报、`/plugins/events` SSE 通道 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器半侧：SSE 订阅、串行重载队列、fiber 替换 |
| [`src/events.ts`](src/events.ts) | 共享帧类型（`graph` / `rebuilt`）与端点常量 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当重载约定不够用时阅读以下页面：提供 bundle 的模块系统、启动它们的外壳，以及 external 背后的模块图规则。

- [客户端模块系统](../modules/README.zh.md)——本驱动器驱动的惰性 CJS 模块表与 `invalidate`/`prefetch` 钩子。
- [Web 启动内核](../web/README.zh.md)——启动插件树并展示 entry 状态的外壳。
- [客户端组地图](../README.zh.md)——本包重载的浏览器半侧。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-hmr)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。重载驱动器属于浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明重载驱动器不会保留或恢复什么。它们是当前包约束，不是任务积压。

- **重载有意保持粗粒度**——全新 fiber 与全新组件；被重载插件内的 React 状态会丢失，而数据层（连接 fiber、运行时 fiber、Session 对象）不受影响。react-refresh 级状态保留与重新执行 bundle 冲突，因此有意排除。
- **失败时不回滚**——失败的重载会让该 entry 保持 FAILED 并在 loader 状态投影中可见；系统不会自动恢复先前 bundle。
- **重建帧不会替换启动图**——每个帧都携带单资源 combo 重载所需的插件产物 revision；页面重载时才接收重新组合的启动图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
