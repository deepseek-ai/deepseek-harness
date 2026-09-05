---
description: "面向构建或排查实验性 Web 预览运行时的维护者，说明浏览器 worker 中的 harness 托管。"
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-runtime`

[English](README.md) | 中文

## 概述

浏览器 worker 宿主：整棵 harness 插件树跑在一个 dedicated Web Worker 里，用于预览部署与打包回归（[experimental 定位](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.zh.md)）。worker 边下载边解压打包好的 VFS 镜像并挂载进内存，经 CommonJS 包装加载器装载模块，并通过一条讲纯 HTTP 的 postMessage 隧道服务页面。当预览需要在没有 Node 宿主的环境中运行已打包 harness 时，请使用它。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

一条 tsdown 管线出三个产物：

- **`lib/index.js`（装配库）**——`createWorkerHost`/`startWorkerHost` 挂载基础镜像和按序排列的数据 overlays（`storage/`）、安装模块加载器（`module-system/`）与 `process` shim、经镜像自带的 `dsh-app-boot` 启动插件树，并把服务缝隙交给隧道。Overlay 只能替换 `home/` 与 `workspace/` 下的文件，不能替换基础 manifest、配置或模块。镜像布局契约（`image-layout.ts`：虚拟根、config/manifest 路径、空目录、`lowered` 包装契约门）与 packer 共享。boot patch 强制部署形态行：关前端静态服务、JSONL 会话日志走明文、preset 根指向镜像内 `config/agent-presets`。
- **`lib/worker.js`（worker 束）**——装配库加本包的 Node 兼容层，合成一个自含 ES module。模块代理表（`module-proxies.ts`）是唯一平台叉口：`node:*` 内建走 VFS、隧道和浏览器原语，浏览器做不到的走结构化 stub（调用即在 console 报错并抛出），native/binary 包则替换执行后端。`node:module` 在镜像 package 根之上提供 `createRequire().resolve` 与 `.resolve.paths()`，使未修改的包无需执行目标模块即可发现 manifest。全局 `process` shim 带有包括 `title` 在内的 Node 环境识别字段，避免 Worker 执行误入仅适用于 DOM 的分支。pack 期解析器会把名称静态可知的模块请求报告给 packer 的可达性遍历，其中包括通过 `node:module` 或 `module` 具名导入在模块作用域直接发起的 `createRequire(import.meta.url)('pkg')` 调用。保存、经 CommonJS 获取或另设基准的 `createRequire` 调用需要镜像入口种子。VFS mutation 驱动 `node:fs` 的 callback、polling 和 promise watcher；打开的 descriptor 在 rename、replacement 和 unlink 后仍保留文件身份与访问模式；`readable-stream` 提供文件流以及 Chokidar、readdirp 等未修改镜像包所用的流状态机。AsyncLocalStorage 经 pack 时降低注入的 snapshot/restore 面在 `await` 间携带同步栈因果。worker 不带编译器：packer 未降低的镜像在挂载时被拒（[note](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.zh.md)）。
- **`src/shell/`（worker 自己的进程层）**——浏览器 worker 无法 fork，所以 `node:child_process` 不是 stub 而是实现：`spawn` 把命令放进它自己的 Web Worker——就是这同一个束，由首帧告诉它「你是 shell 进程」——并以 subprocess 服务消费的 `ChildProcess` 面报告结果。命令不占宿主线程，`SIGKILL` 不管它在干什么都能终止它，而它只能靠消息触达 VFS（由宿主应答这些帧）。Worker 平台 executable 在不替换 JavaScript 包、也不把具体实现耦合进 `node:child_process` 的情况下保持 Landlock 等 native 包协议；普通命令使用本包的求值器与 coreutils 命令表。语法来自 `@yarnpkg/parsers` 的 `parseShell`，而 `execSync`/`fork` 依然拒绝，因为它们需要真进程。
- **`lib/client.js`（页面半）**——启动分为相互独立的两段。`chooseWorkerHostSource({ image?, fixtureManifest? })` 可选地拥有 boot barrier 与 fixture manifest：没有 `preview-fixture` 时停在来源选择面板，合法 query 则直接选择；两条路径都返回按序排列的 overlays。`connectWorkerHost(worker, { image?, overlays? })` 仍是公开的基础运行态连接器；调用方跳过选择器时 overlay 列表为空。`apps/web` 调用这两段并提供静态打包的 Worker。开局 `init` 帧携带基础镜像与按序排列的 overlay URL，boot 载荷送达结构化 index 注入表，`applyIndexInjections` 在壳入口运行前逐行执行。脚本 preload 行只是提示，因此会被跳过：`/plugins` 资源只能经 tunnel 解析，`loadBundle` 会在首次需要时获取 combo、把仅 tunnel 可达的 sourcemap 内嵌为 Base64 data URL，再以 Blob 执行脚本。Tunnel 还暴露 fetch 形式的传输、独立文件上传载体和 API 客户端。请求帧通过结构化克隆保留 Blob 请求体，并转移 `ReadableStream<Uint8Array>` 的所有权。Host Worker 将两种请求体都逐块送入路由，因此通用文件上传不会在任何浏览器线程创建完整字节数组。

验收在 `apps/web/tests/preview-boot.e2e.ts`：静态服务真实构建页面，在 headless Chromium 里驱动 pre-boot 选择面板与 Worker 激活。空白选择验证首次启动；`vfs-example` overlay 提供普通 workspace 文件与明文 persistence 产物，无需模型请求即可验证 Workspace/Session 冷发现、工具呈现、subagent 导航和历史分页。选择面板为 WebFS 保留独立的用户授权来源；该 provider 不读取内置 fixture。

-----

<a id="model-experience"></a>
## 模型体验

无：本包只在浏览器 worker 里承载插件树并应答它的 `node:*` 调用；所有面向模型的注册都属于它启动的那些插件。

#### KV Cache 影响

无：本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **worker 组合写明文会话日志**（`compression: 'none'` boot patch）：不带 Zstandard 编解码器，导出日志是 `.jsonl`，不会是 `.jsonl.zstd`。
- **`node:dns/promises`、`node:vm`、`node:net`、`node:sqlite`、`node:worker_threads` 是结构化 stub**：每次调用在 console 报告拒绝并抛出。需要原生 DNS、真进程或真 realm 隔离的行在此无法运行。
- **文件 watcher 只能观察已挂载的 VFS**：镜像 seed 不产生事件，VFS 也没有符号链接或外部写入方。`persistent`、`ref()` 和 `unref()` 保留 Node API，但浏览器没有引用计数事件循环，因此这些接口不能控制 dedicated Worker 的生存期。
- **Worker confinement 是 VFS 边界，不是内核 Landlock**：`read-only` 和 `workspace-write` 运行未经修改的 `@deepseek-ai/node-addon-landlock-run` JavaScript 与 launcher argv，进程层则实现逻辑 `landlock-run` 可执行文件，并在 shell 的每次文件系统请求上执行其授权。`full` 仅覆盖 Worker 命令表和已挂载 VFS，不表示能够执行任意 native 进程，也不表示 Linux 内核隔离。
- **worker 束钉住了 `@yarnpkg/parsers` 的包内路径**——构建解析到该包自己的 `lib/shell.js` 而非包根，因为包根 barrel 还 re-export 了 Syml 解析器，会把 js-yaml 拖进一个从不解析该格式的束（约 175 kB，外加 worker 启动时的模块体求值）。该路径由包 manifest 派生，包内布局一变即构建期失败、不会静默退回 barrel；升级这个依赖时须复核 shell 解析器是否仍在那里。
- **这个 shell 不是 bash**：没有循环、函数、`case`、作业控制或进程替换——语法止步于管道、`&&`/`||`、子 shell、group、重定向与展开。`&` 会就地把命令跑完，`sed` 只接受替换脚本，模式是 JavaScript 正则，命令表只有 coreutils（没有 `git`，没有网络工具）。
- **shell 进程没有同步文件面**：它靠消息读写宿主的 VFS，因为阻塞等待回帧需要 `SharedArrayBuffer`，而那要求 GitHub Pages 给不了的跨源隔离。因此目录遍历类命令每个条目一次往返，并发的两条命令写入可以交错。
- **transport、worker-host、页面半的覆盖需要浏览器级 harness**——这些模块未达 per-file 覆盖门；单测覆盖 storage、ALS、transform 与 stub 契约。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是 Cordis 启动前的平台 glue；其启动的产品树运行各包自己的不变式，image 与 tunnel 约定在 boot 时失败。
