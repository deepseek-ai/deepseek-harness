---
description: "web GUI 宿主的 HTTP 服务器：具名路由与 upgrade 注册、index 转换，以及服务 Web 壳 SPA dist 的唯一回退席位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

## 概述

浏览器经由 `dsh-host-webserver` 通过 HTTP 访问 web GUI：一个 `node:http` 服务器，其他插件在其中注册具名路由、upgrade 路由、index 启动输入与一个回退 handler。它不了解任何 harness 概念，也不提供任何文件服务——`/api` 桥接、插件 bundle、HMR（热模块替换）事件流与 SPA dist 都属于注册它们的插件。路由匹配顺序固定不变：先在整张表中匹配精确 route，再匹配最长前缀，最后交给回退 handler。它只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch。

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

把 webserver 组合为面向浏览器宿主的 HTTP 传输，然后让功能插件认领各自的路由。激活即开始监听；注册顺序不影响请求处理，因为具名路由组合起来互不相交。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3000
```

`host` 只接受两个值：`127.0.0.1`（默认姿态，仅回环）与 `0.0.0.0`（有意向网络开放——服务器自身不携带 TLS、认证或来源策略）。`port` 为 0 时请求 OS 分配端口；之后用 `ctx.webServer.port` 读取正在监听的端口。

设置 `compression: 'gzip'` 可以包装符合条件的 socket-backed 响应，而不改变 route API。客户端必须接受 gzip，且媒体类型必须可压缩；已知长度小于 `compressionThresholdBytes` 的响应保持未压缩，未知长度 stream 则立即符合条件。已有编码、`Cache-Control: no-transform`、range 响应、SSE、ZIP 与已打包的 `.gz` Worker image 均保持不变。随附 Web bundle 使用 level 1 与 1024 字节阈值；其他组合默认不压缩。

### 注册路由

`register(route)` 添加具名的 `exact`／`prefix` HTTP route，`registerUpgrade(route)` 为精确 pathname 添加 upgrade route，两者返回的 disposer 都会移除注册。同一张表内的重复路径会抛错——route 模式是组合层约定，冲突即配置错误。HTTP 匹配先在整张表中匹配精确 route，再匹配最长前缀，最后交给回退 handler；upgrade 只做精确匹配，未命中连接直接关闭。

### 回退席位

`registerFallback(handler)` 认领所有未被具名 route 命中的请求的唯一个 handler。第二次注册会抛错；没有注册回退时服务器回答 404。在随附的 Web 组合中，[SPA dist 服务器](../frontend-static/README.zh.md)拥有该席位，并对其渲染的每个 index 响应调用 `renderIndex`。

index 启动输入分两层。`collectIndexInjections()` 收集一张全新的注入表——每次调用发一次 `webserver/index-inject` 事件，每个订阅方推入其当前行——`renderIndex(html)` 先把这些行渲染进 index.html 正文，再按注册顺序应用原始 `tapIndex(transform)` 转换。`script-preload` 行会渲染为 classic script 的提示性 preload 链接。静态部署会在启动 payload 中携带同一批行。`applyIndexTaps(html)` 只应用原始转换；它是任何行都无法表达的标记的逃生口。

### 失败时的行为

监听失败（例如 EADDRINUSE）会以绑定诊断信息拒绝插件初始化。handler 抛错的 HTTP 请求会得到 400——若响应头已经发出则销毁 socket——并记录 warning；它绝不会退出进程。upgrade handler 抛错或升级 socket 出现传输错误时，会记录 warning 并销毁对应 socket。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

本包是一个不带任何 harness 词汇的普通路由注册表：`WebServer` 继承 Cordis `Service`，持有三张路由表、回退槽位、原始 index 转换列表，以及 index 渲染器经其收集行的 `webserver/index-inject` 事件。index 渲染每次响应组合两层：`renderIndex` 先把包含提示性 `script-preload` 行的全新注入表渲染进正文，再按注册顺序应用原始转换；`applyIndexTaps` 只运行转换。upgrade handler 拥有协议握手与连接内容；webserver 只交付原始 socket 与 request。`host` 与 `port` getter 暴露其他插件据以自适应的组合期事实（例如 directory-picker 选择器）。

### 匹配与生命周期

`match(pathname)` 先查精确表，再遍历前缀表取最长匹配，最后走回退。激活（`[Service.init]`）即开始监听；资源释放会启动 `close()` 与 `closeAllConnections()`，销毁所有受跟踪的升级 socket，并仅在服务器与这些 socket 均已关闭后返回。Node 的 `closeAllConnections()` 不包含升级 socket，因此服务显式跟踪它们。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `WebServer` 服务：路由表、回退席位、index 渲染、匹配、生命周期 |
| — | 不发布运行时不变式伴生入口；路由注册与释放通过同一服务修改同一张路由表，register/dispose 探针只会重复执行实现。真实路由与 HMR 测试负责该行为。 |
| [`src/injections.ts`](src/injections.ts) | 结构化 `IndexInjection` 行与 `renderIndexInjections` 行渲染 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务器约定不够用时阅读以下内容：先看子系统参考，再看回退持有者，以及谁注册哪条路由背后的分层决策。

- [HTTP 服务器子系统](../../../docs/subsystems/web-server.zh.md)——路由、匹配顺序与服务器接受的配置。
- [SPA dist 服务器](../frontend-static/README.zh.md)——回退席位的随附持有者。
- [Web 配置树启动与传输分层](../../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)——功能插件为何拥有每条路由。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-webserver)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。该 HTTP 载体只桥接浏览器与 API handler，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明服务器在何处有意保持最小。它们是当前包约束，不是任务积压。

- **不提供服务器级 TLS、认证或来源策略**：`dsh-client-connection` 等 route owner 会实施自己的请求策略。绑定非回环地址仍会向该网络公开未受保护的 route 与静态资源。
- **Socket 选项固定不变**：配置只选择绑定宿主与端口；在具体部署产生需求前，backlog 和其他 socket 设置仍保持内部实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
