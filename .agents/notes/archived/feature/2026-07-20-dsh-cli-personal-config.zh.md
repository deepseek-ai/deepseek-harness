# Agent Note: dsh CLI 与来自 Harness home 的个人配置 overlay

Status: implemented
Archived: 2026-09-04

[English](2026-07-20-dsh-cli-personal-config.md) | 中文

## 问题

开发者自己的偏好——TUI 使用哪个提供方和模型、个人凭证、私有的适配器路由——除了改动已提交的文件之外无处安放。要把 TUI 示例指向个人的 Anthropic 代理 Opus 路由，只能在工作区里改 `examples/tui-agent/cordis.yml` 和 `.env`，既有提交密钥的风险，又要在每个 checkout 里重复一遍。也没有可安装的命令：想在任意项目目录里运行这个 agent（智能体），必须回到仓库根目录调用示例脚本。Loader 元数据是静态的——条目 `disabled` 字段除外（见 [loader `disabled` 插值决策](../architecture/2026-08-11-loader-entry-disabled-interpolation.zh.md)）——所以「条件组合使用 overlay」（AGENTS.md）；但 overlay 此前只以已提交的同级文件形式存在，没有机器级的层。

## 决策

下文的各入口模式，以及个人文件的名称与位置，已被 [profile 插件组合包决策](../architecture/2026-08-05-profile-plugin-bundles.zh.md)取代：`dsh` 启动 profile，个人层变成逐 profile 与 home 级的 `cordis.patch.yml`。保留不变的是本笔记的实质：以 Harness home 作为机器级层的根目录、在随附组合之上使用 patch 语义，以及解析失败时明确报错。

两个耦合的部分，与 `dsh web` PR（#443）提出的 `apps/` 装配层对齐：

**`dsh` CLI（命令行界面；`apps/cli`，npm 名 `@deepseek-ai/dsh`）。** `apps/*` 是位于 `packages/*` 库之上的产品组装层。一个 bin 负责分发默认交互式 TUI、`-p`/`--prompt` 无头轮次和 `web` 界面。TUI 以调用目录为 workspace，启动 `examples/tui-agent/cordis.yml`（或 `--config` 指定的配置）。在源码检出中，根目录的 `pnpm dsh` 脚本不执行构建，直接使用 tsx 的 ESM hook 运行同一入口；运行方式由[源码启动决策](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)规定，产物生成由[源码启动与构建分离决策](../simplification/2026-08-12-separate-source-launch-from-build.zh.md)规定。

**个人配置（`dsh-app-boot`）。** 个人 overlay 存放在 Harness home——`$DSH_HOME`，否则 `~/.dsh`——由共享的 [`resolveDshHome`](../architecture/2026-07-24-single-harness-home-resolver.zh.md)（`@deepseek-ai/dsh-home-paths`）解析，与 skill（技能）、AGENTS.md 解析所依据的单一根目录相同。dsh 的 TUI、Web 和无头界面使用其中两个可选文件；各示例 bin 仍然逐字节按已提交的配置树启动：

- `.env`——在调用目录的 `.env` 之后加载；`process.loadEnvFile` 从不覆盖已有值，因此优先级为环境变量 > 项目 `.env` > 个人 `.env`。
- `config.yaml`——顶层 YAML 数组，元素为 `@cordisjs/plugin-include` 的 `PatchOptions`，用 include 自己的 `!!js` 方言解析（`loadPersonalPatches`）并传给 `boot()`，由它作为根 include 的 `patches` 转发。补丁语义与交付的 surface overlay 一致：按 id 定位的补丁替换该配置项的整个 `config`，`insert` 追加配置项，未匹配的 id 静默不执行任何操作。外部包作为 [profile 组合包](../simplification/2026-08-09-remove-repository-plugin.zh.md)安装；这个个人层负责配置这些组合包提供的 Loader 配置项。
- 文件缺失即无 overlay；文件存在但不可读、不可解析或非数组则在启动时抛出（配置错误会明确报错，绝不静默跳过）。

