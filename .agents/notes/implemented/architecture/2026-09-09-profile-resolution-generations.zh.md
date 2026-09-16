# Agent Note: 增加不可变 profile 解析代际

Status: implemented

[English](2026-09-09-profile-resolution-generations.md) | 中文

## Problem

profile 从自己的包项目加载插件配置项，而 Harness 包和所选 bundle 携带的包可能位于该项目普通依赖树之外。当前启动器在启动时计算包优先级，再将结果物化为共享 symlink、profile 自有链接或打包可执行文件的代理包。文件跨进程和安装版本持续存在，需要协调和锁来维护，并向元数据读取方暴露生成的代理 manifest，也无法原子表示进程内变更。

运行时设计保留现有选包规则，不另建一套包策略。它覆盖插件模块内部的 import 以及 Loader 配置项的 import，并在主线程和 Harness 自有 Worker 中工作。generation 替换只接受新增包的集合，不会逐项修改正在使用的表。

## Decision

profile 启动从磁盘 module fallback 使用的同一套依赖遍历生成一个不可变 `ResolutionGeneration`。launcher 默认使用 link 模式，保留现有的物化查找行为。内部调用方和测试可以选择 runtime 模式，把 generation 安装到 Node 的 ESM 与 CommonJS resolver；也可以选择 dual 模式，同时物化并校验同一份 generation。`PluginPackages.replace()` 通过一次引用替换发布完整的新增型后继 generation。

### 唯一选包算法

包遍历继续放在 `@deepseek-ai/dsh-app-boot` 的 profile 加载代码旁。磁盘 materializer 和运行时解析器消费同一个纯计划；两者都不持有另一份优先级算法。普通 Node 调用方可以选择 link、dual 或 runtime 模式，省略模式时使用 link。打包可执行文件与 Electron Host 会选择 runtime，因为其依赖树可能位于虚拟文件系统；dual 保留为内部对比路径。

安装 manifest 是第一个根。它按 BFS 依次遍历 `dependencies` 和 `peerDependencies`，每条边从声明它的 manifest 解析，同名包由第一次找到的已安装包占有。所选 bundle 随后按 profile 顺序逐根遍历；每个较早根的完整依赖图优先于所有较晚根。安装闭包中的名称被保留，bundle 包根本身不成为插件 fallback。与旧行为相同，已声明但未安装的包会被跳过。

profile 本地和插件私有 `node_modules` 不进入 fallback entries，由 Node 在虚拟 fallback 位置之前选择。generation 只记录已安装的 profile 直接包名用于 native 快速分流；每个 fallback 记录包名、版本、旧规则选中的查找目录、声明该边的 manifest 锚点和作用域，足以从选定包重新进入 Node 原生解析并验证换代保持既有映射。

旧 `healProfilesModuleFallback()` 保留为相同纯计算结果的磁盘 materializer，便于直接比较并避免重写旧规则。launcher 默认调用它。runtime 模式只计算 generation 而不物化，dual 模式会物化并安装该 generation 进行比较。

### 不可变 generation

一个解析器 registration 持有一个 `current` generation。每个同步 resolve 在入口只捕获一次该引用，完整调用只读该引用。generation 构造在发布前读取所有必需 manifest；失败时当前 generation 不变。发布成功只替换一个引用，执行中的调用可以继续使用它已捕获的 generation。

选包缓存和包元数据缓存归 generation 所有。发布下一代后，旧 generation 在调用方退出后自然不可达，不逐项清理缓存。generation 命中和原生解析成功结果可以缓存，但 generation 未命中会重新扫描，因此未命中后安装的 profile 本地包会像 link 模式一样变为可见。显式 CommonJS paths 或非默认 conditions 不得复用默认解析缓存。

launcher 只构造启动 generation。服务接受新增型后继 generation，但本实现没有包管理器事务调用替换操作。

### ESM 与 CommonJS 共用规则

resolver 使用 `node-addon-require-builtin` 读取 `internal/modules/esm/loader` 和 `internal/modules/cjs/loader`。ESM 适配器包装每线程单例 `CascadedLoader` 的 resolve 方法。CommonJS 适配器包装内部 builtin 导出的 `Module._resolveFilename`；该 `Module` 与 `node:module` 导出的对象相同。

两个适配器调用同一个路由函数。builtin、相对或绝对路径、URL、profile 作用域外 parent 和支持的查找以外的显式调用都直接委托原生实现。`#imports` 请求使用所属 manifest 中的 Node 映射；外部 bare target 按相同 conditions 遵循本地包、generation 和 after-fallback 的选包顺序，精确 target 解析仍由 Node 负责。对于作用域内的 bare request，package self-reference 保留原 parent，即使 npm alias 使安装目录使用另一个名称。Node 能在虚拟共享 fallback 之前从 profile 本地包或插件私有包解析到所请求入口时，也保留原 parent；没有 `exports` 的 CommonJS 包目录仅缺少所请求 subpath 时，不会压过 fallback。其他请求在 generation 命中时通过该条目的声明锚点解析，未命中时从虚拟 fallback 之后继续原生查找。显式 CommonJS path 列表按调用方顺序，对每个 path 独立应用相同的插入规则。

