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

`installFailLoud` 会为未处理 rejection 或未捕获异常向 stderr 写一条带标签的 `util.inspect` 诊断，在固定超时内等待界面的 release 钩子，然后以 1 退出；控制流不会回到失败的操作，因为只有抛出点知道哪些状态仍然完整，事件循环只运行到 release 结束或超时。有了这个入口，启动会保留所有能够激活的插件。启用但失败的插件会产生带标签的警告。required entry 失败时，启动会拆卸整个应用并以非零码退出；profile 中不存在的 required id 和已禁用的 required entry 不影响启动。全局 required list 覆盖共享 Agent 执行、应用 endpoint，以及 Web 启动与传输：`agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp` 和 `sdk-jsonrpc-server`。

<a id="profiles"></a>
### Profile

Profile 与组合包的声明类型从 [`@deepseek-ai/dsh-package-manifest`](../../util/package-manifest/README.zh.md) 导入。App-boot 将 `DshPackageManifest` 适配为包身份可选的 `ProfileManifest`，因为本地 profile 无需发布版本。App-boot 负责 profile 加载、JSON 校验和解析后的运行时数据。

profile 是同一套 dsh 安装提供不同应用界面的方式：`web`、`headless`、`acp`、`sdk` 与 `sdk-minimal` 从同一 launcher 启动不同组合。profile 位于 `$DSH_HOME/profiles/<name>`，由可安装组合包和自身 `cordis.patch.yml` 组成。组合包的 `dsh.bundle.patch` 指定一个 patch 文件或一个有序的文件列表；`bundlePatchFiles` 校验该声明，`bundlePatchPaths` 把它解析为绝对路径；该层按此顺序拼接各文件的 patch 列表。YAML 组合决定是否启用 HMR。随产品交付的 `web` 模板实时重载，其他随附模板只在启动时应用 patch。`sdk-minimal` 只列出自身的独立组合包，其他模板保留 base 加模式的组合包栈。`dsh --profile <name> --from-default-profile <template>` 从一个随附模板，在新的非内置名称处创建自定义 profile；`dsh plugin` 则初始化以 base 为基础的 profile，并管理其中安装的组合包。组合包解析、manifest 读取或 patch 加载失败时会跳过该组合包，不改变其选择状态；加载结果在 `skippedBundles` 中列出每个被跳过的组合包，启动器每次启动时通过 `reportSkippedBundles` 输出一次。其余组合包保持原顺序；profile 和用户 patch 错误仍会导致启动失败。跳过组合包不保证剩余组合能够提供所需服务。由应用持有的 npm 项目（例如 Electron 保留的 Desktop profile）通过 `loadProfileDirectory` 加载已经初始化的目录，而不会将它暴露给 CLI profile 查找。

profile 导入插件前，DSH 会检查其 `peerDependencies` 中对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的依赖，与 `getDshRuntimeVersion()` 返回的唯一运行时版本比较。每个声明的版本范围都必须匹配；预发布版本参与范围匹配。源码工作区的 `workspace:^`、`workspace:~` 和 `workspace:*` 指向同一个运行时。未声明 DSH peer 时不施加版本约束；无效范围视为不兼容。这些检查使用 peer 声明，而不是 `engines.dsh`，也不是防范恶意包代码的沙箱。

检查只发生在 DSH 自己持有的组合入口，改写的是启动器自己的那份组合：profile 的 patch 层、依赖清单与组合包列表都不会改变。`prepareProfilePatches` 在启动器的空 profile 根之上组合，并在挂载根 Include 时以及每次 profile 重新组合时执行，因此被拒绝的插件永远不会导入其模块；`prepareProfileEntries` 对 preset 行做同样的事。被拒绝的普通行会变成游离的 `disabled: true` 行；原生 group 保持挂载，其被拒绝的子行不会加载；若某个原生 Include 会到达被拒绝的插件，则整体省略该 Include，因为它的文件不会被改写。被策略拒绝的行在 profile 中保留其配置的 `disabled` 值，每次拒绝都会报告包名、版本与风险。组合包本身不是行，因此 `loadProfileDirectory` 在启动和每次重新组合加载 profile 的组合包层时，检查每个组合包自己声明的 DSH peer；没有豁免的不兼容组合包会像无法读取的组合包一样被跳过，并列入 `skippedBundles`。这些入口不覆盖其他嵌入方通过自己的 `ctx.plugin` 调用挂载的插件。会话中直接改文件的两类编辑只在下一次重新组合或启动时才被判定：正在运行的插件自己的 `package.json` peer 声明，以及 Loader 自己读取的入口清单文件（如启动器的根配置或嵌套的 `cordis:include` 文件）。`--dump-config` 报告的是配置出的组合，因此被拒绝的插件行仍会出现在其中，而被拒绝的组合包不提供任何行；`--dump-config-schema` 会导入每个组合模块以读取其 schema，请只对已经信任其插件的 profile 运行。

