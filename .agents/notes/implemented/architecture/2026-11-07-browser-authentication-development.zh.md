# Agent Note: 认证 Provider 接入

Status: implemented

[English](2026-11-07-browser-authentication-development.md) | 中文

## Problem

在内置认证设计中，Connection 同时包含 BrowserAuth 和传输 API，路由 owner 调用它的准入辅助方法。WebApp 通过 Connection 取得带 Token 的地址。拆分凭据实现需要明确的注册、路由、事件和启动用法，不能把 Token 知识重新放回传输或协议 handler。

[Provider 决策](2026-11-07-browser-authentication-providers.zh.md)拥有动机、凭据兼容性，以及 Token、Desktop 和未来 Remote 实现的平级处理规则。本文记录它们与最终 API 的接线。

## Decision

### 注册 Provider 并持有 Peer

Connection 插件提供独立嵌套服务 `connection.authentication`。Provider 插件同时注入 `connection` 和 `connection.authentication`：前者创建 Peer，后者拥有注册与凭据验证。该访问路径是真正的 Cordis 服务，不是构造临时注册表对象的 getter。

下面的完整函数插件示例由 Host 提供可信进程内验证器和 principal。其中 `Config.verify` 是示例的应用输入，不是新 DSH API，也不代替具体凭据算法的实现。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionTrustRequest, Principal } from '@deepseek-ai/dsh-client-connection'

export const name = 'example-authentication'
export const inject = ['connection', 'connection.authentication']

export interface Config {
  principal: Principal
  verify(request: ConnectionTrustRequest): boolean
}

export function apply(ctx: Context, config: Config): void {
  const peer = ctx.connection.createPeer({ principal: config.principal })
  ctx.connection.authentication.register({
    authenticate(request) {
      return config.verify(request) ? peer : undefined
    },
  })
}
```

`createPeer` 将 Peer 归入调用插件的作用域，`register` 将注册归入相同调用方作用域。共享身份的 Provider 像示例一样持有一个 Peer；按会话区分的 Provider 则持有自己的凭据到 Peer 记录，并返回对应的已有 Peer。Host 在创建时固定 `principal` 和可选 `interactions`，两者都不是客户端自行声明的授权信息。

`register` 返回异步 disposer，调用时同步撤销记录。认证读取注册顺序快照，跳过验证过程中撤销的记录，并在采用结果前复核 Peer 与请求。新注册参与后续请求。`authenticate` 返回首个存活 Peer、普通拒绝的401，或存在验证故障且无人成功时的503。来源拒绝仍是 Connection 单独作出的403决策。[实现](../../../../packages/client/connection/src/authentication.ts)包含这些生命周期检查。

### 声明路由准入并使用选定的 Peer

`register`、`registerFallback` 与 `registerUpgrade` 接受 `auth: 'anonymous' | 'required' | 'deny'` 或同步选择器，默认值为 `required`。WebServer 先匹配路由、应用策略，再取得 Connection 的来源与凭据决策，并把选定 Peer 交给 handler。`deny` 不调用认证即拒绝；没有准入监听者时，`required` 返回503，`anonymous` 允许访问。

下面的示例注册普通业务 handler。Host 提供 `Config.upgrade`，即业务已有的协议实现，并非另一个框架操作。HTTP 中的断言对应此路由的 `required` 策略；公共 handler 类型同时支持没有 Peer 的匿名路由。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

export const name = 'example-protected-routes'
export const inject = ['webServer']

export interface Config {
  upgrade: WebUpgradeRoute['handler']
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/identity',
    auth: 'required',
    handler(_req, res, peer) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(peer!.id)
    },
  }))
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/example/socket',
    auth: 'required',
    handler: config.upgrade,
  }))
}
```

