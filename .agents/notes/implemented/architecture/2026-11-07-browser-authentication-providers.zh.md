# Agent Note: 基于 Peer 的认证 Provider

Status: implemented

[English](2026-11-07-browser-authentication-providers.md) | 中文

## Problem

Host 提供具备工具执行能力的操作，因此可达地址不能建立调用方身份。浏览器登录、Desktop 访问和远程邀请或配对需要不同的凭据实现，但不应为每种传输建立不同的授权模型。

拆分前，WebServer 拥有 HTTP 与 upgrade 监听器及各实例的路由表。Connection 构造内置 BrowserAuth，检查请求来源、验证浏览器与 API Cookie，并管理已有的 API Peer 关联。路由 owner 自行调用 Connection 准入方法。WebApp 请求 Connection 为公告地址附加启动 Token，再打印或打开该 URL。旧 `webserver/index-inject` 事件在 Cordis root 内广播，与路由表的实例范围无关。

这种关系把默认 Token 实现放进了通用连接服务。其他认证产品同样需要返回 Peer，却没有公共注册接口可以接入自己的验证器。

## Decision

### 独立认证与平级 Provider

ConnectionAuthentication 是 Connection 包内的独立 Service，注册名为 `connection.authentication`，通过 `ctx.connection.authentication` 访问。它拥有凭据验证器注册与选择。Connection 保留请求来源策略、Peer 创建和 RPC/Fetch 操作；WebServer 执行路由准入并向 handler 传递选定的 Peer。Gateway 与 RemoteAccess 使用该 Peer 授权操作。

AuthenticationProvider 同步返回已存在且存活的 Peer 或 `undefined`。ConnectionAuthentication 按实际注册顺序尝试 Provider，采用首个存活结果。普通拒绝或已结束 Peer 允许后续 Provider 成功；异常也不阻止后续成功。无人成功时，普通拒绝返回401，存在验证故障则返回503。请求取消终止准入。这是一次选择过程，不是凭据种类之间的优先级或权限等级。

| 访问方式 | 凭据实现 | Peer 所有权 |
|---|---|---|
| Web 与 API Token | Token 插件验证进程 Token 交换和签名 Cookie | 浏览器 v1 Cookie 共享插件持有的 Peer；`/connect` v2 Cookie 标识已有的独立 API Peer |
| Desktop | Desktop Provider 验证通过父进程—Host IPC 交付的私有凭据 | 一个 Peer 属于该自有 Host 进程的 Provider |
| Remote | 同一个 Provider 接口可接收产品自己的邀请或配对验证器 | 产品决定自己的 principal、凭据和 Peer 生命周期；Remote 产品本身尚未实现 |

公共认证扩展能力已经完成，不取决于未来 Remote 产品的完成状态。[接入说明](2026-11-07-browser-authentication-development.zh.md)提供带类型的 Provider 示例及路由、事件用法。

### 身份、授权与生命周期相互独立

Host 在创建 Peer 时固定 `peer.principal`；客户端不能通过请求字段选择它。认证建立该身份，不代表允许所有操作。RemoteAccess 继续判断业务权限，`peer.interactions` 继续控制转发事件参与方式，而不是认证等级。

注册由调用插件拥有，Peer 作用域由创建者拥有。凭据撤销阻止后续认证，结束 Peer 也结束其作用域内的通信。已经准入的一元请求保留请求级取消语义。Provider 异步准备可能影响实际注册顺序，因此部署不能从凭据名称推导另一套优先级。

### HTTP、事件与启动的变化

WebServer 路由注册声明 `anonymous`、`required` 或 `deny`，省略时为 `required`。受保护的 handler 接收集中准入选定的 Peer，不再自行调用各个验证器。匿名路由免凭据，但仍经过活动 Connection 的来源策略。可信进程内资源读取保留显式 Peer，并继续遵守 `deny`。

五个 `webserver/*` 事件均以对应 WebServer 为 Cordis 分发 subject。普通监听器遵循 `webServer` 服务隔离；显式 `global: true` 监听器跳过该过滤。请求准入、upgrade 中间件、已有页面注入事件和入口 URL 收集均采用该规则。服务隔离是组合机制，不是同进程插件的安全沙箱。

Token 插件拥有根 Token 交换和 `/connect` 签发。它的 upgrade 中间件仅在 `/api/remote.mux` 上认领自己的 API Peer，保留每个 API Peer 一个 Socket、重复409，以及在异步清理前同步撤销凭据的行为。Inspector 与其他 upgrade 路由不认领该生命周期。WebApp 拥有就绪、`printUrl` 与 `openBrowser`（两者默认 true）、SSH 抑制和发布：收集完整入口，按序打印，只打开首个可自动打开的入口。没有入口则不输出、不打开。

### 保留的协议与明确限制

