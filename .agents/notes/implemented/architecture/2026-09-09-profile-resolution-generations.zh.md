# Agent Note: 增加不可变 profile 解析代际

Status: implemented

[English](2026-09-09-profile-resolution-generations.md) | 中文

## Problem

profile 从自己的包项目加载插件配置项，而 Harness 包和所选 bundle 携带的包可能位于该项目普通依赖树之外。通过共享 symlink、profile 自有链接或打包可执行文件的代理包连接两棵依赖树，会让选包结果跨进程和安装版本持续存在。这些文件需要协调和锁来维护，并向元数据读取方暴露生成的代理 manifest（元数据清单），也无法原子表示进程内变更。

运行时设计保留安装优先、有序 bundle 和本地包优先于 fallback 的顺序。它覆盖插件模块内部的 import 以及 Loader 配置项的 import，并在主线程和 Harness 自有 Worker 中工作。generation 替换保留既有包映射和本地包名，允许调整 linked root 集合，不会逐项修改正在使用的表。

## Decision

profile 启动生成一个不可变 `RuntimeResolution`，并将其安装到 Node 的 ESM 与 CommonJS 解析器。runtime 是唯一的解析后端，不提供模式选择器或磁盘物化器。`PluginPackages.replace()` 通过一次引用替换发布完整的后继 generation。

### 唯一选包算法

包遍历属于 `@deepseek-ai/dsh-app-boot`，与 profile 加载代码放在一起。普通 Node、源码启动、打包可执行文件和 Electron Host 消费相同的 runtime resolution 与拦截。

安装 manifest 是第一个根。它按 BFS 依次遍历 `dependencies` 和 `peerDependencies`，每条边从声明它的 manifest 解析，同名包由第一次找到的已安装包占有。所选 bundle 随后按 profile 顺序逐根遍历；每个较早根的完整依赖图优先于所有较晚根。安装闭包中的名称被保留，bundle 包根本身不成为插件 fallback。已声明但未安装的包会被跳过。

依赖展开时，每个安装根、所选 bundle 根和递归依赖 manifest 都以所属包的真实目录作为查找锚点。因此，祖先 `node_modules` 查找沿 Node 通常执行该包的位置进行，而不是沿指向该包的软链接位置进行。同一声明锚点会被记录下来，供运行时委托解析使用。逻辑路径与真实路径的祖先不同时，这可能改变所选版本，也可能使原本能发现的依赖不再被收录；它不只是对已存路径换一种写法。

profile 本地和插件私有 `node_modules` 条目优先于 runtime resolution 条目。runtime resolution 记录已安装的 profile 直接包名，用于无 I/O 的原生快速分流。每个条目记录包名、版本、选定的查找目录、声明该边的 manifest 锚点和作用域，供原生解析与后继 generation 校验使用。

对于 profile 无法通过自身祖先目录找到的依赖，runtime resolution 的 profile 作用域条目仍然必要。它们将已安装 manifest 中的依赖展开到当前 profile 的 runtime resolution，而不是为每个插件建立独立依赖图。它既不下载包，也不扫描源码 import。运行时钩子在考虑原生本地候选后使用这张表。

### 普通安装与软链接示例

下面两种布局中，profile 都选中 `my-bundle`，其 manifest 声明 `bridge`；只有 `bridge` 声明 `leaf`。安装包集合和 profile 的直接包都不提供 `leaf`，`bridge` 也没有私有 `node_modules/leaf`。这些路径示意了[共享 CLI（命令行界面）profile 测试](../../../../apps/cli/tests/profiles/headless/tests/profile-resolution.ts)覆盖的两种布局。

普通安装目录中，`bridge` 向上查找所属 bundle 的 `node_modules`，找到版本 1.0.0。另一个版本 2.0.0 不在这条查找路径上：

```text
/case/home/profiles/headless/node_modules/my-bundle/
  node_modules/bridge/
  node_modules/leaf/                                  # 1.0.0
/case/dependencies/node_modules/leaf/                 # 2.0.0
```

