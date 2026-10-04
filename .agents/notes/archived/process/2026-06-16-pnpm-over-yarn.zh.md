# Agent Note: 使用 pnpm 替代 Yarn 4 作为包管理器

Status: implemented
Archived: 2026-09-30

[English](2026-06-16-pnpm-over-yarn.md) | 中文

## 问题

本仓库最初使用 **Yarn 4** 搭配 `node-modules` 链接器。这是一个刻意保守的选择：行为类似 npm 的扁平布局，同时享有 Yarn 的 workspaces 和 `yarn constraints`。它能正常工作。但 Yarn 4 源自 Plug'n'Play 的血统，使得 `node-modules` 链接器成为非主流模式；而更广泛的 JS 生态——工具默认值、CI action、Corepack 示例、贡献者的熟悉度——正日益以 pnpm 为中心。对于一个主要由 agent（智能体）构建、偶尔有人类贡献者阅读的仓库而言，「大多数工具和人所期望的包管理器」具有实际价值：更少的意外、更成熟的故障路径、更多可直接复用的解答。

切换成本目前处于最低点。本仓库尚无任何包发布（每个包都是 `private: true`）；开发流程、测试和源码模式 demo 都通过各自声明的 TypeScript 启动器运行，产物检查则会显式构建。因此，包管理器只需做到：（a）解析并链接 `node_modules`，（b）运行 workspace 脚本，（c）强制执行 workspace 约束。唯一的 Yarn 特有资产是 `yarn.config.cjs`（`@yarnpkg/types` 约束引擎），体量小且可机械地重新表达。这与 [tsdown 决策](../../archived/process/2026-06-11-tsdown-over-dumble.md)的逻辑一致：在爆炸半径尚小时，将承重工具换为生态更健康的选项。

## 决策

采用 **pnpm 11.7.0**，通过 `packageManager` 字段固定版本。贡献者环境使用 Corepack，CI 则通过 `pnpm/action-setup` 安装该固定版本：

- **Workspaces** 从 `package.json` 的 `workspaces` 数组 + `.yarnrc.yml` 迁移到 `pnpm-workspace.yaml`；vendored 包、分组包、应用、网站、原生 launcher 与 Python runtime closure 都是显式成员。
- **严格符号链接链接器**（pnpm 默认）取代 Yarn 的提升式 `node-modules` 链接器。我们刻意**不**添加 `node-linker=hoisted` / `shamefully-hoist` 逃生口：pnpm 的非扁平 `node_modules` 会使幻影依赖（引用未声明的传递依赖）明确报错，这对于一个以机械门禁为核心质量保障的仓库（见[机械质量门禁](2026-06-11-quality-gates.zh.md)）是一项*优势*。门禁套件（类型检查、lint、test 和 build）是证明不存在此类幻影导入的安全网。
- **构建脚本白名单。** pnpm 10+ 不运行依赖的生命周期脚本，除非将其加入白名单。`pnpm-workspace.yaml` 携带一份显式的 `allowBuilds` 映射（`esbuild`、`lefthook`、`@google/genai`、`protobufjs`）——与本仓库对模型/工具输出已有的供应链加固姿态一致，现在也应用于安装时的代码执行。`peerDependencyRules.allowedVersions.typescript: '>=5 <7'` 消除仓库内 TypeScript 的良性 peer 范围警告。
- **无 shell 的包管理器再进入。** 需要启动另一条 pnpm 命令的仓库脚本按文件形式解析 `npm_execpath`：`.js`、`.cjs` 和 `.mjs` 入口由当前 Node 可执行文件运行，原生及带 shebang 的可执行入口则直接运行。两条路径都不使用 shell，因此命令路径和参数在各平台上均保留字面内容。[原生 Windows 拉取请求作业](2026-08-08-native-windows-pull-request-ci.zh.md)会提供 `@pnpm/exe`，因此其完整清单会产生真实的 PE 入口集成信号。
- **约束变为包管理器无关。** `yarn.config.cjs`（导入 `@yarnpkg/types`，使用 `Yarn.workspaces()` / `workspace.set()`）被 `scripts/check-workspace-constraints.ts` 取代——一个纯 tsx 脚本，通过 `pnpm run constraints` 运行。它在相同的 `vendor` + `packages` 范围上强制执行完全相同的不变式：每个包 `private: true`；`@deepseek-ai/dsh-*` 包将 `cordis` 同时声明为对等依赖（peer dependency）和 dev 依赖且范围一致、使用根 `package.json` 的版本、设置 `type: module`；vendor 包仅检查是否为私有。
- 所有 CI、lefthook 钩子、`package.json` 脚本和文档中的 `yarn …` 动词变为 `pnpm …` / `pnpm run …`。`yarn.lock` → `pnpm-lock.yaml`（lockfile v9）。`.gitignore` 将 `.yarn/` 换为 `.pnpm-store/`。vendor README（如 `vendor/cordis/README.md`）按 Vendoring Policy 保持其上游 `yarn` 示例不变。

