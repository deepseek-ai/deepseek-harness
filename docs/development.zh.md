# 开发指南

[English](development.md) | 中文

搭建教程引导新贡献者从准备前置条件开始，直到检出目录通过检查。后面的贡献者参考介绍仓库布局、日常工作流和 CI 组织方式。设计依据与实现细节属于链接的 Agent Note 和脚本。

<a id="setup-tutorial"></a>

## 搭建教程

### 前置条件

- Node.js 支持 22.19+ 与 24+。CI 覆盖 22.19、24 和 26；见 [Node 引擎下限 Agent Note](../.agents/notes/implemented/process/2026-07-06-node-engine-floor.zh.md)。
- 启用了 Corepack 的 pnpm。仓库在 `package.json` 中固定使用 `pnpm@11.7.0`；如果 `pnpm --version` 无法通过 Corepack 解析，请先运行 `corepack enable`。
- Git 2.26 或更高版本；钩子设置会启用 Git 的 worktree 专属配置扩展。
- 可选：一个 DeepSeek API key，用于 Web、headless 和 ACP（Agent Client Protocol）自动化 agent（智能体）演示以及真实 API 的 e2e 测试。

### 首次搭建

在仓库根目录安装依赖：

```sh
pnpm install
```

安装过程还会通过 `scripts/install-lefthook.mjs` 配置 worktree 本地的 Lefthook 钩子和 `dsh-translation-pairing` Git 合并驱动。[worktree 本地钩子 Agent Note](../.agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.zh.md) 负责钩子路径的安全约定；[自动配对合并 Agent Note](../.agents/notes/implemented/process/2026-08-08-automatic-translation-pairing-merges.zh.md) 负责合并驱动。

如果依赖是从缓存恢复或 `postinstall` 被跳过而导致任一集成缺失，请手动安装：

```sh
node scripts/install-lefthook.mjs
```

如果包装脚本拒绝现有 Git 配置或报告陈旧锁，请遵循其诊断和所链接的 Agent Note，不要凭猜测编辑 worktree 元数据。移动检出目录后，请重新运行包装脚本以重新生成自有路径。

新克隆后请先运行一次类型检查：

```sh
pnpm run typecheck
```

`pnpm run typecheck` 成功退出即表示搭建完成。

## 贡献者参考

<a id="typescript-project-layout"></a>

### TypeScript 项目布局

仓库使用相互隔离的 Host 与 Client aggregate。普通包只登记进其中一个 aggregate；Host 包进入 `tsconfig.host.json`，Client 包进入 `tsconfig.client.json`；`host/webserver`、`compaction/compaction` 与 `typert/registry` 三个包被两个 aggregate 同时引用，作为共享 leaf，让两侧对同一份源码做类型检查。

| 文件 | 角色 | 是否构成 program？ |
|---|---|---|
| `tsconfig.json` | solution 根：`extends` base、`files: []`、引用两个 aggregate。它是 tsserver 发现入口，也是显式执行整张 Project Reference 图时的入口；经继承的 `paths` 充当 tsx 运行 `scripts/` 时的解析配置。 | 否 |
| `tsconfig.host.json` | Host aggregate：Host 包、示例、测试、脚本和 website，以及 `api/remotes` 的 Host 特例 project。 | 是 |
| `tsconfig.client.json` | Client aggregate：`packages/client/*` 包及其测试、`apps/web`，以及 `api/remotes` 的 Client 特例 project。 | 是 |
| `tsconfig.base.json` | 共享 compilerOptions 与源码 `paths` 映射。同时是各 vitest 配置让 vite-tsconfig-paths 指向的解析门面：它没有 `include`，因此其 `paths` 适用于任何 importer。 | 否 |
| `tsconfig.base.client.json` | 浏览器编译设置（`jsx`、DOM lib、`types: []`），由 Client aggregate 和每个 `packages/client/*` 包 extends。 | 否 |

Host 与 Client 保持两个 aggregate program，是因为两侧在相同键下以不同服务对 cordis `Context` 接口做声明合并；单一 program 同时看到两份合并会报冲突。这种冲突只存在于 `ts.Program` 内部——模块解析永远不会触发它——所以 solution 可以同时引用两个 aggregate，一个 paths 门面也可以横跨两侧。由此推出三条纪律：

