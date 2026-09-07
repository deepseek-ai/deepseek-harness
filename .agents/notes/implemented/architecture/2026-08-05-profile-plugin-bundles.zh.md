# Agent Note: profile 插件组合包取代固定的表层 overlay

Status: implemented

[English](2026-08-05-profile-plugin-bundles.md) | 中文

## Problem

`dsh` 启动器硬编码了自己的组合：`base.cordis.yml` + `web.cordis.yml` 随 `apps/cli` 一起交付，三种各自定制的入口模式（`--config`、`web`、`-p`）各带一套层栈，外加一个全局的个人 overlay（`$DSH_HOME/config.yaml`）。想把树外插件（一个 TUI、一个提供方扩展包）装进已交付的表层，只能修改仓库；第三方包也没有任何位置可以贡献默认组合。

## Decision

一切都变成 **profile**：即目录 `$DSH_HOME/profiles/<name>`，其中包含一个 `package.json`（pnpm 管理的树外插件 `dependencies`，加上 profile manifest `dsh.profile` 及其有序的 `bundles` 层列表）和一份用户 `cordis.patch.yml`。**组合包**（bundle）是声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包；两种 manifest 分别位于互不相同的 `dsh.profile` / `dsh.bundle` 键下，因此一份 package.json 能说明自己扮演哪种角色。配置树在空的根之上组合：按 `dsh.profile.bundles` 顺序应用每个组合包的 patch，然后是用户层与 `--patch` overlay——启动与 `--dump-config` 共享同一条 `applyEntryPatches` 路径。随后，[应用持有命令行的决策](../../archived/architecture/2026-08-06-app-owned-command-line.md)又把调用期取值从启动器派生的 patch 迁移到了启动服务。

默认 Profile 模板为 `web`、`headless`、`sdk` 与 `acp` 使用 `@deepseek-ai/dsh-base` 作为共享核心，并在其上叠加一个模式组合包。[独立 `sdk-minimal` profile](../../../../packages/bundle/sdk-minimal/README.zh.md)则只列出一个拥有完整显式配置树的组合包。通用的 `dsh --profile <name>` 把剩余参数交给该 profile 的命令行启动行：Web 持有自己的 flag 家族，headless 持有任务位置参数，协议 profile 不接受应用选项。patch overlay 使用启动器持有的 `--patch`。`dsh plugin --profile <name> <args...>` 是一层薄薄的 pnpm 转发器，负责初始化 profile，并依据已安装包的组合包声明调和 `dsh.profile.bundles`；没有组合包声明的包保持为普通依赖。[Headless 作为直接 core 入口](../../archived/architecture/2026-08-09-headless-direct-core-entry-point.md)负责 headless 组合约定。

解析在构造上就是双锚点的：`dsh.profile.bundles` 中的名称先从 dsh 安装目录解析，再从 profile 目录解析——因此内置组合包始终来自与运行中 `dsh` 相同的安装，pnpm 从不管理它们——而 patch 行中的裸插件名称经 profile 目录的 Node 父目录逐级查找，落到受维护的扁平回退目录 `$DSH_HOME/profiles/node_modules`（安装目录的应用与各组合包所依赖的每个包各一个符号链接，每次启动时修复）。

两项配套重构：webserver 内置的静态 dist 服务改为单一所有者的**回退席位**（`registerFallback`／`applyIndexTaps`），SPA 服务器提取到 `@deepseek-ai/dsh-host-frontend-static`，使 web 组合包以组合的方式持有自己的 dist，而不是靠启动器代码；[dsh CLI 个人配置决策](../../archived/feature/2026-07-20-dsh-cli-personal-config.md)的个人 overlay 机制（`loadPersonalPatches`、`$DSH_HOME/config.yaml`）改为面向逐 profile 与 home 级的 `cordis.patch.yml` 层（`loadOptionalPatches`、接受文件名的 `watchUserPatches`），取代该笔记的各入口模式与文件位置，同时保留其 Harness home 根目录、patch 语义与响亮失败的解析。

## Alternatives considered

- **依赖扫描加部分 `patchOrder`**（最初的草案）：扫描 `dependencies` 找出组合包、未列出者按字母序排列，会产生两个真源和一条隐式决胜规则；一份显式有序的 `dsh.profile.bundles` 列表更小、完全确定。在 profile 内直接 `pnpm add` 只会安装一个库，不激活任何 patch——行为显式，没有暗中扫描。
- **内置组合包使用 `link:` 条目**：pnpm 无法对指向安装目录的 `link:` 做版本管理、安装或更新，它会把机器路径嵌进用户文件，并且在安装目录移动后失效。双锚点解析加上每次启动修复的符号链接回退提供了同样的保证（「组合包来自安装目录」），且没有这些繁文缛节。
- **在组合包 manifest 中放一个启动前 `context` 模块**承载启动期取值（dist 路径、flag 事实）：否决，改用纯插件——粘合逻辑就是普通配置行和由应用持有的启动服务，因此组合始终可完整 dump，manifest 保持纯数据。启动器提供的宿主 slot（`ctx.cmdlineArgs`、`ctx.appExit` 与环境快照）在任何配置树条目挂载之前，于 `boot()` 的 `prepare` 钩子中提供。
- **组合包的传递式自动应用**：只有直接列在 `dsh.profile.bundles` 中的条目才贡献层；想重新导出另一个组合包 patch 的元组合包，必须在自己的 patch 文件中显式完成。

## Consequences

- 新的组合表层（TUI、提供方扩展包）以普通 npm 包形式交付，可按 profile 安装，无需在仓库中为每种部署形态各留一行。
- `apps/cli` 收缩为 argv 解析、profile 机制的消费方和 pnpm 转发器；`AppCLIEntry` 与各表层专属的启动路径全部移除。
- 无密钥 web e2e 脚手架以与生产相同的空根形态启动相同的组合包层，包括 profiles 模块回退，因此测试与产品之间的组合漂移会响亮失败。
- 按发布前姿态，后端不携带旧磁盘配置的兼容行为；`$DSH_HOME/config.yaml` 会被忽略。
