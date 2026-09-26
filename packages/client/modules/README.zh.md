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

声明类型使用 [`DshClientManifest`](../../util/package-manifest/README.zh.md)。Client-modules 校验 JSON，并持有归一化后的启动图。

组合或构建浏览器客户端插件时使用它：本包把包的 `dsh.client` 声明变成可加载的浏览器 bundle，无需任何逐插件接线。它随 web 组合激活；外壳在任何插件运行前启动它。

### 声明客户端插件

浏览器插件包在其 `package.json` 中以 `platform: 'web'` 声明 `dsh.client`，导出 `./client` bundle，并在 `dsh.client.external` 下列出任何基座之外的模块请求。宿主半侧把每份声明变成 `/plugins` 下提供的 bundle，并让动态提供方先于其消费方加载。

### 浏览器加载什么

application combo 脚本只携带每个插件的 `client.js` 入口，并在启动时仅注册一次这些 factory；模块主体仍保持惰性，只在首次 import 或物化时运行。经 tsdown 拆分的源码 `import()` 会编译为 `require.async("./client.<name>.js")`；只有执行该表达式时，对应的带版本同级脚本才会到达。共享 combo URL 的 row 共用一个进行中的脚本任务。`<script>` 加载失败的 combo 会再请求一次；加载成功但没有注册某条 row 的 combo 绝不会重新执行，因为批量脚本按顺序注册各个包，重放会在第一个重复注册处停止。两种情况下，每条仍缺失的 row 随后加载自己的单资源 combo URL，因此一个失败的 batch 对每条缺失 row 最多花费三次请求，且不影响它已经注册的 row。模块系统按 row 记录最后一次 import 失败（传输、注册、依赖级联或 factory 执行）；Web 启动审计按条目报告该文本。HMR（热模块替换）会让一条发生变化的 row 改用带 revision 的单资源 combo URL。`<id>/client` 与裸 id 解析到同一组导出，因为插件 bundle 就是其包的客户端半侧。

### 插件动态组合

已打开的 Web 页面通过 HMR 传输跟随 Host 的完整模块图。启用普通插件会添加其 Loader 条目；停用会移除条目，并在其异步 effect 完成清理后回收未使用的模块与样式。再次启用会加载一个带样式的实例。其他 Loader 贡献方的条目及活动条目仍需使用的共享模块会保留。「设置 → 插件 → 插件列表」显示当前页面的同步失败，并提供不改变 Host 启用状态的重试。

### 共享模块

外壳初始化一张冻结的模块表（`PLATFORM_MODULES`：React、Cordis 与静态 UI 库）；每个动态 bundle 都精确针对该基座解析其 external。`dsh.client.external` 只添加基座之外的精确请求；系统会将每个请求解析到其指定的动态包 row 或完全匹配的静态表键。纯类型 import 会被擦除，不产生请求。组合阶段会拒绝畸形请求、缺失提供方、自请求与同步请求环。

### 构建要求

宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；缺失 bundle 会明确导致激活失败，并给出一条构建说明及包／路径列表。源码启动会把宿主侧导入映射到 TypeScript 源码，但仍消费这一构建后的客户端导出。本包自身不接受任何插件配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释模块系统的构建方式；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

本包分为两侧：Node 半侧负责组合与提供（`ctx.clientModules`，`ClientModuleRegistry`），浏览器半侧负责加载（`ctx.modules`，`ClientModuleSystem`）。两者之间的协议是启动图——以 `window.__DSH_BOOT__` 注入的 `WebBootEntry` 行，`<` 已转义，插件控制的字符串无法逃出 script 元素。vendored Loader 唯一的消费点是 `EntryTree.import`，因此模块系统就是「插件代码如何到达」的唯一可替换实现。

### 惰性 CJS 模型

执行插件 bundle 只注册其 factory；每个模块主体副作用（包括 CSS 注入）都位于 factory 闭包中，在物化时运行（`factory(require)` → 导出，在 `loadCache` 中记忆化）。factory 依赖另一个已注册但未物化的模块时会递归物化它；require 循环会抛出异常，因为 factory 形式的 CJS 无法提供部分导出。解析会依次检查平台 seed 表、已记忆记录、启动图 row 与已注册 factory；其他情况一律抛错。交给 factory 的同步 `require` 使用相同顺序，但不含异步图 row 加载，并把观察到的边记录到模块记录中。它的 `require.async` 操作返回 Promise，并在一次性物化编译器生成的包内 chunk 前先获取该 chunk。该协议只支持自包含 chunk：入口与 chunk 产物不能同步 require 另一个相对 `client*.js` 产物。

### 增量组合

Node 半侧逐包增量扫描——没有全量重扫路径。每次发出 `internal/plugin` 事件时，系统都会把该 fiber 的 entry 名标脏；微任务 flush 会把每个脏名与当前 loader 条目对账，激活 pass 会初始化同一个脏集合并同步 flush，因此首次扫描与稳态共用同一实现。包元数据按 Loader specifier 与所属 tree base URL 缓存至重启，解析出的 manifest（元数据清单）包名作为浏览器模块身份。若不同的 active Loader source 解析到同一包名，组合会失败；移除冲突来源后，剩余来源无需重启 fiber 即可接替。bundle 内容变更只能通过 `rebuilt()`（HMR 钩子）进入图。

