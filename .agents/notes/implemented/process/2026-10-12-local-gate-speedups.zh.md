# Agent Note: 本地门禁、钩子与测试提速

Status: implemented

[English](2026-10-12-local-gate-speedups.md) | 中文

## 问题

在基线（合并 #6013 时的 master）上，本地运行 Git 钩子、`pnpm run test`、`test:docs` 与 `doc-sync`（文档同步门禁）时，大部分 wall 时间花在结果并不依赖的工作上：

- **经打包器获得 Typert 声明。** pre-push 钩子运行的 `typecheck` 先运行 `build:lib:host`（Host `tsc -b tsconfig.host.json`、Host tsdown 阶段与 Desktop bundle），再运行 `tsc -b tsconfig.client.json`。`lint`、`lint:fix`、`doc-typecheck` 与 CI `typert-contracts` 门禁的前置步骤先运行 Host 包编译，再运行 Host tsdown 阶段（`compile-referenced-projects.ts host-libraries`）。类型检查只读取包声明与 Typert 声明，但无需重查时 `typecheck` 仍需 34.1/35.0 s，前置步骤需 52.2/29.6 s。
- **每次提交都生成第三方声明。** 只要暂存文件是生成器的输入，pre-commit 钩子就重新生成 `THIRD_PARTY_NOTICES.md`。为找出浏览器侧的第三方 import，生成器对 75 个 Client 包试打包并运行一次 Vite 构建，因此每个包源码文件都是它的输入；暂存一个位于包 `src/` 子目录下的文件的提交，钩子合计 16.5/17.8 s，其中第三方声明任务占 12.4/13.4 s。
- **以宿主 CPU 数作为本地 worker 数。** `os.availableParallelism()` 报告的是宿主 CPU 数（测量主机上为 256），而不是容器的 CPU 配额（64）。按此默认值，`pnpm run test` 启动 255 个 Vitest fork，RSS 峰值 55.3 GiB，并偶发地多失败 12 个文件（14 次超时）；同时 `doc-sync`、`test:docs`、`hygiene` 与 `check:all` 最多只并发 4 个门禁。
- **每个候选一次 Git 前缀查找。** `verify-repository-references` 通过 `git cat-file --batch-check` 对约 26,000 个缩写十六进制候选逐个做 Git 前缀查找；这些查找占该门禁 166.8 s 中的 135.7 s。
- **重复解析 Markdown。** markdown links 对每个锚点目标再多解析两次，且探测目标是否存在时不缓存；translation pairing 做四次 glob，并在链接归一化后再次解析每个文档；包 README 的 model experience 与 limitations 检查各自把每个 README 解析三次；type equivalence 解析全部 1,835 个文档；Session format references 把每个配对解析四次。
- **重复读取目录。** markdown wrap、doc refs 与 package paths 背后的遍历器 `uniqueRepoFiles` 对每个 pattern 与每层 `**` 各读取一次每个目录，并对每个匹配文件调用 `realpath`。
- **串行启动 help 与重复的编译器探测。** `gen-cli-help` 依次启动 12 个顶层源码模式的 `dsh … --help` 进程，每个进程大部分时间在等待 profile 启动的 I/O（49.9/53.9 s）；`gen-doc-graphs` 构建多个编译器 host 与 program，重复执行同样的 `ts.sys` 文件系统探测（48.7/44.7 s）。
- **受文件系统探测拖累的测试文件。** Typert generator 的 `type-model.spec.ts` 的 61 个用例各自把 fixture（测试前置数据）复制到磁盘并运行一次完整分析，分析中的四个 TypeScript program 各自加载 DOM lib、`@types/node` 与 zod v4，每次分析约 22,000 次 stat 调用。该文件耗时 316.3/329.1 s，是 `pnpm run test` 的长尾。

## 决策

以下八项决策缩短上述运行。每一项都给出其产物与诊断保持不变的依据，或它接受的有意差异。

