---
description: "面向用户与维护者的 web GUI 客户端模块系统说明：宿主侧组合启动图并提供插件 bundle，浏览器侧按需加载，用于组合或排查客户端插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-modules

[English](README.md) | 中文

## 概述

`dsh-client-modules` 把插件包的 `dsh.client` 声明变成可加载的浏览器 bundle：宿主半侧扫描已启用的 Loader 条目并组合启动图，可用的 Web 载体通过 `/plugins` 提供每个 bundle，由 shell 持有的载体则通过 `fetchBundle()` 分派完全相同的 bundle 响应。浏览器半侧按需惰性加载这些 bundle。插件 bundle 惰性执行——运行 bundle 只注册 factory，模块副作用在物化时运行——因此插件首次被使用之前什么都不会运行。这里的一切都是浏览器内核机制；模型永远看不到它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

声明类型使用 [`DshClientManifest`](../../util/package-manifest/README.zh.md)。Client-modules 负责 JSON 校验和归一化的启动图。

组合或构建浏览器客户端插件时使用它：本包把包的 `dsh.client` 声明变成可加载的浏览器 bundle，无需任何逐插件接线。它随 web 组合激活；外壳在任何插件运行前启动它。

### 声明客户端插件

浏览器插件包在其 `package.json` 中以 `platform: 'web'` 声明 `dsh.client`，导出 `./client` bundle，并在 `dsh.client.external` 下列出任何基座之外的模块请求。宿主半侧把每份声明变成 `/plugins` 下提供的 bundle，并让动态提供方先于其消费方加载。

### 浏览器加载什么

application combo 脚本在启动时注册插件 factory；模块主体仍保持惰性，只在首次 import 或物化时运行。共享 combo URL 的 row 共用一个进行中的脚本任务。HMR 会让一条发生变化的 row 改用带 revision 的单资源 combo URL。`<id>/client` 与裸 id 解析到同一组导出，因为插件 bundle 就是其包的客户端半侧。

### 共享模块

外壳播种一张冻结模块表（`PLATFORM_MODULES`：React、Cordis 与静态 UI 库）；每个动态 bundle 都精确针对该基座解析其 external。`dsh.client.external` 只添加基座之外的精确请求，每个请求由其命名的动态包 row 或精确静态表键回答。纯类型 import 会被擦除，不产生请求。组合阶段会拒绝畸形请求、缺失提供方、自请求与同步请求环。

### 构建要求

宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；缺失 bundle 会以一条构建说明加包／路径列表的方式让激活大声失败。源码启动会把宿主侧导入映射到 TypeScript 源码，但仍消费这一构建后的客户端导出。本包自身不接受任何插件配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释模块系统的构建方式；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

本包是双面孔：node 半侧是组合与服务端（`ctx.clientModules`，`ClientModuleRegistry`），浏览器半侧是加载端（`ctx.modules`，`ClientModuleSystem`）。两者之间的协议是启动图——以 `window.__DSH_BOOT__` 注入的 `WebBootEntry` 行，`<` 已转义，插件控制的字符串无法逃出 script 元素。vendored Loader 唯一的消费点是 `EntryTree.import`，因此模块系统就是「插件代码如何到达」的唯一可替换实现。

### 惰性 CJS 模型

执行插件 bundle 只注册其 factory；每个模块主体副作用（包括 CSS 注入）都位于 factory 闭包中，在物化时运行（`factory(require)` → 导出，在 `loadCache` 中记忆化）。factory 依赖另一个已注册但未物化的模块时会递归物化它；require 循环会抛出异常，因为 factory 形式的 CJS 无法提供部分导出。解析会依次检查平台 seed 表、已记忆记录、启动图 row 与已注册 factory；其他情况一律抛错。交给 factory 的同步 `require` 使用相同顺序，但不含异步图 row 加载，并把观察到的边记录到模块记录中。

### 增量组合

