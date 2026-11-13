---
kind: upgrade-guide
description: WebServer 路由默认要求认证，默认 Token 登录迁入 Provider 插件。
---

# Token Provider 与路由准入迁移

[English](guide.md) | 中文

## 变更

默认 Token 验证与 HTTP 登录交换迁入 `@deepseek-ai/dsh-host-authentication-token`。Connection 移除 BrowserAuth、`authorizeIndex`、`authenticatedUrl`、`requestRejection`、`ConnectionRequestRejection`、`peer(id)`、`createPeer.socketOwned`、`ConnectionAdmission` 与 `admitConnection`。Token 通过准入后的 `webserver/upgrade` waterfall 拥有 `/api/remote.mux` Socket 认领。Cookie 格式与 `/connect` 保持；有效 v2 Cookie 也可认证页面，不再有页面/API `purpose` 字段。

WebServer 注册新增 `auth: 'anonymous' | 'required' | 'deny'` 或同步选择器，默认 `required`。此前公开的 handler、resource、回退与 upgrade 需要显式声明匿名。HTTP 与 upgrade handler 通过可选末尾参数接收准入 Peer；resource 保留已有 Peer 参数。Connection 监听器活动时，来源检查也适用于匿名路由。

## 迁移

1. 在 Connection 与 Credentials 旁挂载 Token。手动将 `cookieMaxAgeDays` 从 `connection.config` 移到 `authentication-token.config`。旧位置的值不生效，既不会自动迁移，也不会被拒绝；未配置 Token 的值时采用30天。
2. 检查 `webServer.register`、`registerFallback` 与 `registerUpgrade` 调用。直接管理 handler 还必须要求 owner Peer。受保护路由保持认证要求；免凭据资源与登录端点声明 `auth: 'anonymous'`，禁止访问的路由声明 `auth: 'deny'`。改变裸回退 handler 策略时改为 `{ handler, auth }`。为所有预期 authority 检查 `trustedHosts`，包括公开资源。
3. 移除页面适配器的 `purpose` 与重复认证调用。使用 `(req, res, peer?)`、`(req, socket, head, peer?)` 或 `resource(request, peer?)` 传入的 Peer，并为该 Peer 渲染受保护页面。可信进程内 `readResource(request, peer)` 仍使用显式 Peer，不检查来源或 Cookie，但遵守 `deny`。
4. `printUrl`、`openBrowser` 与 `publicUrl` 保留在 WebApp。WebApp 就绪后触发 `webserver/entry-url(baseUrl, entries)`；监听器追加 `{ label, url, open }`。WebApp 按序打印入口，并在非 SSH 下打开首个允许自动打开的入口。没有入口就不输出、不打开。Token 贡献签名 URL，不依赖 WebApp。自定义 HTTP 载体在路由前保留 `webserver/request`。
5. Provider 注入 `connection` 与 `connection.authentication`，保存 `createPeer({ principal, interactions })` 结果，并调用 `ctx.connection.authentication.register(provider)`。`browserPeer` 保留给可信进程内调用。使用 `admit` 替代 `requestRejection`。无人作出准入决策时，`required` 返回503，`anonymous` 允许访问。
6. 发起所有 `webserver/*` 事件时传入 WebServer 作为 thisArg，包括 `index-inject` 与 `entry-url`。普通监听器遵循 `webServer` isolation；`global: true` 跳过过滤。在准入后、协议处理前运行 upgrade 中间件，并等待 `next()`。Token 仅在 `/api/remote.mux` 上认领自己的 API Peer。
7. 验证根 Token 登录、已有 Cookie、v2 页面访问、HTTP/WS、`/connect`、匿名资源及来源拒绝403。重复 mux Socket 仍返回409；所属 Socket 关闭时先撤销凭据，再释放 Peer。只有根 Token query 执行凭据交换。Token 加载失败不授予受保护访问。
8. 自定义 Desktop shell/Host 一同更新：每进程凭据在 ready 前通过私有 IPC 交付；主进程使用 `authenticationCookie` 与普通 Host URL。凭据不得进入 renderer。Desktop 也可挂载 Token。
