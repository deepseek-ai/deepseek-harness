# Agent Note: Preview Worker 按正式 profile 启动，懒加载 chunk 按需拉取

Status: implemented

[English](2026-10-14-webworker-preview-profile-parity.md) | 中文

## 问题

浏览器 Preview（[webworker-runtime](../../../../packages/experimental/webworker-runtime/README.zh.md)、[webworker-packer](../../../../packages/experimental/webworker-packer/README.zh.md)）的启动配置可以在打包时生成：packer 用临时 home 运行 `dsh --profile web --dump-config`，把输出写进镜像的 `config/cordis.yml`；Worker 再把整份配置当作 profile 自己的补丁（一条 `insert`）插回去。在这样的镜像上实测，会带来三个后果：

| 现象 | 原因 |
|---|---|
| 插件页看不到任何 optional bundle | 镜像只收 dump 里出现的行，11 个默认关闭的 `OPTIONAL_BUNDLES` 都不在里面；Worker 的 `installAnchor` 指向 profile 自己的 package.json，没有安装依赖 |
| 即使补上，启用后有的 bundle 也不生效 | bundle 层排在 profile 补丁前面，基础行这时还不存在：session-titles 的禁用补丁被跳过，agent-team 产生 4 条 `entry not found`，bundle 新增的行排到了最前面 |
| 镜像 12.79 MiB | 4 个懒加载 chunk（documentpreview 的 pdf、excel、frontmatter，sidebar-terminal 的 terminal，共约 4.4 MiB）和启动必需的代码一起下载 |

实测：不开 bundle 时，两边组合的 188 行里只有 `session-persistence-jsonl` 的 `compression: none` 一处不同。差异来自配置的分层方式，不在数据本身。

## 决策

### 与正式 Web 相同的 profile 启动

正式启动链路（apps/cli、app-boot）不含 Preview 专用代码；由 webworker 包复现这条链路：

- **packer**
  - 收包清单 = `PROFILE_TEMPLATES[profile].bundles` + `OPTIONAL_BUNDLES` + 这些 bundle 补丁文件里的行；bundle 包本身也打进镜像（补丁、locale、icon 走 publish view）。两张表从 app-boot 读，与插件页同一来源。
  - 镜像里放一份只含清单的 `node_modules/@deepseek-ai/dsh/package.json`（原样复制 `apps/cli/package.json`），作为安装锚点，镜像 manifest 在 `installation` 里记录它。
  - 镜像不带组合好的配置，也没有 `config/cordis.yml`；镜像 manifest 记录 Worker 要启动的 `profile`。
  - 镜像带一份 home patch `home/cordis.patch.yml`：对运行时 `PLATFORM_ENTRY_CONFIG` 列出的每一行（`session-persistence-jsonl`），写入模板各 bundle 层合成出的配置，并在其上设置所需字段（`compression: none`）。补丁会整体替换一行的配置，所以保留合成出的字段；打包时读取的 bundle 文件就是镜像里的那些。
- **Worker**
  - 用镜像里 app-boot 的 `loadProfile` 从模板初始化 `home/profiles/<profile>`，写空的根 `cordis.yml`，用 `readProfilePatches` 组合。
  - profileContext 按 `runProfile` 填写：name、dir、patchPath、installAnchor、startedBundles、cwd、home，overlay 列表为空，因此 Worker 与不带 `--patch` 的启动器一样只调用一次 `readProfilePatches`。
  - 提供 launchEnvironment 快照，挂上不带 resolution 的 `PluginPackages`。
- **保留的平台差异**：jsonl `compression: none`（经镜像的 home patch 提供；ConfigEditor 会拒绝修改这一行的配置，与拒绝任何被 home patch 覆盖的行一致）、模块加载器（Worker 自己的 CommonJS 加载器，经 Node internal 模块接口提供，见下节）、日志输出、启动参数、appReady 时机、没有 pnpm、没有进程级代理和信号处理。

Worker 只用 app-boot 现有导出；app-boot 没有 Preview 专用的 override 或注入点。

### Worker 提供 Node internal 模块接口

