# 在反向代理之后发布 Web UI

[English](public-deployments.md) | 中文

`dsh --profile web` 在 loopback 端口上提供 GUI，因此其他机器上的浏览器无法访问它，进程也无从得知你实际使用的地址。它前面的反向代理拥有这条外部链路——公开主机名、TLS，以及转发到监听器之前剥离的路径前缀——`--public-url` 则告诉 DSH 浏览器使用的是哪个地址：

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

## `--public-url` 公告什么

`--public-url` 接受可带挂载前缀的 `http://` 或 `https://` 根，并把它归一化为以 `/` 结尾。它提供打印与打开的启动 URL、`DSH_WEB_URL` 与 web 表层定位。webserver 继续提供 origin-root 路由，且从不了解挂载。`publicUrl` 配置字段发布同样的公告。

## 代理必须做什么

- **保留浏览器可见的 `Host`。** 栅栏把收到的 `Host` 与被接受的 authority 比对，因此代理应原样转发，而不要改写成监听器的地址。
- **剥离挂载前缀。** 监听器应答的是 origin-root 路由，因此对 `/ui/api/...` 的请求必须以 `/api/...` 抵达。
- **转发升级请求。** 页面发出的每个请求与 WebSocket 升级都必须连同其 `Upgrade` 与 `Connection` 头抵达监听器；代理对外提供 HTTPS 时，TLS 在其外部链路上终止。
- **改写 cookie 作用域。** 以明文 HTTP 提供服务的后端签发不带 `Secure` 的 host-only `Path=/` cookie；代理再把 `Path` 改写为挂载（`/ui/`），并仅在其 HTTPS 链路上添加 `Secure`。监听器自身提供 TLS 时 cookie 已带 `Secure`，代理只需改写 `Path`。
- **重定向裸挂载。** `/ui/` 是唯一入口：只有它把启动 token 换成会话 cookie；已持有该 cookie 的浏览器可由它或 `/ui/index.html` 取得文档，因为所提供的文档以自身目录解析 URL。对 `/ui` 的请求必须以 `/ui/` 抵达，而被剥离路径的后端无法重建该外部路径。

## 信任浏览器使用的 authority

栅栏接受 loopback、监听器自身的绑定地址，以及每个由 `--trusted-host` 点名的 authority。浏览器若以其他任何 authority 访问部署，无论代理多么正确，每个 API 调用都会得到 403，因此请用 `--trusted-host` 点名浏览器可见的 authority；用 `--public-url` 公告它只是展示，并不等于接纳。不带端口的条目匹配任意端口，适合每次绑定不同端口的隧道。栅栏只放行请求；打印 URL 中的启动 token 与签名会话 cookie 才完成认证。无论 TLS 在哪里终止都不改变这一切：证书只是向浏览器标识服务器，而不是向服务器标识浏览器。

无论是公告 URL 还是栅栏都不保护监听端口本身，因此请把端口限制在可信代理或网络内。

## 保护外部链路

可以在代理处、监听器本身或两者上终止 TLS；`--public-url` 仍只是公告。面向浏览器的 `http://` 根会明文暴露启动 token。`https://` 代理根保护浏览器到代理这一段；代理与监听器之间是否加密取决于监听器的 TLS 配置。

要在监听器上终止 TLS，请传入 `--tls-cert` 与 `--tls-key`，两者各是相对进程工作目录解析的路径：证书文件包含完整证书链，密钥文件为不带口令的 PEM 私钥。DSH 从不获取、续期或监视证书，且载体只读取一次文件，因此更换文件后需重新加载监听器或重启进程；文件缺失或无效时启动失败，绝不回退到 HTTP。浏览器使用自己的信任库与名称校验，因此证书必须覆盖你所访问的 hostname 或 IP。默认端口仍为 3080。原生 TLS 不需要代理，但代理部署与 `--public-url` 仍分别受支持。TLS 监听器会给会话 cookie 加上 `Secure`；公开部署的浏览器侧链路应保持 HTTPS，才能让浏览器回传这些 cookie。

打印的 URL 携带进程凭据，只应与预期用户分享。

[Web 应用参考](../../../packages/bundle/web-app/README.zh.md#public-deployments)说明 `--public-url`、`--trusted-host` 与 `--tls-cert`/`--tls-key` 命令行选项。在 Web profile 中，`publicUrl` 配置在 `web-runtime` 行，`trustedHosts` 配置在 [Connection 行](../../../packages/client/connection/README.zh.md)，`tls` 配置在 [webserver 行](../../../docs/subsystems/web-server.zh.md#config)。
