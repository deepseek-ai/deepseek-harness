# Agent Note: 客户端壳分层与动态包边界

Status: implemented

[English](2026-08-15-client-shells-and-dynamic-packages.md) | 中文

> [Client 插件装载模型](2026-07-23-client-plugin-loading-model.zh.md)负责模块到达、Cordis 生命周期和 HMR。本 Note 负责包归属、构建 face、共享模块请求及 npm 依赖声明；这些决定取代装载 Note 中较早的包分类和 import 边规则。

## Problem

Client npm 依赖区段描述安装和开发关系，但不能可靠描述 bundle 内容。把 `dependencies`、`peerDependencies` 或 `devDependencies` 当作隐式 bundler 指令，可能内联本应共享的 React 或 workspace 身份，也可能让构建后的库携带未解析子 import，却没有交给预期的宿主组装。

浏览器应用还包含不同角色：HTML/Vite 编译入口、不依赖框架的 Cordis 启动内核、静态装配库，以及由 Loader 治理的插件。HTML 提前执行属于到达策略，不定义包类别。Modules 必须先于 Vite 主模块到达，同时继续使用普通 `lib/client.js` 产物和动态图 row。

共享 UI 库仍向大量消费者暴露同步 TypeScript 与 React 实体。在这些实体进入 service 或 slot 前，形式上把库改为动态 entry 只会保留实体耦合，并模糊外壳必须共享的模块身份。

## Decision

### 分层与构建形态

| 层 | 成员 | 职责 | 构建与加载形态 |
| --- | --- | --- | --- |
| Web 编译壳 | `apps/web` | 拥有 `index.html`、Vite 配置、dist chunk 和静态资源 | 从已构建 package export 组装最终浏览器产物 |
| 启动内核 | `packages/client/web` | 拥有纯 DOM 启动页、模块系统接线、Cordis settle 和 renderer handoff | `staticLinked` `lib/index.js`；无 `dsh.client` row |
| 静态装配库 | Cordis、`ui-primitives`、`ui-slots` | 提供共享模块身份和直接实体 API | ESM `lib/index.js`，由 Vite 合并拆分；不是 Loader entry |
| 模块自举包 | `packages/client/modules` | 提供 client 模块表及其 Cordis wrapper | 带一个普通 `lib/client.js` 的动态包；host 提前送达其 factory |
| 动态 client 包 | connection、`ui-renderer`、主题和功能插件 | 通过 Cordis service、slot 和 effect 参与应用 | 声明 `dsh.client`，产出自注册 `lib/client.js`，并保留 host graph entry |

`packages/client/web` 把 Cordis 保持为 matching peer 与开发依赖，并把 modules 和静态 UI 包作为开发期编译输入。`apps/web` 消费已构建 package export，不通过 alias 读取 workspace 源码。

`staticLinked` 预设让 `lib/index.js` 中每个 bare specifier 保持 external import，并在旁边输出相对 CSS 资产。Vite 宿主负责解析和去重这些 import，并决定最终 chunk 边界。静态库不会把宿主打包策略复制进自身产物。

### 共享模块请求

动态浏览器 bundle 会隐式 external 统一基座：`PLATFORM_MODULES` 命名由外壳播种的 React、Cordis 和静态 UI 身份，`PRELOADED_CLIENT_EXTERNALS` 则为必须先于 shell 启动到达的动态身份预留，当前为空。包只在精确请求基座外实体时使用 `dsh.client.external`。纯类型 import 会被擦除，不产生请求；允许的第三方实现库保留为 bundle 私有内容。

请求只有两种提供方：

1. 请求所命名的 dynamic package row；末尾 `/client` 会别名到该 package row。
2. 外壳静态模块表中的精确 key。

不存在通用 `dsh.client.provide` 别名机制。动态 row 和静态 key 已穷尽实际提供方，Cordis service provide 与此相互独立。图组合会拒绝畸形或缺失请求、自请求和同步请求环，并把动态提供方排在消费者之前。`ClientModuleSystem.import()` 与 `prefetch()` 会在消费者能够物化前递归登记这些动态提供方的 factory，因此网络时序无法破坏同步请求图。

### Parser 预载与 React 移交

Modules Node 半按以下顺序向实际返回的 HTML 注入启动协议：

1. 以 queue 模式安装 `window.__ModuleLoader__`，包含 `pendingQueue`、`load()` 与 `create()`。
2. 开始预加载所有带 revision 的 application combo URL，其中包含 modules 之外的 row。
3. 执行所有阻塞式 bootstrap combo URL；当前其中包含普通的 modules factory registration。
4. 赋值 `window.__DSH_BOOT__`，其中包含全部调度描述及每个 row 的单资源 HMR combo URL。
5. 执行 Vite 主模块。

