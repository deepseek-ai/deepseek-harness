# Agent Note: 由一个 dsh 启动应用 profile

Status: implemented

[English](2026-08-22-single-dsh-application-launcher.md) | 中文

## Problem

DeepSeek Harness 应用进程需要由同一个机制负责组合、插件解析、环境发现、关闭和用户自定义。带完整 `cordis.yml` 的专用应用 bin 会在 profile 启动之外形成第二套生命周期：安装到 profile 的插件无法到达它，行为会与 `dsh-base` 偏离，SDK 调用方还需要学习任意进程 argv，而不是产品的组合模型。

Python SDK 通过四个平台 wheel 包分发原生可执行文件。其打包进程使用同一 profile 启动器，同时保留封闭的 VFS 依赖树、原生伴随文件与 installed-wheel 证据。

## Decision

### 启动范围

所有受支持的 Node 应用都通过 `dsh` CLI 与一个具名 profile 启动。随附应用命令是 `dsh web`、`dsh --profile headless`、`dsh --profile sdk`、`dsh --profile sdk-minimal` 与 `dsh --profile acp`；`dsh web` 是刻意为 `--profile web` 保留的便捷别名，不是另一个应用入口。

Vendor CLI、仅用于构建和测试的可执行文件、进程内直接挂载插件以及私有浏览器 WebWorker 预览都不属于应用启动清单。包应用 bin 或直接启动包入口的根 demo 都不是可接受的扩展点。

### Profile 应用

`@deepseek-ai/dsh-sdk-app` 与 `@deepseek-ai/dsh-acp-app` 在 `@deepseek-ai/dsh-base` 之上组合完整协议应用。SDK 组合包增加 JSON-RPC 服务器、应用自有帮助和 stdio 生命周期；ACP 组合包增加仅用于自动化的 ACP 服务器与相同的应用职责。两者都采用 base 层的模型、工具、持久化、settings、credentials、策略和环境行为。[独立 sdk-minimal profile](2026-08-24-standalone-sdk-minimal-profile.zh.md)复用 SDK 启动与 JSON-RPC 服务，但刻意拥有不含 `dsh-base` 的完整显式配置树。

Profile manifest 负责 patch 重载：

| Profile | `patchReload` |
|---|---|
| `web` | `live` |
| `headless` | `startup` |
| `sdk` | `startup` |
| `sdk-minimal` | `startup` |
| `acp` | `startup` |

自定义 profile 默认为 `live`。`startup` profile 仍会应用组合包、profile、home 级与调用时 `--patch` 各层，但启动后不会监视这些文件。`dsh-base` 插入的模块 HMR（热模块替换）配置项默认禁用；具有经过验证的源码模块重载生命周期的 profile 必须显式启用它。随附 profile 均不启用服务器模块 HMR：`patchReload: live` 使用启动器的仅配置 watcher，`startup` profile 则不安装 watcher。SDK 与 ACP 无法在一个自有 stdio 连接内安全替换其服务器、agent、持久化或工具注册表。

随附协议 profile 将 stdout 保留给协议帧，显示帮助时不启动 transport，并通过有界根节点 dispose（资源释放）处理 stdin EOF 与信号。ACP 继续仅用于自动化。SDK JSON-RPC 方法、通知字段与 `initialize.serverInfo.name` 保持稳定。完整 profile 的模型可见工具与持久化默认值来自 `dsh-base`；`sdk-minimal` 拥有自己的显式默认值。可运行快照负责固定已组装的应用输出。

### TypeScript SDK 自定义

`@deepseek-ai/dsh-sdk-client` 依赖同版本的 `@deepseek-ai/dsh` 包，解析其已安装 CLI 模块，通过当前 Node 可执行文件运行该模块，并默认选择 `sdk`。两层客户端都暴露 `dshBin`、`profile`、有序 `patches`、`dshHome`、进程 cwd、环境和超时；任意 command/argv 启动只保留为 fake-runtime 测试的内部适配器。