bundle 采用 npm-link 风格链接，且其传递依赖也被软链接时，bundle 从 `/case/work/my-bundle` 展开，下一层依赖则从 `/case/dependencies/bridge` 开始展开。该次展开找到真实包旁边的版本 2.0.0：

```text
/case/home/profiles/headless/node_modules/my-bundle -> /case/npm-global/node_modules/my-bundle
/case/npm-global/node_modules/my-bundle -> /case/work/my-bundle
/case/work/my-bundle/node_modules/bridge -> /case/dependencies/bridge
/case/work/my-bundle/node_modules/leaf/                # 1.0.0
/case/dependencies/node_modules/leaf/                 # 2.0.0
```

| Profile 包布局 | 解析 `leaf` 时使用的声明目录 | `tsx/esm` 源码启动 | 普通 Node `lib` 启动 |
|---|---|---|---|
| 普通目录 | `/case/home/profiles/headless/node_modules/my-bundle/node_modules/bridge` | 1.0.0 | 1.0.0 |
| bundle 与 bridge 均为软链接 | `/case/dependencies/bridge` | 2.0.0 | 2.0.0 |

ESM `import` 和 CommonJS `require` 都选中这些版本。在每种模块格式内部，通过 profile fallback 导入 `leaf` 与在 `bridge` 内部导入它，会得到同一个模块实例。优先级更高的原生 profile 包，或安装集合已保留的同名 fallback，仍按选包规则优先；fallback 不会强制所有导入方都使用版本 2.0.0。

### 源码与构建产物的模块身份

[源码启动器](2026-07-29-dsh-source-launch-tsx-esm.zh.md)使用 tsx 的 ESM-only 钩子。导入方 URL 含有 `/node_modules/` 时，tsx 会跳过 tsconfig `paths`。因此，把 workspace 软链接的逻辑路径用作 fallback 声明锚点，可能选中构建后的 `lib/` 导出，而这些模块在真实 workspace 路径中发起的 import 又通过 paths 映射选中 `src/`。真实声明锚点让 workspace import 一致遵循源码映射；没有匹配 workspace 映射的包仍使用普通包导出解析。

例如，`@deepseek-ai/dsh-tools` 使用 `Symbol()` 创建 scheduler 键。从 `lib/` 加载的 Tools 实例，无法通过另一个 `src/` 模块实例导入的键暴露该 scheduler。源码启动让 Tools 与 AgentLoop 都位于 `src/`；普通 Node 启动让两者都位于 `lib/`。scheduler 保留模块本地的 Symbol；正确的 import 共享同一个模块实例。

源码启动器不安装 CommonJS TypeScript 钩子。`createRequire().resolve()` 仍选择包发布的 JavaScript 入口，并要求该文件存在。因此，源码模式的解析测试使用 fixture 提供的 CommonJS 文件，真实安装包的 CommonJS 入口检查则在构建产物存在时运行。

<a id="immutable-generations"></a>
### 不可变 generation

一个 runtime interception 持有一个 `current` generation。每个同步 resolve 在入口只捕获一次该引用，完整调用只读该引用。generation 构造在发布前读取依赖图所需的全部 manifest；失败时当前 generation 不变。发布成功只替换一个引用，执行中的调用可以继续使用它已捕获的 generation。

选包缓存和包元数据缓存归 generation 所有。发布下一代后，旧 generation 在调用方退出后自然不可达，不逐项清理缓存。profile importer 的命中和原生解析成功结果可以缓存，但 generation 未命中会重新扫描，因此未命中后安装的 profile 本地包会通过原生查找变为可见。linked importer 的路由不缓存，每次解析读取所访问祖先位置当前的 peer 声明。显式 CommonJS paths 完全绕过拦截，非默认 conditions 不复用默认解析缓存。

linked root 集合在一个 generation 内不可变。后继 generation 可以增加或移除 root，无需重启进程。目录不再被任何剩余 root 覆盖时，该目录后续的解析使用原生 Node 查询，包括已加载模块发起的新请求。请求可能因此选中开发副本，也可能因缺包而失败。移除拦截不会卸载模块、替换已有引用或清空 Node 自身的缓存。