| # | 决策 | 受影响的命令 | 实测 wall | 产物与诊断 | 有意的行为差异 |
|---|---|---|---|---|---|
| 1 | 类型检查不打包地生成 Typert 声明 | `typecheck`、`lint`、`lint:fix`、`doc-typecheck`、CI `typert-contracts` | `typecheck` 34.1/35.0 → 21.9/20.0 s；前置步骤 52.2/29.6 → 12.5/11.3 s | 140 个 Typert 文件逐字节一致；检查的程序相同 | 不产出可运行 bundle，不写 client build record |
| 2 | pre-commit 钩子不重新生成第三方声明 | `pre-commit` | 16.5/17.8 → 4.3/4.5 s | 新鲜度由测试 lane 断言 | 第三方声明过期时在测试 lane 失败，而不是在提交时 |
| 3 | 本地默认 worker 预算 | run-gates 聚合、`build`、`typecheck`、`pnpm run test`、Oxlint、publint | 255 个 worker 时 `test` 为 243.7 s、55.3 GiB；`test:docs` 74.7 → 50.9 s | 检查不变 | 本地默认值不使用超过 12 或 48 的 CPU |
| 4 | 仓库引用候选对照一次对象列表解析 | `verify-repository-references` | 166.8 → 15.7 s | 27,050 个候选的判定 0 差异 | 无 |
| 5 | 文档门禁每个文档只解析一次 | markdown links、translation pairing、README model experience 与 limitations、type equivalence、Session format references | markdown links 53.4/51.6 → 25.9/25.1 s；type equivalence 23.0/22.5 → 6.0/5.5 s | 门禁输出逐字节一致 | 无 |
| 6 | 仓库文件遍历每个目录只列一次 | markdown wrap、doc refs、package paths | doc refs 8.8/7.0 → 3.2/3.4 s | 文件列表一致 | doc refs 不读取嵌套的 `lib` 目录 |
| 7 | CLI（命令行界面）help 读取并发运行；doc graphs 的探测做 memo | `verify-cli-help`、`verify-doc-graphs` | 49.9/53.9 → 6.9/7.2 s；48.7/44.7 → 32.7/34.2 s | 页面逐字节一致 | CLI help 峰值约用 3.6 GB 内存 |
| 8 | `type-model.spec.ts` 在内存工作区上运行 | `pnpm run test` | 316.3/329.1 → 14.65/15.04 s | 61 个用例与断言不变；快照有一行不同 | 除 Emitter 用例外，桩替代 zod、`@types/node` 与 DOM lib |

### 测量条件

所有数字都是 wall 时间，取自同一个共享 Linux 容器：CPU 配额 64 核，宿主报告 256 个 CPU，一分钟 load average 为 20–150，因此样本带有噪声。工作树位于网络文件系统上，每次文件系统探测的代价都高于本地磁盘。`a/b` 表示两个样本，`x → y` 比较基线与本实现。

### 1. 类型检查不打包地生成 Typert 声明

- **目的：** 让 `typecheck` 以及 `lint`、`lint:fix`、`doc-typecheck` 与 CI `typert-contracts` 门禁的前置步骤得到它们读取的声明，即 `tsc` 产出的包声明与 Typert 声明，而不运行 Host tsdown 阶段或 Desktop bundle。
- **改动：** `typecheck` 是 `tsx scripts/build.ts --scope typecheck`，它通过 run-gates 调度器运行下表中的步骤（[`scripts/build.ts`](../../../../scripts/build.ts)）。该 scope 不构建 native addon、tsdown bundle、Desktop bundle 或 Web 产物，不写 client build record，可运行的 `lib/` 产物保持上一次 `build:artifacts` 的状态；启动或测试构建产物之前先运行 `build:artifacts`。`lint`、`lint:fix`、`doc-typecheck` 与 `typert-contracts` 的前置步骤是 `compile-referenced-projects.ts host-contracts`，它在 host-src 之前运行 host-typert（[`compile-referenced-projects.ts`](../../../../scripts/compile-referenced-projects.ts)）。`build`、`build:artifacts`、benchmark 构建与 vendor 演练都在编译前采用同一仅源码生成（[顺序决策](2026-10-18-source-first-metadata-builds.zh.md)）。