SDK 用户通过 profile 自定义插件。`dsh plugin --profile <name> ...` 管理持久依赖与组合包顺序，profile 的 `cordis.patch.yml` 负责持久配置项变更，启动时 `patches` 提供有序临时覆盖。自定义 profile 必须保留 `@deepseek-ai/dsh-sdk-app` 或另一个 SDK 服务器配置项。相对 CLI 模块、patch、显式 home 与进程 cwd 路径会在 spawn 前变为绝对路径；初始化具有有限时限，诊断会写明所选 profile。

直接使用 SDK 时遵循普通 Harness home 解析：显式 `dshHome`、继承的 `DSH_HOME`，最后是 `~/.dsh`。`subagent-dsh-sdk` 则要求显式绝对 home，因此嵌套运行时不会通过操作系统 home 发现个人 profile、已安装插件、凭据或会话。DSH 专用 ACP 子进程示例同样传入隔离 home；ACP 后端自身继续适用于非 DSH agent。

### Python 运行时

Python 运行时 wheel 通过私有 `dsh-python-runtime-closure` 部署 manifest，打包来自 `node_modules/@deepseek-ai/dsh/lib/bin.js` 的普通 `@deepseek-ai/dsh` CLI。Python 客户端默认选择 `dsh --profile sdk`、有序 patch 文件与显式 Harness home；`python/sdk/examples` 下的可运行示例选择 `sdk-minimal`。安装的 `dsh` 控制台命令暴露相同 profile 语法与单独打包的 `web` 应用。

可执行文件族是 `deepseek-harness-sdk-runtime-<platform>-<arch>`。SDK 协议格式、wheel 与 import 分发名称、伴随文件名称，以及协议 identity `deepseek-harness-sdk-runtime` 保持稳定。SDK 包族是 `@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh-sdk-protocol` 与 `@deepseek-ai/dsh-sdk-jsonrpc-server`；`@deepseek-ai/dsh-acp` 继续作为 ACP 协议插件。仓库不保留 Python 专用 Node 应用、检入的完整配置、兼容包、转发可执行文件、后备解析器或 SDK／ACP 启动别名。[Python profile 运行时决策](2026-08-23-python-sdk-dsh-profile-runtime.zh.md)负责该启动方式，[Windows x64 运行时决策](2026-08-23-python-sdk-windows-x64-runtime.zh.md)负责 Windows 载体。

### 强制校验

`verify-application-entrypoints` 扫描应用／包 manifest、可执行源码和根 demo 脚本。允许清单对 `dsh` 产品 bin、排除的 vendor 范围、私有 WebWorker 构建工具和测试支持进行分类。未分类的 shebang、新包 bin 或绕过 `apps/cli/src/bin.ts` 的 demo wrapper 都会使 hygiene 与 primary／static CI 聚合失败。

## 既有决策与取代关系

本决策取代 [profile 插件组合包](2026-08-05-profile-plugin-bundles.zh.md)、[TypeScript SDK 客户端与 SDK subagent 后端](../feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.zh.md)、[移除 SDK 项目工具链](../simplification/2026-08-11-remove-sdk-project-toolchain.zh.md)和[单文件 Python SDK 运行时分发](2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)中的应用启动与包名事实。这些 Note 对 profile 分层、客户端／协议语义、已删除的项目工具链与原生打包仍分别具有独立权威。

[ACP 仅自动化协议](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)继续负责 ACP 协议格式与交互范围。[仓库命名约定](2026-08-11-repository-naming-contract-and-rename-ledger.zh.md)继续负责基于角色的包名。[独立 sdk-minimal profile](2026-08-24-standalone-sdk-minimal-profile.zh.md)部分取代本 Note 的 base 优先规则与完整配置树替代方案，同时保留本 Note 对 launcher 所有权的决策。没有任何活跃 Note 被完全取代，也没有 Note 符合归档条件。

## 考虑过的替代方案

**保留直启 bin，只声明推荐 profile。** 拒绝：只要受支持的可执行文件仍然绕过 profile，文档就无法让 profile 真正负责插件安装、环境加载、关闭和测试。

**保留转发兼容 bin。** 拒绝：转发可执行文件仍然形成另一个公开启动名称与兼容承诺。预发布仓库可以让调用方直接迁移到 profile。

