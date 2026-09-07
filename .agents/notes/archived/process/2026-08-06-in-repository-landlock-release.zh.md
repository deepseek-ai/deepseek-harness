# Agent Note: 仓库内 Landlock 发布

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-in-repository-landlock-release.md) | 中文

## 问题

`@deepseek-ai/node-addon-landlock-run` 源码已经与其 DeepSeek Harness 消费方一同位于 `native/landlock-run` 下，但此前仍保留独立的 pnpm workspace 和锁文件，并依赖一个独立仓库发布到 npm。Harness 包使用 npm 注册表中的固定版本，因此同一个 PR（Pull Request）可以同时修改启动器约定及其消费方，却无法一起测试这些改动。源码仓库的原生工作流可以演练打包流程，但不会发布它实际测试过的产物。

发布镜像还造成重复的发布协调工作：导出源码、更新另一份锁文件、运行另一套发布工作流、发布原生包家族，然后回到本仓库更新注册表依赖。npm 用户的实际需求并未改变，这种拆分却让每个二进制更难对应到其源提交，也让发布回滚和安全修复协调更困难。

现有的非 scoped npm 包名归独立发布账号所有，而不属于 `@deepseek-ai` 组织。因此，仅迁移工作流仍会让发布依赖仓库发布归属之外的个人凭证。

此次整合必须保留平台选择机制。公开分发有意采用一个 JavaScript 入口包，并为 Linux x64 和 arm64 分别提供二进制包；合并仓库归属并不意味着要把所有二进制文件放进同一个 tarball，也不意味着要按照启动器版本发布所有 DeepSeek Harness 包。

## 决策

`native/landlock-run` 和 `native/landlock-run/packages/*` 属于仓库根 pnpm workspace，并使用根 `pnpm-lock.yaml`。Harness 消费方将 `@deepseek-ai/node-addon-landlock-run` 声明为 `workspace:*`，因此开发、类型检查、构建和 PR 测试都会从同一个 checkout 解析入口包。根 TypeScript 项目图会先构建该入口包，再构建消费方；仓库清理器负责清理其直接生成的 `lib/` 输出目录。

公开 npm 分发边界由 3 个归组织所有的包组成，它们共用一个启动器包家族版本：`@deepseek-ai/node-addon-landlock-run`、`@deepseek-ai/node-addon-landlock-run-linux-x64` 和 `@deepseek-ai/node-addon-landlock-run-linux-arm64`。入口包继续通过 `optionalDependencies` 声明两个平台包；它们在 manifest（元数据清单）中的 `os` 和 `cpu` 字段让 npm 只安装兼容的包。仓库约束要求这 3 个包名设置 `publishConfig.access: public`，并要求其版本与私有启动器 workspace 根包一致。原先的非 scoped 包名不属于本仓库的发布目标。这 3 个已不再是唯一的公开包：[按序列区分 access 的决策](2026-08-13-public-vendor-and-native-sequences.zh.md)让 vendored 框架九包也公开发布，而 dsh 族保持受限。

主仓库同时负责原生 CI 和发布。`Landlock Run` 会为相关 PR 和 `master` 推送运行，并在各自匹配的原生 runner 上构建每个平台包。手动触发的 `Landlock Run Release` 工作流会构建两个平台的二进制文件，将其作为工作流产物传递，组装并验证完整的包家族，打包出内容不可变的 npm tarball，安装并实际运行这些 tarball，之后才允许受保护的发布作业执行。发布顺序是平台 tarball 在前，最后发布将它们列为可选依赖的入口 tarball。发布使用 `landlock-run-vX.Y.Z` tag，避免启动器版本与 monorepo 中其他发布家族发生冲突；预发布版本使用 npm 的 `next` dist-tag。

沙箱打包安装演练不允许 npm 注册表提供启动器。它会根据当前 workspace 的 `dependencies`、`optionalDependencies` 与必需 `peerDependencies` 递归推导 harness 闭包；原生包家族保持独立，因为保留文件模式的打包脚本会提供入口包和匹配平台包。演练把这些本地 tarball 安装到仓库外部的纯 Node 消费方中，并在测试约束效果或失败闭合行为之前，证明所安装的启动器可执行、与原生构建产物字节完全一致，且具有正确的 ELF 架构。

## 曾考虑的替代方案

- **保留独立仓库作为发布镜像**：不予采纳，因为在权威源码已经迁入本仓库后，这仍会保留拆分的锁文件、源码导出、测试使用陈旧注册表版本的时间窗，以及跨仓库发布序列。
- **发布一个包含所有平台二进制文件的 npm 包**：不予采纳，因为用户会下载无法在其主机上运行的二进制文件，而且 npm 无法再利用包级 `os`／`cpu` 筛选。仓库归属与 npm 包布局是两个彼此独立的选择。
- **让启动器使用 DeepSeek Harness 根版本，并递归发布整个 monorepo**：不予采纳，因为本次改动负责的是一个由 3 个包组成的公开包家族，而不是独立的 `@deepseek-ai/dsh-*` 基线。[产物优先的 npm 基线提案](../../proposed/process/2026-08-04-artifact-first-npm-baseline-publication.zh.md)明确将原生 workspace 排除在其目标集合之外。
- **在一个发布作业中交叉编译两个二进制文件**：不予采纳，因为仓库内已提交的包矩阵已经为每种架构分配了原生 GitHub runner，无需再把交叉工具链纳入信任边界。

## 后果

同一个 PR 可以同时修改启动器协议、TypeScript 入口代码、原生源码、harness 消费方式和发布路径测试，并从同一份锁文件解析这些内容。发布 tag 现在标识源码、消费方集成、构建指令，以及主仓库测试过的 tarball。独立镜像已不再属于发布路径，可以在第一次成功从本仓库发布后归档。

npm 消费方改为安装 `@deepseek-ai/node-addon-landlock-run`；原先的非 scoped 包名不会被静默重定向。受支持的 Linux 主机会下载 scoped 入口包及与其架构匹配的包，并跳过另一架构的包。不受支持的主机不会收到平台二进制文件，并继续沿用现有的确定性失败闭合探测路径。

实现涉及的文件比只修改一行依赖更多，因为仓库还必须负责 workspace 约束、TypeScript 构建顺序、清理、CI 触发条件、发布 tag、锁文件生成、将已安装二进制与 workspace 构建进行比较、发布文档和生成的第三方声明。行为边界仍然很窄：此次改动只影响 Landlock 包家族及其 3 个直接 workspace 消费方，不改变其他 DeepSeek Harness 包的版本或发布状态。

第一次发布 scoped 包时，必须通过 `npm-publish` 环境的 `NPM_TOKEN` 使用 `@deepseek-ai` 组织 token，因为 npm 只有在包已经存在后才能配置 trusted publishing。完成 bootstrap 后，必须让 3 个包都授权本仓库的发布工作流，才能移除后备 token。npm 仍会按顺序发布各个包，且不提供跨包事务，因此发布失败可能留下只完成了一部分的版本。由于 npm 会拒绝已经发布的同名同版本包，操作人员必须检查注册表并只发布缺失的 tarball，而不能原样重新运行工作流。Linux x64 和 arm64 runner 仍提供权威的二进制构建与真实内核检查；macOS checkout 可以验证入口包和不受支持平台上的行为，但不能取代这些作业。

本说明仅取代[沙箱 Agent Note](../feature/2026-07-06-sandbox.zh.md)中有关发布镜像和开发源码时依赖注册表固定版本的表述；该 Agent Note 仍负责沙箱行为、runner 选择和强制执行语义。