适配器完成路由后调用捕获的原生 resolver。exports、import/require conditions、main、subpath、扩展名、原生缓存和错误码仍归 Node 处理。路由后的 ESM 失败会把 Node 诊断中的内部查找锚点替换为原始 importer。选中包的无效 export 或缺失目标不会触发另一个同名候选。CommonJS 不替换 `_findPath`，也不复制 `_resolveFilename`。

保证范围是当前线程安装后发生的 Node 默认 `import`、`import()`、`import.meta.resolve`、`require` 和 `require.resolve`。已经链接的模块、自定义 `vm` linker、不透明的非 Node importer 和第三方 Worker 不在透明保证范围。

### 活动插件列表与包元数据

resolution generation 列出可用 fallback 包；Loader entries 组成活动插件列表，两者不能合并。消费方继续使用 Loader 原有 entry 生命周期，并按自身 scope 过滤相关 entries。需要 package metadata 的消费方将 specifier 和所属树的 base URL 交给 app-boot 中的轻量服务，无需 package 导出 `./package.json`。安装 generation 后，即使查询未命中也以 generation 为准；底层嵌入方只安装服务而不提供 generation 时，服务保留 Node 原生查找。

解析器不提供 `imported(entry)`，不观察 ModuleJob，不包装 Entry 方法，不把 fiber 与 import 调用关联，也不替换 registry、tree 或 HMR 方法。重复查询读取同一个 generation，因此不会偏离 import 使用的路线。需要包元数据的非 Node importer 必须显式实现同一个确定性 resolver 接口，不能把调用来源推断重新引入 Node 主路径。

实现集中在 `app-boot/src/profile-resolution/`。`service.ts` 提供长期存在的 `ctx.pluginPackages`，并拥有主线程 resolver 与 Worker generation 的生命周期；`resolver.ts` 实现 generation 查询和 Node Internal 适配器；`worker-bootstrap.ts` 在线程内安装继承的 generation。旧 profile 选包和磁盘 materialize 逻辑留在 `profile.ts`。Worker 只通过 `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap` 公开入口引用 bootstrap。

服务定义与提供方继续放在 `app-boot`，因为 profile boot 拥有 resolver 生命周期。出现与 launcher 无关的提供方或需要独立演进的消费方时，再抽出单独的能力 seam。

### Worker 与 generation 更新

主线程通过 Worker environment data 发布当前 generation 的可结构化克隆表示和 profile scope。每个 Harness 自有 Worker 构建产物通过构建 banner 获取自己的 ESM/CJS Internal 并安装同一适配器，不重新遍历 manifest。bootstrap bundle 不静态导入任何包。源码 Worker 入口保持原有自包含依赖；第三方 Worker 保持不变。

新 Worker 继承最新发布的 generation。已运行的 Worker 保留启动时继承的 generation，因此发布后继 generation 的调用方必须重启它们。ESM bootstrap 无法影响其执行前已链接的静态依赖，因此 Worker bundle 必须保证 bootstrap 之前的静态 import 可由原生 Node 解析，需要 profile resolver 的业务入口在 bootstrap 后通过 dynamic import 启动。

### 只增加包的变更

添加包的调用方先完成 pnpm 事务，再构造下一代。替换操作会拒绝改变任何既有 package name 的目录或版本。调用方先发布只增加映射的后继 generation，再挂载新的 Loader 配置项；本实现不提供该包事务。挂载失败可以留下已安装但未启用的包。

替换、升级或删除已加载包需要重启，因为 Node 的 ESM Module Map、CommonJS cache、现存对象引用和运行中的 Worker 都可能保留旧模块 identity。generation 换代不声称卸载模块。

### 磁盘迁移

runtime-only 启动流程不创建、更新或退休 symlink 和代理包。resolver 把旧共享 fallback 和 `.dsh-module-fallback` 投影视为虚拟插入位置：generation 命中时使用表中目标，未命中时越过旧位置继续原生祖先查找。dual 阶段物化并安装同一个 generation；测试分别禁用一个后端并比较目标。

旧磁盘状态继续供 link-only 启动、旧进程和回滚使用，但不参与 runtime-only 选择。清理旧链接是本次变更之外的独立维护操作。

### 模式行为

link、dual 与 runtime 模式使用同一种 generation schema 和依赖选择策略。link 模式持久化计算结果，runtime 模式只在进程内安装，dual 模式要求 Node 的磁盘结果与 generation 路由一致。

普通 Node 调用方省略 `resolutionMode` 时，`dsh` launcher 选择 link 模式，因此既有 npm 安装的 profile 启动保留文件系统行为。pkg 可执行文件始终选择 runtime，Electron Host 则在挂载任何 profile 条目前安装 runtime generation。测试与底层嵌入方仍可显式选择 runtime 或 dual。

runtime 模式要求受支持的 Node Internal loader 接口，并且不会创建、更新或退休 fallback 链接。dual 模式保留链接写入，并在 Node 的磁盘结果与 generation 不同时失败。可写 profile 状态和包管理器事务不属于 resolver。

