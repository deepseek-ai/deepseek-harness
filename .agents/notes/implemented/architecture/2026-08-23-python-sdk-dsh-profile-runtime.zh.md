# Agent Note: 通过 dsh profile 启动器运行 Python SDK 运行时

Status: implemented

[English](2026-08-23-python-sdk-dsh-profile-runtime.md) | 中文

## 问题

Python SDK 分发一个私有 Node 应用，直接启动完整外部 `cordis.yml`；其他所有受支持应用都从 `dsh` profile 进入。该例外重复了环境加载、配置所有权、插件解析、关闭流程、产物命名与测试路径。它还把 SDK 自定义变成全量替换应用树：只想替换一个插件的调用方也必须拥有 JSON-RPC server 和所有无关 deployment 配置项。

仅修改 Python wrapper 无法采用普通 profile。运行时可执行程序必须包含 `dsh` CLI、随附 profile 与 bundle 文件、原生库，以及在 profile 文件和外部插件位于 pkg 虚拟文件系统之外时仍可工作的模块解析路径。

## 决策

### 一个应用启动器

运行时可执行程序打包 `@deepseek-ai/dsh` 并运行其普通命令语法。Python 客户端默认选择 `--profile sdk`，转发有序绝对 `--patch` 路径，也可以选择另一个 `dsh` 可执行程序或 profile。可运行极简示例选择随附 `sdk-minimal` profile。私有 `@deepseek-ai/dsh-sdk-python-runtime` 应用包和检入的运行时 `cordis.yml` 均不存在。JSON-RPC 服务仍由 `@deepseek-ai/dsh-sdk-app` bundle 与 `@deepseek-ai/dsh-sdk-jsonrpc-server` 插件提供，而不是 Python 自有启动路径。

公开 Python 配置包括 `dsh_bin`、`profile`、有序 `patches`、`dsh_home`、进程 cwd／环境、provider／model／token 选择、有界初始化 timeout，以及可选的轮次／关闭 timeout。它不暴露完整 Cordis 树或任意启动 argv。`RunResult` 报告协议所有的运行值，不重复 profile 的持久化路径。

每次 Python 启动都要求显式 `dsh_home`，或子进程环境中的非空 `DSH_HOME`。SDK 绝不会发现 `~/.dsh`。所选 home 统一拥有 profile、外部插件、凭据、设置与会话。

### 插件自定义

持久 SDK 自定义使用与直接 CLI 相同的 profile 接口。`dsh plugin --profile <name> ...` 管理外部依赖与 bundle 顺序，`$DSH_HOME/profiles/<name>/cordis.patch.yml` 负责持久配置项变更，home patch 对所有 profile 应用机器本地变更，Python `patches` 则提供单次启动 overlay。所选 profile 只有保留 SDK server 配置项时才有效。缺失 profile、bundle、server 配置项或非法 patch 都会直接失败，不存在完整配置回退；保持运行却不提供 JSON-RPC 服务的 profile 会在独立有界的初始化握手中失败，诊断会指明该 profile。

[独立 sdk-minimal profile](2026-08-24-standalone-sdk-minimal-profile.zh.md)只列出一个仓库自有组合包，该组合包会插入不含 `dsh-base` 的完整显式配置树。持久 Bash 与字符串替换 editor 通过组合存在；共享 JSON-RPC server 不暴露根 agent 工具筛选器。动态运行时上下文、workspace 指令、settings、托管凭据、遥测、compaction 与其他所有 base 配置项均不存在。同一运行时仍会把完整 `sdk` 与 `web` profile 作为独立选择打包。

运行时 wheel 安装 `dsh` 控制台命令。普通 profile 与 SDK 运行仍不需要 Node；外部包管理要求调用方自行安装 `pnpm`。

### 可执行程序打包

零代码部署 manifest 是 `dsh-python-runtime-closure`。它把 `node_modules/@deepseek-ai/dsh/lib/bin.js` 以及 profile、bundle、preset、原生 addon 与共享库资源打包进 `deepseek-harness-sdk-runtime-<platform>-<arch>`。Wheel distribution 名称、Python import 模块、JSON-RPC 消息和协议稳定的 `serverInfo.name = deepseek-harness-sdk-runtime` 保持不变。

普通 Node profile 在 `$DSH_HOME/profiles/node_modules` 中使用符号链接，让外部插件共享安装包。操作系统符号链接无法进入 pkg 的 `/snapshot` 文件系统，因此打包 CLI 改为写入小型真实 ESM 代理包。每个代理直接按 Node import 条件解析源包的显式 ESM exports map，公开安装中实际存在的目标，并重新导出其虚拟模块 URL。没有 ESM 运行时目标的 export 项以及仅含可执行入口或类型声明入口的包不会产生不可用的代理条目；格式错误的 exports map 会导致启动失败。完整且匹配的 generation 不会获取跨进程写入锁。缺失或过期的配置项会获取该锁、重新检查 generation，并在不暴露半成品代理的前提下修复；任一载体都可以替换另一载体留下的受管配置项。Loader 配置项和外部插件 peer 因而可以通过普通 profile 逐级向上查找解析，同时保留一个 Cordis 和每个内置模块的单一实例。

已发布目标集合是 Linux x64、Linux arm64、macOS arm64、macOS x64 与 Windows x64。Installed-wheel 黑盒 CI 在每个目标上负责产物来源、默认及 patched profile、外部 bundle 安装、原生工具、MCP、直接 JSON-RPC、快照，以及可信真实提供方轮次。[Windows x64 运行时决策](2026-08-23-python-sdk-windows-x64-runtime.zh.md)负责 Windows 产物及其平台专属 shell surface。

## 既有决策与取代关系

本决策实现并取代[单一 dsh 应用启动器](2026-08-22-single-dsh-application-launcher.zh.md)中的 Python 例外与延后迁移章节。它取代[单文件 Python SDK 运行时分发](2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)中的私有应用、外部完整配置、产物名称与自定义事实；后者继续负责 pkg／SEA、wheel 构建、原生目标验证与发布。[独立 sdk-minimal profile](2026-08-24-standalone-sdk-minimal-profile.zh.md)只取代本 Note 中的极简 overlay 实现。没有任何 active note 被完全取代，因此无需归档。

## 考虑过的替代方案

**把完整 `cordis.yml` 保留为高级逃生口。** 不予采用，因为它会保留第二套应用组装，并允许调用方绕过 profile 的环境、插件与关闭所有权。

**为兼容性静默使用 `~/.dsh`。** 不予采用，因为 SDK 进程不应在没有显式选择时继承个人插件、凭据、设置或会话。

**把虚拟依赖树复制到每个 home。** 不予采用，因为这会重复数百 MB，并加载第二个 Cordis 实例。保留 exports 的代理很小，而且维持模块身份。

**把 pnpm 与 Node 包管理纳入每次 SDK 启动。** 不予采用，因为已安装插件属于 deployment 状态，而不是逐轮运行时工作。只有 `dsh plugin` 需要外部包管理器。

## 结果

Python 调用方使用与 TypeScript 和直接 CLI 用户相同的 profile 词汇，任意外部 bundle 可以扩展 SDK profile，而无需引入另一个 launcher。调用方必须显式选择 home，完整配置与 `session_root` 参数不可用，可执行程序则包含共享库资源和 profile 模块代理。完整 `sdk`、独立 `sdk-minimal` 与 `web` 应用作为同一打包 CLI 内的不同 profile 保持分离。Installed-wheel CI 将包、profile、原生与提供方路径变成发布要求，而不是仅在源码中成立的假设。
