# Agent Note: 不改变产物的构建提速

Status: implemented

[English](2026-10-11-lossless-build-speedups.md) | 中文

## 问题

冷启动构建中有三处与产物内容无关的固定开销：

- **Client 测试聚合程序的 JSX 签名。** `tsc -p tsconfig.client.json` 的 Check 阶段为 59.1 s，其中一半以上用于为每个导入 React 的 JSX 文件计算 `@types/react` 的 module specifier。TypeScript 的 `computeModuleSpecifiers` 遍历该声明文件的每个符号链接位置，并在每个位置扫描全部 491 条 tsconfig `paths`。pnpm 为每个自行声明 `@types/react` 的 workspace 包创建一个 `node_modules/@types/react` 链接；66 个 manifest 声明了它，Client 测试聚合程序因此看到 65 个位置。计数器测得 88 个 JSX 文件 × 2 个模块（`index.d.ts`、`jsx-runtime.d.ts`）× 65 个位置，共 11,457 次 `tryGetModuleNameFromPaths` 调用、5,623,782 次条目扫描，合计 32.6 s。按可见位置数 N 截断的剂量实验在五个截断级别（N 从 1 到 65，Check 从 26.92 s 到 58.40 s）上拟合出 Check ≈ 26.9 + 0.494·N s。
- **Host tsdown 阶段中的 Typert。** Host tsdown 阶段约 21.6–22.6 s。Typert 在第一个 `writeBundle` 中同步发现并生成产物，CPU profile 显示它阻塞 tsdown 主线程约 12.4 s，期间所有包构建都在等待。发现阶段占 8.06 s：它解析两个 face 聚合配置所引用的 362 个包 tsconfig（约 3.8 s），每次解析 Host 聚合配置都展开 2,064 条字面 `include`（1.6 s，分析器从不读取这些文件名），并对 322 个注册项做公开导出表面遍历（2.7–3.2 s）；最终只有 28 个声明 Typert 导出的包产生 Host 产物。
- **Client tsdown 阶段的 manifest 查找。** Client tsdown 阶段约 11.7 s，主线程饱和（空闲仅 7.1%），其中 34.5%（3.95 s）在 `workspaceManifest`：每个包配置按包名 `globSync('packages/*/*/package.json')` 并逐个解析 manifest，直到名字匹配。模块级缓存无效，因为 tsdown 的 native 配置加载器通过 `import-without-cache` 为每个包配置创建新的模块实例；每次 glob 耗时 40–125 ms，且发生在 `tsdown:deps` 的 `neverBundle`/`alwaysBundle` 回调中，阻塞全部构建。

#5849 已合并 Host fixture 类型收窄与 Typert memoization；本 Note 的基线是其后的 master。

## 决策

以下八项提速不改变 `lib/`、`apps/web/dist` 的产物字节，也不改变仓库构建报告的类型诊断集合。唯一的诊断归属变化来自第 4 项：Typert 不校验它不分析的包 tsconfig，这些错误只由 `tsc -b` 报告。命令拆分与并发调度由[构建拆分 Note](2026-10-11-build-artifacts-check-split.zh.md)记录。

| # | 决策 | 受影响阶段 | 实测中位数 | 产物与诊断 | 有意的行为差异 |
|---|---|---|---|---|---|
| 1 | React 类型包只由根 manifest 声明 | Client 类型检查 | 测试聚合 Check 59.1 → 26.3 s | 程序文件数与诊断不变 | 包 manifest 不列出 React 类型包 |
| 2 | Typert 先按 manifest 选择包 | Host tsdown | 22.62 → 19.94 s | 逐字节一致 | 无 |
| 3 | Typert 不展开聚合配置的 `include` | Host tsdown | 19.94 → 16.99 s | 逐字节一致；注册清单一致 | 无 |
| 4 | Typert 惰性解析包 tsconfig | Host tsdown | 16.99 → 16.25 s（噪声内）；Typert 发现 5.9–7.1 → 0.36–0.40 s | 逐字节一致；注册清单一致 | 未分析包的 tsconfig 错误只由 `tsc -b` 报告 |
| 5 | Typert 工作区根目录同时要求 `packages/` | Host tsdown | 噪声内 | 逐字节一致 | `package` 模式下双 face 包获得产物 |
| 6 | Typert 在 Worker Thread 中生成 | Host tsdown | 15.39 → 10.25 s | 逐字节一致；失败仍使 tsdown 失败 | Host tsdown 最大 RSS 约 +0.6 GiB |
| 7 | Typert `transform` 钩子按模块 id 过滤 | Host tsdown | 噪声内；钩子调用 1,566 → 195 | 逐字节一致 | 无 |
| 8 | Client tsdown 预设按包目录读取 manifest | Client tsdown | 12.78 → 8.73 s | 逐字节一致；external 判定一致 | 预设第一个参数是包目录 |