- `tsconfig.base.json` 永不添加 `include` 或 `files`：它们会泄漏进每个 extends 它的包项目，并收窄门面的全匹配范围。
- 构造全仓 `ts.Program` 的脚本显式以 `tsconfig.host.json` 或 `tsconfig.client.json` 为种子——根 solution 永不作为种子，因为把两个 aggregate 展平进一个 program 会撞上 `Context` 合并冲突。
- 新包只登记进一个 aggregate；只有上述拆分包同时携带两个 leaf 配置，共享 leaf 因两侧需要对同一份源码做类型检查而登记进两个 aggregate。包同时具有 Node loader 入口和 browser 入口并不构成拆分理由；普通 Client 插件的两份运行时产物都在 Client 构建阶段生成。

拆分 Host/Client tsconfig 的包有六个：`api/remotes`、`api/gateway`、`api/session-controller`、`api/workspace-controller`、`client/connection` 与 `session-query/session-log-export`。`api/remotes` 的 Host 入口进入 Host Typert 图，而 Client 入口导入生成的 `/remote` 声明；`session-log-export` 则让 Node archive 生产代码不进入浏览器 controller。每个拆分包根 `tsconfig.json` 因此只作为 solution，两个 aggregate 和直接消费方分别引用 `tsconfig.host.json` 或 `tsconfig.client.json`。workspace `constraints` 门禁遍历可达的 Project Reference 图，并按各引用 project 自身的 compiler face 检查：只有单一配置的目标可由任一 face 引用，拆分配置的目标则必须引用匹配的 leaf，不得引用 solution 根或另一侧 leaf；该门禁按「两个 leaf 配置同时存在」自动发现拆分包，所以新拆分的包会自动纳入管辖。[`api-remotes` README](../packages/api/remotes/README.zh.md) 与 [`session-log-export` README](../packages/session-query/session-log-export/README.zh.md)分别说明其拆分。

根构建按生成依赖排序：

```sh
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web
```

两次 tsdown 都使用同一组完整 workspace 匹配，不扫描构建产物来发现 Client 包，也不维护 Host/Client 包过滤表。包内 tsdown 配置根据 `DSH_BUILD_FACE` 决定当前阶段的入口：普通 Client 插件在 Client 阶段同时生成 Node loader 与 browser bundle；`api-remotes` 通过 `hostPhase: true` 提前生成 Host 入口，再在 Client 阶段只生成 browser bundle。tsdown 只消费 `lib/types` 中由前置 tsc 发射的 JavaScript。

Typert 只在 Host tsdown 中以 `tsconfig.host.json` 为种子运行。它分析 Host 类型并生成 Host 反射产物及 Host-for-Client Remote 投影；Client tsdown 不启动 Typert。`pnpm run typecheck` 因此先执行完整 Host lib 阶段，再运行 Client tsc；`pnpm run build` 继续执行 Client tsdown 和 Web 构建。

`pnpm run build` 会内联根包版本、七位源码 commit，并在 Git 报告本地变化时内联 dirty 标记；调用方提供的其他 `DSH_CLIENT_*` 值也会被继承。`pnpm run build:official` 是与 CI 和 release 产物构建等价的跨平台本地命令，并省略本地 dirty 标记。每次完整构建成功后都会写入一份被 gitignore 的记录，把精确公开值与 Vite 输出及动态 client bundle 绑定；release 打包和 built Web 测试会拒绝缺少记录或被后续局部构建改动的产物。`pnpm run dev:web` 仍需要先执行完整构建来准备产物树，但会在启动时读取一次当前版本和 Git 状态，并在本次会话的所有 watcher stage 之间共享该环境；它不会校验完整构建记录，因为 watcher stage 会重写记录覆盖的产物。

静态分析和测试通过 base 的 `paths` 映射把工作区 import 解析到 `src`，且必须在干净树上通过；消费构建产物 `lib/` 的门禁显式声明该依赖。生成的 Host-for-Client Remote 声明是有意设置的例外：公共 `typecheck`、`lint` 和 `doc-typecheck` 命令会先生成这些声明，而内部 `*:contracts-ready` 脚本假定调用它的公共命令或调度器门禁已经依赖 Typert 约定生成阶段或完整构建。tsc-first 发射职责见 [ts-build-config Note](../.agents/notes/implemented/process/2026-06-17-ts-build-config.zh.md)，门禁准备约定见 [Typert Remote Agent Note](../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)。