- **共用生成：** [`scripts/generate-typert.ts`](../../../../scripts/generate-typert.ts) 对 `WORKSPACE_TYPERT_FACES`（[`scripts/typert-faces.ts`](../../../../scripts/typert-faces.ts)，即仓库生成的 face）调用 `WorkspaceTypertGenerator.generateContributors()`，并用 [`artifact-files.ts`](../../../../packages/typert/generator/src/artifact-files.ts) 中插件同样使用的 `writeWorkspaceArtifacts()` 写出结果。与插件一样，它跳过 TypeScript 诊断，这些诊断由 Host 包编译报告；Typert 分析错误使 host-typert 失败，依赖它的编译不会启动。host-typert 由 Node 加 tsx 的 ESM 钩子运行，而不经 `pnpm exec`，因为后者的启动开销会拉长通往 Client 编译的路径。
- **以 build mode 运行聚合检查：** host-check 与 client-check 在本侧 face 的包编译之后才开始，因此 build mode 发现所有 references 都是最新的，只检查聚合根程序，并在根程序的 tsbuildinfo 为最新时跳过它。
- **只读源码的分析：** host-typert 能在 host-src 之前运行，是因为它的 Host program 不读取任何工作区构建产物。`tsconfig.base.json` 把 `@deepseek-ai/dsh-client-file-upload/types` 映射到源码；没有这条别名时，该说明符经包 `exports` 解析到 `lib/types/types.d.ts`。有了它，Host program 加载 1,289 个文件，其中没有一个位于工作区包的 `lib/` 下。`generate-typert.ts` 开启 `rejectBuildOutputs`：face program 加载工作区包 `lib/` 目录下的文件，或无法解析对工作区包的 import（例如包尚未编译的工作区）时，[`build-output-guard.ts`](../../../../packages/typert/generator/src/build-output-guard.ts) 以 `TypertAnalysisError` 使分析失败，并指出每个这样的 import 说明符，以及把它映射到源码的 `paths` 条目。因此无论 host-src 是否已运行，缺失的别名都会使生成失败。公开 tsdown 插件保留独立的生成策略；根产物构建使用仅源码阶段。[Typert generator README](../../../../packages/typert/generator/README.zh.md) 记录了这些写入函数与该选项。
- **无损依据：** 没有任何工作区 tsconfig 设置 `allowJs`，每个 `exports` 的 `types` 条件都指向 `lib/types/` 内或 `lib/typert.*`，每个 tsdown 配置都设置 `dts: false`，因此没有类型检查读取 tsdown 产物。140 个 Typert 文件（28 个包 × 5 个输出）在以下场景中逐字节一致：基线 tsdown 阶段、当前 tsdown 阶段、删除全部 Typert 输出后运行 `generate-typert.ts`、隐藏全部 344 个 `lib/types` 目录后运行 `generate-typert.ts`；临时给 `packages/goal/goal` 加一个 Remote 方法时，tsdown 阶段与 `generate-typert.ts` 写出的文件也相同。`typecheck` 检查两个 face 的全部包 project 与两个聚合根程序，即 `build` 检查的程序。
- **性能：** 无需重查时 `typecheck` 为 34.1/35.0 → 21.9/20.0 s。两个聚合根程序都需要重查时为 83.5 → 76.0/72.1 s，其关键路径是约 66–70 s 的 Host 聚合检查。`lint` 与 `doc-typecheck` 的前置步骤为 52.2/29.6 → 12.5/11.3 s。
- **取舍：** `typecheck`、`lint`、`lint:fix`、`doc-typecheck` 与 `typert-contracts` 写出 Typert 声明但不写 bundle，因此在下一次 `build:artifacts` 之前，可运行的 `lib/` JavaScript 可能落后于这些声明。
- **与构建的关系：** [先生成元数据的顺序](2026-10-18-source-first-metadata-builds.zh.md)负责生成位置及其测得的代价。仅生成声明的命令仍省略打包。[构建拆分 Note](2026-10-11-build-artifacts-check-split.zh.md)负责命令职责。
- **已知缺口：** 增量 `tsc -b` 不把 Client 源码经包 `exports` 访问到的 `lib/typert.remote-client.d.ts` 记为消费方 project 的输入；Remote 签名改变而 Client 源码未变时，增量检查不会重查消费方。这一缺口与由哪一种生成写出声明无关，由 Issue #6022 跟踪。

### 2. pre-commit 钩子不重新生成第三方声明

