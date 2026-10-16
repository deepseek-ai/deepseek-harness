# Agent Note: profile 重新组合时替换已加载包文件发生变化的插件

Status: implemented

[English](2026-10-01-replace-changed-package-modules-on-recomposition.md) | 中文

## Problem

Node 按文件 URL 缓存已求值的模块。profile 使用 pnpm 的 hoisted 布局安装包，因此无论版本如何，包都位于 `node_modules/<name>`。覆盖、升级或重装包时所有文件 URL 保持不变，之后的导入或 Loader entry 重启返回的是旧版本的缓存模块。[包刷新说明](2026-09-30-profile-package-refresh-and-manifest-invalidation.zh.md)刷新 runtime resolution 和包配置，但不处理这一模块缓存；因此 Plugin Manager 把覆盖报告为 `restart-required`，而删除后在同一路径重装时报告 `applied`，旧版本却仍在运行。`link:` 开发包的构建输出变化时也会命中同一缓存，除非其目录列在 HMR 的源码监听根目录中。

## Decision

### 唯一的重新组合路径

`Hmr.reconcileProfile()` 是 HMR 的 profile 监听和 Plugin Manager 共用的 profile 重新组合入口；Config Editor 仍直接通过 app-boot 重新组合。它在 `runExclusive()` 内运行。Plugin Manager 只编辑 profile 文件并运行 pnpm；对于在运行 pnpm 之前能确定包名的已安装包，它拒绝覆盖安装；安装另一个版本需要先卸载再安装，每一步各有一次重新组合。一次重新组合的步骤如下：

1. 读取 profile patch，将 profile 目录及其已链接包目标之下的已加载模块与磁盘比较。
2. 按下文规划替换；patch 读取或比较失败时，在任何模块变化之前抛出错误或报告失败。
3. 逐出可替换的已变化模块及其导入方。若已变化模块的导入方可到达进程入口的静态依赖图，或可到达没有 Loader entry 拥有的插件，该模块连同其导入方保持加载；其余变化照常处理。
4. 通过删除运行时停止运行被替换插件的 Loader entry，使 Loader 不把它们记录为已停用。
5. 以停止之前正在运行的条目调用一次 app-boot 的 `recomposeProfile()`。它记录激活状态，把新一代组合不再列出的行从其所在组中移除，以停止这些行，发布 runtime resolution，基于已发布的包运行兼容性预检，然后应用新一代组合。Loader 在启动条目时导入当前文件：新一代组合保留的行以新代码和新配置启动一次；停用、拒绝或删除的行保持停止，不会运行新代码；新插入的条目链接当前文件。更新未尝试启动的已停止条目（位于未变化 Include 之下或 profile 组合之外）随后启动；更新期间导入失败的条目会再导入一次。随后判定激活结果：之后失败的已停止条目使操作失败；等待服务的条目只是警告，因为出现提供方后它即启动。若没有新一代组合被应用，已发布的 resolution 和已停止的行被恢复，已停止的条目重新启动。
6. 逐出重新组合删除的映射所在目录之下的已加载模块，使已删除或取消选入的包连同其动态导入的依赖在重新加入时重新导入。关闭组合包而其包仍有映射时，它未变化的模块保持加载。

### 检测已变化的模块

[`ModuleFiles`](../../../../packages/boot/hmr/src/module-files.ts) 为 profile 目录及其已链接包的真实目录之下已加载的 ES 和 CommonJS 模块记录 inode、大小和修改时间。dsh 安装目录中的模块不在此范围内。不记录状态变更时间：pnpm 通过硬链接从其 store 导入包，在其他位置添加链接会改变已加载文件的状态变更时间，而内容不变。记录发生在应用就绪时和每次重新组合之后；源码重载重新求值模块时，也为这些模块记录。重新组合记录的是它在替换任何模块之前读取的文件身份，因此重新组合期间发生的写入仍可被检测到；在重新组合期间首次加载的模块在结算后记录，避免下一次安装时发生不必要的重启。首次求值与记录之间的修改可能漏检；时间戳兜底仍覆盖重新组合之外首次加载的模块。就绪时的观察失败时，兜底从 HMR 构造时间开始，而非 Unix 纪元。文件已消失或身份不同的模块视为陈旧。在上次记录之后才首次加载的模块没有记录；若其文件的修改时间不早于该次记录时间减去 2 秒文件系统时间戳精度，则视为陈旧，因此不会漏掉在加载与下一次比较之间发生的重装。比较不参考版本号：lockfile 不为 `file:` 和 `link:` 依赖记录内容标识，而文件身份同样覆盖 registry、tarball、目录和 link 安装。

### 替换

