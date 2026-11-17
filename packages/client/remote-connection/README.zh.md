---
description: "通过一次性二维码或带私密 token 的链接远程登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-remote-connection

[English](README.md) | 中文

## 概述

设置面板在共用登录说明下依次显示访问地址和二维码登录卡片。已登录的 owner 可以生成一次性二维码，或复制带 token 的 URL，让另一个浏览器登录同一 Host。二维码兑换签发 Remote 浏览器 cookie；凭据链接使用独立的 Token 登录。凭据链接不可用时，复制使用干净地址。凭据告警仅在生成二维码或成功复制凭据后出现。登录链接直接显示 token，并在右侧渐隐。复制结果通过关闭设置后仍可见的外壳 toast 提示成功或失败。

## 目录

- [使用本包](#use-this-package)
- [认证与失败处理](#authentication-and-failures)
- [添加设置选项](#add-settings-options)
- [替换设置面板](#replace-the-settings-panel)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

Web bundle 挂载此插件。Host 端依赖 `connection`、`connection.authentication`、`credentials`、`webServer` 和 `webApp`，Client 端通过 `settings.section` 提供面板。移除插件会移除页面、端点、待使用的邀请和 Remote Peer。已签发的 Remote cookie 需要该提供者处于活动状态；插件使用同一凭据记录重新加载后，有效 cookie 可以继续使用。设置面板支持产品提供的全部八种界面语言；匿名登录页支持英文和中文。两张卡片的标题均位于边框内。页面标题和说明文字采用与模型设置页一致的字体和间距。宽卡片中的二维码操作与标题同行，窄卡片中则在标题下方纵向排列并占满宽度。二维码按钮、访问地址卡片按钮和链接框高度均为 32px，地址文字垂直居中。窄卡片中的复制按钮保持自然宽度并靠起始边缘对齐。复制按钮保持固定文案，仅在写入剪贴板时禁用。过期 banner 位于二维码卡片标题栏下方，占满卡片内容宽度。倒计时居中位于二维码下方，并在凭据告警上方增加 16px 下边距。重新生成正在显示的二维码时，仅用加载状态替换二维码图像；倒计时、告警和链接操作保持原位。取消后直接收起二维码预览，不显示成功提示。

公布的应用 URL 支持 HTTP 和 HTTPS，必须指向手机可访问的非回环地址，并通过 Connection 的可信 Host 检查。通过现有 [Web 应用](../../bundle/web-app/README.zh.md) 配置设置监听器、可选证书或反向代理、`publicUrl` 和可信 Host。此插件不会更改监听接口或发现网络地址。反向代理必须保留外部 Host、移除配置的路径前缀，并保护上游连接。普通 HTTP 监听器为 HTTP 公布地址签发的 cookie 不带 `Secure`；HTTPS 监听器以及终止 TLS 的代理后的 HTTPS 公布地址仍使用 `Secure`。HTTPS 代理必须对外部源强制使用 HTTPS。设置面板允许 HTTP 登录，并提醒用户 HTTP 会明文传输登录凭据。

面板在卡片上方以共用提示说明尚未满足的地址前提。地址不可达或不受信任时，访问地址卡片保留可复制的干净 URL，不显示凭据告警，并隐藏二维码登录。二维码登录不可用时，部署信息的读取错误和重试操作保留在访问地址卡片中。重连后会重新检查地址前提。

`cookieMaxAgeDays` 默认为 30，固定每份 Remote cookie 的绝对有效期。`ticketLifetimeMs` 默认为 120000。`pollIntervalMs` 默认为 1000，控制设置面板显示二维码时的状态检查间隔。每个插件实例同一时间只有一个待使用邀请：生成新邀请会替换旧邀请，取消旧邀请不会取消替代它的新邀请。

<a id="authentication-and-failures"></a>
## 认证与失败处理

二维码使用公布的应用根地址，在查询参数中携带 `login=qr`，在 URL fragment 中携带独立生成的 256 位凭据，始终不使用进程启动 token。根地址的登录页面移除 fragment，并向带 `login=qr` 的同源根地址 POST 兑换凭据。GET 和 HEAD 不会兑换凭据。Remote 在读取兑换请求前应用 WebServer 的匿名来源检查，核对公布地址的 authority，消费一次性凭据，再签发自己的 owner 浏览器 cookie。已兑换、过期、取消、被替换和重启前生成的邀请均不能再次兑换。

只有已认证的 owner 可以创建、查询或取消邀请。Host 保留凭据摘要，不保留可重复使用的明文。公开页面不包含已认证应用的初始化注入，也不会向第三方发送凭据。二维码兑换失败时保留普通登录页及已配置的 Token 表单，并用本地化 banner 说明失败原因。兑换中断时 cookie 可能已经签发；banner 提供干净的应用链接以检查未知结果，不会自动重试一次性凭据。

仅供 owner 调用的 `loginUrl()` 读取同一 WebServer 实例通过 `webserver/entry-url` 发布的 Token 入口，返回公布的根地址，并在 `?token=…` 中携带其进程启动 token。未启用 Token 认证的 Host 无法提供此链接，二维码登录仍可使用。与二维码邀请不同，此链接可以重复使用，直到 Host 进程重启。复制链接不会创建、消费或替换二维码邀请。Client 仅在确认部署可用后预取 URL，在插件内存中保留，以右侧渐隐方式显示，并在重连时刷新。开始读取凭据时会清除先前的复制反馈；凭据 URL 变化后，其凭据告警也会重置。凭据 URL 正在加载或不可用时，复制使用显示的干净地址，不显示链接读取错误或重试按钮；二维码生成仍独立可用。只有成功复制当前凭据 URL 后才显示其凭据告警，复制干净地址不会触发该告警。剪贴板拒绝写入时报告失败，并保留再次复制的能力。链接读取结果和复制结果均不持久保存或写入日志。

Remote 拥有持久的 `client-remote-connection/browser-session` 凭据记录。其签名密钥和 v1 cookie 格式独立于 Token；cookie 绑定监听协议与规范化 Host，携带固定签发及到期时间，并使用 `HttpOnly`、`SameSite=Strict` 和 `Path=/`。验证不续期。记录损坏会使插件激活失败，不会替换密钥。保留此记录可让有效登录跨重启继续使用；替换或删除记录会在下次激活时使旧 cookie 失效。

Remote 在根地址使用同一份登录文档处理普通登录和二维码兑换。来源可信但尚未登录的普通根地址访问返回 HTTP 401，HEAD 保留 401 且不返回正文。`login=qr` 模式以 HTTP 200 返回同一份普通登录文档，即使浏览器已有登录 cookie；它尝试二维码兑换，保留页面上的登录控件。文档不暴露 Token 值或私有应用注入；普通登录模式仅在 Token 发布入口时显示 Token 表单。已登录且未指定二维码模式的访问使用实际 Peer 渲染应用，不再次验证凭据。来源拒绝保持 403；认证故障且没有其它成功提供者时保持 503。

<a id="add-settings-options"></a>
## 添加设置选项

在根作用域的列表插槽 `settings.remoteConnection.extensions` 中注册，即可在主面板后添加选项。各插件使用唯一的 `id`；条目按 `order` 升序排列，相同值按注册顺序排列。扩展内容可与默认面板或替换面板同时显示。`RemoteConnectionExtensionProps` 提供与[面板替换组件](#replace-the-settings-panel)相同的共享状态 Hook、操作和 `close()`。各扩展组件负责自己的渲染和本地化文案。

```ts client
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { FunctionComponent } from 'react'
import type { RemoteConnectionExtensionProps } from '@deepseek-ai/dsh-client-remote-connection/client'

declare const ConnectionOptions: FunctionComponent<RemoteConnectionExtensionProps>

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.remoteConnection.extensions', () => ctx.slots.register({
    name: 'settings.remoteConnection.extensions',
    id: 'example.connection-options',
    order: 100,
  }, ConnectionOptions))
}
```

<a id="replace-the-settings-panel"></a>
## 替换设置面板

根作用域的单选插槽 `settings.remoteConnection.content` 支持替换主面板，同时保留唯一的设置导航项和追加的扩展内容。所有组件都获得本包 `/client` 类型入口导出的 `RemoteConnectionContentProps`：`useRemoteConnection(selector)`、`create()`、`cancel()`、`reload()`、`useLoginLink(selector)`、`copyLink()`、`reloadLink()`、`dismissCopyNotice(sequence)` 和设置外壳的 `close()`。插件在视图替换期间持有邀请和链接状态，因此切换视图会保留当前邀请、倒计时和复制反馈。操作结果通过状态 Hook 返回。替换组件负责自己的渲染和本地化文案，可以注册自己的 `locale` 命名空间。

在 Client 插件中注册替换组件，优先级应低于默认面板的 `0`：

```ts client
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { FunctionComponent } from 'react'
import type { RemoteConnectionContentProps } from '@deepseek-ai/dsh-client-remote-connection/client'

declare const CustomPanel: FunctionComponent<RemoteConnectionContentProps>

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.remoteConnection.content', () => ctx.slots.register({
    name: 'settings.remoteConnection.content',
    priority: -1,
  }, CustomPanel))
}
```

`slots.inject` 支持先于远程连接插件加载任一种贡献，并在插槽所有者重新出现时恢复注册。卸载扩展组件仅移除该贡献，保留主面板、其他扩展和共享状态。卸载替换插件会恢复默认面板及其当前状态；卸载远程连接插件则移除两个插槽、停止轮询、立即丢弃链接凭据和复制提示，并等待进行中的读取、剪贴板写入和排队刷新完成。仅在 `phase === 'pending'` 时将 `ticket.url` 显示为二维码：结果不确定的操作可能保留票据用于恢复，但不允许展示。不得持久保存或记录任一凭据 URL。替换此面板不会替换匿名登录页面或 Host 邀请协议。

<a id="further-exploration"></a>
## 进一步探索

- [Web 服务器子系统](../../../docs/subsystems/web-server.zh.md) — 浏览器服务与设置贡献。
- [Connection](../connection/README.zh.md) — 请求来源策略、提供者注册与 Peer 所有权。

<a id="model-experience"></a>
## 模型体验

无；此包提供浏览器认证，不贡献模型输入。

#### KV Cache 影响

无；此包不组装或发送模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 兑换前，任何取得二维码的人都可能抢先兑换。过期和单次使用限制暴露范围，无法防止凭据转发或钓鱼。执行 JavaScript 的预览器可能消费二维码。
- 登录状态属于完成兑换的浏览器。扫码器的内置浏览器和已安装的 PWA 可能使用不同 cookie 存储。清除 cookie、更改 Host authority 或 cookie 过期后需要重新登录。
- 登录后的浏览器拥有 owner 权限。Remote cookie 共用一个运行时 Peer，没有按设备划分的权限或撤销列表。取消二维码不会撤销已签发的 cookie。cookie 过期会拒绝新请求与新连接，不会终止已经准入的 WebSocket。卸载 Remote 会关闭其共享 Peer 与连接，不影响 Token 连接。
- 原浏览器关闭后，Host 仍须运行且可访问。此插件不提供隧道或远程唤醒。

### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