- **改动：** [`lefthook.yml`](../../../../lefthook.yml) 中的 `pre-commit` 钩子没有第三方声明任务。[`gen-third-party-notices.spec.ts`](../../../../scripts/gen-third-party-notices.spec.ts) 在测试 lane（包括必过的 `node 24 / coverage` lane）中断言 `THIRD_PARTY_NOTICES.md` 已提交的字节，过期时指出 `pnpm run gen-third-party-notices`。[生成的第三方声明 Note](2026-07-30-generated-third-party-notices.zh.md) 拥有这一新鲜度决策。
- **性能：** 暂存一个位于包 `src/` 子目录下的文件的提交，钩子耗时由 16.5/17.8 s 降为 4.3/4.5 s，其中第三方声明任务占 12.4/13.4 s。
- **取舍：** 使第三方声明过期的提交会在推送后于测试 lane 失败，而不是在提交时被修正。

### 3. 本地默认 worker 预算

- **目的：** 按共享工作站或容器确定默认并行度；在这类环境中 Node 报告的是宿主 CPU 数而不是 CPU 配额。
- **改动：** [`scripts/parallelism.ts`](../../../../scripts/parallelism.ts) 拥有默认值。`CI=true` 时它是 Node 报告的 CPU 数。否则，run-gates 调度器、`build`、`typecheck`、Oxlint 与 publint 的上限为 12（`LOCAL_PARALLELISM_CAP`），Vitest fork 与本地覆盖率预算的上限为 48（`LOCAL_TEST_PARALLELISM_CAP`）。`doc-sync`、`test:docs`、`hygiene` 与 `check:all` 的每个门禁都构建完整的 `ts.Program`，它们最多并发 8 个门禁，CI 中同样如此。显式的 `DSH_GATE_CONCURRENCY`、`DSH_OXLINT_THREADS`、`DSH_COVERAGE_MAX_WORKERS` 与 Vitest `--maxWorkers` 优先；CI 中，除非 run-gates 的 CI 环境设置了这些变量，Vitest 与 Oxlint 使用各自的默认值。[开发指南](../../../../docs/development.zh.md)向贡献者说明这些默认值。

四种 fork 数下的 `pnpm run test`，运行的是第 8 项所替换的落盘版 `type-model.spec.ts`，32 个 worker 那次的 wall 由它决定：

| Vitest worker 数 | wall | RSS 峰值 | 额外的偶发失败 | 除最慢文件外其余文件完成于 |
|---|---|---|---|---|
| 255（报告的 CPU 数） | 243.7 s | 55.3 GiB | 12 个文件、14 次超时 | 约 135–170 s |
| 32 | 310.4 s | 15.7 GiB | 4 个文件、4 次超时 | 193 s |
| 24 | 337.2 s | 13.2 GiB | 5 个文件、5 次超时 | 233 s |
| 12 | 410.5 s | 8.4 GiB | 2 个文件、3 次超时 | 406 s |

- **Oxlint：** Oxlint 自身的默认值是 64 线程（读取 cgroup 配额）；12 线程时其 wall 保持约 87–90 s，CPU 少约 15%；8 线程时慢约 4 s。
- **文档聚合：** 并发 8 个门禁时 `test:docs` 为 50.9 s，并发 4 个时为 74.7 s。不含第 4 项时测得的 `doc-sync` 在并发 4、8、12 个门禁时分别为 341.8、295.0、253.2 s，RSS 峰值分别为 10.0、13.5、16.3 GiB。
- **取舍：** CPU 配额超过上限的机器，默认并行度也不超过 12 或 48，需要使用覆盖变量；配额低于上限的容器仍会超额订阅，因为 Node 报告的是宿主 CPU 数。并发 8 个门禁时 `doc-sync` 的 RSS 峰值为 13.5 GiB，并发 4 个时为 10.0 GiB；并发 12 个门禁快 41.8 s，但峰值为 16.3 GiB。CI 的文档 workflow 运行 `doc-sync` 时同样最多并发 8 个门禁。

### 4. 仓库引用候选对照一次对象列表解析

