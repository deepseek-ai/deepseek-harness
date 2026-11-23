---
description: "二维码登录、私密登录链接和 owner 审批的浏览器配对。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-remote-connection

[English](README.md) | 中文

## 概述

设置面板在共用登录说明下依次显示访问地址和二维码登录卡片。已登录的 owner 可以生成一次性二维码，或复制带 token 的 URL，让另一个浏览器登录同一 Host。二维码兑换签发 Remote 浏览器 cookie；凭据链接使用独立的 Token 登录。凭据链接不可用时，复制使用干净地址。凭据告警仅在生成二维码或成功复制凭据后出现。登录链接直接显示 token，并在右侧渐隐。复制结果通过关闭设置后仍可见的外壳 toast 提示成功或失败。

## 目录

- [使用本包](#use-this-package)
- [认证与失败处理](#authentication-and-failures)
- [配对申请](#pairing-requests)
- [添加设置选项](#add-settings-options)
- [替换设置面板](#replace-the-settings-panel)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

Web bundle 挂载此插件。Host 端依赖 `connection`、`connection.authentication`、`credentials`、`webServer` 和 `webApp`，Client 端通过 `settings.section` 在浏览器设置中提供面板。Desktop 窗口隐藏此入口。移除插件会移除页面、端点、待使用的邀请和 Remote Peer。已签发的 Remote cookie 需要该提供者处于活动状态；插件使用同一凭据记录重新加载后，有效 cookie 可以继续使用。设置面板支持产品提供的全部八种界面语言；匿名登录页支持英文和中文。两张卡片的标题均位于边框内。页面标题和说明文字采用与模型设置页一致的字体和间距。宽卡片中的二维码操作与标题同行，窄卡片中则在标题下方纵向排列并占满宽度。面板使用标准小号按钮。链接框与复制按钮同为 28px 高，地址文字垂直居中。窄卡片中的复制按钮位于链接框下方，占满卡片内容宽度。复制按钮保持固定文案，仅在写入剪贴板时禁用。过期 banner 位于二维码卡片标题栏下方，占满卡片内容宽度。倒计时居中位于二维码下方，并在凭据告警上方增加 16px 下边距。重新生成正在显示的二维码时，仅用加载状态替换二维码图像；倒计时、告警和链接操作保持原位。取消后直接收起二维码预览，按钮恢复为**生成二维码**，不显示成功提示。

二维码登录使用公布的应用 URL，该地址支持 HTTP 和 HTTPS，必须指向手机可访问的非回环地址，并通过 Connection 的可信 Host 检查。通过现有 [Web 应用](../../bundle/web-app/README.zh.md) 配置设置监听器、可选证书或反向代理、`publicUrl` 和可信 Host。此插件不会更改监听接口或发现网络地址。反向代理必须保留外部 Host、移除配置的路径前缀，并保护上游连接。普通 HTTP 监听器为 HTTP 公布地址签发的 cookie 不带 `Secure`；HTTPS 监听器以及终止 TLS 的代理后的 HTTPS 公布地址仍使用 `Secure`。HTTPS 代理必须对外部源强制使用 HTTPS。设置面板允许 HTTP 登录，并提醒用户 HTTP 会明文传输登录凭据。

面板在卡片上方以共用提示说明尚未满足的地址前提。使用 `127.0.0.1` 等受信任的回环地址时，如果 Token 提供者发布了登录链接，访问地址卡片会显示该链接。owner 可以复制链接，在同一台电脑的另一个浏览器中登录。其他设备无法访问这个回环地址，因此面板会隐藏二维码登录。通配地址和不受信任的地址只显示不带凭据的 URL。配对审批仍可使用。二维码登录不可用时，部署信息的读取错误和重试操作保留在访问地址卡片中。重连后会重新检查地址前提。

`cookieMaxAgeDays` 默认为 30，固定每份 Remote cookie 的绝对有效期。`ticketLifetimeMs` 默认为 120000。`pollIntervalMs` 默认为 1000，控制设置面板显示二维码时的状态检查间隔。每个插件实例同一时间只有一个待使用邀请：生成新邀请会替换旧邀请，取消旧邀请不会取消替代它的新邀请。

<a id="authentication-and-failures"></a>
## 认证与失败处理

二维码使用公布的应用根地址，在查询参数中携带 `login=qr`，在 URL fragment 中携带独立生成的 256 位凭据，始终不使用进程启动 token。根地址的登录页面移除 fragment，并向带 `login=qr` 的同源根地址 POST 兑换凭据。GET 和 HEAD 不会兑换凭据。Remote 在读取兑换请求前应用 WebServer 的匿名来源检查，核对公布地址的 authority，消费一次性凭据，再签发自己的 owner 浏览器 cookie。已兑换、过期、取消、被替换和重启前生成的邀请均不能再次兑换。

只有已认证的 owner 可以创建、查询或取消邀请。Host 保留凭据摘要，不保留可重复使用的明文。公开页面不包含已认证应用的初始化注入，也不会向第三方发送凭据。二维码兑换失败时保留普通登录页及已配置的 Token 表单，并用本地化 banner 说明失败原因。兑换中断时 cookie 可能已经签发；banner 提供干净的应用链接以检查未知结果，不会自动重试一次性凭据。

仅供 owner 调用的 `loginUrl()` 读取同一 WebServer 实例通过 `webserver/entry-url` 发布的 Token 入口，返回公布的根地址，并在 `?token=…` 中携带其进程启动 token。未启用 Token 认证的 Host 无法提供此链接，二维码登录仍可使用。与二维码邀请不同，此链接可以重复使用，直到 Host 进程重启。复制链接不会创建、消费或替换二维码邀请。Client 仅在 Host 允许为公布的地址读取 Token 登录链接后才预取 URL，在插件内存中保留，以右侧渐隐方式显示，并在重连时刷新。开始读取凭据时会清除先前的复制反馈。凭据 URL 变化或用户离开远程连接设置页（包括关闭设置面板）时，会重置凭据告警。离开后才完成的剪贴板写入仍通过全局 toast 报告结果，但不会在下次进入时恢复告警。凭据 URL 正在加载或不可用时，复制使用显示的干净地址，不显示链接读取错误或重试按钮；二维码生成仍独立可用。只有成功复制当前凭据 URL 后才显示其凭据告警，复制干净地址不会触发该告警。剪贴板拒绝写入时报告失败，并保留再次复制的能力。链接读取结果和复制结果均不持久保存或写入日志。

Remote 拥有持久的 `client-remote-connection/browser-session` 凭据记录。其签名密钥和 v1 cookie 格式独立于 Token；cookie 绑定监听协议与规范化 Host，携带固定签发及到期时间，并使用 `HttpOnly`、`SameSite=Strict` 和 `Path=/`。验证不续期。记录损坏会使插件激活失败，不会替换密钥。保留此记录可让有效登录跨重启继续使用；替换或删除记录会在下次激活时使旧 cookie 失效。

Remote 在根地址使用同一份登录文档处理普通登录和二维码兑换。来源可信但尚未登录的普通根地址访问返回 HTTP 401，HEAD 保留 401 且不返回正文。`login=qr` 模式以 HTTP 200 返回同一份普通登录文档，即使浏览器已有登录 cookie；它尝试二维码兑换，保留页面上的登录控件。文档不暴露 Token 值或私有应用注入；Token 发布入口时始终显示 Token 表单。Token 输入框支持令牌或完整登录链接，占位提示使用当前页面的协议、地址、端口和应用路径，使用 `xxx` 作为令牌示例，并采用主题的 caption 颜色，不带入现有查询参数或片段。页面初始化前，HTML 使用通用地址模板。说明引导用户在已登录设备的「设置 → 远程连接」中复制链接，粘贴到此页面。页面沿用应用的默认字体栈和灰阶文字渲染。Token 输入框聚焦时使用主题蓝色细边框，校验错误时保留红色边框。已登录且未指定二维码模式的访问使用实际 Peer 渲染应用，不再次验证凭据。来源拒绝保持 403；认证故障且没有其它成功提供者时保持 503。

<a id="pairing-requests"></a>
## 配对申请

匿名根页面在共同标题下将 Token 输入和设备配对分为两张卡片。页面说明引导用户选择下方任一可用方式验证登录。两张卡片均按标题、说明、操作控件的顺序排列，并使用相同的字体与间距。令牌输入错误时，在输入框下显示错误信息，标题下的说明保持可见。二维码兑换提示位于两张卡片上方；兑换失败后，两种登录方式均可继续使用。公开的 `pairing/client.js` 脚本以 defer 方式加载，定义 `dsh-device-pairing`；元素自主管理申请控件、样式和词典，无需加载已认证 Client 模块。Host 使用随普通入口发布的自包含浏览器函数及公开数据生成此脚本；重新加载插件后，脚本随实现一同更新。移除元素会中止工作并丢弃私密票据；浏览器前进后退缓存的暂停则保留票据，并在恢复时查询状态。

匿名配对卡片依次显示配对码、重新申请、取消申请和等待状态，倒计时位于状态旁。申请和状态查询失败以占满内容宽度的错误横幅显示，拒绝和过期使用警告横幅。横幅不含图标，描边、间距和圆角与设置页远程连接中的横幅一致。倒计时位于横幅外。网络或服务端暂时失败时显示自动重连状态。HTTP 429 限流时提示稍后自动重试，次数耗尽后提示稍后重新申请。恢复次数耗尽后显示错误横幅和“重新申请”，不再提供独立的状态查询操作。申请操作禁用时保留主按钮的前景色。确认取消后恢复“申请配对”，不显示取消提示。

设置页在访问地址和二维码登录卡片之后，以独立卡片显示配对申请，即使公布的二维码地址不可用，审批仍可使用。只有卡片显示申请时，才展示完整访问权限警告。读取列表失败时，卡片隐藏申请和权限警告，显示错误提示和「重试」。重试成功后显示最新列表。通过配对登录的浏览器具有 owner 访问权限，也可以批准其他设备的申请。配对、二维码和链接登录分别管理状态：创建或取消配对申请不会替换二维码邀请或可重复使用的登录链接。

公开 POST 路由 `pairing/request`、`pairing/status` 和 `pairing/cancel` 声明匿名认证；WebServer 在调用处理函数前执行 Host、Origin 和 Fetch Metadata 检查。URL 相对于应用目录解析，以支持反向代理挂载。浏览器在首次创建前生成 ID 和随机 secret，三个路由的 JSON 请求体均仅含这两个字段。使用相同 ID、secret 和 origin 重复创建会返回保留的票据，不延长有效期，也不改变审批或取消结果。Host 生成独立的显示码，并保留首次创建连接的 IP。只有申请者持有 secret；显示码不能用于查询、取消或领取申请。设置页使用 `remoteConnection/pairingRequests` 和 `remoteConnection/decidePairing`；两者都要求当前 invocation 具有 owner 身份，即使 API peer 拥有方法调用权限也不例外。

审批行显示创建申请时从连接中取得的 `sourceIp`，并归一化 IPv4/IPv6 格式；地址缺失时显示“未知”。转发头不参与取值，经过代理时显示的是代理 IP。`authority` 仍用于绑定应用 origin，不作为来源地址显示；IP 不用于识别设备或授予访问权限。

第一次批准或拒绝决定生效。取消可以撤回尚未领取的批准。批准后，申请者通过二维码兑换所用的私有签发函数领取 Remote cookie，与 Token 认证相互独立。响应丢失时，在申请过期前重试可领取同一 cookie，不会延长有效期。拒绝、取消、过期和插件关闭均不能创建登录。

owner 的审批返回 `approved`、`denied` 或 `unavailable` 后，卡片先从可见列表中移除该申请，再显示结果提示。此前仍在途的读取结果不能恢复该行，卡片会立即重新读取列表，即使上次读取失败。审批结果不确定时，列表保留该申请，直到后续读取确认其状态。其他设备产生的变更和申请过期仍通过定期轮询更新。

申请者可以在创建申请或等待批准时取消。创建响应不确定时，浏览器先使用保留的凭据重复创建，取得同一份票据，再确认取消。取消结果不确定时保留凭据，不会创建另一份申请。

等待页面显示剩余时间。创建、状态读取、取消和登录检查均限制完整响应的等待时间。网络失败、无法读取响应、HTTP 429 和服务端失败会自动重试：以 `pollIntervalMs` 为初始延迟指数退避，最多等待 `retryMaxDelayMs`，追加尝试不超过 `maxRetries` 次。状态读取成功后重置次数，其他 HTTP 拒绝立即停止。次数耗尽后停止自动操作并显示错误横幅。**重新申请**先确认旧申请结束，再生成新凭据和配对码；取消结果不确定时绝不创建替代申请。进行中的操作会被中止，其迟到结果不能覆盖新申请。拒绝、取消或确认过期后，同一操作创建新申请。

本地计时到期或 Host 报告过期时，页面中止未完成的配对操作，并向干净的应用 URL 发送不使用缓存的 `HEAD` 请求，核对浏览器认证状态。`200` 会打开应用；收到 `401` 后还会确认取消旧申请，因为 Host 的有效期可能晚于本地倒计时。只有此后才能结束等待或创建替代申请。检查失败时按同样的次数限制自动恢复。次数耗尽后保留凭据并报告登录结果尚不确定；**重新申请**会先重新检查，再决定能否创建新申请。只有确认浏览器未登录后才允许重新开始；取消 fetch 不会撤销已收到的 cookie。

在此插件的 `pairing` 字段下配置申请限制：

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `pairing.requestTtlMs` | 300000 | 申请有效期，包含批准后的领取重试；必须大于轮询间隔 |
| `pairing.maxRequests` | 32 | 保留的待处理与已结束申请总数上限 |
| `pairing.requestIntervalMs` | 1000 | 所有申请者共用的最短创建间隔 |
| `pairing.pollIntervalMs` | 2000 | 申请端最小轮询间隔、初始重试延迟与设置页定期刷新的间隔 |
| `pairing.requestTimeoutMs` | 10000 | 单次 HTTP 尝试的超时，包含响应体读取 |
| `pairing.maxRetries` | 3 | 暂时失败后的追加尝试次数 |
| `pairing.retryMaxDelayMs` | 10000 | 指数退避的最大延迟，不得小于轮询间隔 |

申请只保存在当前进程的有界请求池中，决定后仍保留至过期。重启或卸载插件会清空申请，但不会撤销已签发的 cookie。请求池已满或达到创建频率限制时，申请者需稍后重试；轮询失败会保留私密票据，以便恢复查询。

<a id="add-settings-options"></a>
## 添加设置选项

在根作用域的列表插槽 `settings.remoteConnection.extensions` 中注册，即可在主面板（包括默认的访问地址、二维码登录和配对卡片）之后添加选项。各插件使用唯一的 `id`；条目按 `order` 升序排列，相同值按注册顺序排列。扩展内容可与默认面板或替换面板同时显示。`RemoteConnectionExtensionProps` 提供与[面板替换组件](#replace-the-settings-panel)相同的共享状态 Hook、操作和 `close()`。各扩展组件负责自己的渲染和本地化文案。

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

根作用域的单选插槽 `settings.remoteConnection.content` 支持替换主面板，包括默认的访问地址、二维码登录和配对卡片，同时保留唯一的设置导航项和追加的扩展内容。所有组件都获得本包 `/client` 类型入口导出的 `RemoteConnectionContentProps`：`useRemoteConnection(selector)`、`create()`、`cancel()`、`reload()`、`useLoginLink(selector)`、`copyLink()`、`reloadLink()`、`dismissCopyNotice(sequence)` 和设置外壳的 `close()`。两类插槽 props 均提供 `useApproval(selector)`、`decide(id, decision)` 和 `dismiss()`；仅在 `available` 为 true 时渲染审批控件。插件在视图替换期间持有邀请、链接和配对审批状态，因此切换视图会保留当前邀请、倒计时和复制反馈。操作结果通过状态 Hook 返回。替换组件负责自己的渲染和本地化文案，可以注册自己的 `locale` 命名空间。

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

`slots.inject` 支持先于远程连接插件加载任一种贡献，并在插槽所有者重新出现时恢复注册。卸载扩展组件仅移除该贡献，保留主面板、其他扩展和共享状态。卸载替换插件会恢复默认面板及其当前状态；卸载远程连接插件则移除两个插槽、停止轮询、立即丢弃链接凭据和复制提示，并等待进行中的读取、剪贴板写入和排队刷新完成。仅在 `phase === 'pending'` 时将 `ticket.url` 显示为二维码：结果不确定的操作可能保留票据用于恢复，但不允许展示。不得持久保存或记录任一凭据 URL。替换此面板不会替换匿名登录页面或 Host 的任一登录方式。

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
