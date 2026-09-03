# Agent Note: Python SDK Windows x64 运行时

Status: implemented

[English](2026-08-23-python-sdk-windows-x64-runtime.md) | 中文

## Problem

Python SDK 运行时分发需要 Windows 载体，同时不能创建另一个应用入口，也不能削弱现有原生目标所使用的 installed-wheel 证据。Windows 的可执行文件名、Python wheel 标签、ConPTY addon、ripgrep sidecar、shell 组合、虚拟环境与进程启动规则均不同于 Linux 和 macOS。仅凭跨平台单元测试或非 Windows 可执行文件声称支持 Windows，会使 `pip` 实际选择的产物未经证明。

## Decision

### 唯一 x64 产品

`python/sdk-runtime/platforms.json` 声明唯一的 Windows 目标 `win-x64`。其 pkg 目标是 `node24-win-x64`，运行时 wheel 标签是 `py3-none-win_amd64`，载荷包含 `deepseek-harness-sdk-runtime-win-x64.exe` 与 `deepseek-harness-sdk-runtime-win-x64-rg.exe`。打包后的 `node-pty` 文件树必须包含两个 x64 ConPTY addon。运行时查找会拒绝 Windows arm64，不会选择 x64 wheel 或把它重新标记为 arm64。

Python 进程仍按 [Python profile 运行时决策](2026-08-23-python-sdk-dsh-profile-runtime.zh.md)启动普通 `dsh --profile sdk` 应用，并要求显式 Harness home。Windows 不会增加 Python 专用 Node 应用、完整配置入口、隐式 `~/.dsh` 或系统 Node 要求。

### 原生构建与发布

可执行文件构建器仅允许 x64 使用 pkg 的 `win` 平台，并要求 Windows 构建在 Windows 宿主的 x64 Node 下运行；构建器保留 `.exe` 文件名，并把 `@vscode/ripgrep-win32-x64` 复制为常规 `-rg.exe` sidecar。Pnpm 子进程通过 `process.execPath` 执行调用方提供的 JavaScript 入口。当调用方暴露 `.cmd` shim 时，构建器会通过 `PNPM_HOME` 解析已安装的 `pnpm.mjs` 或 `pnpm.cjs`；如果不存在 JavaScript 入口，构建会失败，而不会启动 shim 或启用命令 shell。

必需 GitHub 矩阵会在 `windows-2025` 上构建 `node24-win-x64`，与 Linux x64、Linux arm64、macOS arm64 和 macOS x64 并列。公开 GitHub 发布与 GitLab 标签流水线都会发布同一组五个运行时 wheel 加纯 SDK wheel。目标解析、manifest、矩阵、发布内容与文档均不包含 Windows arm64。

### Installed-wheel 行为

Windows lane 会创建干净的 Windows 虚拟环境，安装版本精确匹配的 SDK 与 `win_amd64` 运行时 wheel，切换到 checkout 外的目录，清除 `PYTHONPATH` 与 `DSH_RUNTIME_MODE`，再运行与其他目标相同的 `--scenario all --installed-wheel` 黑盒测试。可信拉取请求还会运行相同的双轮 `sdk-live` 真实提供方场景。Fork 与 Dependabot head 不会获得密钥。

公开 Python 客户端通过 `initialize_timeout_seconds` 为首次 profile 握手提供独立的 30 秒默认上限。该上限可容纳 Windows x64 可执行文件冷启动与 profile 物化，同时仍会使卡死的运行时失败；调用方可将其与普通请求超时分开配置。

成功收到 shutdown 响应后，Python 客户端会关闭 stdin，并在已配置的 shutdown 超时内等待 `dsh` 上下文退出及刷写持久 session 状态，然后才回退到终止进程。Shutdown 失败时仍立即执行有界终止。`shutdown_timeout_seconds` 会分别限制 shutdown 请求、EOF 宽限与终止确认阶段，因此异常关闭在最终 kill 前可能接近该值的三倍。该区别会保留 Windows 上最后一个已接受轮次；该平台的 `terminate()` 会强制结束进程，而不是发送可捕获信号。

极简黑盒测试在 Windows 上使用持久 `pwsh` 与 `str_replace_editor`，并由 `minimal/win-x64/model-visible.json` 固定预期；Linux 与 macOS 保留持久 Bash 和共享的 `minimal/model-visible.json`。高级进程／subagent 快照与重启／持久日志快照继续由所有目标共享。随附的 [`sdk-minimal` 组合包](../../../../packages/bundle/sdk-minimal/README.zh.md)为可运行 Python 教程选择同一组平台 shell。

## Existing decisions and supersession

本决策部分取代[单文件运行时分发](2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)中的 Windows 非目标声明，并扩展[安装后 Python wheel 黑盒决策](../testing/2026-08-23-installed-python-wheel-black-box-ci.zh.md)中的必需目标集合。上述 Note 继续负责 SEA 打包、两个 Python distribution、来源校验、密钥处理与通用黑盒场景。

## Alternatives considered

**在 dsh profile 运行时之前增加 Windows。** 否决：针对已退役私有直启载体的测试无法证明 Windows 用户实际获得的形态。Windows 仅定义于唯一的 `dsh` 启动架构。

**同时发布 Windows arm64。** 否决：已接受的产品范围只有 x64；增加第二种架构需要独立的原生构建器、wheel 标签、ConPTY 与 ripgrep 载荷校验、installed-wheel 矩阵 lane 及发布产物。

**为 Windows 提供较小的冒烟测试套件。** 否决：一个平台 wheel 不能借用其他可执行文件的协议、持久化、worker、MCP、插件、原生工具或真实提供方证据。只有持久 shell surface 使用平台专属预期，其余快照继续共享。

**通过 Git Bash 运行 Windows lane。** 否决：仓库要求 Windows runner 使用原生 `pwsh`，而 MSYS 路径转换无法证明原生命令行为。可移植的单行步骤使用各 runner 的默认 shell；路径、虚拟环境与黑盒步骤分别提供显式 POSIX 和 PowerShell 形式。

## Consequences

Python 安装会选择无需 Node 的 Windows x64 运行时，并与 Linux、macOS 使用同一套显式 home 与 profile 自定义模型。每个拉取请求都会把 Windows 可执行文件和运行时 wheel 作为五个原生目标之一进行构建，运行完整 keyless 黑盒测试，并在可信 head 上运行真实提供方任务。候选发行版验证会保留六个 wheel。Windows arm64 用户会收到明确的不支持平台错误，直到另一项原生产品决策提供并证明该载体。
