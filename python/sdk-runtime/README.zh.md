# deepseek-harness-runtime-bin

[English](README.md) | 中文

DeepSeek Harness Python SDK 的平台运行时 wheel 包。它把普通 `dsh` CLI（命令行界面）及其封闭的 Node 依赖树打包成原生可执行程序，因此使用 SDK 不需要系统 Node.js。本包只发布 wheel 包。

## 安装命令与产物

wheel 包会安装 `dsh` 控制台命令和 `deepseek_harness_runtime` Python 模块。`dsh` 将参数转发给内置可执行程序，并要求非空 `DSH_HOME`；它不会回退到 `~/.dsh`。

生产可执行程序位于模块的 `runtime/` 目录，命名为 `deepseek-harness-sdk-runtime-<platform>-<arch>`；Windows 使用 `.exe` 后缀。Linux 与 macOS wheel 包含目标平台原生的 `-rg` 伴随程序，Windows 包含 `-rg.exe`，macOS 还包含 `node-pty` 使用的 `-spawn-helper`。已发布目标是 Linux x64、Linux arm64、macOS arm64、macOS x64 与 Windows x64。wheel 包标签必须与载荷严格匹配；不发布 Windows arm64 wheel 包。

每个目标还要求 `<executable-stem>-office/`，其中 stem 不含 `.exe`。该目录包含完整的已安装 Office 包及其依赖，保留引擎资源、清单、许可证、源码清单与辅助程序权限。复制可执行文件时必须一并复制此目录。缺少目标引擎会使 sidecar 构建失败，错误会指出其 npm 包名与目标平台／架构。

每个 wheel 还包含 `<platform>-<arch>/primary-runtime/`（CPython、锁定版本的 Office Python 库、独立 Node 和 pnpm）及同级 `office-skills/`（三个默认工作流与共用检查脚本）。它们是可重定位的普通文件，不嵌入可执行文件。共享构建器为全部五个 wheel 目标选择原生归档，并在对应构建主机上执行冒烟检查。打包与已安装运行时定位会拒绝缺失资源、平台不符的元数据及 Python 或 Node 执行权限丢失。 较短的平台目录避免在 Windows Python DLL 路径中重复可执行文件名称。

打包启动器通过 `DSH_BUNDLED_PRIMARY_RUNTIME` 提供载体默认路径。`sdk` profile 在未设置 `DSH_PRIMARY_RUNTIME` 时使用该路径；显式路径覆盖它，空字符串禁用查询与 Office 提供方。外部 payload 保持 `primary-runtime/` 与同级 `office-skills/` 布局。加载后的技能给出内置 Node 与伴随 Office CLI 的绝对路径；自定义的纯 Python payload 必须配置 `skill-office.config.cli: false` 或提供 `skill-office.config.node`。SDK 原位读取 Python，不复制到 `DSH_HOME`。源码与仅供开发的 Node 载体没有随包默认路径，需显式设置 `DSH_PRIMARY_RUNTIME`。

选择 skills 与交付资源相互独立：项目、自定义目录和用户文件系统 skills 优先于同名随包 skills。SDK patch 可以仅禁用 Office 提供方，同时保留 Python 查询：

```yaml
- id: skill-office
  disabled: true
```

要成套替换三个 Office 工作流与共用检查脚本，可将 `skill-office.config.assetRoot` 配置为另一个绝对资源目录。任意 skill 集合通过文件系统 skill 提供方加载。配置 patch 在进程启动时生效；切换 skills 无需重建 runtime wheel 或 Python 环境。

仓库构建还会物化仅限开发的 `runtime/node/` 载体。它在系统 Node 22.19 或更高版本上运行 `node runtime/node/node_modules/@deepseek-ai/dsh/lib/bin.js`。系统不会自动选择它，而且 wheel 包与 sdist 均不包含它。

两种载体执行相同的 `dsh` 语法与随附 profile，包括独立的 `sdk-minimal` 配置树，以及包含前端产物的完整 `web` profile。私有 `dsh-python-runtime-closure` manifest（元数据清单）定义打包依赖闭包；不存在 Python 专用 Node 应用或检入的默认 `cordis.yml`。

## Python 模块 API

- `bundled_package_dir() -> Path` 返回已安装模块数据根目录，并校验发布元数据。
- `bundled_runtime_path() -> Path` 返回当前平台可执行程序，并校验必需伴随文件。
- `resolve_bundled_launch_args(mode=None) -> tuple[str, ...]` 默认返回可执行程序 argv。显式 `mode="node"` 或 `DSH_RUNTIME_MODE=node` 会选择仅限仓库使用的 Node 载体。
- `main()` 实现已安装的 `dsh` 控制台命令，并拒绝缺失或空白的 `DSH_HOME`。在 Windows 上，它让打包进程继承标准流，等待其结束并转发退出状态；在 POSIX 上，它替换 Python 进程。

不支持的平台以及缺失的可执行程序或伴随文件会抛出 `FileNotFoundError`，并指出构建与安装路径。未知运行时模式会抛出 `ValueError`。

## 打包后的 profile 解析

`dsh` 在显式指定的主目录下初始化随附 profile、组合其 bundle patch，并从可执行程序的虚拟文件系统加载内置插件。运行时解析使用内存中的 generation，不创建磁盘符号链接或代理包。fallback 导入使用记录的声明包路径，包括可执行程序虚拟文件系统内的路径，因此内置配置项与外部插件 peer 共享内置的 Cordis／模块实例。原生共享库与 Windows ConPTY addon 会同其他原生 addon 一起打包；ripgrep 与 macOS PTY helper 仍是可执行伴随程序。

Python bootstrap 从相邻目录解析 Office kit，让原生辅助程序与 URL Worker 使用真实文件系统路径。kit 负责引擎选择与校验；Python bootstrap 不增加运行时下载或编译。Office smoke 还从已加载技能获取 CLI 路径，并在空 PATH 下执行 capabilities 和 DOCX 转换。

外部 profile 管理使用 `dsh plugin --profile <name> ...`。该命令要求 `PATH` 中存在 `pnpm`；普通 SDK／profile 运行不需要它。

## 构建与分发

生产部署允许工作区中不属于运行时闭包的补丁保持未使用；闭包内包的补丁仍必须成功应用。此例外仅用于部署命令，仓库安装仍拒绝未使用的补丁。

在仓库根目录运行 `pnpm exec tsx scripts/build-exe-for-python-sdk.ts`，会校验闭包、构建包、部署无符号链接的文件树、打包所选目标，并把可执行程序及伴随文件同步到本模块。`scripts/build-python-release.py` 按仓库根版本暂存发布形态的 wheel 包，并将 `deepseek-harness-sdk` 固定到完全相同的运行时版本。

已安装 wheel 包冒烟测试会在检出目录外创建干净的虚拟环境，验证分发物与可执行程序的来源，然后覆盖默认及自定义 SDK profile、外部插件、MCP、原生工具、直接 JSON-RPC、检入快照，以及可信运行中的真实提供方。Office 场景会迁移完整的目标载荷目录，并使用所需的平台引擎转换 DOCX：使用目标已声明的原生引擎，未声明原生引擎时使用 WASM。另见 [Python 贡献者工作流](../development.zh.md) 与 [installed-wheel 测试决策](../../.agents/notes/implemented/testing/2026-08-23-installed-python-wheel-black-box-ci.zh.md)。
