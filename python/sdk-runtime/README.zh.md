# deepseek-harness-runtime-bin

[English](README.md) | 中文

DeepSeek Harness Python SDK 的平台运行时 wheel。它把普通 `dsh` CLI 及其封闭的 Node 依赖树打包成原生可执行程序，因此使用 SDK 不需要系统 Node.js。本包只发布 wheel。

## 安装命令与产物

Wheel 会安装 `dsh` 控制台命令和 `deepseek_harness_runtime` Python 模块。`dsh` 将参数转发给内置可执行程序，并要求非空 `DSH_HOME`；它不会回退到 `~/.dsh`。

生产可执行程序位于模块的 `runtime/` 目录，命名为 `deepseek-harness-sdk-runtime-<platform>-<arch>`；Windows 使用 `.exe` 后缀。Linux 与 macOS wheel 包含目标平台原生的 `-rg` 伴随程序，Windows 包含 `-rg.exe`，macOS 还包含 `node-pty` 使用的 `-spawn-helper`。已发布目标是 Linux x64、Linux arm64、macOS arm64、macOS x64 与 Windows x64。Wheel tag 必须与载荷严格匹配；不发布 Windows arm64 wheel。

仓库构建还会物化仅限开发的 `runtime/node/` 载体。它在系统 Node 22.19 或更高版本上运行 `node runtime/node/node_modules/@deepseek-ai/dsh/lib/bin.js`。系统不会自动选择它，而且 wheel 与 sdist 均不包含它。

两种载体执行相同的 `dsh` 语法与随附 profile，包括独立的 `sdk-minimal` 配置树，以及包含前端产物的完整 `web` profile。私有 `dsh-python-runtime-closure` manifest 定义打包依赖闭包；不存在 Python 专用 Node 应用或检入的默认 `cordis.yml`。

## Python 模块 API

- `bundled_package_dir() -> Path` 返回已安装模块数据根目录，并校验发布元数据。
- `bundled_runtime_path() -> Path` 返回当前平台可执行程序，并校验必需伴随文件。
- `resolve_bundled_launch_args(mode=None) -> tuple[str, ...]` 默认返回可执行程序 argv。显式 `mode="node"` 或 `DSH_RUNTIME_MODE=node` 会选择仅限仓库使用的 Node 载体。
- `main()` 实现已安装的 `dsh` 控制台命令，并在替换 Python 进程前拒绝缺失或空白的 `DSH_HOME`。

不支持的平台以及缺失的可执行程序或伴随文件会抛出 `FileNotFoundError`，并指出构建与安装路径。未知运行时模式会抛出 `ValueError`。

## 打包后的 profile 解析

`dsh` 在显式 home 下初始化随附 profile、组合其 bundle patch，并从可执行程序的虚拟文件系统加载内置插件。操作系统符号链接无法进入该文件系统，因此打包运行会在 `$DSH_HOME/profiles/node_modules` 下维护小型真实 ESM 代理包。每个代理镜像显式运行时 exports、记录原包身份，并重新导出虚拟模块 URL。因此，内置配置项与外部插件 peer 会共享同一个 Cordis／模块实例。原生共享库与 Windows ConPTY addon 会同其他原生 addon 一起打包；ripgrep 与 macOS PTY helper 仍是可执行伴随程序。

外部 profile 管理使用 `dsh plugin --profile <name> ...`。该命令要求 `PATH` 中存在 `pnpm`；普通 SDK／profile 运行不需要它。

## 构建与分发

在仓库根目录运行 `pnpm exec tsx scripts/build-exe-for-python-sdk.ts`，会校验闭包、构建包、部署无符号链接的文件树、打包所选目标，并把可执行程序及伴随文件同步到本模块。`scripts/build-python-release.py` 按仓库根版本暂存发布形态的 wheel，并将 `deepseek-harness-sdk` 固定到完全相同的运行时版本。

Installed-wheel smoke 会在 checkout 外创建干净虚拟环境，证明 distribution 与可执行程序来源，然后覆盖默认及自定义 SDK profile、外部插件、MCP、原生工具、直接 JSON-RPC、检入快照，以及可信运行中的真实提供方。另见 [Python 贡献者工作流](../development.zh.md)与 [installed-wheel 测试决策](../../.agents/notes/implemented/testing/2026-08-23-installed-python-wheel-black-box-ci.zh.md)。