**把调用方提供的完整 Cordis 树放到 profile wrapper 后面。** 拒绝：这只集中 argv，没有集中应用组合。完整 profile 使用 `dsh-base` 加轻量应用组合包，使共享策略只有一个归属。只有当显式清单本身属于产品行为时，才允许仓库自有且有版本的独立组合包，具体见 [sdk-minimal](2026-08-24-standalone-sdk-minimal-profile.zh.md)。

**在 TypeScript 构造函数中接受内联插件或完整 `cordis.yml`。** 拒绝：SDK 会因此成为另一个包安装器和应用组合器。具名 profile 与 patch 文件已通过统一解析模型提供持久与逐次启动自定义。

**只从 `PATH` 解析 `dsh`。** 拒绝：普通 Node 进程不一定继承项目本地 `.bin` 路径。同版本包依赖可以提供确定的运行时。

**在 `dsh-base` 中启用模块 HMR，再由不安全的 profile 逐一禁用。** 拒绝：共享 base 同样承载自定义 profile；默认启用会要求每个新应用都记得退出源码模块替换。base 默认禁用会让模块 HMR 成为显式的 profile 能力，同时保留 `patchReload: live` 配置监视。

**热重载协议 profile。** 拒绝：替换协议服务器或其依赖可能破坏待处理协议帧与 SDK 自有 agent。进程重启是 SDK 与 ACP 配置变更的采用边界。

**不做独立打包证明就把 Python 可执行文件迁移到 profile。** 拒绝：原生 VFS 闭包、四个平台 wheel 包、profile 资源、ripgrep 与 spawn-helper 伴随文件和干净安装行为都需要自己的迁移证据。

## 验证

- 源码与构建后 CLI 验收覆盖 `sdk`、`sdk-minimal` 和 `acp` 的帮助、transport 启动、stdout 纯净性、EOF、信号与根节点 dispose。
- 组合包配置测试钉住 `dsh-base` 默认禁用模块 HMR，随附模式覆盖层不含该策略；自定义 live profile 的 e2e 钉住启动器仅监视 fallback 提供的配置重载。
- 聚焦单元套件覆盖 profile 启动解析、初始化时限、SDK 重试、服务器就绪和嵌套隔离 home，并对变更后的运行时源码实现 100% 覆盖率。
- 免密钥 ACP 与 SDK 快照启动真实 `dsh` profile，并钉住协议输出与持久化日志；嵌套 SDK 组合会启动第二个真实 profile 运行时。
- 真实 API 工作流把文件并行度限制为 4，因为一个 profile e2e 文件可能拥有多个完整 `dsh` 子进程树；工作流测试会钉住该资源上限。
- Python 套件同时测试 exe 与 node 载体；打包运行时场景、原生 macOS 可执行文件构建、两个 wheel 包以及干净 wheel 默认／MCP 冒烟测试会钉住 `deepseek-harness-sdk-runtime-*` 产物与 profile 启动。
- `verify-application-entrypoints` 包含包 bin、可执行源码、直启包的 demo wrapper 与未分类 demo 等非法 fixture（测试前置数据）。

## 影响

- 用户通过具名 profile 与有序 patch 更改 SDK 应用的插件组合，使用与其他所有 dsh 应用相同的安装与解析模型。
- 自定义 profile 可以在不启用服务器模块 HMR 的情况下获得实时配置监视，只有显式覆盖配置项才会启用源码模块替换。
- 完整 SDK 与 ACP profile 共享完整 base 应用和同一份策略与工具；`sdk-minimal` 拥有自己的显式独立清单，快照会呈现这些刻意采用的组装差异。
- 增加 `@deepseek-ai/dsh` 会扩大 TypeScript 客户端的安装体积，换来确定的同版本运行时。
- 受信任用户 patch 可以增加写入 stdout 的插件并破坏自己的协议流；随附 profile 保证纯净，不为任意第三方组合提供保证。
- Python 打包普通 `dsh` profile 启动器，同时保留封闭原生运行时，wheel 用户无需系统 Node。
