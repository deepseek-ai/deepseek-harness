# Agent Note: 所有 /api 路由共用一道载体级浏览器信任边界

Status: implemented

[English](2026-07-28-api-browser-trust-boundary.md) | 中文

## 问题

Web GUI 宿主以纯 loopback HTTP 提供 `/api`（默认 `127.0.0.1:3080`；CLI 拒绝 `--host 0.0.0.0`），而这个面上有远程代码执行级别的方法——`session.prompt` 驱动的 agent（智能体）可以运行 bash。浏览器会用两种经典方式把操作者变成攻击此类本地 API 的「混淆代理人」：恶意页面发出跨站「简单请求」 POST（`text/plain`——不经 CORS 预检即发出），其副作用照常执行、只是响应不可读；以及 DNS rebinding 后的源以「同源」身份直连 socket，CORS 整体失效，只有 `Host` 头会暴露攻击者的域名。在本决策之前，系统里唯一的浏览器信任检查（`isTrustedNativeDialogRequest`：回环 socket、同源、回环 Host）只守着一个装饰性的路由——`host.pickDirectory`，其原生对话框弹在宿主屏幕上——而所有真正具有严重后果的方法都没有防护。按 RPC 逐个设防也活不过应用内目录浏览器：它存在的意义就是服务合法的远程客户端，回环规则恰恰会拒绝它们。

## 决策

在载体层对整个 `/api` 前缀一次性执行浏览器信任检查——分为两部分：

- **媒体类型栅栏（dsh-client-connection）**：每个 `/api` POST 必须声明 `application/json`，否则在解析前以 415 拒绝。跨站「简单请求」由此不复存在：任何跨站尝试都被逼进一次本服务器从不应答的 CORS 预检。
- **权威栅栏（dsh-client-connection，`src/api-request-trust.ts`）**：每个请求的 `Host` 都必须是回环地址，或与某个 `trustedHosts` 条目匹配（带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，均经 WHATWG 归一化；rebinding 防御）。刻意不为无标记请求开捷径：明文 HTTP 下浏览器的读取（EventSource、图片、导航——这些头只发给可信目标）既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求可能是被重绑页面发起且响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；非浏览器客户端经由回环地址、已声明的权威，或[绑定一个具体的 Web 地址](2026-09-19-concrete-web-bind-address.zh.md)所接纳的监听器自身绑定字面量通过。若带 `Origin` 则必须与 Host 权威完全一致；`sec-fetch-site: cross-site` 一律拒绝。不是单纯规范化 authority 的 `trustedHosts` 条目会导致插件加载失败——否则 WHATWG 解析会悄悄授权笔误里的 hostname，或放大精确端口授权。`host.pickDirectory` 失去专属守卫，与其他请求同栅而行。

可达性由 webserver 的绑定配置（`host`；[绑定一个具体的 Web 地址](2026-09-19-concrete-web-bind-address.zh.md)拥有它接受哪些字面量）控制，这道栅栏是混淆代理人防御，而不是身份。Connection 在栅栏之后应用独立的[浏览器令牌认证](2026-08-24-browser-token-authentication.zh.md)。栅栏不检查对端 socket 地址：绑定表达可达性，`trustedHosts` 点名接受的 authority，socket 地址提供不了 Host/Origin 校验需要的额外信息。

`HostConnectionHandle.allowsRemoteAuthorities` 表示是否有通过校验的 `trustedHosts` 条目命名非回环主机名：代理后的回环监听器也能服务远程浏览器，因此目录选择器要求策略不接纳远程 authority，才会选择原生交互。

## 曾考虑的替代方案

- **按 RPC 设防（延续现状）。** 否决：守卫清单永远追着方法清单跑，价值最高的方法本来就没被守住，而 browse RPC 上的回环规则会破坏它们为之存在的远程部署。
- **CORS 头与省略凭据。** 否决：我们根本不想要任何跨源读取，应答预检只会扩大暴露面；拒绝预检严格更强也更简单。
- **认证令牌。** 在本变更中否决：令牌签发、存储与轮换属于独立产品决策。后续[浏览器令牌认证](2026-08-24-browser-token-authentication.zh.md)持有这些机制，不改变本栅栏。

## 后果

- 未来任何 `/api` 方法天然在覆盖范围内；不存在会被遗忘的按路由信任决定。
- 非回环监听器直接接受自己的绑定 IP（[绑定一个具体的 Web 地址](2026-09-19-concrete-web-bind-address.zh.md)）；其他远程 authority 需要配置的信任。每个被接受的 authority 仍须满足浏览器认证。`--trusted-host` 只扩展 Host/Origin 栅栏，绝不授予身份。
- 客户端必须给 POST 体标注 `application/json`（我们自己的客户端一向如此；裸 fetch 测试补上了该头）。
- Host 与 Origin 仍只是请求路由证据。进程令牌与签名 cookie 建立每个 Host 方法使用的浏览器身份。