[浏览器 Token 协议](2026-08-24-browser-token-authentication.zh.md)保留进程 Token、绑定 authority 的签名 Cookie、持久 `client-connection/browser-session` 签名记录、有效期检查和由监听协议决定的 `Secure` 属性。[API connect 决策](2026-10-09-operator-scoped-connect-handshake.zh.md)保留独立 API Peer、HTTP 先于 Socket 关联、交互参与方式和 mux 清理。有效 v2 Cookie 也可认证受保护页面；页面访问不建立另一层凭据等级。

Desktop 直接使用私有凭据，不交换 Token URL。Renderer 接收普通地址与启动数据，不接收私有凭据；wire `ready` 消息不含秘密。Desktop 也可提供 Token 登录及其打印入口 URL。等待 Desktop 凭据时的正常 shutdown 或父通道断连不会导致致命认证错误；非法或重复凭据仍然失败。

Token 激活失败允许应用缺少该 Provider 继续运行，但不授予受保护路由的未认证访问。Token 拥有 `cookieMaxAgeDays`，默认为30天。用户手动将旧 Connection 设置移到 Token：旧位置既不会自动迁移，也不会被拒绝，并且不影响 Token 有效期。[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer/guide.zh.md)拥有迁移说明。

## Testing

前后对比以原内置认证设计为基线。

| 受影响行为 | 原行为 | 最终行为 |
|---|---|---|
| 凭据选择 | Connection 直接使用 BrowserAuth | Token 与 Desktop 使用同一个有序 Provider 服务；前项拒绝或故障后其他 Provider 仍可成功 |
| 受保护 HTTP 与 upgrade | 路由 owner 调用 Connection 准入 | 路由策略集中执行准入，并向 handler 传递一个选定的 Peer |
| 凭据持久化 | 浏览器 Cookie 可跨重启，API Peer 不可 | Token 格式、authority 检查、重启行为和 API 保留规则保持 |
| API 生命周期 Socket | Gateway 关联拥有一个 API Peer | Token 的 mux 中间件保留重复409和关闭时撤销，不认领其他 upgrade |
| 事件范围 | 路由按实例持有，页面注入广播 | WebServer subject 按服务隔离过滤五个事件，同时保留显式 global 出口 |
| 浏览器启动 | WebApp 打印／打开一个由 Connection 生成的 URL | WebApp 保留默认值与就绪规则，发布 Provider 按序贡献的入口 |
| Desktop 启动 | Desktop 交换启动 URL 取得 Cookie | Desktop 使用私有 IPC 凭据，并确认正常的早期关闭 |

[Connection 测试](../../../../packages/client/connection/tests/authentication.host.spec.ts)、[真实传输组合](../../../../packages/api/gateway/tests/authentication-provider.host.spec.ts)、[mux 生命周期测试](../../../../packages/api/gateway/tests/operator-connect.host.spec.ts)与 [WebApp 隔离测试](../../../../packages/bundle/web-app/tests/event-isolation.host.spec.ts)覆盖这些行为。接入说明补充回调与自定义载体的验证。

## Alternatives considered

**将 Token 专属操作保留在 Connection 内。** 这会让每个认证产品依赖默认凭据实现。通用凭据注册表直接返回传输与授权层已经使用的 Peer。

**返回布尔值或绑定标识，再解析 Peer。** 布尔值无法确定身份，绑定标识则增加映射与 owner。Provider 已经持有自己的 Peer，验证成功直接返回该对象。

**每个 HTTP 与 upgrade handler 分别认证。** 重复检查可能不一致，也可能漏掉新路由。路由策略与集中准入明确表达要求，端点专属票据和输入校验仍由端点负责。

**将业务 Socket 策略放入 Peer 子类或绑定 API。** 单 Socket 规则属于 `/connect` 的 mux 会话，不属于所有 Peer。业务拥有的 upgrade 中间件保留该规则，不需要通用 Peer 策略标志，也不让 Gateway 依赖 Token。

## Consequences

新增凭据实现不改变 Gateway 分发或已有 Peer 协议。Provider 初始化、凭据存储、登录交互和会话生命周期仍由产品负责。默认 Token 与 Desktop 使用未来 Remote 产品也能采用的同一接口，但不声称邀请或审批 UI 已经存在。

集中路由准入把此前未分类路由的默认策略设为 `required`，公开端点需要显式声明策略。按实例作用域分发的事件阻止隔离 WebServer 接收另一台服务器的普通监听器，但显式全局监听器仍覆盖应用。即使没有公开原始 Token getter，含凭据的入口 URL 仍属于敏感输出。

本决策只部分扩展浏览器 Token、API connect 与[请求来源策略](2026-07-28-api-browser-trust-boundary.zh.md)记录中的实现归属。原记录继续保留凭据、生命周期和安全规则的独立理由，没有任何一份被完全取代或归档。
