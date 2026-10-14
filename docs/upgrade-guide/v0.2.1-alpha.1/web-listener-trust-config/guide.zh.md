---
kind: upgrade-guide
description: "Web profile 用 `webStartup` 取代 `webRuntime` 服务与 `web-runtime` 行的 `trustedHosts` 配置，并拒绝通配监听地址。"
---

# Web 监听与信任配置迁移到 `webStartup`

[English](guide.md) | 中文

## 变更

Web profile 不再提供 `webRuntime` 服务，`web-runtime` 行也不再声明 `trustedHosts` 配置值。仍注入 `webRuntime` 的 profile、overlay 或 `--patch` 文件会等待一个永不挂载的服务，读取 `ctx.webRuntime.trustedHosts` 的表达式则会求值失败，导致必需的 Connection 无法启动。

`web-startup` 行提供唯一的 `webStartup` 服务，携带本次调用的 `--trusted-host` authority；`connection` 行通过 `ctx.webStartup.trustedHosts` 读取它们。监听 host 现在也必须是本机网卡的一个具体 IPv4 或 IPv6 地址：`host: 0.0.0.0`、`--host ::` 及其他未指定地址都会在加载时被拒绝，因为绑定所有接口会把端口暴露到网络。

## 迁移

1. 将所有需要调用信任的行的 `inject: [webRuntime]` 换成 `inject: [webStartup]`。
2. 将 `ctx.webRuntime.trustedHosts` 表达式换成 `ctx.webStartup.trustedHosts`，并删除已不存在的 `ctx.webRuntime.lanAddresses`。
3. 按 `webStartup` 改写 `connection` overlay，并把原先由 `web-runtime` 行携带的 `trustedHosts` 值并入其表达式。patch 会整体替换所匹配行的 `config`，因此必须完整重述该配置；数组值的 `!!js` 表达式要写成带引号的标量：

   ```yaml
   # before
   - id: connection
     inject: [webRuntime]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.webRuntime.trustedHosts]"
   # after
   - id: connection
     inject: [webStartup]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.webStartup.trustedHosts]"
   ```

4. 将通配 `host` 换成本机网卡的一个具体地址。所绑定的 IP 会被 Host 栅栏直接接受，无需 `--trusted-host`；代理或 DNS authority 仍需显式配置。
5. 使用迁移后的 overlay 启动：`dsh --profile web --patch ./extra.yml --no-open` 必须打印 `dsh web:` URL 行并正常服务。仍在等待 `webRuntime` 的行会让必需的 Connection 保持 pending 并报告激活失败；被拒绝的 `host` 会在加载时失败。`dsh --profile web --patch ./extra.yml --dump-config` 可在启动前打印组合后的 patch。[Web 组合包 README](../../../../packages/bundle/web-app/README.zh.md)说明这些行。