第 5–7 项改变了发布的 `./tsdown` 导出 `typertPlugin()`（`transform` 为 `{ filter, handler }`、`writeBundle` 为异步、工作区根目录必须包含 `packages/`）；rolldown 与 tsdown 的使用方接受两种钩子形式，分析器本来就要求 `<root>/packages`，因此此前可用的外部工作区都不会失效。

### 测量条件

所有数字取自同一台共享 Linux 主机（256 vCPU、4 TB 内存，运行期间 load average 23–111），Node v24.18.0、TypeScript 6.0.3、tsdown 0.22.2（rolldown 1.1.1）。

- **Host tsdown：** `node node_modules/tsdown/dist/run.mjs --config-loader native --env.DSH_BUILD_FACE host`，每次运行前删除全部 `lib/typert.*`；各变体交替顺序运行，每组 3–4 个样本。第 2–4 项取自第一轮测量（起点为基线），第 5–7 项取自第二轮测量（起点为第 2–4 项合入后的代码）。产物比较覆盖 `packages/*/*/lib`、`apps/*/lib`、`vendor/*/lib` 顶层的 743 个文件（含 140 个 Typert 产物）的 SHA-256。相同代码的两组中位数相差 0–0.11 s，组内样本跨度最大 2.5 s。
- **Client 测试聚合：** references 预先构建后运行 `tsc -p tsconfig.client.json --extendedDiagnostics`，使用全新的 tsBuildInfo 文件；相同代码 6 个样本的 Check 跨度为 3.8 s（约 6%）。
- **Client tsdown：** 已构建的树上运行 `node node_modules/tsdown/dist/run.mjs --config-loader native --env.DSH_BUILD_FACE client`。第 8 项的原型 3 轮轮换顺序，基线跨度 1.56 s；最终实现与原实现交替运行，各 3 个样本。产物比较覆盖 `{packages,apps,vendor,native}/**/lib/**`（排除 `*.tsbuildinfo`）的全部文件。

### 1. React 类型包只由根 manifest 声明

