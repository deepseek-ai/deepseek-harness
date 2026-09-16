---
description: "dsh profile 与临时 Python SDK 运行时的共享 Loader 启动支持：环境层、patch、诊断与配置预览。"
kind: "package-library"
---

# @deepseek-ai/dsh-app-boot

[English](README.md) | 中文

## 概述

`dsh-app-boot` 是 `dsh` profile（包括 Python 运行时 wheel 包所含的 CLI（命令行界面））背后的共享 Loader 启动库。它加载环境层、组合 profile 组合包与 patch、启动每个插件，再返回运行中的应用，或指出失败插件与原因。产品应用使用 `dsh` launcher 而不发布单独 bin；直接配置 helper 只保留给低层嵌入方与测试。你还可以在启动前预览生效配置，按 profile 选择实时或仅启动时应用 patch，并让持有终端的应用在致命退出前恢复终端。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用此包启动应用是一个小而显式的入口：你给它一个配置文件，它运行整个启动过程。本节说明你能做什么、能得到什么；每个结果背后的 helper 调用记录在下方可折叠的实现章节中。

### 何时使用

在实现共享 `dsh` launcher 或嵌入其低层启动 helper 时使用它。产品功能应放入 profile 组合包，而不是新增应用 bin；只向已运行应用添加插件的代码直接挂载插件即可。

### 启动应用

你把配置文件交给入口，进程就会启动整个应用：加载环境层、应用 patch 与 profile、启动每个插件，并在应用运行后返回。在回放模式下，它会启动同级的 `cordis.snapshot.yml` 替代文件，使已记录的会话能够原样复现。最小的入口只需两次调用：

```text
installFailLoud('dsh')
const ctx = await boot('dsh', resolveConfigPath(argv[2], process.env.DSH_SNAPSHOT))
```

有了这个入口，启动会保留所有能够激活的插件。启用但失败的插件会产生带标签的警告。required entry 失败时，启动会拆卸整个应用并以非零码退出；profile 中不存在的 required id 和已禁用的 required entry 不影响启动。全局 required list 覆盖共享 Agent 执行、应用 endpoint，以及 Web 启动与传输：`agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp` 和 `sdk-jsonrpc-server`。

<a id="profiles"></a>
### Profile

Profile 与组合包的声明类型从 [`@deepseek-ai/dsh-package-manifest`](../../util/package-manifest/README.zh.md) 导入。App-boot 将 `DshPackageManifest` 适配为包身份可选的 `ProfileManifest`，因为本地 profile 无需发布版本。App-boot 负责 profile 加载、JSON 校验和解析后的运行时数据。

profile 是同一套 dsh 安装提供不同应用界面的方式：`web`、`headless`、`acp`、`sdk` 与 `sdk-minimal` 从同一 launcher 启动不同组合。profile 位于 `$DSH_HOME/profiles/<name>`，由可安装组合包和自身 `cordis.patch.yml` 组成。YAML 组合决定是否启用 HMR。随产品交付的 `web` 模板实时重载，其他随附模板只在启动时应用 patch。`sdk-minimal` 只列出自身的独立组合包，其他模板保留 base 加模式的组合包栈。`dsh --profile <name> --from-default-profile <template>` 从一个随附模板，在新的非内置名称处创建自定义 profile；`dsh plugin` 则初始化以 base 为基础的 profile，并管理其中安装的组合包。缺失组合包或未声明 patch 的组合包会让启动明确失败。由应用持有的 npm 项目（例如 Electron 保留的 Desktop profile）通过 `loadProfileDirectory` 加载已经初始化的目录，而不会将它暴露给 CLI profile 查找。

你的机器本地偏好同样位于 harness home 中：

