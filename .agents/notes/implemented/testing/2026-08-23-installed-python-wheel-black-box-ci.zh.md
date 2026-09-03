# Agent Note: 安装后 Python wheel 黑盒拉取请求验证

Status: implemented

[English](2026-08-23-installed-python-wheel-black-box-ci.md) | 中文

## Problem

Python SDK 单元测试驱动 fake peer，而打包运行时工作流可以在两个 Python distribution 尚未生成时，用源码 SDK 驱动新构建的可执行文件。干净虚拟环境只覆盖默认与 MCP 场景，必需的拉取请求 CI 也只构建 Linux x64。因此，源码 checkout、editable install、不匹配的 SDK／运行时组合、损坏的原生 wheel 包、平台相关闭包或真实提供方集成都可能绕过阻止合并的证据。

## Decision

### 安装产物边界

必需的 Python 运行时工作流先构建纯 SDK wheel 包与各平台运行时 wheel 包，再进行行为测试。每个原生目标都把这两个本地文件安装进新的 Python 3.10 虚拟环境，切换到仓库外的临时目录，清除 `PYTHONPATH` 与 `DSH_RUNTIME_MODE`，并且只调用公开 Python 模块与打包后的可执行文件。

黑盒测试会拒绝非 venv 进程、仓库内工作目录、源码或 editable import、不相等的 distribution 版本、未精确固定运行时版本的 SDK 依赖、位于已安装运行时包之外的可执行文件，以及未出现在运行时 distribution 记录中的可执行文件。该来源校验发生在首个 agent 请求之前，因此行为通过也不能掩盖实际运行了错误代码。

### Keyless 行为

每个目标都会在安装后运行完整的打包运行时场景。一个本地 SSE mock 模型提供确定性输出，公开 SDK 则覆盖默认 SDK profile、有序 patch overlay、通过 `dsh plugin` 安装外部 bundle、持久 PTY 与 editor 行为、worker thread 代码与 workflow 执行、基于 ripgrep 的搜索、外部 stdio MCP 发现与执行、模型可见及持久化快照、Zstandard 持久化、直接 JSON-RPC 与关闭。Restart 快照针对同一持久化根目录启动两个完整 SDK 运行时进程，并固定其彼此隔离的模型历史、高层结果与独立持久日志。安装后运行取代 wheel 构建前的源码 SDK 运行，因此可执行文件与 wheel 包共同接受一次验证，而不是维护两套行为清单。

Linux 另外保留 manylinux 2.28 干净安装冒烟测试与 GLIBC 检查。macOS 保留部署目标与原生 helper 检查。这些平台约束补充共同黑盒行为，不能替代它。

### 真实 DeepSeek API

可信拉取请求会在每个原生目标上运行第二项安装后 wheel 检查，并且只在预检与 live 测试步骤中把 `DEEPSEEK_API_KEY_EXTERNAL` 映射进去。密钥为空时预检失败，因此提供方测试不能通过自行 skip 产生假绿。该测试通过公开 SDK 访问 `https://api.deepseek.com`，要求模型通过当前平台 shell 写入内容精确的 sentinel 文件，再在同一 session 的第二个轮次中读取它，并校验外部文件行内容、最终响应、已完成的轮次结束原因、模型请求的工具调用，以及 session 日志存在且采用 Zstandard framing。解码后的记录内容与已完成轮次的持久性是由 restart 快照负责的确定性 keyless 要求，不从压缩后的 live 提供方字节推断。

Fork 与 Dependabot 拉取请求永远不会获得仓库密钥。它们的原生 job 运行完整 keyless 路径并跳过两个带密钥的步骤；禁止使用 `pull_request_target`，因为它会让不可信代码带着密钥执行。

### 必需目标

拉取请求的 `python-runtime` job 会针对 Linux x64、Linux arm64、macOS arm64、macOS x64 与 Windows x64 调用可复用构建器。其聚合结果仍是 `all checks passed` 的依赖项，因此任一原生载体失败、取消或缺失都会阻止必需判定通过。[Windows x64 运行时决策](../architecture/2026-08-23-python-sdk-windows-x64-runtime.zh.md)负责 Windows 目标及其 PowerShell 专属极简快照。

## Existing decisions and supersession

本决策取代已归档的[必需 Python 运行时拉取请求验证](../../archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md)中的单目标拓扑，同时保留真实可执行文件、快照、wheel 包与干净安装必须在合并前相遇的要求。[Python SDK dsh profile 运行时](../architecture/2026-08-23-python-sdk-dsh-profile-runtime.zh.md)负责启动应用与自定义接口；[单文件 Python SDK 运行时 distribution](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)继续负责 SEA 打包、原生 sidecar、wheel 包标签与发布产物。

## Alternatives considered

**只保留 Linux x64 必需载体。** 否决：五个已发布目标的原生 addon、可执行文件构建、wheel 包标签与 helper 文件不同。等到发布时才发现问题，对每个 Python SDK 安装都会按平台选择的产物而言太晚。

**在 wheel 构建前运行完整行为，并保留两个很小的安装后冒烟测试。** 否决：这只能证明可执行文件配合源码 import 工作，再通过 distribution 证明很少的行为。干净安装环境是在同一批场景中验证用户实际安装内容的更强位置。

**只使用 keyless 模型模拟。** 否决：本地 SSE endpoint 不能证明真实提供方的认证、请求兼容性、流式输出、工具调用解释或完整轮次。

**通过 `pull_request_target` 向 fork 拉取请求暴露密钥。** 否决：任意 fork 代码都可以窃取仓库密钥。不可信 ref 缺少带凭据证据是明确且保留安全性的结果；可信 head 与合并后提供方 CI 继续提供 live 信号。

## Consequences

每个拉取请求都会承担五个原生可执行文件及 wheel 包构建，并运行确定性的安装后产物场景。可信的同仓库拉取请求还会在每个目标上承担一次双轮 DeepSeek 任务。相应地，必需结果描述 Python 用户实际安装的文件，在合并前证明每个已发布载体，并且不能通过导入 checkout 或静默跳过真实提供方而通过。
