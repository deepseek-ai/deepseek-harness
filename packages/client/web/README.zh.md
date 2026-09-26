---
description: "面向用户与维护者的 web GUI 启动内核说明：客户端插件树的两阶段启动、无框架启动页与共享模块表，用于组合或排查浏览器应用。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

## 概述

`dsh-client-web` 启动 web GUI：它先从 Host 提供的启动图加载客户端模块系统，再在应用挂载前激活每一个客户端插件，因此只有当所有插件都就绪时完整 UI 才会出现。无框架启动页会逐 entry 报告状态，因此失败的 bundle 或插件保持可见，而不是白屏。它还定义共享模块表（`PLATFORM_MODULES`），每个动态 bundle 都依据它解析 external。模型永远看不到本包。

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

组装浏览器应用时使用它：`apps/web` 的 Vite 入口对挂载点运行 `new AppWebEntry(container).run()`，启动页会在激活过程中向用户展示进度。普通浏览器调用方不传任何选项。默认使用预注入的页面传输，除非提供 `seams` 覆盖：当 `globalThis.__DSH_TRANSPORT__` 携带 `loadBundle` 时，模块阶段将其采纳为 bundle 传输并跳过 `immediately` 层级的 HTTP 预取，而显式 `seams` 仍然优先（例如外部 `<script>` 执行无法到达页面上下文的 jsdom 测试）。

静态应用页面在入口运行前安装 `__DSH_BOOT_READY__`。`run()` 等待期间会立即显示启动页；页面所有者通过 `applyIndexInjections`（也从 `./injections` 导出）应用 Host 注入项，并在所有脚本完成后兑现延迟对象。延迟对象拒绝时显示启动失败；若调用方提供 `run(onFailure)`，则由外部呈现错误并保留加载页。Desktop 使用该回调请求原生恢复。Desktop 与 WebWorker 共享注入解释器；服务端 `tapIndex` HTML 转换仅适用于服务端提供的文档。

外壳基础样式会在支持的浏览器中为普通内容自动添加中西文间距。语义化代码以及终端、diff、读取和搜索输出容器会保留源码中的原始间距和列对齐；不支持 `text-autospace` 的浏览器会忽略这两项声明。

### 启动过程是怎样的

启动分两个阶段：模块阶段接纳 parser 已加载的 bootstrap 批次，从 Host 提供的启动图构建模块系统，并通过只执行一次的共享 application 批次 URL 预取 `immediately` 层级。插件阶段随后激活每个图 entry 并等待全部就绪，之后才把带标记的启动 DOM 交给 UI 渲染器，由它 hydrate 并切换到完整 UI。

### 启动页

启动页只使用原生 DOM 与本地 CSS，因此 bundle 与插件激活失败保持可见：它显示一个 spinner 节点，其 CSS 圆弧随 entry 激活而增长，并逐 entry 报告状态。spinner 及其动画相位会一直保留，直到完整 UI 替换启动页。导入或激活失败的插件会按名称报告并给出原因（缺失服务、导入失败或状态），而不是白屏。控制台包含原始导入错误。

### 共享模块表