导入方闭包可到达进程入口静态依赖图（包括已安装包）的陈旧模块保持加载，并被报告。其余陈旧模块及其静态导入方（沿 ES 模块链接和 CommonJS `require` 子模块）构成受影响集合，从每个陈旧文件到其 profile 根目录或链接目标的各级 manifest 都通过 `PackageManifests.invalidate()` 失效。整个受影响集合在重新组合之前被逐出且不保留备份，因此重新组合期间执行导入的每个条目都读取当前文件。在 Loader entry 之外注册的插件没有能启动其替换版本的所有者，因此其模块导入的变化保持待处理；插件从 ES 模块命名空间和已缓存的 CommonJS exports 中读取，因此通过 `require` 注册的 CommonJS 插件同样保留其缓存。HMR 本身不导入替换代码，因此是否允许加载由 Loader 的普通激活决定：停用、删除或被拒绝的行永远不会对新模块求值，动态 `disabled` 表达式和嵌套 Include 按启动时的方式求值。每次重新组合都会先让 profile 根目录下的包配置失效，并逐出链接或求值失败的模块（Node 会在缓存中保留这些模块），再次导入上次导入失败的每个已启用条目，因此修正后的文件或之后安装的依赖无需重启即生效。只有当受影响插件自身的 Loader entry fiber 启动某个插件时，该插件才算有所有者；由另一个插件通过动态导入注册的已变化插件保持待处理。被替换插件中未变化的依赖不会重新求值，因此共享库保持单一实例。通过 `partialReload()` 进行的源码重载保留其自身带回滚的原地替换。

`reconcileProfile()` 返回 `pending`，即每个只有重启后才能加载的陈旧模块及其原因（`host-module`、`unmanaged-plugin`，规划失败时为 `module-comparison`）。待处理模块保持陈旧，包括在上次记录之后才首次加载的模块，因此下一次重新组合会重试它们。在重新组合期间首次加载、且其文件在比较之后被修改的模块同样保持陈旧：激活可能在该写入之前已对其求值。列出或比较模块时发生的失败会保留原有记录，并设置 profile 级 `restartReason: module-comparison`，即使无法确定模块 URL。两种情况都不会阻止重新组合。激活失败（包括替换版本导入失败）会连同 Loader 的导入错误一起抛出；未变化的失败在后续重新组合中作为警告返回。Plugin Manager 把抛出的失败报告为带该诊断的 `failed`，把 `pending` 转为带其 `restartReason` 的 `restart-required`，除非操作报告 `overridden`。Web 页面本地化该原因，agent 工具据此生成一句 `nextStep`，因此没有任何界面解析诊断字符串。

[打包 worker loader](../../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts) 在私有映射中保存已求值模块，其 `require` 不暴露缓存。HMR 无法通过 Node API 替换它们，因此报告需要重启。原生 Node 使用异步模块 hook 时仍暴露其缓存。

### Plugin Manager 与 runtime resolution

对于在运行 pnpm 之前能确定包名的已安装包，Plugin Manager 拒绝覆盖安装，因此新版本或新位置需要先卸载再安装：卸载停止插件、逐出其模块并删除映射，安装再重新映射该包。runtime resolution 接受保留的 profile 映射在规范化目录和作用域不变时更改版本，即共享依赖被另一次安装升级的情形；移动到其他目录的映射被拒绝。linked root 可以指向其他目录；对于原目标之外的导入方，Node 缓存的链接真实路径若选中原目标之下的文件，该文件会被重新定位到当前目标之下。被拒绝的发布，包括对安装范围映射或本地覆盖的更改，不改变 resolution 和组合，并报告原因是 `package-moved` 的 `restart-required`。

## Alternatives considered

**由 Plugin Manager 单独调用包替换。** Plugin Manager 知道自己安装了哪个包，但不知道哪些 Loader entry 导入了它；新组合包 patch 中的行增加、删除和配置变更也必须在同一步应用。第二个操作会把一次 profile 变更拆成两个顺序未定义的事务。重新组合本来就会读取新的 profile；在此处比较已加载文件，同时覆盖 Plugin Manager、之后执行重新组合的 CLI 安装以及 link 构建。

**比较 profile manifest 或 lockfile 中的包版本。** profile manifest 存储的是 spec，不是解析后的版本，`pnpm update` 可以在不修改 spec 的情况下改变版本。lockfile 不为 `file:` 和 `link:` 依赖记录内容标识，而同版本重装 tarball 会改变内容却不改变版本。

**让 app-boot 在其重新组合内部调用 HMR。** 为应用之前和判定之前的步骤提供 hook，会把一次操作的顺序拆分给两个所有者。HMR 改为先停止它替换的所有内容，再把已停止的条目传给一次 app-boot 调用。

**向 HMR 暴露重新组合的各个阶段。** 分别调用记录激活状态、发布后准备、应用、恢复和丢弃映射，可让 HMR 在其间插入停止操作，但会给调用方留下类型无法表达的顺序义务。在调用之前停止插件，代价是准备失败时需要重新启动已停止的插件。

**发布两次，在应用新一代组合期间保留被丢弃的映射。** 同时包含新映射和被丢弃映射的临时表，可以让一次 Loader 更新既停止又启动条目，但它是第三个 generation，更新失败时必须仍能重新计算。先停止被丢弃的行，之后只需发布一次。