- **改动：** [`verify-repository-references.ts`](../../../../scripts/verify-repository-references.ts) 用 `git cat-file --batch-all-objects --batch-check=%(objectname)` 一次列出全部对象名（约 120 万个对象，0.6 s），排序后在内存中对每个小写候选前缀做二分查找；随后一次 `--batch-check=%(objectname) %(objecttype)` 调用读取命中对象的类型。只有当候选前缀恰好匹配一个可用对象且该对象是 commit 时，它才算 commit 引用，这与 Git 自身前缀查找的规则相同；与 Git 的查找一样，该列表也包含不可达对象与 alternate 对象。
- **性能：** 166.8 → 15.7 s。
- **无损依据：** 在 27,050 个真实与合成候选上（包括歧义前缀、blob 与 tree 前缀以及随机字符串），Git 的逐候选前缀查找与内存查找的判定完全一致。
- **取舍：** 120 万个对象的列表约为 49 MiB 的 Git 输出，读取时的输出上限为 1 GiB。

### 5. 文档门禁每个文档只解析一次

- **改动：** 下表中的每个门禁对一个 Markdown 文档只解析一次，并把语法树传给本次运行中的所有使用方。

| 门禁 | 单次解析机制 | wall |
|---|---|---|
| markdown links（[`verify-md-links.ts`](../../../../scripts/verify-md-links.ts)） | 一个按运行划分的缓存对每个文件只解析一次，同时取得其 destination 与锚点，并对每个解析后的目标只探测一次 | 53.4/51.6 → 25.9/25.1 s |
| translation pairing（[`verify-translation-pairing.ts`](../../../../scripts/verify-translation-pairing.ts)） | 一次 glob 覆盖所有范围 pattern；record 在下述守卫条件下复用原文语法树 | 51.0/47.1 → 30.3/29.3 s |
| package README model experience、package README limitations | 每项检查对一个 README 只解析一次，并把语法树传给 `markdownProseLines()` 与 `markdownHeadingLines()` | 各约 12 → 5.9 s |
| type equivalence（[`verify-type-equiv.ts`](../../../../scripts/verify-type-equiv.ts)） | 文本预筛跳过不可能含源码等价围栏的文档；manifest（元数据清单）中的每个 TypeScript 源文件只解析一次 | 23.0/22.5 → 6.0/5.5 s |
| Session format references | persistence 渲染器把它解析出的语法树传给配对 record | 10.2 → 5.3 s |

- **配对复用守卫：** [`translation-pairing-record.ts`](../../../../scripts/translation-pairing-record.ts) 中的 `normalizedTopLevelBlocks()` 仅在以下条件同时成立时，才为归一化后的文本复用原文语法树：每处链接归一化编辑都替换一个完整、无 title 且不在行首开始的 destination，原文等于该节点的 `url`，且原文与替换文本都只含 `[A-Za-z0-9._/:#%-]`。这些字符既不能结束 destination，也不能开始或结束其他语法结构，因此归一化后的文本解析出相同的节点，只是偏移量随之移动。其他任何编辑都回退为对归一化文本的完整解析。
- **type equivalence 预筛：** [`type-equiv-prefilter.ts`](../../../../scripts/type-equiv-prefilter.ts) 在文档含 `type-equiv` 或 `public-api`，或者某个含 `` ``` `` 或 `~~~` 的行同时含 `&` 或 `\` 时，保留该文档进行解析。解析只会通过解码字符引用与反斜杠转义改变信息字符串，因此 `ts type&#45;equiv` 与 `ts type\-equiv` 所在的文档都会被保留；[`type-equiv-prefilter.spec.ts`](../../../../scripts/type-equiv-prefilter.spec.ts) 覆盖这两种写法。
- **无损依据：** 每个门禁在仓库上的输出逐字节一致，人为注入的错误也被同样报告。对配对而言，语料中全部 1,886 个文档的顶层块与全部 943 个配对的 record 都与完整重新解析的结果一致，随机 destination 的结果也一致。

### 6. 仓库文件遍历每个目录只列一次

