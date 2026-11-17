---
description: "Web 壳的 SPA dist 服务器：占据 webserver 回退席位，以遍历拒绝与 SPA index 回退服务已构建的前端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-frontend-static

[English](README.md) | 中文

## 概述

从配置的发布目录提供已构建的 Web 壳。根路径与配置的 index 入口要求认证 Peer，并渲染其启动数据；其他资源无需凭据，但仍经过活动 Connection 的来源检查。缺失或非文件路径返回404、遍历返回403，已准入但方法不受支持的请求返回405。同一时间只能有一个实例拥有未匹配请求；第二次激活失败，卸载后未匹配请求返回404。

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

### 服务器实施的约束

请求从 dist 根目录（包含 `distIndex` 的目录）提供。根路径与配置 index 以200渲染 `index.html`；其他已有文件使用其 MIME 类型，未知扩展名使用 `application/octet-stream`。根目录外路径返回403，缺失或非文件目标返回空404。准入后，非 GET/HEAD 请求返回405。回退 resource 通过 `webServer.renderIndex` 渲染各 index，使用 WebServer 准入的 Peer，或可信 `webServer.readResource(request, peer)` 显式传入的 Peer。启动 manifest（元数据清单）与该 Peer 的访问快照会送达两个 index 入口。

所服务的 HTML 携带唯一的文档 base `<base href="./">`，位于每一条注入资源行之前，因此它冻结页面加载时所处的入口目录：shell 自身的应用目录相对引用与宿主的插件资源行都在服务该页面的挂载下解析。同一份 index 因而既服务源站根目录，也服务剥离前缀的代理所拥有的任一挂载；本插件只为 dist 根目录与配置的 index 路径渲染它。

回退的同步 `auth` 选择器对根路径与配置 index 请求要求 `required`，其余文件声明 `anonymous`。WebServer 在文件服务前通过 Connection 集中准入；匿名资源免凭据验证，但仍执行 Connection 来源策略。resource 直接接收准入 Peer 并供 index 渲染闭包使用，不重复认证。Token 中间件在路由前处理根路径 Cookie 交换。读取 index 内容后，渲染检查请求与 Peer 均仍存活。

除 index 外，所有提供的文件都由浏览器重新验证。这类响应携带 `cache-control: no-cache` 和由文件内容 SHA-1 生成的弱 ETag，因此文件内容变化后即使名字不变也会得到新的 ETag；`If-None-Match` 等于当前 ETag 的请求得到空的 304。渲染出的 index 不带缓存头。

### 可观察的失败

遍历返回 403 而不是错误页。dist 根目录内不存在或不是文件的目标返回空 404，因此失效链接或拼错的 pathname 是显式失败，而不是静默的 SPA 回退。第二次占据席位会抛错，而席位无人占据时 webserver 返回 404——本插件的 fiber 被 dispose（资源释放）后，浏览器看到的就是该响应。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

函数插件包装 `serveStatic`，将 Fetch `Request` 映射为 `Response`。回退声明路由 auth，使用 WebServer 提供的 Peer；进程内读取使用调用方的显式 Peer。renderer 执行 index 转换，并在资源引用前插入文档 base。插件作用域拥有回退注册，并在 dispose 时释放唯一席位。

### 遍历栅栏

`serveStatic` 规范化请求的 pathname 并拼接到 dist 根目录，然后要求目标就是根目录本身或保持在它之下。检查使用 `sep` 而非 `/`，因为 `resolve()` 在 Windows 上输出反斜杠路径，此时 `/` 后缀会把每个合法子路径都当作遍历拒绝。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `serveStatic` 与 `apply`：回退 resource、遍历拒绝、index 鉴权与渲染、重新验证、MIME 表 |

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
