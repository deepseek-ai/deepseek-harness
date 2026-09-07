# Agent Note: dsh web 的 config-tree boot 与 web 传输分层

Status: implemented

[English](2026-07-24-web-config-tree-boot-and-transport-layering.md) | 中文

> 范围：`dsh web` 如何组合（cordis.yml + cordis 之前的 boot 类 + 配置源），以及 web 传输如何跨包分层（网关 / 载体 / 绑定 / 图 / 开发期重载）。浏览器侧装载链归 [client 插件装载 note](2026-07-23-client-plugin-loading-model.zh.md) 所有，本组合只是它的供给方。

## 问题

`dsh web` 曾是仅剩的手工装配面：`bootHost` 逐个挂 32 个插件、config 钉死在代码里（违反 no-hardcoded-tunables），client roster 是 `web.ts` 常量，而 TUI/headless 早已是 yml 组合。传输层的职责错位与之配套：webserver 自称哑载体却认识 `__DSH_BOOT__` 图、拥有 SSE（Server-Sent Events）通道、硬编码 `/api/*` 前缀；dev 的 bundle watch 寄居在 prod 注册表里靠 `watch?` 参数开关、生命周期无主；图注册表对每次 `internal/plugin` 全量重扫；单请求失败与致命 server 错误共用一个一律退出进程的 sink。还有一个用户可见缺陷：web 路径从不加载 `$DSH_HOME/.env`，`DSH_HOME=… dsh web` 读不到自定义 home 下的 API key。

## 决策

**组合结果是一棵平铺配置树。** `apps/cli/config/base.cordis.yml` 与 `apps/cli/config/web.cordis.yml` 共同持有全部行——host 运行时（32 行）、`api-gateway` 行、`webserver` 行、`dsh.client` 行（浏览器 roster；modules 行同时是 host 行）。不做主干 bundle：每插件一行、每个 config 字段 yml 可改。这一立场后来推广到全仓：两个 surface 共享的配置项被抽取进 `apps/cli/config/base.cordis.yml`，各 surface 则收敛为一份 overlay（[共享 base overlay](../../archived/simplification/2026-07-29-shared-base-config-overlays.md)）。`dsh-client-hmr` 行是普通的始终启用的 bundle 行（最初由 `--dev` 在代码中追加；该旗标已废除）。行序无装载语义；激活由服务可用性驱动。共享 audit 会拒绝没有 fiber 的 import、仅等待失败的 fiber 以恢复原始激活错误，并报告让 fiber 停在 `PENDING` 的服务；抛出错误前，审计会通过一个进程级检查点标记这些 rejection 的确切原因，从而让 `installFailLoud` 将 Loader 的重复通知合并为一次，而无关的未处理 rejection 仍然致命。Node app-boot 产物内嵌 `@cordisjs/plugin-include`，但将 `@cordisjs/plugin-loader` 保持为外部依赖，因此 include 的 `EntryTree` 与 host 会绑定到同一个 Loader peer，而不会让一棵配置树横跨两个 Loader 实现。

**boot 胶水由两个类组成。** `AppCLIEntry`（apps/cli）与 `AppWebEntry`（壳内核）只持有那些必须独立于 cordis、提前存在的东西：argv 事实、合成的 patch 集、解析出的 boot manifest（元数据清单）、模块系统实例、loading 页句柄——其余一律进插件。`AppCLIEntry.run()` 三段：分层 env（ambient > cwd `.env` > `$DSH_HOME/.env`，顺手关掉上述缺陷）→ patch 合成 → Loader include boot 加 activation audit。`AppWebEntry.run()` 在浏览器侧镜像它：把 `window.__DSH_BOOT__` 解析成 `BootManifest`（双视角：npm 包行给模块表、cordis 插件行给 entry 组合；畸形 wire 大声抛）、建模块系统、渲染 loading 页、immediately 层预取与 Context/Loader 准备并行、**create entry 之前等预取齐**（物化是 `tree.import` 的同步 require，不受 fiber inject 等待保护；i18n → runtime/client 这类跨包 require 边要求 immediately 层工厂全部注册完——否则有实测 10–25% 的 boot 竞态）、收编 modules entry、逐一创建图行、settle、sweep。