HTTP handler 接收 `(req, res, peer?)`，upgrade handler 接收 `(req, socket, head, peer?)`，resource 保留 `resource(request, peer?)`。业务 handler 不再遍历 Provider。Gateway 之外的直接管理路由（包括 Inspector 和 open-in-app）在访问 Host 资源前要求 owner Peer。可信进程内 `readResource(request, peer)` 保留显式 Peer，不执行网络来源或凭据检查，但仍遵守 `deny`。准入拒绝响应携带 `Cache-Control: no-store`。

### 使用有作用域的 WebServer 事件

每个 WebServer 事件都以对应 WebServer 为 Cordis thisArg。请求分发使用该服务实例，WebApp 入口收集传入 `ctx.webServer`。普通监听器匹配该 subject 的 `webServer` isolation，包括已有的 index 注入事件。`{ global: true }` 明确接收同一应用中跨服务隔离的事件。Peer 数据不选择事件监听器。[WebServer 参考](../../../../packages/host/webserver/README.zh.md)定义自定义载体的要求。

| 事件 | 模式 | 最终接线 |
|---|---|---|
| `webserver/request` | waterfall | 在路由选择前执行；Token 处理根 Token query 交换，账号插件处理经过校验的 OAuth 回调 |
| `webserver/authorize` | bail | 判断已匹配路由的来源与凭据准入，采用首个决策 |
| `webserver/upgrade` | waterfall | 在准入后、协议 handler 前执行，携带已选定的 Peer |
| `webserver/index-inject` | emit | 在服务器隔离范围内，为传入 Peer 收集页面或 Worker 启动数据 |
| `webserver/entry-url` | emit | 在服务器隔离范围内，为传入基地址收集完整入口 URL |

Waterfall 监听器处理请求时拥有响应或 Socket，否则等待 `next()`。异常由载体容纳，并结束对应响应或 Socket。为支持登录协议，不会对所有匿名路由关闭来源策略。

账号插件在通用准入前注册临时回调监听器。它匹配发起登录时 redirect URI 的 authority 和精确路径，再保留 GET、单值 state/code、常量时间 state 比较、活动尝试检查、有效期、取消和 S256 PKCE。因此合法跨站浏览器返回可以完成，而不绕过这些校验，也不放宽无关匿名路由。监听器随尝试结束而移除，不导入 WebServer 实体辅助函数。

### Socket 策略归凭据签发产品

Token 监听器位于 `/connect` 路由旁，仅处理 `/api/remote.mux`。它按映射表对象身份识别自己的 API Peer，以409拒绝第二条 mux Socket，并在等待 Peer 和 Socket 清理前同步移除凭据。关闭 Inspector CDP Socket 不会认领或撤销该 API 会话。其他 Provider 保留各自生命周期策略；Gateway 只以传入的 Peer 执行协议升级。

Upgrade 为该连接固定 Peer，后续 HTTP 请求重新认证。Token 的浏览器共享 Peer 不随单条 Socket 关闭而结束，API Peer 则遵循已有 mux 生命周期。已经准入的一元调用保留自身取消作用域。[mux 回归](../../../../packages/api/gateway/tests/operator-connect.host.spec.ts)和 [API connect 决策](2026-10-09-operator-scoped-connect-handshake.zh.md)覆盖这个区别。

### WebApp 发布完整入口 URL

WebApp 保留 `publicUrl`、`printUrl` 和 `openBrowser`，两个输出开关默认均为 true。Loader 装配结束并完成启动审计后，它发出 `webserver/entry-url`，传入自己的 WebServer subject、普通基地址和初始为空的 `WebEntryUrl[]`。每条入口包含 `label`、完整 `url` 和布尔值 `open`。

Token 不读取 WebApp 服务，只贡献带签名的 `dsh web` URL。没有用户入口的 Provider 不贡献条目，其他产品可以贡献自己的 label 和完整 URL。启用打印时，WebApp 逐行输出 `label: url`；启用浏览器打开且不在 SSH 下时，只打开首个 `open: true` 条目。空列表不产生输出或浏览器打开。即使接线未公开原始 Token getter，进程凭据仍是敏感信息。