pkg 与打包 Electron 载体强制使用 runtime 解析。Electron Host 通过设置 `ELECTRON_RUN_AS_NODE=1` 的 Electron 可执行文件运行，从 ASAR 读取 dsh 依赖树，并把 ASAR 中的可执行条目映射到 electron-builder 的 unpacked 目录。两种载体都不会创建、更新或删除旧解析链接。

### 性能与验证

generation 构造发生在启动或显式更新阶段，不属于单次 resolve，但需要单独报告绝对延迟。普通热路径只包括 scope 分类、bare name 提取、本地优先判断、Map 查询和一次原生解析；缓存命中直接返回 generation 级结果。当本地 CommonJS 包目录没有 `exports` 且仅缺少所请求 subpath 时，一次请求可能先执行一次原生探测，再执行一次路由解析。作用域外调用不读取 manifest，只缓存 parent 是否位于 profile scope。

实现期间的一次性本地测量用 plain Node 在全新进程中执行构建后的 JavaScript，并与完全没有安装 hook 的进程比较。测量脚本和结果未提交，这些数据不是 benchmark 或 CI 预算。七轮交替顺序覆盖 outside、profile-local 和 fallback 的 dynamic import、`import.meta.resolve`、require、`require.resolve`。Node 22.19、24.18 和 26.8 的热路径中位数最大正向回退为 4.5%。Node 24.18 的 256 包 cold workload 最大回退为 11.2%，generation 构造中位数为 16.027 ms；32 包本地 `require.resolve` 因固定启动成本在整批增加 1.033 ms（+34.7%）。

行为测试在同一包树上比较运行时 generation 与磁盘 materializer，再覆盖根顺序、传递依赖和 peer、本地与外层优先级、exports 与 subpath 错误、conditions 和显式 CommonJS options。Node 兼容矩阵会在受支持的内部 loader 变体上运行 resolver、service 和 bootstrap 规格。Worker 测试通过 mock 线程与 native loader 接口验证 environment data 发布和 bootstrap 安装，但不会启动构建后的 Worker。generation 测试证明构造失败不发布部分状态，成功换代只做原子引用替换。

## Alternatives considered

**永久保留磁盘投影。** 这能在没有进程 hook 时沿用原生查找，但仍有跨进程写入、陈旧 generation、代理 manifest、写锁和打包运行时差异。迁移期 dual 模式仍有价值，因为两个后端消费同一个 generation。

**在 resolve 时惰性扩展依赖图。** 这会把 manifest 读取和错误分散到首次使用，改变磁盘实现的时机，使 Worker 启动更复杂，并让热路径成本随依赖图变化。完整构造 generation 更容易比较和原子替换。

**使用 `module.registerHooks`。** 公共 API 会在 profile scope 拒绝请求之前让相关解析进入 Node 的全局 hook 分发。直接访问已有 ESM/CJS 内部解析器可以保留更小的快速路径，并继续让 Node 完成最终解析。

**通过 Loader 和 HMR 适配器记录每个 Entry 的实际 import。** 实际 import 记录能支持相同输入返回不同目标的有状态 resolver。本设计改为以 generation 作为确定性权威，因此这些记录只会复制 resolver 的答案，同时增加 Entry、fiber、registry、ModuleJob 和 HMR 生命周期状态。

**每次包操作增量修改一张长期表。** 增量修改会暴露半成品依赖图，并要求定点失效缓存。完整构造下一代使失败保持原子，并让所有缓存随 generation 生命周期存在。

**热替换已经加载的包版本。** 解析表换代无法使所有存活模块实例和对象引用失效。重启可以保证每个进程只使用一个 package identity。

## Verification

- 一次 eager 计算同时供应保留的磁盘 materializer 和运行时 generation。
- link-only、dual 和 runtime-only 测试消费同一个 generation；runtime 启动既不写入也不退休模块解析数据。
- pkg 与 Electron 载体选择 runtime 解析；Electron 以 Node 模式从 ASAR 承载的 dsh 依赖树执行 Host，原生可执行条目保持 unpacked。
- ESM 与 CommonJS 适配器共享同一个路由器，并把最终解析委托给 Node，不使用 `module.registerHooks` 或替换 `_findPath`。
- 生产 package metadata 查询不记录 Loader import 结果，也不包装 Entry、registry、tree 或 HMR 方法。
- Node 兼容矩阵会在受支持的 loader 接口上运行主线程 resolver 规格；service 和 bootstrap 规格覆盖 Worker environment data 与安装接口，但不会启动构建后的 Worker。
- 一次性 plain Node 构建产物测量得到上述相对无 hook Node 的热路径和 cold 观察结果；脚本与结果并未提交为证据。
- package README、架构引用、生成目录和双语文档对描述已交付实现。

## Consequences

runtime 启动避免磁盘修改和代理 manifest，同时保留既有选包算法。代价是持续维护 Node Internal 兼容测试，并在每个自有 Worker 中最早执行自包含 bootstrap。link 保持普通 Node launcher 的默认值，dual 保留迁移比较路径，pkg 与 Electron 载体则强制使用 runtime 且不退休旧链接。在产品拥有模块缓存失效和 Worker 重启前，generation 替换只能新增映射。