**每个配置源有唯一声明位置。** 组合包 yml 值是工程默认，Settings 分节是可写的用户偏好，CLI（命令行界面）flags 面向其归属的启动器配置行，env 值则通过 yml `!!js` 表达式进入。patch 会整体替换一行的 config。解析后的前端 `distIndex` 通过同一条 patch 通道作为组装事实传递。与传输无关的提供方／模型默认值归 `ctx.agentDefaultModel` 所有；[直接 headless 入口](../../archived/architecture/2026-08-09-headless-direct-core-entry-point.md)与 Session Controller 消费同一份状态。

**传输职责各有明确 owner。** `dsh-client-connection` 持有 `/api` 路由、请求与响应 envelope、浏览器认证、Host/Origin 检查、精确 Fetch 路由注册以及共享 Typert interceptor 席位。`dsh-api-gateway` 持有类型化 Remote 分发和多路复用 WebSocket。`dsh-host-webserver` 是朴素的路由注册插件：`WebServer` provide `ctx.webServer`（`register(route) → disposer`、重复 pattern 即抛、`renderIndex` 渲染——先结构化 `webserver/index-inject` 行、后原始 `tapIndex` 按注册序应用——与 `port`），激活即 listen，单请求失败时答 400 并记日志，且不认识任何 harness 概念。其基于 socket 的 Node HTTP 入口可以通过受维护的中间件应用已配置的 gzip，无需新增响应写出服务方法或改变 route owner；Web Worker 隧道传递 identity 字节。modules node 半（`ClientModuleRegistry`，provide `ctx.clientModules`）持有单包增量扫描、bundle 路由、启动注入行与 `onRebuilt`/`onGraphChanged` 通知。HMR（热模块替换）node 半通过 `fs.watchFile` membership 与 `/plugins/events` SSE 路由持有开发期重载。

**包出口纪律。** modules 包只暴露 `.`（node 半）与 `./client`（完整浏览器半：`ClientModuleSystem`、`parseBootManifest`、收编插件面）——不设专用子路径；wire 类型经根出口 re-export 给 host 侧消费方。收编握手：内核在 cordis 之前把建好的实例写入 `window.__DSH_MODULES__`；`./client` 的 apply 读取该槽位（缺少时显式抛错）并 provide `ctx.modules`。

## 后果

- 重组一个 web 部署 = 改 yml/patch；退役件（`mountWebPlugins`、`CLIENT_PACKAGES`、`createHostWebPluginRegistry`、`startWebServer`、webserver 的图/SSE/api 知识）全部删除。
- [Headless 是直接 core 入口](../../archived/architecture/2026-08-09-headless-direct-core-entry-point.md)：其随附 profile 包含共享的 base Agent 能力，并省去 Host、HTTP、Web 与浏览器层。本笔记的传输划分是浏览器 surface 的约定。
- 一个值得记住的 TypeScript 坑：`declare module 'cordis'` augmentation 所在文件若**没有任何 cordis import**，会被降级成独立模块声明，无声打散全程序的 `Context` merge（`ctx.on`/`ctx.effect` 全程序消失）。用 `import type {} from 'cordis'` 锚定。

## 考虑过的替代方案

| 弃案 | 一行理由 |
|---|---|
| 专门的 `dsh-host-profile` 受体包 | 用户模型状态归 Settings 支撑的 `ctx.agentDefaultModel` 所有；额外的 Host 受体会重复归属，并排除直接入口 |
| 运行时里的 `assembly` 垫层插件（provide `apiHandler`） | Connection 已在传输边缘把 Remote interception 与功能自有的精确 Fetch 路由组合成一个 handler |
| 全量重扫与增量扫描并存 | 两条实现两份语义；单包路径足以覆盖激活初扫 |
| modules 包特设 `./impl` 出口 | 出口不统一；标准 `./client` 承载完整浏览器半 |
| dev overlay / `cordis.dev.yml` | 一套 yml；`!!js` 无法条件化行存在性，`--dev` 追加一行就是全部差异 |
| env 进映射表 | 同一字段将出现 env/json 双源，需再发明优先级 |
| create 不等预取（以 `arrive()` 去重为安全依据） | 被 10–25% boot 竞态证伪：在途去重只覆盖同包双拉，不覆盖跨包同步 require 边 |
| json 直接当 loader patches 文件 | json 键名将耦合 yml 行结构，profile 编写者要懂 cordis |
| 公开响应写出方法并让每条 route 选择接入 | 响应编码属于 Node HTTP 策略；经 `ctx.webServer` 暴露会让每个 route 所有者与测试替身依赖这项策略 |
| 手写 gzip 协商与流生命周期 | 受维护的中间件已经处理协商、媒体类型筛选、响应头改写、背压与阈值行为 |
