# Agent Note: 结构化 index 注入表（webserver/index-inject 事件）

Status: implemented
Archived: 2026-09-04

[English](2026-08-19-web-index-injection-table.md) | 中文

## Problem

Web 壳的启动 HTML 需要三类注入：client-modules 的引导协议（`__ModuleLoader__` 注册队列内联脚本、parser 阻塞的 preload `<script src>`、`__DSH_BOOT__` 全局图）与 ui-theme 的首帧主题脚本。旧机制是 `webServer.tapIndex(html => html)` 字符串变换：每个注册方各自用正则找 `<head>`/`<body>` 改 HTML。静态 worker 部署（页面是构建产物、host 树在 Web Worker 里）没有「服 HTML」这一步，于是 worker 侧只能在 `/__boot__` 载荷里手工重抄同一批数据（graph + theme，经 `ctx.get` 硬掏），页面侧再用手写代码（facade 安装、theme 应用、preload 循环）把 tap 干的事重演一遍——同一份启动语义存在三份实现。

## Decision

注入面事件化、数据化：webserver 声明 `webserver/index-inject` 事件与纯数据行类型 `IndexInjection`（`global`/`script`/`script-src`/`script-preload`/`style`/`html`，在适用的行上携带定位）。想注入的插件订阅事件、往表里 push 行；每次收集（`collectIndexInjections()`）都是一次全新 emit，订阅方现读现填（模块图、主题偏好天然新鲜，无重注册问题），订阅随 fiber 销毁自动摘除。

一张表两个渲染器：served 形态 `webServer.renderIndex(html)` 确定性把行渲染进 index.html（head 行插 head 首、body 行插 body 首，全局值 JSON `<` 转义、src 属性转义）；worker 形态 `/__boot__` 载荷就是 `{ injections }`，页面侧小解释器逐行执行（设全局 / 建脚本元素 / 经 tunnel loadBundle 载外链 / 挂样式与 DOM）。`script-preload` 行在 served HTML 中渲染为浏览器预加载提示；worker 解释器忽略它，因为 `/plugins` 资源只存在于 tunnel 后方，并在实际需要时加载。行是纯 JSON 数据，这是双端等价的纪律。

`tapIndex`/`applyIndexTaps` 保留为原始 HTML 变换的逃生口，在行渲染之后执行；内部消费者全部迁走。

## Consequences

- client-modules 与 ui-theme 不再各自正则改 HTML；worker 侧 `readBootPayload` 的 `ctx.get` 手掏（clientModules、settings、theme 常量 loader.load）删除；页面侧 `installModuleLoaderFacade`、`applyBootTheme`、`PARSER_PRELOAD_IDS` 三份重抄退役。
- 顺序语义：跨订阅方按订阅注册顺序（与旧 tap 顺序一致），单订阅方内按 push 顺序；modules 自己保证队列→application preload→bootstrap script→全局的顺序。
- `__DSH_BOOT__` 的 served 渲染文本从 `window.__DSH_BOOT__ =` 变为 `globalThis["__DSH_BOOT__"] =`；已核实无已提交快照期望含此文本，无需重录。
- 新的模型可见/页面可见注入一律走行类型扩展，不再新增 tap 消费者。

## Alternatives considered

- **保留 tap 函数、worker 侧对假 document 重放**——否决：tap 是不透明的 `html => html` 闭包，worker 无法序列化或重放，除非把 DOM 仿真塞进启动链。
- **注册表式（`registerInjection(row): dispose`）**——否决于事件天然化解的两个问题：行数据会相对活状态（主题偏好、模块图）过期，除非每个生产者变更时重注册；且每个生产者多背一个 disposer。按次 emit 的拉取免费获得新鲜读取与 fiber 级清理。
- **直接删除 `tapIndex`**——否决：表还年轻，原始 HTML 变换的逃生口零成本，外部组合可能还有行类型暂不能表达的变换。