业务服务在 Host 使用 `@Remote` 或 `@RemoteScope` 声明可调用方法；Host 构建生成 Host-for-Client 类型与运行时贡献，Client 的 `api-remotes` 组合加载这些贡献并挂到 `ctx.remote` 与作用域 `agentCtx.remote` namespace。两侧的生成产物、装配关系、SRC 开发回退和 Web 构建顺序见 [API Gateway](api-gateway.zh.md)。

如果相关的本地检查需要使用构建后的包产物，请先构建一次：

```sh
pnpm run build
```

`pnpm run hygiene` 包含 `publint`（用构建出的 `lib/*.js` 文件校验包入口点）和 `verify-node-next-types`（用一个临时的 NodeNext 消费方校验构建出的声明文件）。新 worktree 在 `pnpm run build` 运行之前没有打包的 JS 和声明文件；普通提交和推送无需构建，除非所选检查会使用这些产物。

### 环境变量

真实的 DeepSeek 适配器和需要密钥的 agent 演示从环境变量或仓库根目录一个被 gitignore 的 `.env` 文件读取凭证：

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` 可选，默认为公开 API。请勿提交真实凭证。未设置 `DEEPSEEK_API_KEY` 时，真实 API 的 e2e 套件会自动跳过。

### Git 集成

当两种语言的文件都使用 Git 默认文本策略且能干净合并时，配对合并驱动会根据已确认的祖先、当前和另一侧的配对文档 blob，推导出发生冲突的 `.i18n.yaml` 记录。配对文档发生冲突、存在非文本合并配置或记录无效时，它会拒绝处理并保留冲突；如果合并已经因冲突而停止，请运行 `pnpm run resolve-translation-pairing-conflicts`，该命令会暂存每份可安全生成的配对记录；如果其他配对冲突仍需手工处理，则以非零状态退出。[双语文档约定](i18n/README.zh.md#the-pairing-contract)列出该驱动接受的确切文件和状态。

安装脚本在发布 worktree 配置前，会探测确切的 Node/tsx 驱动入口点。如果该运行时之后变得不可用，不依赖 Node 的启动器会写入 Git 的普通文本合并结果、让伴随文件保持未解决状态，并打印恢复路径；请恢复依赖后运行 `pnpm run resolve-translation-pairing-conflicts`，或运行 `git merge --abort`。如果 `pre-merge-commit` 拒绝原本能干净完成的合并，Git 会把完整结果留在暂存区但不创建提交；请修复失败后运行 `git commit`，或中止合并。确切的索引与 `MERGE_HEAD` 状态由[自动配对合并 Agent Note](../.agents/notes/implemented/process/2026-08-08-automatic-translation-pairing-merges.zh.md#failure-contract)负责记录。

lefthook 在 `lefthook.yml` 中配置，作为快速的本地检查点：

- `pre-commit` 对照暂存的配对文档 blob 校验暂存的配对记录，使用不加载项目的 `.oxlintrc.staged.json` 配置验证暂存文件，并通过一次有界重试应用 Oxlint 修复，在暂存文件属于 `THIRD_PARTY_NOTICES.md` 的输入时重新生成该文件，然后检查暂存 diff 中的空白错误，并运行 vendor manifest（元数据清单）守卫；
- `pre-merge-commit` 在 Git 创建自动合并提交前执行同样以索引为准的配对检查；
- `pre-push` 运行 `pnpm run typecheck`；该命令会先完成包含 Typert 约定生成的完整 Host lib 阶段，再运行 Client TypeScript 检查。

vendor manifest 守卫检查 `vendor/*/src` 下的改动是否连同对应的 `vendor/README.md` manifest 更新一起暂存。请在编辑 vendor 代码前先阅读 `vendor/README.md`。

除限定范围的暂存记录校验外，这些钩子有意不运行测试、快照、文档检查、构建或 `hygiene`。贡献者只运行一次[与改动行为相关的检查](../AGENTS.md#run-relevant-checks-locally)；CI 负责全量覆盖率门禁、构建产物冒烟测试，以及 Node 22.19、24 和 26 兼容性矩阵。

贡献者可以选择运行 `pnpm run check:all`，执行全面的本地门禁集。该命令独立于 Git 钩子，也不是对 agent 的指令。

### CI 门禁

keyless [CI 工作流](../.github/workflows/ci.yml) 将独立门禁分组到若干宽粒度 lane，并在受支持的 Node 版本上运行一组较小的兼容性检查。产物消费方在各自 lane 内等待一次 build。必需 benchmark 在标准 GitHub 托管 Linux 上独立运行；[benchmark 运行器决策](../.agents/notes/implemented/testing/2026-09-06-standard-hosted-benchmark-runner.zh.md)拥有路由及 job 超时。单独的真实 API 工作流按其配置的 worker 上限运行 `pnpm run test:e2e`。当前门禁和 job 清单以 [scripts/run-gates.ts](../scripts/run-gates.ts) 和工作流文件为准。

不带凭据的 dsh 依赖布局检查与 dsh/vendor 打包演练仅在 `DSH_CI_FAILOVER_LINUX=selfhosted`，且事件为受信任的 master 推送或同仓库、非 fork、非 Dependabot 拉取请求时使用现有 Linux 自托管池。其余情况（包括手动触发）均使用 `ubuntu-24.04`；手动发布仍使用托管运行器。持久化存储隔离与回退限制见[发布演练运行器决策](../.agents/notes/implemented/process/2026-09-06-release-rehearsal-selfhosted.zh.md)。

### 日常命令

根目录的[贡献者说明](../AGENTS.md#commands)概述常用命令，[`package.json`](../package.json) 与 [scripts/run-gates.ts](../scripts/run-gates.ts) 则负责当前脚本和门禁清单。请选择覆盖变更表面的最小检查集。文档变更使用 `pnpm run doc-sync`；包公开行为变更还需更新所属 README 或 JSDoc，而基于构建产物的检查需要先运行 `pnpm run build`。

### Profile 运行

从源码 checkout 运行这些演示前，请单独执行仓库构建：

```sh
pnpm run build
```

单次运行的 Headless coding agent 需要环境变量或仓库根目录 `.env` 中的 `DEEPSEEK_API_KEY`：

```sh
pnpm dsh --profile headless "summarize this workspace"
```

PTC mode 演示启用代码式工具展示，并运行同一个 headless profile：

```sh
pnpm run demo:ptc -- "summarize this workspace"
```

### TODO 标记

请使用以下三种注释标签之一标记代码中的已知问题，按紧急程度排序：

- `FIXME`：应当阻塞新版本发布的问题。除非评审者明确同意该更改可以合并，否则发布版本不应包含未解决的 `FIXME`；
- `TODO`：应当尽快修复的问题，等资源到位即可处理；
- `XXX`：也许某天会修复的问题，优先级最低，不作承诺。

请选择与紧急程度匹配的标签，让浏览代码的人一眼分清「发布阻塞」和「有空再说」。

<a id="documenting-types-verbatim-ts-type-equiv"></a>

### 逐字记录类型定义（`ts type-equiv`）

[子系统](subsystems/README.zh.md)页面会把与源码等价的声明及其原始 JSDoc 一并粘贴，让读者看到确切类型定义和源码约定。为防止粘贴内容在源码变化时漂移，请将其围栏为 ` ```ts type-equiv `（而不是 ` ```ts `），并在 `scripts/type-equiv.manifest.json` 中登记它镜像的源文件和符号：

```json
{ "doc": "docs/subsystems/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv`（`doc-sync` 的一环）随后通过 TypeScript 解析器从源码提取该符号的声明及其附带的 JSDoc，并断言代码块同时匹配两者。对于不应把实现体写进目录的类，请使用 ` ```ts public-api ` 并设置 `"projection": "public-api"`；门禁检查的投影会保留公共字段、构造函数、访问器、方法以及类和成员的原始 JSDoc，同时省略实现体和私有或受保护成员。比对会忽略空白和非 JSDoc 注释，但要求保留每条原始 JSDoc（包括成员文档），让读者同时看到源码约定和确切类型定义。该门禁按文档、符号和投影，在主块与 manifest 条目之间强制 1:1 对应；只有当配对 `.zh.md` 块的完整受跟踪围栏序列与其无后缀兄弟文件按字节一致且顺序相同时，才会复用后者的条目。`doc-typecheck` 对可编译围栏应用同一派生规则，同时跳过两种源码等价围栏的编译，并将其排除在 opt-out 比例的计算之外。当你改动一个已记录的类型声明或其 JSDoc 时，门禁会失败直到你更新粘贴内容；当你增删一个主块时，请在同一个变更里更新 manifest。
