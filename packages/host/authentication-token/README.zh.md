---
description: "通过默认启动 Token 登录，并使用绑定 authority 的 Cookie 持续访问应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-authentication-token

[English](README.md) | 中文

## 概述

打开带 Token 的启动地址以签发浏览器 Cookie，随后携带该 Cookie 继续访问应用。API 客户端通过 `/connect` 交换同一个进程 Token，取得独立连接凭据。插件保留默认 Cookie 格式与签名密钥记录，并通过通用 ConnectionAuthentication 服务注册。

## 目录

- [使用方式](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方式

将此函数插件与 Connection 和 Credentials 一同挂载。它还注入由 Connection 插件提供的 `connection.authentication`。存在 WebServer 时提供 HTTP 交换路由；认证 Provider 也能用于没有 Web 监听器的组合。插件通过 `webserver/entry-url` 贡献带签名的 `dsh web` 入口；打印与浏览器打开归 WebApp。包运行入口导出 `name`、`inject`、`Config` 和 `apply`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cookieMaxAgeDays` | `30` | 浏览器与 API Cookie 的绝对有效期，单位为天 |

在 WebApp runtime 上配置 `printUrl` 与 `openBrowser`，而非本插件。不发布启动入口时，认证仍然可用。

携带启动 Token query 的根路径请求由原 Token 交换处理：成功的 `GET /` 返回303、写入 Cookie，并重定向到 `./`；无效凭据返回401。其他路径的请求交给其路由 owner。WebApp 就绪后收集入口时，本插件向传入的基地址追加进程 Token，同时保留 authority、路径与其他 query 字段。贡献的入口允许自动打开。Token 不读取 WebApp 服务，也不拥有打印、就绪判断或原生浏览器打开器。

浏览器 v1 Cookie 认证为本插件拥有的共享 Peer。`/connect` 声明匿名路由准入：Connection 检查来源，handler 随后验证启动 Token、创建 API Peer，并在 v2 Cookie 中签入其 ID。有效 v2 Cookie 通过同一 Provider 认证页面与 API 请求。Peer 的 principal 与 RemoteAccess 决定权限，不区分页面/API purpose 等级。Token 限制每个 API Peer 只有一条 `/api/remote.mux` Socket；重复关联返回409，不撤销首条连接。该 Socket 关闭时先同步撤销凭据，再释放 Peer；后续使用该 Cookie 的请求被拒绝。其他升级路由（包括 Inspector CDP）不认领该 Peer，也不在关闭时撤销它。

签名密钥仍使用 Credentials 的 `client-connection/browser-session` grant 记录。Cookie 名称、签名 audience、有效期验证及监听器决定的 `Secure` 属性遵循既有协议。重载保留根应用的启动 Token 与尚有效 Cookie，同时创建新的插件共享 Peer。Token 激活失败允许应用在缺少此验证器时继续运行，但不允许未认证访问受保护路由。Desktop 可以同时挂载本 Provider 与私有凭据 Provider。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部说明 — 点击展开</summary>

插件准备签发器，通过 Connection 创建共享 Peer，并通过 `ctx.connection.authentication` 注册验证器：v1 Cookie 返回共享 Peer，v2 ID 验签后通过插件自己的 API Peer 映射表解析。页面与 API 调用使用相同验证。WebServer 请求监听器拥有根 Token 交换，匿名精确路由拥有 `/connect`。

该路由旁的 `webserver/upgrade` 监听器委派非 mux 路径，并在 `/api/remote.mux` 上按 `apiPeers.get(peer.id) === peer` 识别自己拥有的 API Peer；浏览器共享 Peer 与其他 Provider 调用 `next()` 委派。此监听器位于路由准入后、协议处理前。Socket 关闭、错误及 upgrade 失败时，在异步释放前撤销 API 凭据。Peer 释放也会关闭其 Socket。清理幂等；Web 接线作用域移除监听器、撤销自己的 API 凭据、仅销毁自己拥有的 API Socket，并等待 Socket 关闭与 Peer 清理。迟到的中间件不能恢复已撤销的 Peer。同步 `webserver/entry-url` 监听器贡献带签名的 URL；事件和入口类型由 WebServer 声明，无需依赖 WebApp bundle。

原启动 Token 寿命与 Cookie 算法保留在内部 [BrowserAuth 实现](src/browser-auth.ts)。[插件入口](src/index.ts)负责 Connection、ConnectionAuthentication 与 WebServer 接线，[内部类型](src/types.ts)描述签发器使用的 HTTP 操作。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connection](../../client/connection/README.zh.md) — ConnectionAuthentication 注册与既有 Peer 生命周期。
- [WebServer](../webserver/README.zh.md) — HTTP 路由与请求事件。
- [Credentials](../../credentials/credentials/README.zh.md) — 持久签名密钥记录。

<a id="model-experience"></a>
## 模型体验

无，因为插件认证 HTTP 调用方，不贡献模型输入。

#### KV Cache 影响

无；认证不修改模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器 Cookie 共用一个插件 Peer；结束插件作用域时，其存活连接一同结束。
- 明文 HTTP 不加密 bearer Cookie。Cookie 的 `Secure` 属性由监听器 TLS 决定。
- Token 中间件只拥有根路径交换。其他 HTML 或产品路径仍由路由 owner 处理，包括这些路径上的 token query。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