解析器在自身生命周期内保留每个已成功发布的 link 名称对应的真实目标，仅用于校验后继 generation。移除 root 不会抹掉该记录，也不会让其目录继续被拦截。同名、同目标可以重新加入；不同目标会被拒绝，因为 Node 缓存真实路径。发布失败时，当前 generation 和已记录目标均不变。

launcher 只构造启动 generation。服务接受完整的后继 generation，但本实现没有包管理器事务调用替换操作。

### ESM 与 CommonJS 共用规则

resolver 使用 `node-addon-require-builtin` 读取 `internal/modules/esm/loader` 和 `internal/modules/cjs/loader`。ESM 适配器包装每线程单例 `CascadedLoader` 的 resolve 方法。CommonJS 适配器包装内部 builtin 导出的 `Module._resolveFilename`；该 `Module` 与 `node:module` 导出的对象相同。

两个适配器调用同一个路由函数。builtin、相对或绝对路径、URL、profile 与已记录 linked root 之外的 parent，以及所有带显式 `paths` 的 CommonJS 请求，都直接委托原生实现。`#imports` 请求使用所属 manifest 中的 Node 映射；外部 bare target 按请求的 conditions 遵循相同选包顺序，精确 target 解析仍由 Node 负责。包自引用保留原 parent，包括 npm alias。profile 使用固定拦截位置，linked importer 则在每个原生祖先位置应用当前 peer 条件。原生 CommonJS 探测决定旧式子路径缺失是否继续查询下一个位置。完整选包规则由[查找顺序 Note](2026-09-19-profile-resolution-lookup-order.zh.md)统一记录。

适配器完成路由后调用捕获的原生 resolver。exports、import/require conditions、main、subpath、扩展名、原生缓存和错误码仍归 Node 处理。路由后的 ESM 失败会把 Node 诊断中的内部查找锚点替换为原始 importer。选中包的无效 export 或缺失目标不会触发另一个同名候选。CommonJS 不替换 `_findPath`，也不复制 `_resolveFilename`。

保证范围是当前线程安装后发生的 Node 默认 `import`、`import()`、`import.meta.resolve`、`require` 和 `require.resolve`。已经链接的模块、自定义 `vm` linker、不透明的非 Node importer 和第三方 Worker 不在透明保证范围。

### 活动插件列表与包元数据

runtime resolution 列出它提供的包；Loader entries 组成活动插件列表，两者不能合并。消费方继续使用 Loader 原有 entry 生命周期，并按自身 scope 过滤相关 entries。需要 package metadata 的消费方将 specifier 和所属树的 base URL 交给 app-boot 中的轻量服务，无需 package 导出 `./package.json`。安装 runtime resolution 后，即使查询未命中也以它为准；底层嵌入方只安装服务而不提供 runtime resolution 时，服务保留 Node 原生查找。

解析器不提供 `imported(entry)`，不观察 ModuleJob，不包装 Entry 方法，不把 fiber 与 import 调用关联，也不替换 registry、tree 或 HMR 方法。包目录查询使用相同选包规则，包括 linked importer 祖先当前的 peer 声明，但不校验所请求的子路径或加载文件。需要包元数据的非 Node importer 必须显式实现同一个 resolver 接口。

实现集中在 `app-boot/src/profile-resolution/`。`service.ts` 提供长期存在的 `ctx.pluginPackages`，并拥有主线程拦截与 Worker runtime resolution 的生命周期；`resolver.ts` 实现 runtime resolution 查询和 Node Internal 适配器；`worker-bootstrap.ts` 在线程内安装继承的 runtime resolution。profile 选包和 runtime resolution 构造留在 `profile.ts`。Worker 只通过 `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap` 公开入口引用 bootstrap。

服务定义与提供方继续放在 `app-boot`，因为 profile boot 拥有 resolver 生命周期。出现与 launcher 无关的提供方或需要独立演进的消费方时，再抽出单独的能力 seam。

### Worker 与 generation 更新