- **目的：** 把 Client 测试聚合程序看到的 `@types/react` 位置数 N 从 65 降到 1，消除随 N 线性增长的 module specifier 计算。
- **改动：** 根 `package.json` 的 `devDependencies` 声明 `@types/react` `~18.3.1` 与 `@types/react-dom` `~18.3.0`，沿用各包原先统一的版本范围；`apps/*`、`packages/*/*` 与 `vendor/*` 的 manifest 在任何依赖区段都不声明它们。TypeScript 从任一包向上查找时都解析到根 `node_modules/@types/react`。runtime `react` 与 `react-dom` 仍按 [Client 依赖声明规则](../../../../packages/client/AGENTS.md#dependency-declaration)由各包声明；只通过 `import type` 引用 React 的 `packages/client/ui-slots` 在 `devDependencies` 中声明 `react`。pnpm `dedupeDirectDeps` 保持关闭。lockfile 的变化集中在 importers 区段（另有一条 integrity 相同的 `papaparse` 条目重排）。
- **防回退：** [`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) 在 `hygiene` 与 CI 中要求根 manifest 的 `devDependencies` 声明这两个包，并拒绝 `apps/*`、`packages/*/*`、`vendor/*` 中任一 manifest 在 `dependencies`、`devDependencies`、`optionalDependencies` 或 `peerDependencies` 中声明它们；诊断指明要删除的条目，并链接 Client 依赖声明规则第 8 条。规则只匹配这两个精确包名，其他 `@types/*` 包仍按 DefinitelyTyped 类型提供方处理。依赖区段推导不把这两个包视为 `react`/`react-dom` 的类型提供方：包缺少 `react` 声明时，验证器报告 `react` 缺失，`--fix` 拒绝修复并要求先声明版本范围；`--fix` 也不写回或删除这两个包。[`verify-package-dependencies.spec.ts`](../../../../scripts/verify-package-dependencies.spec.ts) 覆盖各依赖区段的拒绝、根 manifest 缺失声明、被接受的布局，以及类型提供方排除。
- **性能：**

  | 测量项 | 各包自声明（N = 65） | 根 manifest 声明（N = 1） |
  |---|---|---|
  | Client 测试聚合 Check | 59.08 s（3 个样本的中位数） | 26.28 s（5 个样本的中位数），−56% |
  | Client 测试聚合 wall | 68–71 s | 33.6–34.9 s |
  | Client 测试聚合 user CPU | 79–83 s | 44.5–45.3 s |
  | 76 个 client-only 包项目的 Check 总和 | 34.6 s（2 个样本的中位数） | 26.5 s（2 个样本的中位数），−23% |
  | 76 个 client-only 包项目的 wall | 55.7 s（2 个样本的中位数） | 44.5 s（2 个样本的中位数） |

- **无损依据：** 66 个包级链接与根链接指向同一个 realpath（`.pnpm/@types+react@18.3.31`），因此程序读取的声明内容相同；程序文件数保持 2,613，`tsc -b --force tsconfig.client.json` 以 0 退出且无诊断。`devDependencies` 不随已发布的包安装，[发布依赖面](2026-08-26-published-dependency-faces.zh.md)中独立 TypeScript 消费者自行安装所引用类型包的结论不变；runtime 解析不读取 `@types/*`。
- **取舍：** 包 manifest 不列出自己的 React 类型依赖，所有 workspace 包共用同一个 React 类型版本；某个包需要不同版本时，需要新的 Agent Note 推翻本项。检查只覆盖 `apps/*`、`packages/*/*` 与 `vendor/*`；`website`、`benchmarks`、`native/system` 与 `python/sdk-runtime` 等其他 pnpm 成员不在范围内，目前它们都不声明 React 类型包。

### 2. Typert 先按 manifest 选择包

- **目的：** workspace 模式只为声明 Typert 导出的包生成产物，避免对其余候选包做表面遍历。
- **改动：** `WorkspaceAnalyzer.discoverPackages(includeManifest?)` 与 `WorkspaceTypertGenerator.discover(faces?, includeManifest?)` 接受可选的 `package.json` 谓词，在表面遍历之前应用；被拒绝的包既不读取源码，也不解析项目配置。`WorkspaceTypertGenerator.generateContributors(faces?)` 以 `hasTypertExport`（`exports` 含 `./typert`、`./client/typert` 或 `./remote`）为谓词。不传谓词的调用方（Cordis 目录、不指定包的 `generate()`）行为不变。
- **性能：** Host tsdown 22.62 s → 19.94 s（各 3 个样本的中位数）。
- **无损依据：** 谓词就是原先在发现之后应用的同一过滤条件，被它拒绝的包本来就不产生产物；743 个产物文件逐字节一致（Typert generator 自身的 `lib/index.js` 除外，其源码即本项改动）。

### 3. Typert 不展开聚合配置的 `include`

- **目的：** 分析器只读取聚合配置的编译选项与 project references，展开 `include` 只为填充从不使用的 `fileNames`。
- **改动：** `WorkspaceCaches.aggregate(path)` 返回并缓存 `AggregateConfig { path, options, projectReferences }`。解析自身声明 `references` 的聚合配置时，使用 `readDirectory` 返回空列表的 `ParseConfigHost`；不声明 `references` 的聚合配置照常展开。
- **性能：** Host tsdown 19.94 s → 16.99 s（各 3 个样本的中位数）。
- **无损依据：** TypeScript 只对既无 `files` 也无 `references` 的配置报告 TS18003（无输入），因此声明 `references` 的聚合配置在不展开时得到相同的诊断、选项与 references。强制读取每个惰性配置后导出的注册清单（408 个注册项，含 `fileNames` 与选项，以及聚合配置的选项和 references）与基线逐字节一致；产物逐字节一致。测试 `reads aggregate options and references without expanding include patterns` 与 `reports an aggregate without references or inputs` 固定这两种配置的行为。

### 4. Typert 惰性解析包 tsconfig

- **目的：** 只解析被选中分析的包的 tsconfig，而不是聚合配置引用的全部包。
- **改动：** `PackageRegistration.config` 是 `caches.config(configPath)` 的 getter，首次读取时解析。注册清单的顺序、face、包名、根目录与导出子路径不变。
- **性能：** Host tsdown 16.99 s → 16.25 s（各 3 个样本的中位数），在 2.5 s 的组内跨度以内。第 2–4 项合计在隔离基准中把 Typert 发现从 5.9–7.1 s 降到 0.36–0.40 s，tsconfig 解析从 362 次降到 28 次，表面遍历从 322 次降到 28 次，Typert 总耗时从 9.7–11.8 s 降到 4.4–4.5 s。
- **无损依据：** 注册清单比较与第 3 项相同（逐字节一致），产物逐字节一致。测试 `reads only the project configs of manifests selected for discovery` 固定只解析所选包的配置。
- **取舍（非无损）：** Typert 不解析它不分析的包的 tsconfig，因此这类 tsconfig 的语法或配置错误不会使 Typert 失败。同一构建中，先于 Host bundle 运行的 Host 包编译 `tsc -b` 与 Client 包编译 `tsc -b` 解析每个被引用的 tsconfig，并拒绝其中的错误；`PackageRegistration.config` 的 JSDoc 与 [Typert generator README](../../../../packages/typert/generator/README.zh.md) 写明这一归属。单独调用 Typert 而不运行 `tsc -b` 的使用方不会得到这些诊断。

### 5. Typert 工作区根目录同时要求 `packages/`

- **目的：** 修正工作区根目录的判定。24 个双 face 包带有自己的 `tsconfig.host.json` 叶子配置；只按 `tsconfig.host.json` 向上查找时，每个这样的包都被当作根目录，workspace 模式每次构建为它们各做一次空发现，`package` 模式下双 face 包得不到产物且没有报错。
- **改动：** 工作区根目录是打包输出最近的、同时包含 `tsconfig.host.json` 与 `packages/` 的祖先目录。
- **性能：** Host tsdown 14.82 s → 15.39 s（各 3 个样本的中位数），在噪声内。
- **无损依据：** workspace 模式的比较中，743 个产物文件逐字节一致；[先生成顺序](2026-10-18-source-first-metadata-builds.zh.md)负责当前根构建的生成。测试 `resolves the workspace root above a dual-face package leaf` 固定该判定。
- **行为差异：** `package` 模式的使用方构建双 face 包时得到该包的 Typert 产物；仓库构建不使用 `package` 模式。

### 6. Typert 在 Worker Thread 中生成

- **目的：** 让 Typert 分析与 tsdown 主线程上的打包重叠，而不是在第一个 `writeBundle` 中阻塞全部包构建。
- **改动：** [`src/worker.ts`](../../../../packages/typert/generator/src/worker.ts) 是 Worker Thread 入口，运行 `generateContributors(faces)` 并回传一条 `artifacts` 或 `failure` 消息。workspace 模式下，本次构建的第一个 `buildStart` 以 `options.cwd` 定位工作区根目录并启动生成；`writeBundle` 是异步的，第一个完成的打包认领写入并等待结果，之后的打包立即返回。分析错误、worker 崩溃或提前退出、格式错误或无法反序列化的响应、worker 无法终止，都以指明工作区与原因的 `TypertWorkerError` 使认领写入的打包失败，从而使整个 tsdown 阶段失败；结果敲定前 worker 已终止，未被认领的结果不会成为未处理的 rejection。构建产物从 `./worker.js` 启动 worker；源码运行（测试）通过 `tsx/esm/api` 加载 `worker.ts`。`package` 模式仍在主线程中生成。
- **性能：** Host tsdown 15.39 s → 10.25 s（各 3 个样本的中位数）。最终配置（第 2–7 项）的 profile：主线程 10.1 s，第一个 `buildStart` 出现在 4.18 s（tsdown 配置解析），主线程上的 `writeBundle` 只占 0.37 s；worker 5.0 s（模块加载约 0.4 s、发现 0.28 s、生成 3.88 s，其中 `createProgram` 2.21 s），约在 9.3 s 结束。Host tsdown 的 wall 约为 max(打包, 4.2 s + Typert)。
- **无损依据：** 第二轮的 54 次运行全部以 0 退出，每次的 743 个产物文件均与基线一致（generator 自身的 `lib/index.js` 除外）。测试 `writes the artifacts in-process generation produces` 比较 worker 与进程内生成的产物；在临时工作区中把一个包的 `files` 改坏后，tsdown 在 2.4 s 内以 1 退出，报告 `TypertWorkerError` 及 worker 内的 `TypertAnalysisError`，不写入任何产物。各失败路径由 `typertPlugin workspace mode` 测试组覆盖。
- **取舍：** worker 堆约 300–420 MiB；最终配置的 Host tsdown 最大 RSS 中位数为 6,296–6,408 MiB，基线为 5,676 MiB。共享主机高负载时 worker 可能落在关键路径上：一次样本为 21.91 s，拥有产物的包构建等待 worker 约 14 s，其后 10 个样本未复现；load average 约 100 时两次运行为 17.86 s 与 14.3 s。worker 在 1,024 MiB 堆上限下也能完成，因此不是 GC 压力；归因于主机争用尚未证实。

### 7. Typert `transform` 钩子按模块 id 过滤

- **目的：** 避免每个模块都从 rolldown 进入 JavaScript `transform` 钩子，只为被扩展名检查拒绝。
- **改动：** `transform` 声明 `filter: { id: /^[^?]*\.[cm]?tsx?(?:\?|$)/ }`，处理函数仍以同一正则检查 id。
- **性能：** 每次 Host 构建的钩子调用从 1,566 次降到 195 次（195 个 TypeScript 模块，其中 4 个含装饰器）。wall 中位数为 11.07 s（3 个样本）与 9.98 s（4 个样本），第 6 项为 10.25 s，相同代码的对照组为 11.07 s 与 9.87 s，差异在噪声内。
- **无损依据：** 该正则只含 ASCII 构造，在 rolldown 的 Rust 正则与 JavaScript 中匹配相同的 id 集合；处理函数应用同一检查，因此不读取过滤器的宿主行为相同。产物逐字节一致；测试 `filters transform calls to TypeScript module ids` 固定过滤器。

### 8. Client tsdown 预设按包目录读取 manifest

- **目的：** 每个包配置只读取自己的 `package.json`，消除按包名遍历全部 manifest 的 glob。
- **改动：** [`packages/client/tsdown.client.ts`](../../../../packages/client/tsdown.client.ts) 的 `clientBundle`、`staticLinked` 与 `clientLibrary` 的第一个参数是包目录（通常为配置文件的 `import.meta.dirname`），预设读取一次 `<packageDir>/package.json`，以其中的 `name` 作为插件 id 与诊断名称；该 manifest 缺失、不可读或缺少 `name` 时，配置加载以指明路径与原因的错误失败。82 个包配置调用这些预设。预设不保留模块级 manifest 缓存；Node 半边的生产依赖 external 列表在首次 resolve 时由该 manifest 计算，并缓存在该配置的闭包中。
- **性能：** Client tsdown 从 12.78 s 降到 8.73 s（各 3 个样本的中位数），−4.05 s（−31.7%），两组样本区间不重叠；user CPU 从 26.1 s 降到 25.2 s，sys 从 5.9 s 降到 4.9 s，因此收益主要来自解除主线程阻塞，而不是减少 CPU 总量。原型（一次 glob 建立按包名索引）为 11.72 s → 7.46 s（−36%）。Host tsdown 中只有 5 个 `hostPhase` 包经过该查找，一对样本为 11.92 s → 10.71 s，置信度低。
- **无损依据：** 11 次运行的 11,566 个 lib 文件逐字节一致。82 个调用处改为传入包目录后，没有一个解析出的包名与原先手写的包名不同。进程内比较 82 个配置 × 3 个 face × 1,600 个 specifier 的 external 判定，结果与原实现完全一致；负对照（多加一个 external）使 75 个判定不同。`client-bundle-purity.spec.ts` 覆盖这些 manifest 错误。
- **行为差异：** 预设的调用约定从包名改为包目录。

## 考虑过的替代方案

- **开启 pnpm `dedupeDirectDeps`（第 1 项）：** 作用于所有直接依赖，改变每个 workspace 包的链接布局，副作用是全局的。
- **给 TypeScript 打补丁（第 1 项）：** 上游式补丁（预先计算候选扩展名并缓存规范化的 `paths` 模式）使 Check 降低 31.9 s，与提升相当；在已提升的树上不再带来收益（refs Check 25.76 s 对 26.47 s），且需随每次 TypeScript 升级维护。
- **在 tsconfig `paths` 中为 `react` 加别名（第 1 项）：** tsx、vitest 与 vite 也读取 `paths`，别名会改变它们对 runtime `react` 的解析。
- **把 `paths` 收窄为各 face 的 reference closure（第 1 项）：** 保留通配键的 328 条版本 Check 为 55.73 s 对 59.08 s（1 个样本），在噪声内；去掉通配键的版本产生 18 个诊断。
- **拆分 Client 测试聚合程序（第 1 项）：** 每个子程序都必须注入 242 个含模块增强的文件才能通过检查，可见位置数仍为 33–49；拆成 2、4、8 组时 Check 总和基本不变，user CPU 分别增加 9%、30%、57%，只降低 wall，且 4 组与 8 组各出现 1–2 个诊断。
- **缓存解析结果并把发现队列改为 O(1)（Typert）：** 第 2–4 项之后只剩 28 次表面遍历，约 0.18 s，低于噪声。
- **在产物构建中把 Typert 移到独立构建步骤（Typert）：** 第 6 项之后 worker 已与打包重叠，剩余收益不超过约 1 s。不需要 bundle 的类型检查运行只读源码的生成步骤（[本地门禁提速](2026-10-12-local-gate-speedups.zh.md)）。 [先生成顺序决策](2026-10-18-source-first-metadata-builds.zh.md)为了编译依赖顺序而选择独立步骤，并记录无改动构建的代价；公开 worker 插件仍可使用。
- **按代码内容过滤 `transform`（第 7 项）：** rolldown 以 Rust 正则语义解释 `^` 与 `\s`，在孤立 CR、U+2028 与 BOM 上与 JavaScript 不同，可能漏掉含装饰器的模块。
- **在 `globalThis` 上建立进程级 manifest 索引（第 8 项）：** 原型收益与第 8 项相当，但它是没有 owner 的进程全局状态，违反[包规则](../../../../packages/AGENTS.md)中的共享状态归属要求。
- **关闭 tsdown 的 gzip 报告（第 8 项）：** `--no-report` 使 Client tsdown 降低 0.95 s，在 1.56 s 的基线跨度内。
- **为 DSH 的 `resolveId`/`load` 钩子加 rolldown 过滤器（第 8 项）：** 降低 1.16 s，在噪声内。
- **按模块 id 缓存输入隔离检查（第 8 项）：** 降低 0.93 s，在噪声内；叠加在 manifest 索引之上只再降低 0.18 s。

## 后果

Client 类型检查的 CPU 与 wall 时间、Host tsdown 与 Client tsdown 的 wall 时间都明显下降，且不改变 runtime 解析、发布安装语义或任何产物字节。串行构建的各段中（master → 本分支，各一个样本），Host tsdown 从 22.5 s 降到 11.7 s，Client 包编译从 55.6 s 降到 48.7 s，Client 聚合检查从 68.2 s 降到 35.9 s，Client tsdown 从 13.9 s 降到 10.5 s；串行各段合计在 master 上为 308.5 s，在本分支上为 254.9 s（见[构建拆分 Note](2026-10-11-build-artifacts-check-split.zh.md)）。Host tsdown 位于 `build` 与 `build:artifacts` 的关键路径上，Client tsdown 位于 `build:artifacts` 的关键路径上，Client 聚合检查是 `build` 关键路径的最后一步。

代价：所有 workspace 包共用一个 React 类型版本；Typert 不校验它不分析的包 tsconfig，这些错误由 `tsc -b` 负责；Host tsdown 的最大 RSS 约增加 0.6 GiB，共享主机高负载时 worker 可能成为 Host tsdown 的关键路径。

重新评估条件：迁移到 TypeScript 7 时重新测量第 1 项，若位置数不再影响 Check 时间，可以重新评估包级声明。tsdown 的配置加载本身每次 Client 构建仍占 1.8–2.3 s（每个配置一个无缓存的模块实例），需要上游改动。第一个 `buildStart` 在 Host 构建开始约 4.2 s 后才出现；在插件构造时以显式根目录启动 worker 可以进一步提前 Typert。

验证：Typert generator 的 `tsdown-plugin.spec.ts`、`tsdown-plugin-worker.spec.ts` 与 `type-model.spec.ts` 固定第 2–7 项的行为；generator 测试 209 个通过、28 个跳过，`tsc -b tsconfig.host.json` 以 0 退出。仓库覆盖率 gate 不包含 `packages/typert/*/src/**`，在临时覆盖率配置下 `tsdown-plugin.ts` 的 statements、branches、functions 与 lines 均为 100%。五个负对照（旧根目录规则、立即解析包配置、展开聚合配置、不认领写入、跳过 worker 终止）各自使守护它的测试失败；真实 tsdown 失败路径在 2.4 s 内以 1 退出并报告 `TypertWorkerError`。第 1 项：`verify-package-dependencies` 以 0 退出（74 个包），其 spec 47/47 通过，`verify-client-packages` 以 0 退出，`tsc -b tsconfig.client.json` 无诊断，Client 聚合 Check 为 26.48 s。第 8 项：72 个相关 spec 全部通过。