- **改动：** [`scripts/repo-files.ts`](../../../../scripts/repo-files.ts) 中的 `uniqueRepoFiles()` 在一次调用的所有 pattern 之间共享一个目录列表缓存，使每个目录最多读取一次，并且只对经符号链接到达的匹配调用 `realpath`；只经真实目录到达的普通文件，规范路径为仓库 realpath 拼接其相对路径。它的可选谓词 `skipDirectory` 让遍历器不进入调用方排除其下全部路径的目录；[`verify-doc-refs.ts`](../../../../scripts/verify-doc-refs.ts) 跳过第一段路径之后的每个 `lib` 目录，其下文件本来就全部被它排除。
- **性能：** markdown wrap 25.8/25.0 → 21.3/21.2 s；doc refs 8.8/7.0 → 3.2/3.4 s；package paths 9.9/8.1 → 7.2/5.5 s。
- **无损依据：** 三个门禁得到的文件列表逐项相同，损坏或循环的符号链接仍会经 `realpath` 失败。
- **行为差异：** doc refs 不列出被跳过的 `lib` 目录，因此不可读的此类目录不会以 EACCES 使门禁失败。

### 7. CLI help 读取并发运行；doc graphs 的探测做 memo

- **CLI help：** [`scripts/gen-cli-help.ts`](../../../../scripts/gen-cli-help.ts) 中的 `prefetchHelp()` 在默认 worker 预算内启动 12 个顶层 `dsh … --help` 读取（启动器、`plugin`，以及每个 profile 的简写与 `--profile` 形式），每个读取使用独立的临时 `DSH_HOME` 与 `DSH_AGENTS_HOME`，并由按原顺序进行的遍历消费；嵌套读取共享同一上限。失败的读取在遍历请求该调用时才交给遍历；`close()` 中止排队与运行中的读取，并等待每个已启动的子进程结束。该门禁为 49.9/53.9 → 6.9/7.2 s。
- **doc graphs：** [`scripts/gen-doc-graphs.ts`](../../../../scripts/gen-doc-graphs.ts) 中的 `withMemoizedFileSystemProbes()` 在 `renderDocs` 运行期间对 `ts.sys` 的 `fileExists`、`directoryExists`、`realpath`、`readDirectory` 与 `getDirectories` 做 memo，使一次运行中的所有编译器 host 与配置解析共享同一个文件系统视图。运行期间工作区不得改变，写出页面之前恢复原方法。该门禁为 48.7/44.7 → 32.7/34.2 s。
- **无损依据：** 两个生成器生成的页面逐字节一致。
- **取舍：** 并发的 help 进程合计峰值约占 3.6 GB 内存。

### 8. `type-model.spec.ts` 在内存工作区上运行

- **改动：** [`type-model.spec.ts`](../../../../packages/typert/generator/tests/type-model.spec.ts) 用 [`type-model-workspace.ts`](../../../../packages/typert/generator/tests/type-model-workspace.ts) 中的 `memoryFileSystem()` mock `node:fs` 与 `ts.sys` host，使内存根目录下的 fixture 复制、用例编辑、写模式注解、tsconfig 展开与模块解析都不触及磁盘。每个工作区挂载最小的 `zod` 与 `@types/node` 声明桩；只有 Emitter 用例保留真实 zod。fixture 的 `tsconfig.base.json` 设置 `lib: ["ES2024"]`，不含 DOM lib；读取未修改 fixture 的用例共享一份深度冻结的分析结果。generator 源码没有任何测试专用路径。
- **性能：** 单独运行该文件为 316.3/329.1 → 14.65/15.04 s。
- **行为覆盖保持不变的依据：** 61 个用例名及其断言相同。快照只有一行不同，即外部 zod 符号路径，它指向桩（`<external>:node_modules/zod/index.d.ts#ZodType`），而不是某个 pnpm store 版本。
- **取舍：** 除 Emitter 用例外，该 spec 不针对真实文件系统、DOM lib 以及真实 zod 与 `@types/node` 声明检验分析器。内存文件系统只实现分析器使用的 `node:fs` 调用（`existsSync`、`readFileSync`、`realpathSync` 与 `writeFileSync`）；对内存路径的其他调用会落到真实文件系统，而该路径并不存在。

### 全仓对比

两棵树在同一时段测量，每个命令在 `pnpm run build:artifacts` 之后交替运行基线与本实现（`pnpm run test` 在两棵树上失败的都是依赖环境的文件，基线 42 个，本实现是其中的 28 个）：