Bootstrap combo 当前只登记 modules factory。启动内核把原始图与外壳 seed 传给 `__ModuleLoader__.create()`。Facade 移除 modules registration，用拒绝全部 external 的 `require` 函数将其物化，再调用其 `createClientModuleSystem` 导出。Modules bundle 解析图、构造并返回 `ClientModuleSystem`、把自身 exports 缓存为 modules row，并把同一 facade 切换到 live 模式。内核把该实例装成自身 Loader 的 `internal`，modules 插件从这里读取并提供 `ctx.modules`。因此 modules client face 保持零 external 的自举要求，也没有模块级系统身份。

Host 发布 graph 与 combo descriptor 时不会拼接响应 body。每个脚本 URL 共用一个惰性 Promise，在首次 `GET` 时拼接捕获的 bundle 字节并追加对应的 map URL；每个 map URL 使用另一个惰性 Promise，只在首次 `GET` 时读取并组合 source map。`HEAD` 不触发任一 body。Web URL 仍由 Loader 结算和 required-entry audit 控制，但这个就绪点不会物化 combo body；index 请求读取当时的最新 graph。

Theme 的 Host 贡献会前置到 index 收集顺序。head 中的 CSS 选择初始文档画布调色板，`system` 偏好直接使用 `prefers-color-scheme`；body 脚本在加载页面和应用模块之前应用既有的调色板属性与字号变量。

`immediately` 层级完成 factory 注册后，内核创建全部 Loader entry，等待 Cordis 静止，并要求每个 fiber 都进入 ACTIVE。随后调用 `ctx.uiRenderer.mount(container)`。动态 `ui-renderer` 包拥有 React、slot 渲染、已有启动 DOM 的 hydrate 和 React root 生命周期；启动内核与失败页保持 React-free。

### 依赖声明

每个 Client 包都把 Cordis 保持为范围一致的 `peerDependencies` 和 `devDependencies`；Cordis 是唯一的 peer。Browser import、类型引用、模块扩充与 `dsh.client.inject` 都是开发输入，因为 Client 构建与发布 profile 会提供其运行期身份。同时发布 Host 入口的包把该入口的运行期 value import 放在 `dependencies`。[发布依赖门面](../process/2026-08-26-published-dependency-faces.zh.md)负责包发现、例外与显式 Host 名册。

普通安装库仍放在 `dependencies`：动态构建可以内联私有实现，而 `staticLinked` 库会保留 bare import 交给最终宿主。各构建 face 独立决定 external，不由 npm 区段推导。发布文件列表覆盖产物实际可达的每个运行期入口、相对资产和声明文件。

`verify-package-dependencies` 检查并修复依赖区段。`verify-client-packages` 检查构建形态、parser preload 对齐、共享模块请求和模块图无环性。仓库 publint pass 负责检查发布闭包。

## Alternatives considered

**立即把所有 client 包改为动态插件。** `ui-primitives` 与 `ui-slots` 仍提供同步实体，且没有独立 service 或 slot 生命周期；只加 manifest 声明不会移除这些 import。

**为 modules 生成单独的 `client-static.js`。** 该包仍是动态图 row 和 Cordis 插件，只有 factory 提前到达。第二份产物会把宿主策略编码进文件名，并让同一源码产生两个运行期产品。

**把全部共享模块编进 Vite entry。** 这会让业务插件失去部署组合与插件级替换能力，包括 renderer 和主题。

**保留通用模块 provider 声明。** Package row 和精确静态 key 已命名全部提供方；别名会增加另一套归属协议，却没有第三种供给来源。

**在 `apps/web/index.html` 中硬编码预载 URL。** URL 与 `rev` 属于 host 当前 graph。改写实际返回的 HTML 才能让 queue、bundle URL 和 manifest 使用同一 graph revision。

## Consequences

内部 DSH 关系仅放在开发区段时，bundle 内容仍保持稳定，因为每个构建 face 都直接声明 external。静态库继续由宿主装配，动态包则保留统一产物与生命周期治理。发布 profile 拥有完整 Client 包名册，因此各 Client 包不再要求 npm 通过 peer placement 重复求解同一张图。

启动协议依赖 modules 的 package id，modules 还必须保持运行期自包含。Combo 生成保留其普通 package 产物，并为其他全部 row 提供一条共享初始传输；HMR 使用同一条路由，并只把该 row 作为资源。响应 body 的延迟生成会把拼接移到首次访问，而 map 的独立延迟生成会让仅供调试器使用的工作不进入脚本交付路径。缺少 bootstrap registration 会在 Cordis 启动前失败；后续插件 import、apply 与 service 等待失败仍由启动页的 ACTIVE 扫描呈现。

外壳消费已构建 `lib/` 产品，因此在相关 build 或 watcher 运行前，源码与浏览器产物可能漂移。仅源码 typecheck 通过不能证明实际服务的应用使用同一份代码。

两个静态 UI 库仍是明确例外。把其中任一项转换为动态包时，必须在同一变更中把全部实体消费者迁移到 service 或 slot，并从静态 seed 删除对应身份。
