# 在反向代理之后发布 Web UI

[English](public-deployments.md) | 中文

`dsh --profile web` 在 loopback 端口上以明文 HTTP 提供 GUI，因此其他机器上的浏览器无法访问它，进程也无从得知你实际使用的地址。它前面的反向代理拥有这条外部链路——公开主机名、TLS，以及转发到监听器之前剥离的路径前缀——`--public-url` 则告诉 DSH 浏览器使用的是哪个地址：

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

## `--public-url` 公告什么

`--public-url` 接受可带挂载前缀的 `http://` 或 `https://` 根，并把它归一化为以 `/` 结尾。它提供打印与打开的启动 URL、`DSH_WEB_URL` 与 web 表层定位。webserver 继续提供 origin-root 路由，且从不了解挂载。`publicUrl` 配置字段发布同样的公告。

## 代理必须做什么

- **保留浏览器可见的 `Host`。** 栅栏把收到的 `Host` 与被接受的 authority 比对，因此代理应原样转发，而不要改写成监听器的地址。
- **剥离挂载前缀。** 监听器应答的是 origin-root 路由，因此对 `/ui/api/...` 的请求必须以 `/api/...` 抵达。
- **转发升级请求。** 页面发出的每个请求与 WebSocket 升级都必须连同其 `Upgrade` 与 `Connection` 头抵达监听器；代理对外提供 HTTPS 时，TLS 在其外部链路上终止。
- **改写 cookie 作用域。** 后端始终签发不带 `Secure` 的 host-only `Path=/` cookie；代理把 `Path` 改写为挂载（`/ui/`），并仅在其 HTTPS 链路上添加 `Secure`。
- **重定向裸挂载。** `/ui/` 是唯一入口：只有它把启动 token 换成会话 cookie；已持有该 cookie 的浏览器可由它或 `/ui/index.html` 取得文档，因为所提供的文档以自身目录解析 URL。对 `/ui` 的请求必须以 `/ui/` 抵达，而被剥离路径的后端无法重建该外部路径。

## 信任浏览器使用的 authority

栅栏接受 loopback，以及每个由 `--trusted-host` 点名的 authority。浏览器若以其他任何 authority 访问部署，无论代理多么正确，每个 API 调用都会得到 403，因此请用 `--trusted-host` 点名浏览器可见的 authority；用 `--public-url` 公告它只是展示，并不等于接纳。不带端口的条目匹配任意端口，适合每次绑定不同端口的隧道。栅栏只放行请求；打印 URL 中的启动 token 与签名会话 cookie 才完成认证。

无论是公告 URL 还是栅栏都不保护监听端口本身，因此请把端口限制在可信代理或网络内。

## 保护外部链路

在代理处终止 TLS。`http://` 公告根会以明文发送启动 token 与会话 cookie，而 `https://` 根只加密浏览器到代理这一段。打印的 URL 携带进程凭据，只应与预期用户分享。

[Web 应用参考](../../../packages/bundle/web-app/README.zh.md#public-deployments)负责 `--public-url` 与 `--trusted-host` 的命令行约定，以及 `publicUrl` 与 `trustedHosts` 字段。