| 命令 | 基线 | 本实现 | 变化 | 对应项 |
|---|---|---|---|---|
| `pre-commit` 钩子，暂存一个位于包 `src/` 子目录下的文件 | 16.5/17.8 s | 4.3/4.5 s | −75% | 2 |
| `pnpm run typecheck`（pre-push），无需重查 | 29.7/23.3 s | 14.2/16.1 s | −43% | 1、3 |
| `pnpm run lint` | 110.0 s | 106.7 s | −3% | 1 |
| `pnpm run doc-typecheck` | 45.2 s | 36.1 s | −20% | 1 |
| `pnpm run test:docs` | 102.4/104.0 s | 26.8/29.3 s | −73% | 3–6 |
| `pnpm run doc-sync` | 186.8 s | 70.3 s | −62% | 3–7 |
| `pnpm run test` | 222.7 s（255 个 worker） | 148.1 s（48 个 worker） | −34% | 3、8 |

`lint` 的耗时主要是 Oxlint 本身，其前置步骤的下降见第 1 项。CPU 时间随 wall 一同下降：`typecheck` 的 user 时间 39.5 → 14.2 s，`test:docs` 212.6 → 126.3 s，`doc-sync` 628.2 → 503.2 s，`test` 3,417 → 3,014 s。

## 考虑过的替代方案

- **所有本地默认值一律以 12 为上限，包括 Vitest fork（第 3 项）：** 12 个 worker 时 `pnpm run test` 为 410.5 s，255 个时为 243.7 s，慢 68%。
- **以 cgroup CPU 配额的一半作为本地预算（第 3 项）：** 读取配额的改动更大，且只在容器内有意义。
- **用 `worker_threads` 并行解析文档（第 5 项）：** 它带来的复杂度高于每个文档只解析一次，而后者直接消除了重复工作。
- **在 pre-commit 钩子中重新生成第三方声明（第 2 项）：** 浏览器输入使每个包源码文件都成为生成器输入，钩子会让几乎每次提交都运行约 16 秒的生成器，而改变输出的提交很少；[生成的第三方声明 Note](2026-07-30-generated-third-party-notices.zh.md) 拥有该决策。

## 后果

无需重查时 pre-push `typecheck` 约 14–22 s，`lint` 与 `doc-typecheck` 的前置步骤约 12 s，改动 1 个文件的提交的钩子约 4 s。`pnpm run test` 在本地最多启动 48 个 fork，`test:docs` 与 `doc-sync` 最多同时运行 8 个门禁。Typert 输出、生成的页面、文件列表与引用判定都与基线逐字节一致。

代价：类型检查命令不刷新可运行的 bundle；第三方声明过期时在推送后于测试 lane 失败；本地默认值不使用超过上限的 CPU，而配额低于上限的容器仍会超额订阅；并发 8 个文档门禁抬高 `doc-sync` 的 RSS 峰值；CLI help 峰值约用 3.6 GB 内存；doc graphs 与 markdown links 假定运行期间工作树不变；除 Emitter 用例外，`type-model.spec.ts` 检验的是桩，而不是真实 zod、`@types/node`、DOM lib 与磁盘 I/O；增量 `typecheck` 继承 Issue #6022 跟踪的 Remote 声明缺口。

验证：`generate-typert.spec.ts` 固定与 workspace 模式插件逐字节一致的文件、对加载已编译工作区声明的 Host program 的拒绝（并指出缺失的别名），以及每个失败阶段；`compile-referenced-projects.spec.ts` 固定 `host-contracts` 的步骤及其失败报告；`build.spec.ts` 固定 typecheck scope 的步骤；`parallelism.spec.ts`、`run-gates.spec.ts` 与 `run-oxlint.spec.ts` 固定 CI 与本地预算以及覆盖变量；`repo-files.spec.ts`、`markdown.spec.ts`、`translation-pairing.spec.ts`、`type-equiv-prefilter.spec.ts`、`verify-md-links.spec.ts`、`gen-cli-help.spec.ts` 与 `gen-doc-graphs.spec.ts` 固定目录只列一次、语法树复用、配对守卫、预筛、预取顺序与失败路径，以及探测 memo 及其恢复。