主线程通过 Worker environment data 发布当前 generation 的可结构化克隆表示和 profile scope。每个 Harness 自有 Worker 构建产物通过构建 banner 获取自己的 ESM/CJS Internal 并安装同一适配器，不重新遍历 manifest。bootstrap bundle 不静态导入任何包。源码 Worker 入口保持原有自包含依赖；第三方 Worker 保持不变。

新 Worker 继承最新发布的 generation。已运行的 Worker 保留启动时继承的 generation，因此发布后继 generation 的调用方必须重启它们。ESM bootstrap 无法影响其执行前已链接的静态依赖，因此 Worker bundle 必须保证 bootstrap 之前的静态 import 可由原生 Node 解析，需要 profile resolver 的业务入口在 bootstrap 后通过 dynamic import 启动。

### 只增加包的变更

添加包的调用方先完成 pnpm 事务，再构造下一代。替换操作会拒绝改变任何既有 package name 的目录或版本。调用方先发布只增加映射的后继 generation，再挂载新的 Loader 配置项；本实现不提供该包事务。挂载失败可以留下已安装但未启用的包。

修改或删除既有运行时包映射，或删除已记录的 profile 本地包名，需要重启，因为 Node 的 ESM Module Map、CommonJS cache、现存对象引用和运行中的 Worker 都可能保留旧模块 identity。这些限制不禁止从拦截范围移除 linked root。generation 换代不声称卸载模块。

### 文件系统与运行时载体

解析器不创建、更新或删除 fallback 软链接与代理包。runtime resolution 条目占据 `$DSH_HOME/profiles/node_modules` 上各自的包名位置；其余包名把该目录当作普通祖先。构造时记录目标同时位于共享 profiles 树和当前 profile 自身之外的目录链接，包括没有自身 manifest 的目标。installation 作用域包目录不参与 linked 拦截，即使更宽的 linked root 包含它们。符合条件的 linked importer 保留原生祖先顺序与逐位置的 peer 映射。优先级和范围见[查找顺序 Note](2026-09-19-profile-resolution-lookup-order.zh.md)。可写 profile 状态和包管理器事务不属于解析器。

运行时解析要求受支持的 Node Internal loader 接口。Electron Host 通过设置 `ELECTRON_RUN_AS_NODE=1` 的 Electron 可执行文件运行；打包构建从 ASAR 读取 dsh 依赖树，并把 ASAR 中的可执行条目映射到 electron-builder 的 unpacked 目录。pkg 与 Electron 使用和普通 Node 启动相同的 runtime resolution 机制。

### 性能与验证

generation 构造发生在启动或显式更新阶段，不属于单次 resolve，但需要单独报告绝对延迟。profile 热路径只包括 scope 分类、bare name 提取、本地优先判断、Map 查询和一次原生解析；缓存命中直接返回 generation 级结果。linked importer 请求运行时表提供的包名时，读取所访问的祖先 manifest，不缓存选中的路由。旧式子路径缺失时，CommonJS 可以探测多个位置。作用域外调用不读取 manifest，只缓存 parent 是否具有拦截层。

实现期间的一次性本地测量用 plain Node 在全新进程中执行构建后的 JavaScript，并与完全没有安装 hook 的进程比较。测量脚本和结果未提交，这些数据不是 benchmark 或 CI 预算。七轮交替顺序覆盖 outside、profile-local 和 fallback 的 dynamic import、`import.meta.resolve`、require、`require.resolve`。Node 22.19、24.18 和 26.8 的热路径中位数最大正向回退为 4.5%。Node 24.18 的 256 包 cold workload 最大回退为 11.2%，generation 构造中位数为 16.027 ms；32 包本地 `require.resolve` 因固定启动成本在整批增加 1.033 ms（+34.7%）。

行为测试覆盖根顺序、传递依赖和 peer、本地与外层优先级、exports 与 subpath 错误、conditions 和显式 CommonJS options。Node 兼容矩阵会在受支持的内部 loader 变体上运行解析器、服务和 bootstrap 规格。Worker 测试通过 mock 线程与原生 loader 接口验证 environment data 发布和 bootstrap 安装，但不会启动构建后的 Worker。generation 测试证明构造失败不发布部分状态，成功换代只做原子引用替换。

