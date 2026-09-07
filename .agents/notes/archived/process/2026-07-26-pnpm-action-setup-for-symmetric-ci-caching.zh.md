# Agent Note: 经由 pnpm/action-setup 提供 CI 的 pnpm

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md) | 中文

## 问题

除 `landlock-run.yml` 外，每个安装 pnpm 的工作流都曾用 `corepack enable` 手工提供 pnpm，其中五个还各自重复着一套手写（hand-rolled）的缓存设置——`pnpm store path --silent >> $GITHUB_OUTPUT`、再加上以 `pnpm-lock.yaml` 为缓存键的 `actions/cache@v4`：`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 node-compat、serial-linux 与 benchmark 作业。与之等价、由官方维护的做法——`pnpm/action-setup@v4`（从 package.json 读取 `packageManager`）加带 `cache: pnpm` 的 `actions/setup-node`——当时已在仓库内的 `landlock-run.yml` 中得到验证，而 corepack 被从较新 Node 发行版中移除，使每一处 `corepack enable` 都成了已知的未来失效点。

## 决策

`pnpm/action-setup@v4` 是 CI 中提供 pnpm 的机制：没有任何工作流运行 `corepack enable`。自托管 Windows 安装步骤是刻意的例外——它们调用 `corepack pnpm`，因为 clone 模式安装需要系统 corepack pnpm 携带、而 `pnpm/action-setup` 的 dest 构建缺少的 `@reflink/reflink` 原生模块（见 [Windows ReFS store note](2026-08-30-windows-refs-store-block-clone-install.zh.md)）。根目录的 `@yarnpkg/cli-dist` 开发依赖另行提供 generated-project e2e 所运行的现代 Yarn CLI（命令行界面）；因此，用于包管理器覆盖率的 Yarn 不会沿用 runner 镜像里的 Yarn Classic。缓存仍是叠加在 pnpm 提供机制上的按作业策略，保留三种有意采用的形态：

- **对称缓存**（既恢复也保存）：带 `cache: pnpm` 的 `actions/setup-node`——`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`、`ci.yml` 的 node-compat 作业，以及 `ci-master.yml` 的两个 benchmark 作业。larger-runner benchmark 通过条件化的 `cache:` 输入让 store 缓存仅限 Linux；consolidated benchmark 在两个平台上都启用缓存。
- **只恢复不上传**（手写的 `actions/cache` 步骤）：企业 runner 上的三个 PR（Pull Request）作业和基于 Wine 的必需 Windows 作业只恢复不保存，把缓存压缩／上传挡在它们的延迟敏感路径之外——这种不对称是 `setup-node` 的缓存无法表达的。每个作业都在 action 可替换的安装目录之外配置 store，并解析该路径。没有任何 master 作业生产这些 hosted 缓存，这些恢复步骤只能命中仍有归档的旧条目，直至其被逐出；企业作业在自托管故障切换期间跳过恢复，因为该 VM 的持久 store 已经预热。
- **无缓存或持久化**（不使用 store 缓存 action）：独立的原生 Windows 作业、原生 serial-windows 和 serial-macos，以及 `sandbox.yml` 均从冷 store 或 runner 本地 store 安装。解压含有大量文件的 pnpm store，成本高于在 Windows 上进行一次全新安装；自托管热备与故障切换作业则复用其 VM 的持久 pnpm store，不传输托管缓存归档。

## 曾考虑的替代方案

- **保留手写步骤。** 它们能用，但那是会各自漂移的设置样板副本，而且对 corepack 的依赖是已知的未来失效点。
- **把企业作业的缓存也转换成 `cache: pnpm`。** 否决：只恢复不上传的不对称是 `ci.yml` 注释中有记录的延迟决策；为统一工具而抹掉它，属于颠倒优先级。
- **转换 serial-linux 的 store 缓存。** 实现期间否决：原提案曾把 serial-linux 计入对称设置，但其缓存步骤是企业作业只恢复不上传配对中的生产者一端——把它改成 `setup-node` 的键格式，等于换条路径做了企业作业的转换。
- **只转换带缓存的工作流，留下其余出现 `corepack enable` 的位置。** 否决：提供 pnpm 与缓存是可分离的关注点，在无缓存作业里留下 corepack 只会保留未来失效点和两套并存的提供方式，毫无收益。
- **依赖 runner 镜像自带的 Yarn。** 否决：Corepack 移除后，托管镜像提供的是 Yarn 1.22，而 generated-project e2e 要求 Yarn 2 或更高版本。锁定版本的根开发依赖让该项覆盖率不再受 runner 镜像内容影响。
- **用一个组合 action 包装 action-setup 加 setup-node。**不予采纳：剩余的按作业差异（Node 版本矩阵、按平台的条件缓存、只恢复不上传配对）是刻意采用的策略而非样板。包装层要么需要增加与这些差异一一对应的输入，要么会抹平真实的不对称，而两行组合已经接近下限。

## 后果

- corepack 依赖已从 CI 中消失，唯独自托管 Windows 安装步骤例外——它们为 ReFS 块克隆原生模块调用 `corepack pnpm`；pnpm 在其他工作流中都经由 pnpm 团队的官方 action 提供，版本锁定继续单一来源于 `package.json` 的 `packageManager` 字段。
- generated-project e2e 运行根目录锁定的 Yarn 4 CLI，既不再沿用 runner 镜像中的 Yarn 版本，也不会因此悄然跳过。
- 已转换泳道的缓存键格式变更了一次；各跑一次冷运行重建缓存后，命中率与旧步骤持平。内建缓存键涵盖平台、架构与锁文件哈希，但不含 Node 版本，因此 node-compat 的各个矩阵任务共享同一条 store 缓存记录——这是安全的，因为 pnpm store 与 Node 版本无关。
- `setup-node` 内建的 pnpm 缓存只按精确键恢复，没有 `restore-keys` 前缀回退：`pnpm-lock.yaml` 一旦变更，已转换泳道会从冷 store 起步，而不是利用上一条缓存记录预填充。
- `pnpm/action-setup` 每次运行都会删除其安装目录，并把默认 store 放在由此产生的 `PNPM_HOME` 下。因此，需要 hosted 缓存恢复或自托管持久化的 Linux 作业会把 `PNPM_CONFIG_STORE_DIR` 设为 `$HOME/.local/share/pnpm/store`，置于 action 目录之外；只恢复不上传的作业会解析这一稳定路径及精确键。