Desktop 父进程为每个 Host 进程持有新私有凭据，并在 ready 前交付。Desktop Provider 创建 Peer，通过相同认证服务注册验证。Electron 使用本地组装的 `authenticationCookie`；runtime smoke 等父进程消费者不使用普通 ready URL 尝试 Token 交换。Renderer 启动数据和 wire ready 消息不含私有凭据。

## Testing

| 受影响行为 | 原行为 | 最终行为与覆盖 |
|---|---|---|
| Provider 注册 | 只有内置 BrowserAuth 提供网络身份 | 有序独立验证器选择一个存活 Peer；[认证测试](../../../../packages/client/connection/tests/authentication.host.spec.ts)覆盖作用域卸载、验证故障和取消 |
| HTTP 与 upgrade 接入 | 消费者调用 Connection 准入 | 路由 auth 一次提供 Peer；真实 [Provider 传输测试](../../../../packages/api/gateway/tests/authentication-provider.host.spec.ts)覆盖两种载体 |
| 服务器隔离 | 路由表按实例持有，index 注入覆盖 root | 五个事件均使用 WebServer subject；[服务器](../../../../packages/host/webserver/tests/event-isolation.host.spec.ts)和[应用](../../../../packages/bundle/web-app/tests/event-isolation.host.spec.ts)测试覆盖普通／global 监听器及保留的外部 Host |
| 浏览器 OAuth 返回 | 回调校验 state 与 PKCE | 有作用域的前置回调保留校验，并接受真实跨站导航；[账号测试](../../../../packages/credentials/deepseek-account/tests/account.spec.ts)保留错误 Host 和 SSH 转发覆盖，[Chromium](../../../../apps/web/tests/account-login.e2e.ts)断言实际 Fetch Metadata header |
| 启动输出 | WebApp 打印／打开一个 Connection 生成的登录 URL | [启动测试](../../../../packages/bundle/web-app/tests/startup.host.spec.ts)覆盖按序入口、首个可打开项、空列表、就绪和 SSH 抑制 |
| Desktop runtime 消费者 | 以带 Token 的 ready URL 交换 Cookie | [Runtime smoke 测试](../../../../apps/desktop/tests/smoke-runtime.spec.ts)在 HTTP 探针中使用私有 Cookie；[产物 Remote 测试](../../../../packages/api/remotes/tests/built-lib.e2e.ts)收集当前 Provider 入口，并传递准入 Peer |

## Alternatives considered

**在 Connection 上保留逐请求认证包装。** 独立注册的 Service 直接表达所有权和必需注入，不在每次消费者读取认证时分配 facade。

**增加另一张路由表或请求上下文容器。** 现有 WebServer 注册已拥有分发，Peer 就是下游消费的身份。路由策略和末尾 Peer 参数保留这些 owner。

**给每个请求增加 WebServer 字段。** Cordis 已支持服务 subject 与隔离过滤。采用该机制也能限制页面注入和入口收集的作用域，而不增加 payload 字段。

**让 Token 持有 WebApp 地址服务或浏览器 opener。** 这会反向依赖组装它的 bundle。WebApp 拥有发布时机和动作，Provider 通过共同事件贡献完整入口。

## Consequences

凭据实现不需要改变 Gateway，但自定义载体必须以自己的 WebServer subject 发事件，并把准入 Peer 传给协议 handler。消费嵌套认证服务的插件在注入中声明 `connection.authentication`。显式全局事件监听器仍负责判断跨服务器实例共享数据是否合适。

撤销 Provider 注册和释放其 Peer 是不同操作。共享一个 Peer 的产品也共享其终止范围；使用独立凭据的产品持有自己的 Peer 记录和撤销策略。此接线不增加通用 Socket 策略或另一层认证权限等级。

[Provider 决策](2026-11-07-browser-authentication-providers.zh.md)拥有协议兼容性和部署后果。[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer/guide.zh.md)拥有手动配置迁移和载体更新说明；本记录描述已经实现的接线，而非未来 Remote 产品。