**在一次操作中覆盖已安装的组合包。** 在 pnpm 运行之前停止该组合包、之后再启动，或根据已加载模块文件检测已移动的包，可以让升级只需一次调用；但这需要为每种 pnpm 失败提供重启路径、按原顺序恢复选择列表，并为已移动的目录制定释放规则。拒绝覆盖安装后只剩卸载和安装，现有操作已按此顺序执行。

**预加载替换版本，并在其加载失败时保留原插件。** HMR 将在停止旧运行时之前导入新代码，并在失败时恢复旧缓存。预加载不得对新一代组合停用、删除或拒绝的行求值，因此 HMR 要先于 Loader 决定是否允许加载；动态 `disabled` 表达式和嵌套 Include 不经激活就无法判定，因此这些变化需要重启。回滚还必须删除已恢复模块的新导入方，而旧代码仍会收到新配置。重启会加载相同的损坏文件，因此保留原插件只是推迟一个无论如何都需要修复的失败。

**在重新组合之前原地重启被替换的插件。** 新代码会先以旧配置启动，而升级后的版本可能拒绝旧配置；新组合停用或拒绝的行（例如安装失败后留在磁盘上的不兼容版本）也会短暂运行。

**在重新组合之后替换运行中的插件。** 重新组合会以新配置重启旧代码，而旧版本可能拒绝新配置，导致一次成功的升级被报告为失败；重新组合期间插入的条目也会链接到仍为运行中插件缓存的、已变化依赖的旧副本。

**在 pnpm 运行前停止受影响插件。** 这能防止旧代码惰性加载 pnpm 已经替换的文件，但会让整个安装期间插件不可用，并在 pnpm 运行期间占用 HMR 队列。

**重新求值被替换插件的全部依赖。** 源码重载会重载插件在 `node_modules` 之外的依赖树。若对 `node_modules` 之下做同样处理，会为其他插件使用的、未变化的共享库和 Cordis 包创建第二个实例。

**在模块加载 hook 中记录文件身份。** `module.registerHooks()` 可以在加载时记录每个文件，消除两次记录之间加载的模块的检测空窗，但这会给每次模块加载增加一个 hook，并与 TSX 和 vendored Loader 的内部机制相互影响。时间戳规则在该空窗内只会导致一次多余的重载。

## Consequences

- 通过卸载再安装进行的升级，以及文件被原地更改的包，在替换版本成功加载并启动时无需重启即生效；替换版本加载或启动失败时，原插件停止并报告 `failed` 及该错误，其文件或依赖被修正后它即启动。
- 每次重新组合对 profile 的所有已加载文件执行一次 stat；有文件变化时才遍历模块图，宿主依赖图在首次使用时收集。
- 不跟踪动态 `import()` 边：导入方继续运行，而其下一次动态导入会求值新文件。已存在的 Worker 和 TSX loader 线程保留各自的缓存。
- 被替换的 Loader entry 在重新组合之前停止，之后启动一次；旧版本不会恢复。
- profile 组合之外的 Loader entry 以替换后的代码重启，不重新进行兼容性检查（[限制](../../../../packages/boot/hmr/README.zh.md#known-limitations-and-deferred-work)）。
- `ModuleFiles` 属于单个 HMR 实例。重启 `hmr` 条目本身的重新组合会启动一个新实例，其首次观察记录当前文件，因此此时待处理的变化不再被报告或重试。
- `pending` 描述整个 profile，因此由已链接工作区包纳入范围的宿主模块，会使后续无关操作也报告 `restart-required`，直到进程重启。
- 若文件被替换为指向较旧 store 文件的硬链接，它保留较旧的修改时间；当其模块在上次记录之后才首次加载时，该变化不会被检测到。
- 仅限于 `package.json` 的变化不会被检测到。HMR 的 profile 监听不会因仅涉及依赖的 manifest 变化而重新组合，因此在 Plugin Manager 之外执行的安装要等到下一次重新组合或重启。

## Verification

| 覆盖面 | 位置 |
|---|---|
| 伴随组合包 patch 变更的原地升级、旧版本拒绝的配置、新插入的条目和停用行、没有 Loader entry 的插件、共享依赖的导入方、已链接包、硬链接、CommonJS `require` 子模块及其失败、替换失败与重试、嵌套 group 和 Include、动态停用、同路径重装、延后加载的模块、宿主依赖图中的模块、比较失败与重新组合失败、逐出重新组合不再使用或已删除其映射的包，以及发布被拒绝或准备失败后已停止条目的重启 | `packages/boot/hmr/tests/package-reload.spec.ts` |
| 被拒绝的覆盖安装、有 HMR 时先卸载再安装、安装失败、重新链接和从链接改为 registry 的重装、非托管插件、比较失败 | `packages/boot/plugin-manager/tests/package-reload.spec.ts`、`packages/boot/plugin-manager/tests/manager.spec.ts` |
| profile 映射原地更改版本、保留目录和作用域的拒绝（包括 profiles 树内重新链接的路径）、重新链接的 root 以及被重新定位到当前目标之下的原生查询 | `packages/boot/app-boot/tests/profile-resolution.spec.ts` |

测试不需要 API key，不调用模型。
