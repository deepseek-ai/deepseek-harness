---
description: "通过统一协调队列热重载插件代码和 profile 配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hmr

[English](README.md) | 中文

## 概述

在应用运行期间重载插件源码和配置。模块替换、Include 刷新与 profile 配置变更共用一个队列。包安装在该队列之外执行。`ctx.hmr` 保留现有 Cordis HMR 的配置和事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启动器提供 `profileContext` 时，base 组合包以 `root: []` 启用 HMR；没有该 profile 上下文的宿主保留此条目为禁用状态。Headless、SDK 和 ACP 组合包在 YAML 中禁用此条目，后续 profile patch 可以重新启用。禁用或省略 HMR 时，更改在重启后生效。如需监听源码模块，在启动前通过 profile patch 配置 base 组合包提供的 `hmr` 条目：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["."]
```

已有配置将模块名 `@deepseek-ai/cordis-plugin-hmr` 替换为 `@deepseek-ai/dsh-hmr`。继续提供 `hmr` 服务键、`baseDir`、`config`、`getLinked()`、`getOuterStack()`、`hmr/change` 和 `hmr/reload`。工作区保留 vendored 包；DSH profile 使用本包。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `base` | Context 的 base URL | 模块监听的基准目录。 |
| `root` | `["."]` | 模块监听目录；`[]` 仅保留显式注册的配置监听。 |
| `ignored` | `["**/node_modules", "**/.*", "cache", "data"]` | 排除的模块路径。 |
| `debounce` | `100` | 合并模块变化的毫秒数。 |

Chokidar 选项（包括轮询）保持原有含义。精确配置监听同时观察新增、删除及初始不存在的父目录。它们默认使用 `awaitWriteFinish: true`：编辑后等待 Chokidar 的 2 秒写入稳定窗口，避免其变化事件节流丢失通知。可通过 `awaitWriteFinish` 调整窗口；禁用它可能漏掉快速连续编辑。直接通过 Plugin Manager 发起的操作无需等待文件事件即可应用。

HMR 的 profile 监听和 Plugin Manager 执行的 profile 重新组合，还会替换 profile 目录下已加载文件在磁盘上发生变化的插件。这包括 `node_modules` 之下的已安装包，以及已链接包的目标。因此，文件被原地更改的包，例如构建输出发生变化的已链接包，或被另一次安装升级的依赖，会在下一次此类重新组合时生效，无需重启；不要求通过 `root` 监听源码。替换版本加载失败时，原插件被停止，并以 `failed` 及其加载错误报告，而不是报告为需要重启，因为重启会加载相同的文件；此后每次重新组合都会再次导入它，因此其文件或依赖被修正后它即启动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`watchConfig()` 注册会被等待的配置处理器，仅监听目标路径及必要的父目录；同级文件（包括临时写锁）在创建原生 watcher 前即被排除。`runExclusive()` 将配置变更、Loader 更新与自动重载串行化，并拒绝嵌套事务。包安装和删除在该队列之外执行。HMR 不获取包操作写锁；manifest 通知仅在有序的 `dsh.profile.bundles` 列表变化时触发重载。profile 与 home patch 变化也会触发重新组合。配置事务期间收到的文件事件在事务结束后处理。 Include 刷新和 profile 重载都通过普通的 Loader 条目更新到达插件；仅 volatile 变化由 Loader 就地提交。

App-boot 负责 profile 解析和 patch 优先级规则。HMR 读取启动器提供的纯数据 `profileContext`，在初始化时注册 profile manifest 和两份用户 patch 的监听，并等待应用就绪后处理更改。销毁 HMR 时会关闭监听器并取消等待启动的重载。配置监听器在当前事务上下文之外启动，使后续通知可以进入队列。

`reconcileProfile()` 由 HMR 的 profile 监听和 Plugin Manager 共用；调用方持有 `runExclusive()`。Config Editor 通过 app-boot 重新组合，不替换模块。app-boot 在缓存或运行中条目发生变化前准备新一代组合并执行预检。

文件比较覆盖 profile 目录及已链接包的目标，在应用就绪时记录。[ModuleFiles](src/module-files.ts) 记录 inode、大小和修改时间；仅添加硬链接不会使模块失效。已有模块保留替换前读取的身份，以检测之后的写入。新加载的模块在结算时记录，因此后续安装不会仅因其文件较新而将其重启。

替换沿 ES 模块链接以及每个 CommonJS 父模块的 `children` 传播。模块的插件从其 ES 模块命名空间以及 Node 已缓存的 CommonJS exports 中读取，不求值任何代码，因此在 Loader entry 之外注册的 CommonJS 插件保留其缓存。宿主依赖及可遍历 Loader 树之外的插件保持待处理。其余已变化模块及其导入方被逐出且不保留备份，运行受影响插件的 Loader entry 被停止。HMR 本身不导入替换代码：新一代组合启动条目时，Loader 导入当前文件，因此停用、删除和不兼容的行永远不会执行替换代码，动态 `disabled` 表达式和嵌套 Include 按启动时的方式求值。

受影响的运行时停止，但其条目不会被标记为停用；`reconcileProfile()` 把它们传给 app-boot 的单次 `recomposeProfile()` 调用，由该调用启动它们，包括未变化 Include 之下的条目和 profile 组合之外的条目，且不会重复导入同一条目。任何插件停止之前发生的失败会让所有插件继续运行；没有新一代组合被应用时，已停止的插件以当前 resolution 重新启动。逐出之后，导入或启动失败的替换版本属于激活失败，使操作失败；其旧代码不再运行。每次重新组合都会先让 profile 根目录下的包配置失效并逐出链接失败的模块，再次导入此前导入失败的条目，因此修正后的文件或之后安装的依赖无需重启即生效。[ProfileReconciliation](../../../docs/subsystems/boot.zh.md#profile-reconciliation) 列出需要重启的变化。在重新组合期间首次加载、且其文件在比较之后被写入的模块保持陈旧，因此激活期间的写入会在下一次加载；比较或缓存检查失败时，即使无法确定已变化的 URL，也要求重启。HMR 的监听记录这些结果。

每次重新组合之后，HMR 逐出重新组合删除的映射所在目录之下的已加载模块，并使这些包的配置过期，因此已删除或取消选入的组合包连同其动态导入的依赖，在它再次出现时重新导入。组合包的包本身不是映射：其文件在磁盘上变化时被替换；关闭组合包而其文件未变化时，它的模块保持加载。runtime resolution 拒绝的发布（例如移动到其他目录的保留 profile 映射）会停止并重新启动新一代组合将删除的行，组合保持不变；结果带有 `restartReason: 'package-moved'`。

`node_modules` 之外的 `package.json` 变化使该包的配置缓存失效。仅作为配置的 manifest 不触发模块重载；作为 JSON 模块导入的 manifest 保留依赖驱动重载，位于宿主依赖图中的 manifest 保留宿主重载。专属配置监听保留原有归属。新包入口在 Loader entry 重启时生效。

Loader entry 保留原始导入结果。HMR 为每个 entry 名称与配置树 base URL 保留所有不同的已导入命名空间；尚未初始化的 entry 不会覆盖其他 entry 的命名空间。HMR 将这些对象与缓存中 ModuleJob 的模块命名空间按对象身份匹配，不再重新解析 entry 名称。没有已导入命名空间的名称和 `cordis:` 内置入口仍按名称解析。因此 `exports` 或 `main` 改变后，源码重载仍使用已加载模块。

共享同一运行时的 entry 一起替换，每个 entry 使用其自身模块对应的实现。同一模块的重复 entry 仍保有各自的插件实例。替换失败时，HMR 清理已部分激活的替换实例，并恢复原来的模块和插件实现。重载成功后更新所有匹配的 entry 记录，包括已停用的 entry；替换失败时这些记录保持不变。从未加载过的 entry 仍保持未初始化状态。

[package-manifest.ts](src/package-manifest.ts) 封装 package 读取、scope、type 和最近 manifest 查询所需的 Node internal 接口。每个 HMR 实例拥有自己的配置缓存，销毁时恢复它安装的 hook。manifest 失效会清空 ESM `ResolveCache` 和 CommonJS `_pathCache`：它们都不记录查询过的全部 manifest，入口也可能指向包目录之外。CommonJS 加载先用 Node 默认 resolver 解析请求，再进入原生 loader，绕过旧请求别名并保留已求值模块。同步 resolve hook 收到的是解析后的文件名。普通模块替换仍由 HMR 独立处理。

被监听模块的路径沿用 Node ESM 解析所用的 `realpathSync()` 表示，包括 Windows 短目录名，使文件事件与模块缓存匹配。

模块替换实现源自 `@cordisjs/plugin-hmr` 1.0.15，包含 Harness 的 Node loader 和惰性配置修改。保留其 [MIT 许可证](LICENSE)。

</details>

<a id="model-experience"></a>
## 模型体验

### 被重载的插件

#### 模型看到什么

`ctx.hmr` 不添加模型工具或消息。加载后的插件决定后续工具和提示词贡献。

#### Token 影响

没有直接的 token 贡献。

#### KV Cache 影响

重载提供上下文的插件可能改变后续请求前缀；HMR 不改写对话历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 模块替换需要 Node loader 内部接口。框架依赖变化调用宿主提供的 `loader.exit()` 钩子；HMR 本身不重启进程。
- 仅限于 `package.json` 的变化不会被检测到。`node_modules` 之下 manifest 的监听通知仍被忽略。浏览器 Client 模块图保留独立的浏览器侧加载机制。
- 替换沿静态导入传播。对陈旧模块的动态 `import()` 在下次调用时求值新文件，而其导入方继续运行；已存在的 Worker 和 TSX loader 线程保留各自的模块缓存。
- profile 的 `node_modules` 之下的每个符号链接都会扩大比较范围。链接进程入口（通过 bin 链接的真实路径定位）静态导入的包（例如来自 dsh checkout 的 `dsh-app-boot`、Cordis 或 Loader）会把宿主模块纳入范围；这些模块的变化保持待处理，Plugin Manager 对后续操作报告 `restart-required`，直到进程重启。Loader entry 导入的已链接 dsh 包与其他插件一样被替换。
- 比较记录属于单个 HMR 实例。重启 `hmr` 条目本身的重新组合会重新记录当前文件，因此此时待处理的变化不再被报告或重试。
- 导入或启动失败的替换版本保持未激活，直到其文件或依赖被修正；旧版本不会被恢复。
- 兼容性检查只在 DSH 组合行时运行：启动、profile 重新组合和 preset 挂载；Loader 导入模块时不做任何检查。被替换的 profile 行会通过重新组合的预检，但 profile 组合之外的行（例如 preset 行，或通过 `ctx.loader.create()` 添加的条目）以替换后的代码重启，不经检查。Plugin Manager 拒绝不兼容的版本，因此这只影响在它之外变化的包，例如在 profile 目录中手动执行 `pnpm add`，或重新构建的 `link:` 包。
- [打包 worker loader](../../experimental/webworker-runtime/src/module-system/module-loader.ts) 不暴露 Node 的 `loadCache` 或 `require.cache`；配置重新组合仍可执行，但代码替换需要重启。原生 Node 即使使用异步模块 hook 也保留这些缓存。[打包 worker 浏览器测试](../../../apps/web/tests/preview-boot.e2e.ts) 覆盖此部署。
- 新加载文件首次在重新组合结算后记录，其修改时间晚于比较时间时计为已变化。比较时间是 HMR 在临时目录中写入的标记文件的修改时间，因此在同一台机器上，两者都来自为本地文件写入记时的时钟；在比较之后、处于 profile 所在文件系统时间戳精度之内的修改被视为更早，可能被漏检；网络文件系统使用服务器的时钟为写入记时。
- 若文件被替换为指向较旧 store 文件的硬链接，它保留较旧的修改时间；当其模块在上次记录之后才首次加载时，该变化不会被检测到。
- HMR 自身监听触发的 profile 重新组合不会因仅涉及依赖的 manifest 变化而执行，因此在 Plugin Manager 之外执行的安装在下一次重新组合或重启时生效。
- TSX loader 和普通应用自行创建的 Worker 不在包缓存刷新支持范围内。
- CommonJS 请求必须能由 Node 默认 resolver 解析。同步 hook 可以像 Desktop 的 Office resolver 一样处理解析后的文件名；依赖原始请求名或引入虚拟请求的 hook 不受支持。内置模块保留 Node 原有的加载行为。
- 后续工作：跨 HMR 销毁和替换保留包配置失效状态。恢复原生 reader 后，其旧配置缓存可能重新可见。
- 如果共享运行时的替换模块具有不同的插件回调，没有 Loader entry 的实例就无法确定应使用哪一个。HMR 会报告歧义错误并回滚此次重载。
- `watchConfig()` 在 Chokidar 报告就绪时 resolve。darwin 上 libuv 随后才在自己的线程启动 FSEvents 流，因此注册后数毫秒内落地的写入要等到该目录的下一个事件才会被报告；启动之后的编辑不受影响。

### 开发备注

<a id="dev-note"></a>

无。
