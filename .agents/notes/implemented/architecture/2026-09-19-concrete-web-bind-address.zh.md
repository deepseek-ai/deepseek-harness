# Agent Note: 绑定一个具体的 Web 地址

Status: implemented

[English](2026-09-19-concrete-web-bind-address.md) | 中文

## 问题

Web 监听器只接受 `127.0.0.1` 或 `0.0.0.0`。通配绑定会暴露机器的每个接口，因此 bundle 在绑定时把 LAN IPv4 地址采样进 `webRuntime` 服务并追加到 `trustedHosts`，为操作者从未点名的接口授予 authority，并把推断的可达性混入配置的信任。应当只暴露一个地址的容器或工作站无法表达这一点，IPv6 地址完全不被接受，浏览器拨号已暴露地址时把它作为 `Host` 发送，却只在采样列表恰好包含它时才被接受。

## 决策

`webserver.config.host` 接受一个具体的 IPv4 或 IPv6 地址字面量，默认回环；未指定地址的所有拼写（`0.0.0.0`、`::`、`::ffff:0.0.0.0` 及其展开形式）在配置加载时被拒绝，随附的 `dsh web` 命令在任何消费者激活前对 `--host` 拒绝同样的拼写。IPv6 的 `%zone` 保留给 `listen`；通过导出的 `isWildcardHost` 与 `isLoopbackHost` 分类时只读取地址本身。

浏览器 Host/Origin 栅栏接受监听器自身的绑定 IP 字面量作为任意端口上的 `Host`，独立于 `trustedHosts` 并忽略 zone。拨号该字面量的浏览器把它作为 `Host` 呈现，该字面量不是重绑目标，Origin 与跨站检查仍然生效。解析到该地址的 DNS 名称、其他接口与代理 authority 仍需 `--trusted-host`。Connection 直接从 `webStartup` 提供方读取调用 authority；`webRuntime` 服务与 LAN 采样不再存在。

公告 URL 对 mapped 回环绑定使用 IPv4，为其他 IPv6 绑定加方括号、剥离回环 zone，并因 zone 不能出现在 URL 中而要求带 zone 的非回环绑定显式提供 `--public-url`。非回环绑定提供明文 HTTP，即使前置 HTTPS 的 `--public-url` 也会在启动时警告。`web-runtime` 是必需的启动条目，因此绑定失败会使启动失败，而不是留下一个没有监听器的静默进程。Desktop 固定 `--host 127.0.0.1`，即 Electron 拨号的地址。

## 备选方案

**继续把采样的 LAN 地址加入 `trustedHosts`。** 否决：监听器已经持有具体绑定地址。采样会授权其他接口的 authority，并把推断的可达性混入配置的信任；直接接受绑定 IP 可以保留两者的区分，无需另设运行时服务。

**只在绑定端口上接受绑定 IP。** 否决：不带端口的 `trustedHosts` 条目本就匹配任意端口，同一地址上的代理可能监听其他端口，端口对 Host 检查提供的重绑防御没有增益。

**保留 `0.0.0.0` 并给出警告。** 否决：绑定所有接口会向机器加入的每个网络暴露远程代码执行，而操作者可以逐个点名应暴露的地址。

## 影响

操作者只暴露 `--host` 点名的接口，并无需额外配置即可通过该字面量访问监听器；其他每个远程 authority 都是一个 `--trusted-host` 决定。曾绑定 `0.0.0.0` 的组合在加载时失败，并给出点名被拒绝拼写的消息。纯 IPv6 主机得到端到端支持，包括打印与打开的 URL。

[原生 HTTPS 监听器决策](2026-09-23-native-https-web-listener.zh.md)取代本说明仅支持 HTTP 传输的前提。非回环警告只适用于未启用 TLS 的监听器；绑定地址校验与 authority 接纳保持不变。

## 测试

`packages/host/webserver/tests/webserver.spec.ts` 分类通配与回环拼写并拒绝通配配置；`packages/bundle/web-app/tests/startup.spec.ts` 在消费者激活前拒绝通配 `--host`；`packages/client/connection/tests/api-request-trust.host.spec.ts` 与 `node-half.host.spec.ts` 在任意端口上接纳绑定字面量而不接纳其他 authority；`packages/bundle/web-app/tests/web-app.spec.ts` 覆盖带方括号的 IPv6 URL 与明文 HTTP 警告；`apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts` 在非回环地址与带 zone 的回环地址上启动已构建的 profile；`web-failure-matrix.expected.e2e.ts` 与 `packages/boot/app-boot/tests/app-boot.spec.ts` 报告必需的 `web-runtime` 条目。