Node 半侧会在发布前快照每个 `client.js` 入口，并在不构建响应 body 的情况下创建 combo descriptor。它把资源分组为 combo 路由键（`/plugins/??...&rev=...`）：modules row 使用一个 bootstrap combo，其余 row 使用一个或多个 application combo；每个阶段都会在 URL 超过 3 KiB 之前分区。启动图与批次描述符携带同一路由键的应用目录相对形式（`plugins/??...&rev=...`），浏览器文档会按其自身挂载解析它，而响应表仍以绝对路由为键；source-map trailer 则相对该 combo 脚本自身目录解析。脚本 body 在首次 `GET` 时只组合一次，并以对应的 map 引用结尾；map 文件则在首次 map `GET` 时单独读取、校验并组合，`HEAD` 不会物化任一 body。Host 不扫描也不预加载同级 chunk：精确的 `/plugins/<package>/client.<name>.js?rev=<rev>` 请求会读取并缓存该脚本，其 map 仍会等到 map URL 被请求后才计算。浏览器从所属 row 派生出该 chunk 引用，因此它同样是文档相对形式（`plugins/<package>/client.<name>.js?rev=<rev>`）；chunk 脚本携带的 map trailer 则是裸文件名 `client.<name>.js.map?rev=<rev>`，由该脚本自身目录解析。每个 combo 或 chunk map 都是 Indexed Source Map v3，并在可用时使用作者提供的 section，否则为已打包 bundle 生成 identity section。首次发布与 HMR 都从入口的 `mtimeMs`、`ctimeMs` 和大小派生逐插件 revision，不对产物内容求哈希。状态变更时间用于区分保留 mtime 和大小的重写。未变化的产物因此会跨 Host 重启保持 revision，SSE 重连不会替换其浏览器插件。共享预设会在该包所有输出写完后标记 `client.js`，因此仅 chunk 发生重建也会更换 owner revision，无需 Host 扫描 chunk。combo revision 从有序 row revision 派生。已公告的 combo 响应与已请求的 chunk 响应会跨无关图重组保持不可变；未知资源或 revision 返回 404。

### 启动 manifest 注入

bundle 路由随注入的 `webServer` 生命周期注册：服务就绪时注册，服务被替换时移除并重新注册。模块组合与 `fetchBundle()` 在没有 Web server 时仍可用。

宿主贡献结构化 index 行，并向 `<head>` 注入：`window.__ModuleLoader__` queue facade、每个 application combo 的提示性 preload、阻塞 parser 的 bootstrap combo 脚本，然后才是外壳读取前的启动图。Web 载体把这些行渲染进 index 响应；由 shell 持有的载体则可以在没有 Web server 时渲染同一批行。facade 的 `create()` 物化 modules bundle、把构造委托给其 `createClientModuleSystem` 导出，并让同一 facade 进入 live registration 模式。外壳把返回的系统装成自身 Loader 的 `internal`；modules 插件将该实例发布为 `ctx.modules`，因此不同 Cordis 树不会通过模块级全局状态选择实例。

### 条目所有权

`ClientEntries` 记录启动时创建的条目，并在同一个 Loader 上串行执行完整图更新、重试和代码重载。本地代际阻止旧下载在目标条目或代码变化后挂载；目标相同的快照共用进行中的加载。新增模块使用单资源 URL，不会重新执行可能重复注册现有 factory 的启动 batch。Factory 在条目创建前就保留产物 revision；图更新会在导入消费者前丢弃未归属条目的陈旧 factory、其样式和失败的到达目标。清理会保留每个剩余 Loader 条目的已声明及已观察到的传递模块依赖。其可观察状态不导入运行时库，因为 modules bootstrap 在平台种子可用之前物化。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Node 半侧：`ClientModuleRegistry`、扫描、产物快照、可选 combo 路由、结构化 index 行 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器半侧：bootstrap 导出、`ctx.modules` 登记 |
| [`src/client/system.ts`](src/client/system.ts) | `ClientModuleSystem`：加载／物化／失效机制 |
| [`src/client/entries.ts`](src/client/entries.ts) | 页面条目对账、重试与代码替换 |
| [`src/client/entry-lifecycle.ts`](src/client/entry-lifecycle.ts) | 通过注册表清理 Loader fiber，回收模块自身样式 |
| [`src/client/manifest.ts`](src/client/manifest.ts) | 协议类型、启动清单解析与 `dsh.client` 声明解析器 |

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

- **基于元数据的 revision**——revision 标识文件系统代际，而非内容相等性。仅元数据变化也可能重载插件；mtime、ctime 和大小都无法反映的变化无法区分。
- **有意采用扁平模块图**——每个 bundle 是一个模块节点，其边只指向表中的叶节点；接口（`loadCache`/`edges`/`invalidate`）已经支持通用模块图，因此可以改变 externalization 粒度而不更改接口。
- **Bootstrap 与代码替换限制**——页面保留 modules bootstrap 和静态平台模块的身份。移除或替换 bootstrap 需要刷新页面；动态替换请求会报告页面本地错误，并保留其 fiber 与导出；替换包代码及其所有现有消费者不属于普通启停同步。
- **惰性提供会保留已请求的 body**——Host 在内存中保留每个 bundle 与惰性响应计划；脚本或 map body 在首次 `GET` 后保留缓存，HMR 还会保留上一代启动响应。内存仅随客户端实际请求的响应 body 增长，同时保留一代竞态容忍。
- **从未请求的上一代 map 会读取当前 map 文件**——combo revision 跟踪可执行 bundle，而不跟踪调试产物。若 HMR 在保留的旧 URL 首次收到 map `GET` 前重建 map，该响应会把当前 authored map 与旧 bundle offset 组合；在重建前请求 map 会固定该 URL 的响应。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