`PLATFORM_MODULES`（位于 `src/platform.ts`）列出外壳预置的共享模块——React、Cordis 与静态 UI 库——并与 `PRELOADED_CLIENT_EXTERNALS`（parser 预载的运行时行）一起定义每个动态 bundle 解析所依据的隐式 external 基座。`dsh.client.external` 只添加基座之外的精确请求；参见[共享模块与模块图](../AGENTS.md#shared-modules-and-the-module-graph)。

### 配置

本包自身不接受任何插件配置；生成的[配置目录](../../../docs/config-catalog.zh.md)列出仓库中每个插件配置以供对照。

-----

<a id="understand-the-implementation"></a>
## 理解实现

菜单采用共享 `MenuSurface` 材质，包括用于背景模糊的 macOS 底层；自定义内容遵循[菜单规则](../../../docs/web-styling.zh.md#component-rules)。

<details>
<summary>实现细节——点击展开</summary>

本节解释启动内核的构建方式；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

内核恰好拥有三样东西：模块系统、Cordis Loader 与启动页。Graph、批次 preload 与 loader facade 归 Host 所有，因此 `AppWebEntry` 永不感知 bootstrap 包 id，也不解析协议格式（wire format）。动态 UI 渲染器只在每个客户端 entry 激活后收到挂载点。

### 两阶段启动

`run()` 调用 Host 安装的 `window.__ModuleLoader__.create({ boot, staticModules, ...seams })`；facade 接纳 parser 已加载的 bootstrap 批次后返回构造好的模块系统与已解析 manifest（元数据清单）。模块阶段通过一个共享的 application 批次 URL 预取 `immediately` 层级。插件阶段挂载 Loader、把 `loader.internal` 赋为 `modules`、统一创建全部图 entry、等待完全停稳，然后审计激活：任何导入失败、因缺失服务而 pending，或落入其他非 active 状态的 entry，都会抛出一个聚合错误，点名每个失败 entry。

### 启动页机制

启动页是原生 DOM 加本地 CSS，其回退字体与颜色匹配加载期间到达的主题 token。`internal/status` 事件驱动一个 spinner 节点与逐 entry 标签；hydrate 会保留该节点与动画相位直到应用提交，`fail()` 渲染抛出的原因。React 挂载、slot 渲染与应用组装位于 `ui-renderer`；`ui-layout` 拥有组装后的浏览器标题投影。

启动内核把清单条目创建交给 Client Modules，使启动后的动态图同步继续持有相同的条目身份。初始激活审计仍然严格；后续页面本地失败显示在「设置 → 插件 → 插件列表」。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 库入口：`AppWebEntry`、`getStaticModules`、平台表 |
| [`src/boot.ts`](src/boot.ts) | `AppWebEntry`：模块阶段、启动页、immediately 层级预取、安装窗口拖拽矩形 watcher，随后调用 `bootClient` + `mountClient` |
| [`src/boot-client.ts`](src/boot-client.ts) | `bootClient` / `assertEntriesActive`：挂载 Loader、每个 manifest 行一个 entry、激活审计 |
| [`src/mount.ts`](src/mount.ts) | `mountClient`：经 `uiRenderer` 依赖 fiber 完成渲染器交接 |
| [`src/boot-page.ts`](src/boot-page.ts) | 无框架启动页：spinner、逐 entry 状态、失败渲染 |
| [`src/platform.ts`](src/platform.ts) | `PLATFORM_MODULES` / `PRELOADED_CLIENT_EXTERNALS`：隐式 external 基座 |
| [`src/seed.ts`](src/seed.ts) | 启动时交给 loader 的静态模块表 |
| [`src/window-drag/regions.ts`](src/window-drag/regions.ts) | darwin app-region 组合模型，以及 `base.css` 减除的交互元素选择器 |
| [`src/window-drag/recall.ts`](src/window-drag/recall.ts) | 外壳唯一的窗口拖拽矩形 watcher（electron/electron#32341）：逐帧测量被打标行，并在它们移动期间脉冲 recall 标记 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当启动约定不够用时阅读以下页面：它所启动的模块系统、挂载应用的渲染器，以及基座背后的客户端编写规则。

- [客户端模块系统](../modules/README.zh.md)——本内核消费的惰性模块表与启动图。
- [UI 渲染器](../ui-renderer/README.zh.md)——接收挂载点并把 slot 数据绑定到 React。
- [客户端模块子系统](../../../docs/subsystems/client-modules.zh.md)——web 插件表、启动图协议与 bundle 路由。
- [客户端编写规则](../AGENTS.md#shared-modules-and-the-module-graph)——共享模块基座与 `dsh.client.external` 语义。
- [客户端组地图](../README.zh.md)——本包所属的浏览器半侧。

-----

<a id="model-experience"></a>
## 模型体验

无。启动内核属于浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明启动内核不支持什么。它们是当前包约束，不是任务积压。

- **应用会等待全部 entry 就绪**——只要一个 entry 失败，无框架启动页就会保留并逐项报告；不支持部分 UI 可用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是 Vite entry shell，只负责 boot glue 与 module-table seeding，不发出 Cordis 事件或持有跨插件可变状态；boot chain（加载页 → 启动就绪 → 一次切换至 UI）由真实 carrier 上的 web e2e 冒烟测试验证。