## Alternatives considered

**永久保留磁盘投影。** 这能在没有进程钩子时沿用原生查找，但仍有跨进程写入、陈旧 generation、代理 manifest、写锁和打包运行时差异。把 link 与 dual 保留为对比模式，也会留下没有受支持启动器需要的物化器及其生命周期。

**保留软链接逻辑锚点。** 这会沿软链接的祖先查找，但可能选中与真实包内部 import 不同的依赖，也可能抑制 tsx 的 workspace paths 映射。规范化锚点让 eager 依赖发现与运行时委托解析都对齐包的执行位置。

**在 resolve 时惰性扩展依赖图。** 这会把 manifest 读取和错误分散到首次使用，改变磁盘实现的时机，使 Worker 启动更复杂，并让热路径成本随依赖图变化。完整构造 generation 更容易比较和原子替换。

**使用 `module.registerHooks`。** 公共 API 会在 profile scope 拒绝请求之前让相关解析进入 Node 的全局 hook 分发。直接访问已有 ESM/CJS 内部解析器可以保留更小的快速路径，并继续让 Node 完成最终解析。

**通过 Loader 和 HMR 适配器记录每个 Entry 的实际 import。** 实际 import 记录能支持相同输入返回不同目标的有状态 resolver。本设计改为以 generation 作为确定性权威，因此这些记录只会复制 resolver 的答案，同时增加 Entry、fiber、registry、ModuleJob 和 HMR 生命周期状态。

**每次包操作增量修改一张长期表。** 增量修改会暴露半成品依赖图，并要求定点失效缓存。完整构造下一代使失败保持原子，并让所有缓存随 generation 生命周期存在。

**热替换已经加载的包版本。** 解析表换代无法使所有存活模块实例和对象引用失效。重启可以保证每个进程只使用一个 package identity。

## Verification

- 一次 eager 计算供应 runtime resolution；启动既不写入也不退休模块解析数据。
- [Generation 测试](../../../../packages/boot/app-boot/tests/profile-resolution.spec.ts)覆盖普通目录和递归软链接下的安装图与所选 bundle 图，包括逻辑锚点和真实锚点旁存在不同依赖版本的情况。测试还覆盖 linked root 移除、同目标恢复、重叠 root、原生缺包、已加载模块的新请求，以及移除后重新链接不同目标时的拒绝。
- [源码启动测试](../../../../apps/cli/tests/source-launch.compat.spec.ts)与[构建入口测试](../../../../apps/cli/tests/built-bin.e2e.ts)通过真实 CLI 运行两种 profile 布局，断言 ESM/CJS 版本、加载路径、各模块格式内的依赖身份，以及一致的 Tools/AgentLoop 模块实例和可访问的 scheduler 键。
- pkg 与 Electron 载体选择 runtime 解析；Electron 以 Node 模式从 ASAR 承载的 dsh 依赖树执行 Host，原生可执行条目保持 unpacked。
- ESM 与 CommonJS 适配器共享同一个路由器，并把最终解析委托给 Node，不使用 `module.registerHooks` 或替换 `_findPath`。
- 生产 package metadata 查询不记录 Loader import 结果，也不包装 Entry、registry、tree 或 HMR 方法。
- Node 兼容矩阵会在受支持的 loader 接口上运行主线程 resolver 规格；service 和 bootstrap 规格覆盖 Worker environment data 与安装接口，但不会启动构建后的 Worker。
- 一次性 plain Node 构建产物测量得到上述相对无 hook Node 的热路径和 cold 观察结果；脚本与结果并未提交为证据。

## Consequences

runtime 启动避免磁盘修改和代理 manifest，同时保留包优先级规则。真实目录锚点让依赖发现对齐 Node 默认加载与 tsx workspace 映射，也覆盖软链接逻辑路径会选中另一版本的情况。实现需要持续维护 Node Internal 兼容测试，并在每个自有 Worker 中尽早执行自包含 bootstrap；它不提供纯磁盘后端或 dual 对比模式。包映射和本地包名仍只允许新增；linked root 集合可以变化，而不卸载模块。
