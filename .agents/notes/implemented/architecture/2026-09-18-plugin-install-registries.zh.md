# Agent Note: 插件安装的注册表

Status: implemented

[English](2026-09-18-plugin-install-registries.md) | 中文

## Problem

安装对话框把 spec 交给 `pnpm add` 时不指定注册表，pnpm 就从它自身配置指定的地方解析包；对于从未写过 `.npmrc` 的人，那就是 `registry.npmjs.org`。在连不上它的网络里，每次安装都在 pnpm 自身重试之后以网络错误告终——对不应答的注册表，这要一分多钟；安装前的检查也以同样方式失败，而没有任何地方提供镜像。镜像是中国大陆的常规答案，但 pnpm 的 `--registry` 是对话框传不了的命令行参数，而 `.npmrc` 不是对话框的受众会去编辑的东西。

## Decision

**管理器询问的是一个注册表计划，不是一个注册表。** `PluginManager.Config` 新增 `registry`——首先询问的注册表（缺省为 `null`，即 pnpm 自身配置指定的那个）和 `fallbackRegistries`——随后依次询问的注册表，默认为 npmmirror。`registryPlan` 解出一次操作的计划：请求的注册表，否则配置的第一个，然后是配置集合中的其余。请求的注册表不在这个集合里时只问它自己：私有源永远不会落到公共源，否则两边都有的名字会装上别人的包。注册表按 pnpm 的形式比较：小写主机名加尾部斜杠。

**pnpm 自身的注册表只有读出来是公共的才算公共。** `null` 指向本机 `.npmrc` 链说的任何地方，可能是公司注册表。每次做计划前管理器在 profile 目录里用 `pnpm config get registry` 读出它，只有它是 npm 官方源或某个配置的备选源时 `null` 才进入配置集合；否则不论以 `null` 还是以它的 URL 请求都只问它自己，改问公共源时也绝不回落到它。pnpm 已经指向的注册表只问一次而不是两次。读取失败时保守处理：读不出来就让 `null` 只问自己。`registries()` 把读出的结果作为 `resolved` 返回，所以 pnpm 指向的不是 npm 官方源时，对话框按其主机名标注该选项。

**只有换一个注册表能改变的失败才让操作继续。** `attributeFailure` 把 `network`、`timeout` 归于注册表，把 `not-found`、`no-matching-version` 也归于注册表，因为镜像落后于它复制的注册表，几分钟前刚发布的包还没到那里；其他种类立即停止。git spec 和 tarball URL 携带 pnpm 拉取它们的 `host`，没有注册表能替代它：错误行点名那台主机的失败归于 spec 自身主机并停止，而点名注册表（spec 的依赖来自那里）的失败则继续；仅仅链接到该主机的警告行不算。归因以 `ChangeResult.failedAt` 交给调用方，所以对话框按 Host 的判断而不是自己的猜测来措辞并决定是否提供换源。分类器新增 npm 的 `FETCH_ERROR` 作为网络失败；pnpm 的 `ERR_PNPM_NO_OFFLINE_META` 是离线缓存缺失，换注册表改变不了，保持未分类。

**检查决定哪个注册表活着；安装从那里开始。** `inspect` 以 `--registry` 和 `--config.fetch-retries=0` 运行 `pnpm view`，所以不应答的注册表会在 `inspectTimeoutMs` 内报告——pnpm 自身的节奏是重试之间先等十秒再等一分钟——然后询问下一个；在这个上限被杀掉的查询与连接被拒一样作为 `network` 问题拒绝。pnpm 把 `--json` 的拒绝以 `{ error: { code, message } }` 打印在 stdout 而 stderr 为空，所以分类器两者都读。通过的答复带上作答的 `registry`；客户端把它传给 `installBundle`，安装从那里开始，而不是从检查已经发现死掉的注册表开始。安装保留 pnpm 的重试设置：它要下载 tarball，更短的超时会在慢但可用的网络上掐断下载，且它只在运行中途失败时才转问下一个注册表。为此不写 `pnpm-workspace.yaml`：那里的 `fetchRetries` 与 `fetchTimeout` 会同时约束安装的下载和检查，而命令行传入的 `--config.fetch-timeout` 会让 pnpm 11.8 崩溃，因为它被当作字符串读取。

