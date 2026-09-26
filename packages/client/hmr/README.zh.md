---
description: "Web 客户端插件的动态图同步与开发时 bundle 重载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-hmr

[English](README.md) | 中文

## 概述

`dsh-client-hmr` 让已打开的 Web 页面与 Host 插件图保持同步，并重载重建后的浏览器 bundle。普通插件的启停无需刷新页面或重启 Host 即可生效。代码重建会替换受影响插件并重置其组件状态。模型不会收到新的输入或输出。

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

随包提供的 Web 组合挂载此传输，以交付插件动态变更。开发时，bundle watcher 还会提供代码重建。停用此传输会停止向已打开的页面交付图更新。

### 启动重载链路

运行 `pnpm run dev:web`，它会同时启动宿主与重建 watcher（`--no-serve` 则只把 watcher 接到别处启动的宿主上，使用共享 Client tsdown 预设的任何 watch 进程亦然）；重建后的插件随后会被自动逐个替换进运行中的浏览器。该预设会在所有包内 chunk 写完后标记 `lib/client.js`，因此仅 chunk 发生重建也会推进包 revision，无需 Host 扫描 chunk。

### 一次重载做什么

每次成功的重载都会重新执行插件 bundle，并用全新状态重新挂载插件。依赖被重载插件的插件会随之自动重载。失败会显示在插件列表中，可直接重试，无需等待下一次重建。

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

Host 半侧监听每个包带完成标记的入口产物，并提供 `/plugins/events`。它转发现有的图变化与重建通知；每个新连接都会收到当前完整图。图描述浏览器的目标条目，不保证 Host 清理已经完成。Host 的激活与清理仍由 Host 生命周期管理。入口的 mtime、ctime 和大小共同标识 revision，无需对其内容求哈希；元数据未变时无需读取内容。Host 重启时若产物未变，revision 保持不变，因此图流重连不会替换浏览器插件。浏览器半侧将两种帧都交给 Client Modules，由它串行处理条目变更并等待浏览器资源清理。

### 浏览器侧替换

收到 `rebuilt` 帧后，控制器使旧模块失效，并在旧 fiber 仍然服务时预取其单资源脚本。随后删除注册表 runtime、等待旧 fiber 清理、清除条目中的 fiber 引用并移除自身样式。模块系统先物化新导出，再由 `entry.refresh()` 通过 Loader 挂载；这样即使 Loader 只记录导入错误，页面诊断仍能获得失败原因。CSS 在旧 effect 完成清理后注入。

### 级联与自重载

fiber 的激活 epoch 会串联其服务提供方的 uid，因此替换提供方 fiber 会通过 Cordis 自身级联重载所有依赖方，无需 HMR（热模块替换）侧维护任何簿记信息。本插件本身也是一个图 entry，因此 `rebuilt` 帧可能点名它；进行中的重载在旧 bundle 的闭包中继续运行，新 bundle 的 apply 会打开全新通道。

### 失败策略

下载失败时，正在运行的插件保持活动。旧 fiber 被卸载后，导入或激活失败不会恢复先前的 bundle。失败会显示为当前页面的同步错误。「设置 → 插件 → 插件列表」会针对最新图重试，即使其 revision 未变化；后续重建也会重试受影响的插件。无关且已成功运行的插件保持活动。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | node 半侧：bundle stat 轮询、`rebuilt` 上报、`/plugins/events` SSE 通道 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器半侧：SSE 订阅与共享条目控制器调用 |
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
- **失败时不回滚**——旧 fiber 被卸载后，替换失败不会恢复先前的 bundle。
- **仅负责 Web 传输**——Electron 的安装和后端重启流程不使用此 SSE 路径。条目对账本身不依赖传输。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