精确版本豁免保存在 profile 自己的 `compatibility.json` 中，而不是 `package.json`，因此写豁免不会触及依赖清单、组合包列表或 Cordis patch 文件。它把精确的 `package-name@version` 键映射到精确 DSH 运行时版本列表；插件升级和 DSH 升级都不继承授权。文件缺失表示没有豁免。文件损坏绝不会阻止 profile 启动：读取器接受的记录仍然生效，每条被拒绝的记录会与插件拒绝信息一起输出到 stderr，此后该文件被视为只读，因此授予或撤销会拒绝执行并要求用户手工修复，而不是覆盖用户的内容。[插件管理器](../plugin-manager/README.zh.md#version-compatibility-and-exemptions)负责每次变更所需的授权、撤销与风险确认。

你的机器本地偏好同样位于 harness home 中：

- **`.env`**——你的普通环境层：调用目录的文件优先于 harness home 的文件，两者都低于继承环境。在文件中设置的进程启动变量（如 `PATH`、`DSH_*`、`XDG_*`）会被拒绝：请改为导出这些变量。四个代理名（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`）只从 harness home 的文件接受，绝不从调用目录的文件接受——后者随 clone 一起到来。对于只想加载某个目录 `.env` 的非产品 bin，文件缺失不影响启动，文件无法加载时输出一行带标签的警告。
- **`cordis.patch.yml`**——你的 tweak 层，应用在所有组合包层之后（先应用逐 profile 的文件，再应用 home 级文件，因此后者优先级更高）：替换某个条目的整个配置（重述你要保留的字段）、插入新条目，或在启动时插值 `!!js` 表达式。patch 指定的条目不存在时输出 stderr 警告；空文件或仅含注释的文件会导致启动失败——如需禁用该层，请改用 `[]`。

启用的 `dsh-hmr` 插件会监视 profile manifest 与两份用户 patch 文件，重新读取按顺序排列的组合包层，并应用[重载失败策略](#startup-and-reload-failures)。[DSH HMR](../hmr/README.zh.md) 将这些重载与[插件管理器](../plugin-manager/README.zh.md)的配置写入串行化；包操作在其队列之外执行。启动器不安装 HMR 或监视器；HMR 被禁用或不存在时，更改需要重启。

插入条目的插件名可以是绝对文件系统路径、文件 URL 或包标识符。patch 加载会把 `insert` 条目及其嵌套分组中的绝对路径以及相对于 patch 文件的 `./` 或 `../` 路径转换为文件 URL；对已有条目名称的断言及替换用的 `config` 值保持原样。

挂载 profile 条目前，`dsh` launcher 会从安装依赖图与有序 bundle 依赖图计算一份不可变的 runtime resolution。普通 Node、打包可执行文件与 Electron Host 等所有 profile 启动器都使用 runtime 解析，将 runtime resolution 安装到 Node 的 ESM 与 CommonJS 解析器中，不创建 fallback 链接。

`sanitizeProfile(binName, profileDir, bundles)` 提供文件恢复，无需加载插件或解析 patch。Desktop 在原生致命错误恢复中调用它。调用前必须停止 profile 并排除并发 profile 写入。它将 profile 的 `cordis.patch.yml` 重命名为带唯一 `.bak-<timestamp>` 后缀的同目录备份，并恢复调用方指定的 bundle 列表，保留已安装包和其他 manifest 字段。时间戳为 Unix 毫秒数；同名备份已存在时追加序号（`-1`、`-2`、……），时间戳保持不变。返回值为备份路径；patch 不存在时返回 `undefined`，缺失的 profile 不会被创建。下次启动的 profile 初始化会重新创建空 patch。home 级 patch 不变。无效 profile JSON 在修改前报错；后续错误向调用方抛出，保留已完成的修改供重试。

### 预览生效配置

启动前，你可以打印应用将挂载的确切配置：dump 会以 `!!js` 表达式原样展示组合后的条目列表，并按注释分组标明每个源文件及其 patch 层，输出是一份可加载的 YAML 文档。未匹配到任何行的 patch 会连同其层标签一起报告；配置缺失、无法解析或字段无效都会使 dump 失败。

### 检查插件配置 schema

`generateConfigSchema` 接收用于诊断的 bin 名称、已准备好的磁盘 profile、有序 patch 列表和安装锚点，返回 `ConfigSchemaDump`。App-boot 负责组合、运行时解析和收集诊断。调用方负责 profile 准备、home/argv 层选择、进程流及退出策略。`createConfigProjector`、`isNativeConfigSchema` 与 `LOADER_EXPRESSION_SCHEMA` 供不经 profile 收集、只投影单个运行中插件 Config 的调用方使用；投影后的取值位置会引用 `#/$defs/loaderExpression`，外层文档必须定义它。

生成的 JSON Schema 2020-12 描述组合后的 entry list，以 `$defs.patchList` 描述根树 overlay，并从插件 Config 图投影共享定义。它包含禁用项、原生 group 和字面量 YAML/JSON include；内置与规范原生包导出按每棵树的模块解析基准匹配，包括 profile 本地副本。不会根据 config 字段猜测自定义承载插件。include 缺失但有字面量 `initial` 条目时，只在内存中展开，不写文件。发现和投影诊断保留在 `x-cordis` 中，包括未知 Config 和部分约束。[CLI schema dump 参考](../../../apps/cli/reference/README.zh.md#config-schema-dump)负责说明输出字段和编辑语义。

投影器使用 Ajv 根据生成的 schema 检查字面量默认值，以保留原生省略行为，不执行原生验证器或 transform 回调。正则兼容性检查、不支持的情况及递归默认值分析会产生显式限制说明。不透明的输入转换和 lazy 元数据副作用会放宽验证，而不是重放原生修改。非 JSON 默认值或展示注释会被省略并附上限制说明，不丢弃结构 schema；无法表示的默认值使省略接受性保持未知，必填字段除外。这些依赖仅在收集运行时加载。导入、Config getter 和 lazy builder 仍会执行可信代码；收集不是沙箱。profile 解析拦截不得重叠。收集器返回前释放自己的拦截，而 Node 仍缓存导入的模块；运行时创建的插件和 Agent preset 实例不在发现范围内。

### 读取插件展示元信息

使用 `readPluginMeta(specifier, parentURL)` 或 `ctx.pluginPackages.metaOf(specifier, parentURL)` 读取已安装包的展示文本，无需导入或激活插件。查询使用完整包标识与调用方的解析基准，并遵循 Node exports。文件路径与文件 URL 不解析资源，直接返回无元信息。缺失的 locale 字段回退到该地址下可访问的 `package.json`；格式错误的元信息返回 `error` 诊断。结果保留翻译，由 Client 选择语言。即使 locale 文本完整，读取器也会将 `package.json.icon` 加载为图片 data URL；图标出错时，保留有效文本并附上诊断。作者格式见[插件展示元信息](../../../docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)。

<a id="startup-and-reload-failures"></a>
### 启动与重载失败

profile 重载返回未变化的已有故障诊断，不让无关修改因此失败。新增未激活条目、配置或 fiber 变化、诊断变化都会使重载失败；被移除的 fiber 仍须完成释放。显式启用的目标必须成功激活，即使它的故障早于本次操作。成功重载在生命周期结束及诊断检查通过后发出 `app-boot/config-reload`，包括未启用 HMR 时的程序化更新。事件不携带 diff 或解析后的配置。 成功重载在生命周期结束及诊断检查通过后返回；仅 volatile 的条目变化由 Loader 在更新过程中提交。

Loader 结算后，app-boot 在仅 optional 条目未激活时输出警告。如果已启用的 required 条目无法激活，`boot()` 会在释放资源后以 `StartupError` 拒绝。独立管理生命周期的 logger exporter 会保留异步资源释放期间的警告和错误记录，并在 `boot()` 结算前释放。其消息分组列出所有失败插件和等待的服务，标记 required 条目，并保留原始堆栈、嵌套原因和聚合错误成员。CLI 仅输出该消息一次，并在保存[完整启动诊断](../../../apps/cli/reference/README.zh.md#startup-diagnostics)后以退出码 1 结束；其他异常保留正常堆栈输出。表中的“终止启动”指释放已挂载插件并以非零码退出，不报告就绪；“继续”指保留成功运行的插件。后续配置 HMR 不会再次执行 required 启动审计，也不会回滚整个更新。

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
| 同步回调（流的 `'data'` 监听器、定时器）在进程生命周期任一时刻抛出未捕获异常 | 致命错误：释放应用并以非零码退出；失败的操作不会被恢复 | 致命错误：释放应用并以非零码退出；失败的操作不会被恢复 | 致命错误：释放应用并以非零码退出，与条目 id 无关 |
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

- **运行时版本。** `getDshRuntimeVersion()` 通过文件系统路径读取本包清单，也支持可执行文件内的虚拟文件系统；版本缺失或无效时会失败，而不会绕过兼容性检查。
- **Profile 启动数据。** `ctx.profileContext` 只包含 profile 位置、启动时组合包名称、已解析的调用级 overlay 与遥测退出值。`readProfilePatches()` 组合传入的启动 profile，或读取这些位置上的当前文件；调用方负责调度和应用结果。
- **进程内模块解析。** launcher 在挂载 profile 条目前，将 runtime resolution 安装到 Node 的 ESM 与 CommonJS 内部 resolver。exports、conditions、子路径、模块缓存和错误码仍由 Node 负责；路由后的 ESM 失败报告原始 importer。显式 CommonJS `paths` 始终保留原生查询，包括指向 profile 内的路径。
- **链接目录。** profile 链接到树外目录时，其下的 importer 参与逐层 peer 查询，即使目标没有自身的 `package.json`。在每个 `D/node_modules` 位置，当前 `D/package.json` 的 peer 包名若存在于运行时表，就使用运行时包；其他包名查询物理候选。更近的物理包先于后续 peer 声明，peer 位置无需物理 `node_modules`。installation 作用域包目录不参与 linked 拦截，重叠 root 不改变 importer 的查询顺序（[规则](../../../.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.zh.md)）。
- **包元数据。** `ctx.pluginPackages.packageOf` 定位所属包，不加载代码，也不要求导出 `package.json`；子路径选择其所属包，不校验该文件。安装 runtime resolution 后，即使查询未命中也以其选包规则为准。仅安装服务而不提供 runtime resolution 的底层嵌入方保留原生查询。展示元数据使用上文另述的入口感知读取器。
- **两个 Loader builtin。** `mountRootInclude` 把 `cordis:include` 与 `cordis:group` 注册为 Loader builtin：group 行能把一个提供方与它的消费方放进同一个 `isolate` realm，而位于本工作区之外的 agent preset 无法按名称解析 `@deepseek-ai/cordis-plugin-group`。两者都通过宿主的模块管线加载，而非被包含树自身的说明符解析。
- **由 consumer 持有严格语义。** 普通 Loader group 保留成功 sibling。App-boot 在首次结算后应用全局 required-entry policy；agent preset 与动态多 entry 组合在需要 all-or-nothing setup 时，持有并拆卸各自的独立 Loader 子树。App-boot 读取 failed fiber 来报告已记录的错误，并在一个进程检查点内合并 Loader 重复的 rejection 通知。
- **唯一 runtime resolution。** 安装优先、有序 bundle 逐根 breadth-first 遍历生成运行时表。runtime 解析不创建链接；runtime resolution 条目占据 `$DSH_HOME/profiles/node_modules` 上各自的包名位置，其余包名把该目录当作普通祖先。profile 加载时删除 Link 后端发布版写进 profile 的 `.dsh-module-fallback` 投影；pnpm 安装的包保留。package `imports` 选中的外部 bare target 使用相同的选包顺序，映射、conditions 和精确 target 解析仍由 Node 负责。完整后继 runtime resolution 可以在既有包映射和本地包名约束内原子增加 package name、更新 linked root 集合。
- **移除链接拦截。** 后继 generation 可以移除 linked root，无需重启。目录不再被任何剩余 root 覆盖时，后续请求使用原生查询，可能找到开发副本，也可能报告缺包。已有模块引用和 Node 缓存保持不变。同名、同目标可以重新加入；曾发布的名称改指向不同目标时，即使中间移除过也会被拒绝（[generation 规则](../../../.agents/notes/implemented/architecture/2026-09-09-profile-resolution-generations.zh.md#immutable-generations)）。
- **应用自有 profile。** 应用自有 profile 使用相同的 runtime resolution。目标位于当前 profile 目录内的链接（包括 pnpm store 链接）不算外部 root，即使 profile 位于共享 profiles 树外。解析过程不修改其 `node_modules`；已安装包由 pnpm 管理。
- **自有 Worker。** Worker 构建 banner 会在业务 bundle 前导入 `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap`。每个 Worker 在自己的 isolate 中安装结构化克隆的 runtime resolution。bootstrap bundle 不静态导入任何包。源码 Worker 入口保留自包含依赖，第三方 Worker 不接受注入。
- **更新完成。** App boot 通过 `internal/update` waterfall 观察重启失败。实时 patch 重载在检查激活状态前等待配置树中的 fiber；单独调用 `Fiber.update()` 或 `Entry.update()` 不能确定重启成功。
- **单一 rejection 检查点。** `inactiveEntries` 把折入启动诊断的确切原因保持到下一个进程级 rejection 检查点可见，使 `installFailLoud` 能合并 Loader 的重复通知，而所有无关的未处理 rejection 仍然致命。
- **两阶段失败标签。** 除启动审计失败外，`boot()` 区分 `host preparation failed`（`prepare` 在任何配置树条目挂载前抛出）与 `plugin tree failed to load`，并追加最深层插件错误的堆栈。插件诊断保留嵌套原因和聚合错误中的各项失败；原因链出现循环时会停止遍历，但不会替换原始错误。

启动错误还保留未激活条目的元数据和原始启动警告、错误记录，不保留 Loader tree。其 `entries` 和 `startup` 字段不可枚举：直接访问和完整诊断报告保留这些字段，常规错误检查输出则省略它们。只有等待条目时没有 `cause`；存在已记录错误时，`AggregateError` 保留其原始值。收集器在 Loader 挂载前通过 logger 收集导入错误，因为这些导入尚无 failed Fiber。启动结算后会移除临时 exporter。

### Helper 行为

每个导出各负责启动的一个阶段：配置解析与快照回放、分层环境加载、明确报错的保护机制、激活审计、patch 解析、根 include 挂载、配置 dump 渲染、profile 组合，以及 harness 源码段落。各导出的约定在代码中，不在本 README——见 [`src/index.ts`](src/index.ts) 与 [`src/profile.ts`](src/profile.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 启动 helper：配置解析、环境加载、会明确报错的保护机制、激活审计、patch 解析、配置 dump、harness 源码段落 |
| [`src/profile.ts`](src/profile.ts) | profile 发现、初始化、组合包解析、runtime resolution 构造 |
| [`src/profile-plugins.ts`](src/profile-plugins.ts) | 已安装依赖、bundle 启用策略与 manifest 更新 |
| [`src/profile-sanitize.ts`](src/profile-sanitize.ts) | profile patch 备份与恢复 bundle 启用状态 |
| [`src/config-schema/`](src/config-schema/) | Profile schema 生成、发现、原生投影与结果类型 |
| [`src/profile-resolution/`](src/profile-resolution/) | 运行时 resolver、package metadata 服务与构建后 Worker bootstrap |
| — | 不发布运行时不变式伴生入口；每个 runtime resolution 只有一个拦截所有。 |

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

- **运行时解析依赖 Node 内部机制**——受支持的 Node 版本需要 native builtin access addon 和可执行兼容验证。只有构建后的 Harness 自有 Worker 接收 runtime resolution bootstrap；第三方 Worker 与自定义 `vm` linker 保持原生解析。
- **重新链接 profile 包需要重启**——Node 缓存真实路径，因此改变 profile 链接或依赖链接的目标需要重启进程。
- **链接作用域以记录的真实目录为准**——提升后的依赖若在所有 linked root 之外，就使用原生 Node。每次读取 peer 都不会使 Node 缓存失效，也不会改变被监视的文件。
- **源码启动只安装 ESM 钩子**——CommonJS 请求仍需要 package exports 选中的 JavaScript 文件，解析器不会补出缺失的构建产物。
- **快照回放替换仅识别特定 basename**——只有以 `cordis.yml` 或 `cordis.yaml` 结尾的配置会映射到同级 `cordis.snapshot.yml`；自定义配置名称需要调用方自行选择。
- **环境发现以启动为界**——`loadLayeredEnv` 只读取一次调用目录与 harness home 中的 `.env`；它不搜索父目录，也不跟随之后选择的 workspace。`loadEnv` 仍是非产品 bin 使用的单目录 helper。
- **用户 patch 会替换匹配到的整个配置**——按 id 定位的 patch 不做深度合并，因此 profile 覆盖必须重述需要保留的组合包字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 待定：YAML 配置 dump 稳定性

`renderConfigDump` 的输出是一份可加载的 YAML 文档，其 `# ==` 来源注释与 `!!js` 原样渲染服务于 `--dump-config` 诊断。任何内容都不承诺跨包版本的字节稳定性；在程序化消费该输出之前，请决定 dump 是否成为序列化约定。JSON Schema 输出遵循单独的 [pre-stable 兼容性规则](../../../apps/cli/reference/README.zh.md#config-schema-dump)。

</details>