读插件元信息（`readPluginMeta`）、配置 schema 导出和 HMR 不经过 ctx，而是用 `ModuleLoader.fromInternal()` 或 `node-addon-require-builtin.requireBuiltin(id)` 直接取 Node 的 internal 模块。如果 Worker 藏起这些模块，例如把 `process.versions.node` 报成 `0.0.0` 让 `fromInternal()` 返回空，挂上 `PluginPackages` 后这些调用方就会出错：插件页每个 bundle 都报“Plugin metadata requires the Node module resolver”，HMR 看不到 `loadCache`，每次开关都返回 `restart-required`。

- **只照搬接口**：Worker 用静态模块替换 `node-addon-require-builtin`，`requireBuiltin(id)` 按 Node v24.18.0 的 id 返回调用方实际读取的 5 个模块，成员名和签名与 Node 一致；其余 id 抛 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`。`process.versions.node` 报 `24.18.0`，`execArgv` 不带 `--expose-internals`。
- **`internal/modules/esm/loader`**：cascaded loader 的 `resolveSync(parentURL, request)` 和 `import` 交给 Worker 现有的加载器，解析失败带 Node 的 `ERR_MODULE_NOT_FOUND`、`ERR_PACKAGE_PATH_NOT_EXPORTED`；`loadCache` 是空的 `LoadCache`；`getOrCreateModuleJob` 存在但调用即拒绝。cascaded loader 由 Worker 加载器实例持有。
- **HMR 替换的成员**：`internal/modules/cjs/loader` 的 `Module`、`package_json_reader`、`internal/bootstrap/realm` 的 `modules` binding、`module_map` 的 `ResolveCache` 保留 Node 的成员名，供 HMR 替换与还原；被调用时拒绝。Worker 自己的 `require` 不经过它们。
- **同一个 cascaded loader**：Worker 不覆写 `ctx.loader.internal`；Cordis Loader 与静态调用方经 `fromInternal()` 拿到同一个 cascaded loader。
- **按实测调用方补齐的 Node 行为**：`node:path.win32.isAbsolute`（图标路径校验）、`node:util.inherits`（`http-errors`），均按 Node 源码实现。

### Inspector 在没有 worker_threads 的平台上降级

Worker 的结构化 stub 抛出带 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 的错误。Inspector Host 只在 Worker 启动以这个错误码失败时降级：警告一次，bootstrap 路由返回 503，不注册 DevTools 路由、不注入、不提供 `inspector` 服务；其他启动错误让 fiber 失败。`serve-static` 和 `open` 在 Worker 启动成功后才加载，降级时不加载。同一 bundle 里的 Session Inspector 因此正常运行。

### 懒加载 chunk 独立归档

- **分类**：client 构建预设只以 `require.async("./client.<name>.js")` 的形式产出包内 chunk 请求，`verify-client-packages` 禁止同步 require chunk。packer 的 `lazyChunksOf` 扫描清扫后镜像里的每个页面资源（各包的 `lib/client.js` 和 `lib/client.*.js`）中的这些字面量，因此 chunk 引用的 chunk 不必从 `./client` 入口沿请求追踪也能找到。在任一条件下被某个包的 `./client` 导出指向的目标（如 `client.browser.js`）会被立即加载，留在基础镜像；其余目标移出基础镜像。请求包未发布的 chunk 会让打包失败。
- **归档**：每个 chunk 一个确定性 tar.gz，按压缩后归档的 SHA-256 命名为 `lazy/<sha256>.tar.gz`。基础 manifest 的 `lazy` 列表把每个 archive 记录为 `{ archive, files: [{ path, size }] }`，不记录文件 mode。不设大小阈值。
- **登记**：Worker 用 `MemoryVfs.deferArchive` 登记列出的每个文件，同时创建其父目录，并赋予 VFS 默认文件 mode；列出懒加载 archive 的镜像必须从 URL 拉取，archive 名相对这个 URL 解析。`exists`、`stat`、`readdir` 依据登记同步作答。
- **拉取**：Worker 的 `node:fs` 和 `node:fs/promises` 中读取已登记文件的异步接口会等待其 archive：`fs.promises.readFile`、`fs.promises.open`（因此每个 FileHandle 都在到达后才打开）、`fs.promises.cp` 和 `fs.createReadStream`。其中第一个调用拉取 archive、解压，校验其中恰好是登记的路径和登记的大小，再物化文件；并发读取方共用一次拉取。archive 名里的摘要不做校验。拉取失败只让等待它的读取失败；文件保持登记，下一次异步读取再次拉取。
- **到达之前**：同步读取，以及同步和 promise 形式的写入、追加、截断、chmod、重命名和硬链接，都以 `ERR_DSH_VFS_DEFERRED` 拒绝，并给出 archive 名；会移动已登记文件的目录重命名在目标改变之前就被拒绝，目标保持原样。unlink 和递归删除会撤销登记，对该路径 seed 会替换登记；之后到达的 archive 不改动这些路径。
- **client-modules**：`chunkResponse` 在 `lazyBody` 里用 `fs.promises.readFile` 读取 chunk；`lazyBody` 让并发请求共用一次读取，被拒绝的读取一旦落定就丢弃，下一次请求重新读取。在 Node 下，异步读取与同步读取得到相同字节。

### 文件监听与 Client 插件下发

- Worker 的 `fs.watch` 和 `fs.watchFile` 监听器在创建 watcher 时的异步上下文里运行，与 Node 从 watch 句柄派发事件一致，而不是在写入方的上下文里运行。因此 HMR 的配置 watcher 在写入方的 HMR 事务之外运行，事务内的配置写入不会让随后的重载因嵌套事务而失败。
- `@deepseek-ai/dsh-client-hmr` 的浏览器部分在 shell 提供 `__DSH_TRANSPORT__.fetch` 时（Worker preview 隧道）经它读取 `/plugins/events`，否则经 `EventSource` 读取。因此在 Preview 里启用 bundle 后，其 Client 插件无需刷新页面即可挂载。

## 考虑过的替代方案

**保留打包期组合，只在 Worker 里包成一个合成 base bundle。** 改动小，但合成 bundle 会出现在插件列表里，打包期“自己编”的配置也还在，与正式 Web 不同构。

**Worker 用同步 XHR 拉 chunk。** 不改 client-modules，但下载期间整棵 Host 树都被阻塞。

**隧道按 URL 识别 chunk 请求后预取。** 需要在隧道里复制 client-modules 的 `/plugins/<id>/<file>` 路由规则。

**按包或按大小阈值合并 archive。** 每次 `require.async` 只要一个文件，按 chunk 拆分最贴合；阈值是没有依据的可调参数。

**把 Node v24 的 CJS 加载器和解析器源码搬进 Worker，替换 Worker 的整条 require 流程。** 解析路径可以与 Node 逐字一致，但要改用 Node 的条件集（镜像内容随之变化）、引入 cjs-module-lexer 计算具名导出，worker.js 约增加 300 KB；而调用方只需要 internal 模块的接口。

**给 `readPluginMeta` 注入解析器。** 要改 app-boot 的公共函数来适配一个平台差异，配置 schema 导出等其他 `fromInternal()` 调用方仍然拿不到加载器。

**模拟 `--expose-internals`。** vendor Loader、HMR 和 app-boot 在没有这个参数时都退到 `node-addon-require-builtin`，替换这个包即可覆盖全部调用方。

## 后果

Preview 启动的组合与正式 Web 相同。不开 bundle 时，Worker 组合与正式 Web 只差 jsonl 的平台覆盖；开任一 bundle 都没有被跳过的补丁。插件页和“设置 → 内置插件”列出全部 `OPTIONAL_BUNDLES`，每个都显示标题和图标，没有元信息错误。11 个 optional bundle 逐个开启再关闭，两次都返回 `applied`；开启后它改动的每个启用行都是 active，关闭后插件列表恢复原样。启用 session-titles 会禁用 `@deepseek-ai/dsh-session-title-first-prompt-llm`（行 `session-title-llm`）并启用 `@deepseek-ai/dsh-session-title-all-prompts-llm`，与正式 Web 一致；启用 inspector-profile 后 Session Inspector 运行，NodeJS Inspector 降级启动。降级以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 为前提，所以正常 `dsh web` 运行完整的 Inspector。

体积（MiB，实测）：基础镜像 9.20（打包期组合且 chunk 随启动下载时为 12.79，−28%），含 11 个 optional bundle；另有 5 个 lazy tar 共 4.45（pdf 2.88、excel 1.39、terminal 0.13、frontmatter 0.05、inspector 底部面板 0.00）。基础镜像不含懒加载 chunk，页面请求 chunk 时才拉取对应 archive。

这一取舍的代价：

- HMR 不替换模块：Worker 的 ES module 缓存始终为空，VFS 里被修改的模块文件仍运行已加载的代码，而 HMR 照常报告 `applied`。Preview 镜像不会修改模块文件（包操作会因 `execa` 拒绝而失败）。
- Node internal 模块里只提供成员名的部分被调用时拒绝；将来有调用方真正调用它们，会在 Preview 里明确失败。
- `process.versions.node` 报 `24.18.0` 可能改变按版本分支的第三方代码；扫描镜像只发现 undici 在 ppc64 上按版本选择 wasm SIMD，与 Worker 无关。
- CommonJS 的 `require('stream')` 返回模块命名空间而不是 `Stream` 构造函数，把它传给 `util.inherits` 的代码会在加载时失败。
- optional bundle 里浏览器跑不了的能力（sqlite、终端、本地语音）按“跑到才炸”处理：启用不报错，用到时报错。NodeJS Inspector 降级后只剩返回 503 的 bootstrap 路由。
- 镜像布局里没有 `config/cordis.yml`，`WorkerHostOptions` 没有 `configPath`，缺少 `profile` 的镜像 manifest 无法通过校验，所以带组合配置打出的镜像必须重新打包。
- 延迟文件要求读取方走会等待的异步接口；新增的同步读取方会在 Preview 里明确失败，而不是退化。Worker 只校验到达的 archive 中登记的路径和大小，不校验命名它的摘要。

## 测试

- [profile-image.spec.ts](../../../../packages/experimental/webworker-packer/tests/profile-image.spec.ts) 锁定收包清单（模板 bundle、全部 optional bundle、它们补丁行指向的包），以及记录 profile 和 installation、只带安装清单的镜像。
- [lazy-chunks.spec.ts](../../../../packages/experimental/webworker-packer/tests/lazy-chunks.spec.ts) 锁定每个 `require.async` chunk 一个 archive、多次打包得到相同的 archive 名和字节、拒绝未发布的 chunk、`./client` 导出目标留在基础镜像。
- [lazy-archive.spec.ts](../../../../packages/experimental/webworker-runtime/tests/storage/lazy-archive.spec.ts) 锁定登记后的作答、`ERR_DSH_VFS_DEFERRED` 拒绝、重命名目标保持不变、删除与 seed、共用一次拉取、拉取失败后重试，以及会等待的 `node:fs` 接口。
- [require-builtin.spec.ts](../../../../packages/experimental/webworker-runtime/tests/node/require-builtin.spec.ts) 锁定提供的 internal 模块、其他 id 以平台错误码拒绝、cascaded loader、HMR 替换的成员和报告的 Node 版本；[fs-watch-context.spec.ts](../../../../packages/experimental/webworker-runtime/tests/node/fs-watch-context.spec.ts) 锁定监听器在 watcher 创建时的上下文里运行。
- [bootstrap-route.host.spec.ts](../../../../packages/experimental/inspector/tests/bootstrap-route.host.spec.ts) 锁定 Inspector 降级；[transport.client.spec.ts](../../../../packages/client/hmr/tests/transport.client.spec.ts) 锁定经页面 transport 读取事件流；[node-half.client.spec.ts](../../../../packages/client/modules/tests/node-half.client.spec.ts) 锁定 chunk 读取重试。
- [preview-boot.e2e.ts](../../../../apps/web/tests/preview-boot.e2e.ts) 启动打包好的 Worker 部署，经隧道请求一个懒加载 chunk，逐个开关全部 optional bundle，检查 session-titles 和 inspector-profile 的行，并在不刷新页面的情况下挂载已启用 bundle 的 Client 插件。镜像体积是实测值，没有测试锁定。
