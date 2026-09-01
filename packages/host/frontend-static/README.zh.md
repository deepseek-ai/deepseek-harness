---
description: "Web 壳的 SPA dist 服务器：占据 webserver 回退席位，以遍历拒绝与 SPA index 回退服务已构建的前端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-frontend-static

[English](README.md) | 中文

## 概述

浏览器从 `dsh-host-frontend-static` 获取已构建的 Web 壳：它占据 [webserver](../webserver/README.zh.md) 回退席位，并按锁定语义服务已构建前端目录——只有 dist 根目录与配置的 index 路径以 HTTP 200 渲染 `index.html`，其他已有文件直接提供，dist 根目录内缺失或非文件的 target（包括配置的 index 缺失）返回空 404，越出 dist 根目录的遍历返回 403，未知扩展名按 `application/octet-stream` 提供，GET／HEAD 之外的方法在没有匹配的具名路由时返回 405。每个成功的 index 响应都经 webserver 的 `renderIndex` 渲染，启动 manifest（元数据清单）就是经这条路径送达页面的。回退席位只有单一所有者：第二次占据会抛错，卸载插件即释放席位。

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

在服务已构建 Web 壳的浏览器宿主中组合本插件：它占据 webserver 的回退席位，并应答所有未被具名路由命中的请求。它只需要一个配置值——已构建前端的 `index.html` 位于何处。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-host-frontend-static'
  config:
    distIndex: /absolute/path/to/dist/index.html
```

`distIndex` 是组合应用的组装事实：[`dsh-web-app`](../../bundle/web-app/README.zh.md) 通过前端包的 exports 解析它并挂载本插件；部署绝不硬编码它。

### 服务器强制什么

请求从 dist 根目录（包含 `distIndex` 的目录）提供。dist 根目录与配置的 index 路径以 HTTP 200 渲染 `index.html`；任何其他已有文件按自身 MIME 类型直接提供，未知扩展名按 `application/octet-stream` 提供。解析到根目录之外的路径以 403 拒绝，因此精心构造的路径无法读取 dist 之上的文件。dist 根目录内缺失或非文件的 target——文件缺失、目录或配置的 index 缺失——返回空 404。没有匹配具名路由的非 GET／HEAD 请求回答 405。每个成功的 index 响应都经 webserver 的 `renderIndex` 渲染，因此启动 manifest 在 `/` 与配置的 index 路径上到达页面。

根路径与配置的 index 响应会在读取 HTML 前调用 `ctx.connection.authorizeIndex`。有效进程 token 会得到 303 重定向与持久浏览器 cookie；已有有效 cookie 时直接提供 index；其他 index 请求得到 Connection 所有的 401 响应。非 index 文件仍是公开静态资源。Token、cookie、过期时间与签名记录语义都归 Connection 所有。

### 可观察的失败

遍历返回 403 而不是错误页。dist 根目录内缺失或非文件的 target 返回空 404，因此失效链接或拼错的 pathname 是显式失败，而不是静默的 SPA 回退。第二次占据席位会抛错，而席位无人占据时 webserver 回答 404——本插件 fiber 被 dispose 后浏览器看到的就是它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

本包是围绕 `serveStatic` 的一个函数插件：`apply` 从 `distIndex` 解析出 dist 根目录，构建一个对原始 `index.html` 运行 `ctx.webServer.renderIndex` 的 `renderIndex` 闭包，并在 effect 作用域下注册回退 handler。按 webserver 的约定，席位只有单一所有者——第二次注册会抛错——且受 effect 作用域约束，因此 dispose fiber 即释放席位。

### 遍历栅栏

`serveStatic` 规范化请求的 pathname 并拼接到 dist 根目录，然后要求目标就是根目录本身或保持在它之下。检查使用 `sep` 而非 `/`，因为 `resolve()` 在 Windows 上输出反斜杠路径，此时 `/` 后缀会把每个合法子路径都当作遍历拒绝。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `serveStatic` 与 `apply`：回退占据、遍历拒绝、index 渲染、MIME 表 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务约定不够用时阅读以下内容：先看席位所有者的约定，再看解析 dist 的组合与子系统参考。

- [Webserver](../webserver/README.zh.md)——本插件占据的回退席位与它运行的 index 转换器。
- [dsh-web-app 组合包](../../bundle/web-app/README.zh.md)——解析 `distIndex` 并挂载本插件的应用。
- [HTTP 服务器子系统](../../../docs/subsystems/web-server.zh.md)——回退席位如何融入路由表。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-frontend-static)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。该 SPA dist 服务器只应答浏览器资产请求，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明某个资产类别何时尚未被覆盖。它们是当前包约束，不是任务积压。

- **初始 MIME 表很精简**：它覆盖 Vite 输出的资产集合及实际交付的 PWA manifest；其他扩展名在相应资产类别发布前都会回退到 `application/octet-stream`。
- **Pathname 路由是显式声明**——当前客户端从根目录或配置的 index 路径进入，没有 History API pathname 路由。新增一条需要显式服务器规则与真实组合覆盖，而不是对每次未命中做宽泛回退。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。唯一关系是单个 fallback seat，但 teardown event 在 disposer 前发出，运行时探测会误报；register/release 对称性由真实组合的 HMR 测试覆盖。