## 曾考虑的替代方案

- **保留 Yarn 4**——零变动，但押注于使用率较低的链接器模式和一个绑定单一包管理器的约束引擎。
- **npm workspaces**——无处不在，但没有约束方案，monorepo 开发体验也较差。
- **pnpm 搭配提升式链接器**——迁移更平滑，但放弃了幻影依赖安全性，而这正是迁移的核心正确性理由。
- **始终通过 Node 运行 `npm_execpath`**——适用于 pnpm 的 JavaScript 分发，但会让 Node 尝试解析 `@pnpm/exe` 提供的 ELF、Mach-O 或 PE 可执行文件。
- **通过 shell 运行再进入命令**——可接受更多启动器形式，但会改变每条子命令的引号、元字符展开、可执行文件解析和信号行为。

## 后果

约束检查失去了 Yarn 的自动**修复**能力（`workspace.set()` 能原地改写 manifest）；tsx 脚本仅做检查，不通过时以非零退出码和消息退出。这是可接受的：CI 从未运行过 `--fix`，且需要手动编辑的情况很少。贡献者现在为 pnpm 而非 Yarn 运行 `corepack enable`；`pnpm exec lefthook install` 取代 `yarn lefthook install`（`postinstall` 钩子仍会运行 `lefthook install`）。

性能（迁移时在开发 NFS 文件系统上测量；运行次数为个位数的样本，方差大——仅供方向性参考，非基准测试套件）：

| 场景 | Yarn 4 | pnpm 11 |
|---|---|---|
| 冷启动（空缓存/store，无 `node_modules`） | ~14 s | ~16 s |
| 热重链接（缓存/store 已热，`node_modules` 已删除） | ~12–14 s | ~15–22 s |
| 冻结安装，`node_modules` 存在（无操作重验证） | ~2–8 s | ~0.5–7 s |

在快速本地磁盘上，pnpm 的内容寻址 store 通常在冷/热安装中胜出，尤其在多个检出之间的**磁盘占用**方面优势明显（一个全局 store 通过硬链接接入每个 `node_modules`，而 Yarn 每个 worktree 复制约 279 MB——部分开发者经常为本仓库保持约 10 个或更多 worktree）。该去重优势在上述迁移时数据中**未能**体现，因为测试 store 和 `node_modules` 位于不同文件系统，硬链接失效；在单文件系统的开发机或 CI 缓存上则适用。诚实的总结：在我们的 NFS 开发文件系统上，安装速度在噪声范围内不分伯仲；迁移的理由是生态对齐、幻影依赖安全性和跨检出磁盘去重，而非原始安装时间的胜出。

所有质量门禁（constraints、类型检查、lint、doc-sync、达到 100% 的 test:coverage、构建、publint 以及已构建应用的冒烟测试）均在 pnpm 下通过，证明更换链接器没有引入幻影依赖故障。