node 半侧逐包增量扫描——没有全量重扫路径。每次 `internal/plugin` 发出都会把该 fiber 的 entry 名标脏；一个微任务 flush 会把每个脏名与当前 loader 条目对账，激活 pass 播种同一脏集合并同步 flush，因此首次扫描与稳态共用同一实现。包元数据按 Loader specifier 与所属 tree base URL 缓存至重启，解析出的 manifest 包名作为浏览器模块身份。若不同的 active Loader source 解析到同一包名，组合会失败；移除冲突来源后，剩余来源无需重启 fiber 即可接替。bundle 内容变更只能通过 `rebuilt()`（HMR 钩子）进入图。

node 半侧会在发布前快照每个客户端 bundle 及其现有 source map。它把资源分组到 `/plugins/??...&rev=...` combo URL：modules row 使用一个 bootstrap combo，其余 row 使用一个或多个 application combo；每个阶段都会在 URL 超过 3 KiB 之前分区。每个 combo map 都是 Indexed Source Map v3，并在可用时使用作者提供的 section，否则为已打包 bundle 生成 identity section。初始逐插件 revision 使用进程 nonce，所以启动时不哈希每个插件；HMR 只哈希被报告为已变化的产物。已公告响应不可变；未知组合或 revision 返回 404。

### 启动清单注入

宿主贡献结构化 index 行，并向 `<head>` 注入：`window.__ModuleLoader__` queue facade、每个 application combo 的提示性 preload、阻塞 parser 的 bootstrap combo 脚本，然后才是外壳读取前的启动图。Web 载体把这些行渲染进 index 响应；由 shell 持有的载体则可以在没有 Web server 时渲染同一批行。facade 的 `create()` 物化 modules bundle、把构造委托给其 `createClientModuleSystem` 导出，并让同一 facade 进入 live registration 模式。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | node 半侧：`ClientModuleRegistry`、扫描、产物快照、可选 combo 路由、结构化 index 行 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器半侧：bootstrap 导出、`ctx.modules` 登记 |
| [`src/client/system.ts`](src/client/system.ts) | `ClientModuleSystem`：加载／物化／失效机制 |
| [`src/client/manifest.ts`](src/client/manifest.ts) | 协议类型与启动清单解析 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当模块约定不够用时阅读以下页面：子系统参考、启动插件树的外壳，以及图背后的客户端编写规则。

- [客户端模块子系统](../../../docs/subsystems/client-modules.zh.md)——web 插件表、`WebBootGraph` 协议与 bundle 路由。
- [Web 启动内核](../web/README.zh.md)——创建模块系统并启动插件树的外壳。
- [客户端 HMR 驱动器](../hmr/README.zh.md)——在重建 bundle 上驱动 `invalidate`/`prefetch` 的重载链路。
- [客户端编写规则](../AGENTS.md#shared-modules-and-the-module-graph)——共享模块基座与 `dsh.client.external` 语义。
- [客户端组地图](../README.zh.md)——本包所属的浏览器半侧。

-----

<a id="model-experience"></a>
## 模型体验

无。模块 loader 属于浏览器侧内核机制，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明模块系统不做什么。它们是当前包约束，不是任务积压。

- **有意采用扁平模块图**——每个 bundle 是一个模块节点，其边只指向表中的叶节点；接口（`loadCache`/`edges`/`invalidate`）已经支持通用模块图，因此可以改变 externalization 粒度而不更改接口。
- **自身不维护卸载记录**——样式移除与 fiber 拆卸顺序属于 HMR 驱动器（`@deepseek-ai/dsh-client-hmr`）；loader 只在每条记录中登记其拥有的样式标签 id。
- **快照式提供会保留产物字节**——Host 在内存中保留每个 bundle、可选 source map、生成的单资源响应和当前启动 combo 响应；HMR 还会保留上一代启动响应。内存会随已组合客户端产物增长为数份副本，以换取不可变响应和一代竞态容忍。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