**每次尝试都可见。** `installBundle` 每问一个注册表通告一次 `installing`，带上这次的注册表、序号和计划长度，两次尝试之间恢复 profile 文件，并在用户已经取消时不再以失效的信号启动下一次运行，每次运行以自己的 job id 流式输出且命令行带 `--registry`，并在最后一次运行的结果旁报告问过的 `registries`。被拒绝的检查同样列出它问过的 `registries`。对话框提供配置集合、pnpm 自身的注册表（标题带上它指向的主机名）和手动输入的地址，在浏览器 `localStorage` 记住选择之前从 Host 首先询问的注册表开始，在 Host 转问时说明现在问的是哪个注册表，给每次运行标上注册表，所有注册表都连不上时逐一列出，而 Host 把失败归于 spec 自身主机时则点名那台主机。它不描述计划：询问顺序是 Host 的，发生时才显示。手动输入的地址用 Host 校验所用的同一个 `REGISTRY_URL` 检查，该常量经包的 `./registry` 入口发布给浏览器。

## Alternatives considered

**把所选注册表写进 profile 的 `.npmrc` 或 `pnpm-workspace.yaml`。** 否决：这个选择属于一次安装，不属于 profile 里之后的每条 pnpm 命令，而 pnpm 每次运行都读的文件得在每次尝试前后改写再恢复。

**把上次选择存进 Host 设置。** 暂时否决：一个设置命名空间、它的控制器写入路径和目录条目换来的是跨浏览器并与 CLI 共享的选择，而 `dsh plugin add --registry` 已经在命令行接受它；对话框的选择显式传给每次调用，Host 不为它保存状态，由浏览器记住。

**任何失败都换遍所有注册表。** 否决：被拦下的构建脚本、写满的磁盘、不声明组合包的包在哪里都同样失败，连不上的 git 主机经由任何注册表也连不上；重试这些只让人白等，还掩盖原因。

**私有源之后落到公共源。** 否决：依赖混淆。私有源提供而公共源也有的名字，会在私有源宕机时装上公共源的包。这对本机 `.npmrc` 指定的私有源和对话框里手填的私有源同样成立，所以 pnpm 自身的注册表要先读出来才可能进入计划。

**不读取就把 pnpm 自身的注册表当作公共源。** 否决：那样出厂配置会把每个 `.npmrc` 配置了公司注册表的用户的失败转到 npmmirror。读取的代价是每次计划一个 `pnpm config get registry` 进程，约 170 ms。

**让对话框描述计划。** 否决：成员规则的副本立刻就漂移了——手填没有尾斜杠的镜像 URL 在对话框里读作单独的注册表，而 Host 归一化后把它并入集合——而且选项下方一句关于备选的说明对正在选源的人只是噪音。对话框只在 Host 询问时按实际顺序显示。

**像检查一样限制安装的请求。** 否决：检查只发一个小请求，它的存活答复正是计划所需；安装在慢但可用的连接上下载 tarball 需要 pnpm 的默认值，而安装从检查发现活着的注册表开始。

## Consequences

`Config` 新增 `registry` 与 `fallbackRegistries`；`inspect` 在 signal 之前接受 `InspectOptions`，并答复作答的注册表、spec 自身的主机和拒绝时问过的注册表；`InstallBundleOptions`、`ChangeResult`（含 `registries` 与 `failedAt`）、`PluginInstallProgress` 和 `plugin_manager` 工具携带注册表；`registries()` 加入 Remote 并答复 `resolved`。`viewProfilePackage` 接受 `registry` 且从不让 pnpm 重试；`readProfileRegistry` 向 pnpm 询问其配置指向哪里。包把 `./registry`——`registryPlan`、`normalizeRegistry`、`REGISTRY_URL`——作为浏览器安全的入口发布，客户端 bundle 内联它；对话框使用 `REGISTRY_URL`。每次计划花费一个 pnpm 进程做读取；pnpm 读不出来的机器没有备选。

## Testing

`packages/boot/plugin-manager/tests/registry.spec.ts` 钉住计划（含私有与未知的 pnpm 注册表）与归因；`install-spec.spec.ts` 钉住各 spec 形式携带的主机和分类器的模式；`manager.spec.ts` 从检查和安装依次询问注册表、读取打印在 stdout 的拒绝、在尝试之间恢复文件、在 git 主机和配置集合之外的注册表处停下、把两次尝试之间的取消报告为已取消，并在加载时拒绝不是 http(s) URL 的注册表；`operations.spec.ts` 钉住查询的参数和 pnpm 注册表的读取。`packages/client/ui-plugin-manager/tests` 覆盖 store 的选择、跨控制器的记忆、Host 通告的尝试、带着展开选项回到 spec，以及页面的选择器、尝试文案、运行标记和失败句子。