PTY 冒烟测试的启动器把 `$DSH_HOME` 隔离到每个测试自己的目录，与它已有的 `DSH_AGENTS_HOME` 隔离方式完全一致，开发者真实的个人 overlay 不可能泄漏进 fixture（测试前置数据）；只有 dsh CLI 读取个人配置，因此其他测试启动器无需改动。

TUI 和 Web 启动后通过 Cordis HMR（热模块替换）注册确切的个人配置路径。每次新增、变更或移除都会以事务方式通过启动器自己的组合闭包重新组合完整 patch 列表，因此新的个人 patch 落在启动时相同的层次位置。YAML 无效或 Loader 候选被拒时，最后一个可用树保持活动状态，并广播 `hmr/config-update-failed(filename, Error)`；无头界面只在启动时读取该文件。Include 在已提交配置文件刷新时也会重新应用其 patch（见[配置热重载韧性 Agent Note](../bug-fix/2026-07-20-config-hot-reload-resilience.zh.md)）。

## 考虑过的替代方案

**另设一个 `bin/dsh` 包装脚本并由其占用 `dsh` 名称。** 否决，因为 `apps/cli` 是统一的产品 CLI，负责分发默认 TUI、无头和 Web 界面。两个相互竞争的入口会在 `$PATH` 和产品身份上冲突。

**pi 风格的类型化设置文件（`defaultProvider`/`defaultModel`/`providers`）。** 否决，选择补丁语义（产品负责人决策）：个人文件是叠加在随仓库提供的默认配置之上的 cordis overlay，而不是需要另行拥有和翻译的第二套配置词汇。

**个人完整 `cordis.yml` 去 include 请求的配置。** 否决：个人文件将不得不写死叶子配置的路径，而该路径随 checkout 变化；补丁反转了依赖方向，bin 仍然选择配置树，个人层只做修正。

**把个人补丁深合并进配置项配置。** 否决：会使补丁语义与已提交 overlay 和 vendor 的 include 分叉；整个 `config` 替换已是成文约定。

**用环境变量开关代替存在性判断。** 否决：默认关闭的个人配置永远不会被用起来；存在即生效加上每个测试的显式隔离，让实际运行获得 overlay、测试获得封闭性。

## 后果

- 已安装的 `dsh` 命令可从任意目录运行，源码用户则从 checkout 调用 `pnpm dsh`；两者都无需修改 checkout 即可应用个人提供方、模型、已安装组合包的配置项和其他 Loader 配置项。该行为已针对个人 Anthropic 代理与 Opus 4.8 端到端验证，包括一次 bash 工具往返。
- 由于按 id 定位的补丁替换整个 `config`，个人覆盖必须复述它保留的基础字段，并可能随基础配置项形态变化而漂移；诊断手段是 loader 的「配置项未找到/名称不匹配」警告和 [`dsh --dump-config`](../../../../apps/cli/README.zh.md#profiles)（打印这些补丁合成出的配置树）。
- 个人补丁只在被启动文件自身的树里解析 id，因此嵌套 include 的 overlay（PTC mode）不会被个性化；这些叶子的实际运行等价性暂缓。
- `dsh-app-boot` 依赖 `js-yaml`，并直接导入 include 的 `!!js` YAML 方言（`entryListSchema`）；与 `apps/cli` 一样依赖 `@deepseek-ai/dsh-home-paths` 以获取 `resolveDshHome`。
- 只有长时间运行的 TUI 和 Web 进程进行实时监视。无头自动化使用确定性的启动配置，退出时不会保留 watcher。

## 测试

`packages/boot/app-boot/tests/user-patches.spec.ts` 固定解析、启动时应用、确切路径的新增、失败、恢复、移除、最后可用状态回滚、失败广播以及应用自有 patch 的保留。`apps/cli/tests/built-bin.e2e.ts` 启动真实 dsh bin 并基于 profile 端到端验证实时 patch 层。测试启动器会隔离 `$DSH_HOME`，因此开发者的真实 overlay 不会泄漏进 fixture。
