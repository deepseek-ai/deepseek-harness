---
description: "面向构建或排查实验性 Web 预览运行时的维护者，说明浏览器 worker 中的 harness 托管。"
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-runtime`

[English](README.md) | 中文

## 概述

浏览器 worker 宿主：整棵 harness 插件树跑在一个 dedicated Web Worker 里，用于预览部署与打包回归（[实验组](../README.zh.md)）。worker 边下载边解压打包好的 VFS 镜像并挂载进内存，经 CommonJS 包装加载器装载模块，并通过一条讲纯 HTTP 的 postMessage 隧道服务页面。当预览需要在没有 Node 宿主的环境中运行已打包 harness 时，请使用它。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

公开 npm 包在根入口导出运行时库，通过 `./worker` 提供自包含的浏览器 Worker，通过 `./client` 提供页面连接器。部署方通过 [打包器](../webworker-packer/README.zh.md) 单独提供和托管 VFS 镜像；安装此库不会增加 profile 层。根入口还导出打包器所用的模块代理表与替换表。

一条 tsdown 管线产出三个构建产物；另有一层由源码维护的进程实现：

- **`lib/index.js`（装配库）**——`createWorkerHost`/`startWorkerHost` 挂载基础镜像和按序排列的数据 overlays（`storage/`）、登记镜像的懒加载归档、安装模块加载器（`module-system/`）与 `process` shim、经镜像自带的 `dsh-app-boot` 启动插件树，并把服务 seam 交给隧道。Overlay 只能替换 `home/` 与 `workspace/` 下的文件，不能替换基础 manifest 或模块。镜像布局契约（`image-layout.ts`：虚拟根、manifest 路径、懒加载归档目录、空目录）与 manifest（`image-manifest.ts`：profile、安装清单、`lowered` 包装契约门、懒加载归档）与 packer 共享。Worker 按启动器的方式启动 manifest 指定的随附 profile：镜像里的 app-boot 用随附模板初始化 `home/profiles/<profile>/`，从镜像单独携带的安装 manifest 解析 bundle，并合成各 bundle 层、profile patch 与 home patch。profile 上下文、启动环境快照，以及不带运行时 resolution 的 `PluginPackages` 服务都按启动器的方式提供；模块解析由 Worker 加载器负责。profile 上下文不带命令行 overlay；packer 按 `PLATFORM_ENTRY_CONFIG` 写入镜像的 home patch（`home/cordis.patch.yml`），使 JSONL Session 日志保持明文。ConfigEditor 将覆盖值持久化到 profile patch，协调每次写入，Loader 提交实时值。Worker 在隧道开始服务后提交 `appReady`，因此 HMR 可以加载 profile 变更并实时应用；Worker 的 ES module 缓存始终为空，`process` shim 也不报告入口脚本，因此 HMR 不比较、也不替换已加载的模块。插件管理可以列出并开关安装提供的 optional bundle，其包操作会因 `execa` 拒绝而失败。配置修改在当前 Worker 生命周期内有效。
- **懒加载归档**——manifest 按路径和大小登记 packer 移出基础镜像的每个页面 chunk，并给出相对镜像 URL 的归档名。存在性、stat 和目录列表立即作答；第一次异步读取（`fs.promises.readFile`、`fs.promises.open`、`fs.createReadStream`、`fs.promises.cp`）为所有等待中的读取方只拉取并解压一次该归档，按登记内容校验后挂载其文件，不发布 mutation。拉取失败时本次读取被拒绝，文件保持登记状态，下次读取会重新拉取。在此之前，对已登记文件的同步读取、写入、追加、截断、chmod、rename 和 link 会以 `ERR_DSH_VFS_DEFERRED` 失败，错误中写明归档名；unlink 和递归删除会移除登记，再次 seed 该路径会替换登记。归档名由内容摘要派生，拉取时只校验登记的路径和大小，不校验摘要。登记了懒加载归档的镜像必须以 URL 传入。
- **`lib/worker.js`（worker 束）**——装配库加本包的 Node 兼容层，合成一个自含 ES module。模块代理表（`module-proxies.ts`）是唯一平台叉口：`node:*` 内建走 VFS、隧道和浏览器原语，浏览器做不到的走结构化 stub（调用即在 console 报错并抛出），native/binary 包则替换执行后端。`node:module` 在镜像 package 根之上提供 `createRequire().resolve` 与 `.resolve.paths()`，使未修改的包无需执行目标模块即可发现 manifest。`node-addon-require-builtin` 应答 vendor Loader、app-boot 和 HMR 在没有 `--expose-internals` 时读取的 Node v24.18.0 internal 模块：cascaded ESM loader 的 `resolveSync` 和 `import` 经 Worker 加载器完成，失败时带 Node 的 `ERR_MODULE_NOT_FOUND` 与 `ERR_PACKAGE_PATH_NOT_EXPORTED` 错误码，`loadCache` 为空；HMR 会替换的 CommonJS loader、package reader、`modules` binding 与 resolve cache 成员被调用时拒绝。`process.versions.node` 报告 `24.18.0`，因此 `ModuleLoader.fromInternal()` 和 Loader 的 `internal` 拿到的是这个 cascaded loader。`node:path.win32.isAbsolute` 与 `node:util.inherits` 与 Node 一致，其余 `win32` 成员抛出。`node:util` 的 JSON 数据比较器检查可枚举的自有属性，使 `__proto__` 等记录字段的准入判定与 Node 一致。全局 `process` shim 带有包括 `title` 在内的 Node 环境识别字段，避免 Worker 执行误入仅适用于 DOM 的分支；镜像中加载的包通过 Node 的 `global` 别名访问同一个 `globalThis` 对象。pack 期解析器会把名称静态可知的模块请求报告给 packer 的可达性遍历，其中包括通过 `node:module` 或 `module` 具名导入在模块作用域直接发起的 `createRequire(import.meta.url)('pkg')` 调用。保存、经 CommonJS 获取或另设基准的 `createRequire` 调用需要镜像入口种子。VFS mutation 驱动 `node:fs` 的 callback、polling 和 promise watcher，监听回调运行在创建 watcher 时的异步上下文中，而不是写入方代码的上下文中；打开的 descriptor 在 rename、replacement 和 unlink 后仍保留文件身份与访问模式，只要文件名仍指向该文件，`FileHandle.stat({ bigint: true })` 报告的 device 与 inode 身份就与路径 stat 相同，`FileHandle.chmod()` 则更新打开文件身份的权限；`readable-stream` 提供 `node:stream/promises` 的完成等待与管道方法，以及文件流以及 Chokidar、readdirp 等未修改镜像包所用的流状态机。维护中的 `string_decoder` 包提供 `node:string_decoder`，在数据块之间保留不完整的多字节字符。AsyncLocalStorage 经 pack 时降低注入的 snapshot/restore 面在 `await` 间携带同步栈因果。worker 不带编译器：packer 未降低的镜像在挂载时被拒。回调式 `fs.realpath.native` 别名在已挂载的 VFS 内解析路径，并支持 `util.promisify`。
- **`src/shell/`（worker 自己的进程层）**——浏览器 worker 无法 fork，所以 `node:child_process` 不是 stub 而是实现：`spawn` 把命令放进它自己的 Web Worker——就是这同一个束，由首帧告诉它「你是 shell 进程」——并以 subprocess 服务消费的 `ChildProcess` 面报告结果。命令不占宿主线程，`SIGKILL` 不管它在干什么都能终止它，而它只能靠消息触达 VFS（由宿主应答这些帧）。Worker 平台 executable 在不替换 JavaScript 包、也不把具体实现耦合进 `node:child_process` 的情况下保持 Landlock 等 native 包协议；`xdg-open` 把一个 VFS 文本文件交给页面的只读查看器，因此 **打开配置文件** 等桌面打开操作会在页面内显示该文件；普通命令使用本包的求值器与 coreutils 命令表。语法来自 `@yarnpkg/parsers` 的 `parseShell`，而 `execSync`/`fork` 依然拒绝，因为它们需要真进程。
- **`lib/client.js`（页面半）**——启动分为相互独立的两段。`chooseWorkerHostSource({ image?, fixtureManifest? })` 可选地拥有 boot barrier 与 fixture manifest：没有 `preview-fixture` 时停在来源选择面板，合法 query 则直接选择；两条路径都返回按序排列的 overlays。`connectWorkerHost(worker, { image?, overlays? })` 仍是公开的基础运行态连接器；调用方跳过选择器时 overlay 列表为空。`apps/web` 调用这两段并提供静态打包的 Worker。开局 `init` 帧携带基础镜像与按序排列的 overlay URL，boot 载荷送达结构化 index 注入表，`applyIndexInjections` 在壳入口运行前逐行执行。脚本 preload 行只是提示，因此会被跳过：`/plugins` 资源只能经 tunnel 解析，`loadBundle` 会在首次需要时获取 combo、把仅 tunnel 可达的 sourcemap 内嵌为 Base64 data URL，再以 Blob 执行脚本。在 shell 入口运行之前，页面读取 `GET /__assets__`（隧道以镜像中所有包资源组成的未压缩 tar 回答），并提供 `resolveAsset`，把 bundle 传给 `require.asset` 的每个 `plugins/<package>/assets/<path>` 引用映射为这些字节的 Blob URL。worker 主动发出的 `view-text` 帧会打开页面的模态文本查看器。Tunnel 还暴露 fetch 形式的传输、独立文件上传载体和 API 客户端。请求帧通过结构化克隆保留 Blob 请求体，并转移 `ReadableStream<Uint8Array>` 的所有权。Host Worker 将两种请求体都逐块送入路由，因此通用文件上传不会在任何浏览器线程创建完整字节数组。Remote 流的上行以 `stream-uplink-item` / `stream-uplink-end` 帧进入没有上限的 `TunnelUplink`，`end` 之后到达的项被丢弃：页面与其 worker 是同一个可信的同源边界，Host 的 inbox 上限在此不适用。

在显式根上下文中登记的回调和定时器保留其空 store，避免继承无关事务。

验收在 `apps/web/tests/preview-boot.e2e.ts`：静态服务真实构建页面，在 headless Chromium 里驱动 pre-boot 选择面板与 Worker 激活。空白选择验证首次启动；`vfs-example` overlay 提供普通 workspace 文件与明文 persistence 产物，无需模型请求即可验证 Workspace/Session 冷发现、工具呈现、subagent 导航和历史分页。showcase 混排空字符串、纯空白与非空推理块，并包含多行长命令和父路径文件链接；这些是人工构造的 fixture，不是真实模型输出。另一个根 Session `preview-turn-spacing` 含三个多步骤轮次，其正文用于对照收紧后的过程行间距与回复间距。[打包器](../webworker-packer/README.zh.md)在 Node 中根据已提交的历史日志准备当前代后继文件；这些源日志在 overlay 中逐字节保持不变。fixture 生成器负责验收测试的当前投影缓存。选择面板为 WebFS 保留独立的用户授权来源；该 provider 不读取内置 fixture。

[已构建 bundle 导入检查](tests/compile/transform-corpus-check.ts)在库构建后检查裸 Node 导入。Dockkit 例外接受 Node 针对任意样式表报告的未知 `.css` 扩展名错误，而不限定某一固定路径；其他扩展名、错误码或消息，以及意外成功的豁免导入，仍然报错。

-----

<a id="model-experience"></a>
## 模型体验

无：本包只在浏览器 worker 里承载插件树并应答它的 `node:*` 调用；所有面向模型的注册都属于它启动的那些插件。

#### KV Cache 影响

无：本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **worker 组合写明文会话日志**（镜像 home patch 中的 `compression: 'none'`；ConfigEditor 会拒绝修改这一行的配置）：不带 Zstandard 编解码器，导出日志是 `.jsonl`，不会是 `.jsonl.zstd`。
- **`node:dns/promises`、`node:vm`、`node:net`、`node:sqlite`、`node:worker_threads` 是结构化 stub**：每次调用在 console 报告拒绝，并抛出带 Node `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 错误码的错误。需要原生 DNS、真进程或真 realm 隔离的行在此无法运行。
- **`node:assert/strict` 仅支持真值断言**：对于假值，可调用的默认导出和 `ok` 使用传入的消息或通用文本抛出 `ERR_ASSERTION`，或原样抛出传入的 Error。其他断言 API 未提供。
- **原生 TLS 监听器需要 Node Host**：worker 的 `node:https.createServer` 会拒绝激活，不会替换成明文。预览内部的 HTTP 隧道不绑定套接字；面向浏览器的 HTTPS 由部署服务器提供。
- **桌面产品埋点不可用**：`got.post` 明确报告 worker host 不支持该调用。浏览器镜像不包含 Got 及其 Node HTTP 依赖；预览组合不启用桌面上报。
- **宿主包管理命令不可用**：`execa` 明确报告 worker host 不支持该调用；预览无法运行 pnpm、安装插件或安装原生依赖。
- **Pi Agent 执行不可用**：`@earendil-works/pi-coding-agent` 替代模块允许元数据导入，并以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝 SDK 调用。镜像不包含其原生 CLI 与终端 UI 依赖。原生 DSH 仍保留完整的 OAR 运行时注册表。
- **pi-ai 模型请求不可用**：替代实现暴露已安装提供方标识的固定子集，不包含模型，使适配器能够注册配置元数据。升级 pi-ai 时必须保持这些标识有效；推理入口明确报告 worker host 不支持该调用。
- **PTC Node 程序不可用**：process shim 用 `/dsh/bin/node` 表示可执行文件身份，使 provider 能够激活，但 Worker 既没有 Node 可执行文件，也没有 `stripTypeScriptTypes`。程序执行会在启动子进程前失败。
- **Office 转换需要 Node Host**：LibreOffice kit 的替代模块以 `unavailable` 拒绝创建转换器。浏览器镜像排除 kit 及其引擎依赖；Office 预览提示转换不可用。
- **HMR 不替换模块**：Worker 的 ES module 缓存始终为空，因此 VFS 中被修改的模块文件仍保持已加载的代码，而 HMR 会照常应用 profile 变更。preview 镜像不会修改模块文件：包操作会因 `execa` 拒绝而失败。
- **Node internal 模块只提供 HMR 会替换的成员**：CommonJS loader、package reader、`modules` binding 与 `getOrCreateModuleJob` 被调用时拒绝；Worker 自己的 `require` 不经过 CommonJS loader，因此替换 `Module._resolveFilename` 或 `Module._load` 不会改变 Worker 的解析。
- **CommonJS 的 `require('stream')` 返回模块命名空间，而不是 Node 的 `Stream` 构造函数**：把它传给 `util.inherits` 的代码会在加载时失败。
- **懒加载提供的文件在其归档到达前不能同步读取**：使用方必须先异步读取一次；Host 的按需 Client chunk 路由就是这样做的。
- **文件 watcher 只能观察已挂载的 VFS**：镜像 seed 不产生事件，VFS 也没有符号链接或外部写入方。`persistent`、`ref()` 和 `unref()` 保留 Node API，但浏览器没有引用计数事件循环，因此这些接口不能控制 dedicated Worker 的生存期。
- **Worker confinement 是 VFS 边界，不是内核 Landlock**：`read-only` 和 `workspace-write` 运行未经修改的 `@deepseek-ai/node-addon-system/landlock-run` JavaScript 与 launcher argv，进程层则实现逻辑 `landlock-run` 可执行文件，并在 shell 的每次文件系统请求上执行其授权。`full` 仅覆盖 Worker 命令表和已挂载 VFS，不表示能够执行任意 native 进程，也不表示 Linux 内核隔离。
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
