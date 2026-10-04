# Agent Note: 对外公告的公开 HTTP(S) Web 根

Status: implemented
Archived: 2026-09-30

[English](2026-09-07-public-web-deployments.md) | 中文

## Problem

转发网关可以把 Web GUI 暴露在共享的 HTTP(S) origin 之下，并在转发前剥离其路径前缀，因此同一个进程要同时应答 loopback `/` 与外部挂载——该挂载监听器无从得知，而该 origin 只有运维方知道。经代理转发的请求会在 `Host` 中携带这个外部 authority，浏览器信任栅栏在部署声明它之前会予以拒绝。

## Decision

`--public-url` 是可选的对外公告 HTTP(S) 应用根——`http(s)://`，可带转发前缀，不允许凭据、query 或 fragment——经由 `src/public-url.ts` 抵达 Web bundle 的 `publicUrl` 配置。它提供打印与打开的 URL、`DSH_WEB_URL` 与 web 表层定位，且不配置任何路由、客户端传输或 cookie 作用域。配置字段与 CLI flag 都只是公告：浏览器可见的 authority 必须用可重复的 `--trusted-host` 点名，栅栏才会接受它；栅栏仍逐请求校验 `Host` 与 `Origin`，因此公告既不授予身份，也不代表已认证。

公告根是首个可能携带挂载前缀的生产输入，因此启动流程加上启动 token 时不会压平该挂载。网络监听始终显式且独立——随附 CLI 拒绝通配的 `--host`——外部链路归代理所有，部署必须提供的操作发布在[公开部署指南](../../../../docs/user/guide/public-deployments.zh.md)。

## Alternatives considered

**让公告根同时决定路由与 cookie。** 单一根会提供全部浏览器 URL 与 cookie 路径，但公告随即成为请求路由决策，一个进程再也无法同时服务 loopback 与带前缀的挂载。

**把公告主机并入 trustedHosts。** 否决：公告不得改变栅栏，且 #4181 让信任始终显式。

**让后端产出感知挂载的 URL。** 配置 `<base>` 或带前缀的资源路径会要求 webserver 了解外部挂载，并重复代理已经掌握的信息。

**从请求或转发头推断外部链路。** 请求派生的 authority 可被伪造，而同时接受被剥离与未被剥离的路径会让部署变得含糊。

**从公告根或可信主机推断网络暴露。** 展示或 authority 选择不能授权打开所有网卡，因此监听选择始终显式，通配主机也始终被拒绝。

## Consequences

公告 URL 在进程附带启动 token 之前不含凭据，而配置错误的地址仍可能泄露它。HTTP 根会在无 TLS 的情况下携带带 token 的 URL 与会话 cookie，HTTPS 根则只加密浏览器到代理这一段。

公告本身不接纳任何 authority：浏览器以任何非 loopback authority 访问部署，都会一直处于栅栏之外，直到 `--trusted-host` 点名它。

## Testing

`tests/public-url.spec.ts` 覆盖 URL 校验与归一化；`tests/startup.spec.ts` 在真实 Loader 树上覆盖该 flag，包括公告主机不会改动被接受的 authority；`tests/web-app.spec.ts` 覆盖打印 URL、交接、web 表层提示词、`DSH_WEB_URL`，以及字段为 `null` 时公告 loopback；`apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts` 以 `--public-url` 在参考剥前缀代理之后启动已构建的 profile，并同时经公告挂载与 loopback 完成认证，因此 bundle patch 中的 `publicUrl` 表达式按出厂形态得到执行。