- **`.env`**——你的普通环境层：调用目录的文件优先于 harness home 的文件，两者都低于继承环境。在文件中设置的进程启动变量（如 `PATH`、`DSH_*`、`XDG_*`）会被拒绝：请改为导出这些变量。四个代理名（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`）只从 harness home 的文件接受，绝不从调用目录的文件接受——后者随 clone 一起到来。对于只想加载某个目录 `.env` 的非产品 bin，文件缺失不影响启动，文件无法加载时输出一行带标签的警告。
- **`cordis.patch.yml`**——你的 tweak 层，应用在所有组合包层之后（先应用逐 profile 的文件，再应用 home 级文件，因此后者优先级更高）：替换某个条目的整个配置（重述你要保留的字段）、插入新条目，或在启动时插值 `!!js` 表达式。patch 指定的条目不存在时输出 stderr 警告；空文件或仅含注释的文件会导致启动失败——如需禁用该层，请改用 `[]`。

启用的 `dsh-hmr` 插件会监视 profile manifest 与两份用户 patch 文件，重新读取按顺序排列的组合包层，并应用[重载失败策略](#startup-and-reload-failures)。[DSH HMR](../hmr/README.zh.md) 将这些重载与[插件管理器](../plugin-manager/README.zh.md)的配置写入串行化；包操作在其队列之外执行。启动器不安装 HMR 或监视器；HMR 被禁用或不存在时，更改需要重启。

插入条目的插件名可以是绝对文件系统路径、文件 URL 或包标识符。patch 加载会把 `insert` 条目及其嵌套分组中的绝对路径以及相对于 patch 文件的 `./` 或 `../` 路径转换为文件 URL；对已有条目名称的断言及替换用的 `config` 值保持原样。

挂载 profile 条目前，`dsh` launcher 会从安装依赖图与有序 bundle 依赖图计算一份不可变的 package resolution generation。默认 link 模式会物化现有的共享 fallback 链接与 profile 自有 fallback 链接，因此受支持的启动行为保持不变。内部调用方和测试工具可以改用 runtime 模式，把 generation 安装到 Node 的 ESM 与 CommonJS resolver；也可以使用 dual 模式，同时物化并校验同一份 generation。

### 预览生效配置

启动前，你可以打印应用将挂载的确切配置：dump 会以 `!!js` 表达式原样展示组合后的条目列表，并按注释分组标明每个源文件及其 patch 层，输出是一份可加载的 YAML 文档。未匹配到任何行的 patch 会连同其层标签一起报告；配置缺失、无法解析或字段无效都会使 dump 失败。

<a id="startup-and-reload-failures"></a>
### 启动与重载失败

profile 重载返回未变化的已有故障诊断，不让无关修改因此失败。新增未激活条目、配置或 fiber 变化、诊断变化都会使重载失败；被移除的 fiber 仍须完成释放。显式启用的目标必须成功激活，即使它的故障早于本次操作。

Loader 结算后，app-boot 将 optional 失败报告为警告；若已启用的 required 条目无法激活，则拒绝启动。表中的“终止启动”指释放已挂载插件并以非零码退出，不报告就绪；“继续”指保留成功运行的插件。后续配置 HMR 不会再次执行 required 启动审计，也不会回滚整个更新。

| 失败模式 | Optional 条目启动时 | Required 条目启动时 | 后续配置 HMR |
|---|---|---|---|
| 根配置或必需 overlay 缺失、不可读、格式错误，或包含无效条目 | 终止启动 | 终止启动 | 拒绝格式错误或无效的实时 patch，不改变运行中的配置；有效修改可以应用 |
| 模块 import 失败或模块求值抛出异常 | 警告；继续 | 终止启动 | 报告错误；保留成功的兄弟插件；修正 import 后可以激活 |
| 插件配置 schema 校验失败 | 警告；继续 | 终止启动 | 新条目保持未激活；现有条目保留原实例与配置；有效修正可以应用 |
| 配置 `!!js` 求值抛出异常 | 警告；继续 | 终止启动 | 报告错误；保留成功的兄弟插件；有效修正后可以激活 |
| `disabled: !!js` 求值抛出异常 | 警告；继续 | 终止启动 | 报告求值错误，不将条目当作已禁用；有效修正后可以激活 |
| 同步 `apply()` throw | 警告；继续 | 终止启动 | 报告错误；保留成功的兄弟插件；修正配置后可以激活 |
| 异步 `apply()` throw | 结算后警告；继续 | 结算后终止启动 | 结算后报告错误；保留成功的兄弟插件；修正配置后可以激活 |
| 注入的服务不可用 | 警告；继续，条目等待依赖 | 终止启动 | 条目继续等待；补上缺失的提供方后可以激活 |
| HTTP 端口绑定失败 | 警告；继续，但该端点不可用 | 终止启动 | 进程继续运行，但失败的端点不可用；修正配置后可以恢复 |
| 脱离 `apply()` 返回 Promise 的异步任务产生未处理 rejection | 致命错误：释放应用并以非零码退出 | 致命错误：释放应用并以非零码退出 | 致命错误：释放应用并以非零码退出，与条目 id 无关 |
| 条目缺失或被显式禁用 | 忽略 | 忽略 | 不激活该条目；不执行 required 启动审计 |

上面的 required 列表包含 `modules` 与 `connection`；只要其中一个已启用条目失败，Web 就无法成功启动。Optional 提供方失败也可能使 required 消费方无法激活。现有条目的新配置在更新前被 schema 校验拒绝，并不等于对兄弟插件的变更做事务回滚。

[Web 进程矩阵](../../../apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts)和[启动验收测试](../../../apps/cli/tests/profiles/web/tests/web-best-effort-startup.expected.e2e.ts)通过随附 Web profile 验证这些结果；[app-boot 测试](tests/app-boot.spec.ts)还覆盖根 Include 失败。

如果你的应用持有终端，它可以在进程退出前把终端交还，你的 shell 绝不会残留在 raw 模式。交还过程有界：卡住的清理只会延迟致命退出，而不会取消它。

### 告诉 agent（智能体）harness 所在位置

当你的应用启动模型驱动的 agent 时，你可以告诉 agent DSH 实现代码 checkout 的位置：它得知该路径，也知道不得据此推断工作目录——它应使用 `pwd`。这条指示在系统提示词靠前位置出现一次。没有系统提示词服务的应用会跳过；开发环境中，重新加载系统提示词后它会消失，直至下次启动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释上述结果如何实现，并指出实现它们的代码位置；这里的内容面向开发者，使用本包并不需要。

### 设计说明

- **Profile 启动数据。** `ctx.profileContext` 只包含 profile 位置、启动时组合包名称、已解析的调用级 overlay 与遥测退出值。`readProfilePatches()` 组合传入的启动 profile，或读取这些位置上的当前文件；调用方负责调度和应用结果。
- **进程内模块解析。** runtime 和 dual 模式会在挂载 profile 条目前，将一份 generation 安装到 Node 的 ESM 与 CommonJS 内部 resolver；link 模式不修改这两个 resolver。exports、conditions、subpath、模块缓存和错误码仍由 Node 负责；路由后的 ESM 失败会报告原始 importer，而不是内部查找锚点。`ctx.pluginPackages` 从同一 generation 提供 package metadata，不记录 Entry import；安装 generation 后，即使查询未命中也以 generation 为准，仅安装服务而未提供 generation 的底层嵌入方仍使用 Node 原生查找。
- **两个 Loader builtin。** `mountRootInclude` 把 `cordis:include` 与 `cordis:group` 注册为 Loader builtin：group 行能把一个提供方与它的消费方放进同一个 `isolate` realm，而位于本工作区之外的 agent preset 无法按名称解析 `@deepseek-ai/cordis-plugin-group`。两者都通过宿主的模块管线加载，而非被包含树自身的说明符解析。
- **由 consumer 持有严格语义。** 普通 Loader group 保留成功 sibling。App-boot 在首次结算后应用全局 required-entry policy；agent preset 与动态多 entry 组合在需要 all-or-nothing setup 时，持有并拆卸各自的独立 generation。App-boot 读取 failed fiber 来报告已记录的错误，并在一个进程检查点内合并 Loader 重复的 rejection 通知。
- **唯一 fallback generation。** 安装优先、有序 bundle 逐根 breadth-first 遍历同时生成运行时表和保留的磁盘 materializer。runtime 模式不创建解析链接，并在旧链接原来的查找位置忽略陈旧投影。package `imports` 选中的外部 bare target 使用相同的选包顺序，映射、conditions 和精确 target 解析仍由 Node 负责。link 模式物化同一张表；dual 模式还会比较 Node 的磁盘结果与表。完整后继 generation 可以原子增加 package name，修改或删除既有映射则要求重启。
- **应用自有 profile。** link 模式在 profile 内投影缺失的安装包及 bundle 包，不写共享的 Harness-home 后备目录。runtime 模式提供相同的安装包及 bundle generation，不创建链接。包操作仅移除 dsh 所有的 profile 链接；pnpm 管理的条目保持不变。
- **自有 Worker。** Worker 构建 banner 会在业务 bundle 前导入 `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap`。每个 Worker 在自己的 isolate 中安装结构化克隆的 generation。bootstrap bundle 不静态导入任何包。源码 Worker 入口保留自包含依赖，第三方 Worker 不接受注入。
- **更新完成。** App boot 通过 `internal/update` waterfall 观察重启失败。实时 patch 重载在检查激活状态前等待配置树中的 fiber；单独调用 `Fiber.update()` 或 `Entry.update()` 不能确定重启成功。
- **单一 rejection 检查点。** `assertEntriesActivated` 把折入启动诊断的确切原因保持到下一个进程级 rejection 检查点可见，使 `installFailLoud` 能合并 Loader 的重复通知，而所有无关的未处理 rejection 仍然致命。
- **两阶段失败标签。** `boot()` 区分 `host preparation failed`（`prepare` 在任何配置树条目挂载前抛出）与 `plugin tree failed to load`，并追加最深层插件错误的堆栈。插件诊断保留嵌套原因和聚合错误中的各项失败；原因链出现循环时会停止遍历，但不会替换原始错误。

### Helper 行为

每个导出各负责启动的一个阶段：配置解析与快照回放、分层环境加载、明确报错的保护机制、激活审计、patch 解析、根 include 挂载、配置 dump 渲染、profile 组合，以及 harness 源码段落。各导出的约定在代码中，不在本 README——见 [`src/index.ts`](src/index.ts) 与 [`src/profile.ts`](src/profile.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 启动 helper：配置解析、环境加载、会明确报错的保护机制、激活审计、patch 解析、配置 dump、harness 源码段落 |
| [`src/profile.ts`](src/profile.ts) | profile 发现、初始化、组合包解析、模块后备机制 |
| [`src/profile-plugins.ts`](src/profile-plugins.ts) | 已安装依赖、bundle 启用策略与 manifest 更新 |
| [`src/profile-resolution/`](src/profile-resolution/) | 运行时 resolver、package metadata 服务与构建后 Worker bootstrap |
| — | 不发布运行时不变式伴生入口；每个 resolver generation 只有一个 registration 所有，dual 模式在解析时比较独立物化的结果。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享启动机制逐步进入组合模型及其背后的决策证据。

- [Cordis 入门](../../../docs/cordis-primer.zh.md)——Loader、`!!js` 配置表达式，以及 include/group 语义。
- [dsh 应用](../../../apps/cli/README.zh.md)——消费这些 helper 的 `dsh` bin。
- [dsh-cmdline](../cmdline/README.zh.md)——各 bin 使用的启动器到应用命令行交接。
- [Profile 组合包](../../bundle/README.zh.md)——组合进 `dsh --profile` 的可安装 patch 层。
- [dsh-home-paths](../../util/home-paths/README.zh.md)——harness home 解析器（`resolveDshHome`）。
- [配置来源归属](../../../.agents/notes/implemented/architecture/2026-08-04-configuration-source-ownership.zh.md)——被发现的文件为何不得决定 bootstrap 行为。
- [Profile 插件组合包](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与组合包组合设计。
- [用户 patch HMR 测试](../../../.agents/notes/implemented/testing/2026-09-09-user-patch-hmr-test-delivery.zh.md)——实时 patch 行为与原生文件系统投递的验证归属。

-----

<a id="model-experience"></a>
## 模型体验

模型通过此包加载的插件树间接受影响——只有该树贡献模型上下文；唯一贡献模型可见文本的导出 `addHarnessSourceSection`，也只有在消费方启动后调用它时才会产生影响。

#### KV Cache 影响

启动本身不改变请求前缀。`addHarnessSourceSection` 将源码路径放在第一方可复用指令之后，因此工具与配置一致时，不同 checkout 不会改变前置字节。不保证提供方复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明此启动库在何时不合适，或何时需要特别注意。它们是当前包约束，不是任务积压。

- **运行时解析依赖 Node 内部机制**——受支持的 Node 版本需要 native builtin access addon 和可执行兼容验证。只有构建后的 Harness 自有 Worker 接收 generation bootstrap；第三方 Worker 与自定义 `vm` linker 保持原生解析。
- **快照回放替换仅识别特定 basename**——只有以 `cordis.yml` 或 `cordis.yaml` 结尾的配置会映射到同级 `cordis.snapshot.yml`；自定义配置名称需要调用方自行选择。
- **环境发现以启动为界**——`loadLayeredEnv` 只读取一次调用目录与 harness home 中的 `.env`；它不搜索父目录，也不跟随之后选择的 workspace。`loadEnv` 仍是非产品 bin 使用的单目录 helper。
- **用户 patch 会替换匹配到的整个配置**——按 id 定位的 patch 不做深度合并，因此 profile 覆盖必须重述需要保留的组合包字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 待定：配置 dump 稳定性

`renderConfigDump` 的输出是一份可加载的 YAML 文档，其 `# ==` 来源注释与 `!!js` 原样渲染服务于 `--dump-config` 诊断。任何内容都不承诺跨包版本的字节稳定性；在程序化消费该输出之前，请决定 dump 是否成为序列化约定。

</details>
