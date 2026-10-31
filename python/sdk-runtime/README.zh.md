# deepseek-harness-runtime-bin

[English](README.md) | 中文

DeepSeek Harness Python SDK 的平台运行时 wheel 包。它把普通 `dsh` CLI（命令行界面）及其封闭的 Node 依赖树打包成原生可执行程序，因此使用 SDK 不需要系统 Node.js。本包只发布 wheel 包。

## 安装命令与产物

wheel 包会安装 `dsh` 控制台命令和 `deepseek_harness_runtime` Python 模块。`dsh` 将参数转发给内置可执行程序，并要求非空 `DSH_HOME`；它不会回退到 `~/.dsh`。

生产可执行程序位于模块的 `runtime/` 目录，命名为 `deepseek-harness-sdk-runtime-<platform>-<arch>`；Windows 使用 `.exe` 后缀。Linux 与 macOS wheel 包含目标平台原生的 `-rg` 伴随程序，Windows 包含 `-rg.exe`，macOS 还包含 `node-pty` 使用的 `-spawn-helper`。已发布目标是 Linux x64、Linux arm64、macOS arm64、macOS x64 与 Windows x64。wheel 包标签必须与载荷严格匹配；不发布 Windows arm64 wheel 包。

wheel 仅携带可执行程序、原生执行辅助程序，以及包含 `downloads.json` 和轻量 `office-skills/` 目录的 `<platform>-<arch>/`。CPython、创作库、独立 Node、pnpm 和完整 Office sidecar 均为可选下载资源。导入 Python 模块、启动 SDK profile 和处理 Office 文件都不会下载资源。

使用前显式下载所需的任一种资源：

```py
from deepseek_harness_runtime import download_office, download_primary_runtime

office = download_office()
primary_runtime = download_primary_runtime()
```

`download_office()` 下载锁定版本的 npm Kit、目标引擎及完整依赖树，并准备运行 Kit CLI 的独立 Node。`download_primary_runtime()` 独立下载 CPython、锁定的 Python 库、Node、pnpm 和 Office skills。两者返回绝对资源目录，并复用完整缓存。创作下载会在返回前校验目标平台、解释器、库目录与 skills。现有本地 `installPrimaryRuntime()` 操作仍只复制已有载荷，不执行下载。 共享构建器采用 [NumPy/pandas 测试文件裁剪规则](../../apps/desktop/README.zh.md#bundled-workspace-dependencies)。

`DSH_RESOURCE_CACHE` 指定绝对缓存根目录，默认为 `~/.cache/deepseek-harness/resources`。资源身份包含发布版本锁定的输入。下载会校验归档哈希和包身份、保留执行权限，并原子发布完整目录。下载失败后可重试。`DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS` 限制每个归档的下载耗时，包含响应内容；默认值为 `300000`，接受 `1` 到 `2147483647` 的整数。下载遵循 Harness 代理环境策略。已安装的 wheel 文件不会被修改。不同发布版本使用独立缓存目录；不再使用的版本需手动删除。下载使用锁定的上游 URL，不提供 registry 或镜像覆盖。

后续启动时，打包 bootstrap 将已下载资源提供给 SDK profile。`DSH_PRIMARY_RUNTIME` 覆盖缓存中的创作环境；空值禁用其查询和包管理器选择。`DSH_OFFICE_SIDECAR` 可选择包含独立 Node 的绝对 sidecar 目录。用户可自行提供 Python 环境和文档库，无需下载创作环境。选择任一种资源即可使用 Office skills；仅有创作环境时，skills 中的 Kit CLI 被禁用。外部创作载荷保留 `primary-runtime/` 及同级 `office-skills/` 布局。SDK 原位读取资源，不复制到 `DSH_HOME`。`sdk-minimal` profile 不挂载这些提供方。

选择 skills 与交付资源相互独立：项目、自定义目录和用户文件系统 skills 优先于同名随包 skills。SDK patch 可以仅禁用 Office 提供方，同时保留 Python 查询：

```yaml
- id: skill-office
  disabled: true
```

Office 操作技能通过 profile 的 shell 命令调用配置的 Node 和 Kit CLI。命令选择及替换技能集合的方式见 [Office 提供方](../../packages/skill/skill-office/README.zh.md#use-this-package)。配置 patch 在进程启动时生效；切换技能无需重建 runtime wheel 或 Python 环境。

仓库构建还会物化仅限开发的 `runtime/node/` 载体。它在系统 Node 24.9 或更高版本上运行 `node runtime/node/runtime-bootstrap.mjs`。系统不会自动选择它，而且 wheel 包与 sdist 均不包含它。

两种载体执行相同的 `dsh` 语法与随附 profile，包括独立的 `sdk-minimal` 配置树，以及包含前端产物的完整 `web` profile。私有 `dsh-python-runtime-closure` manifest（元数据清单）定义打包依赖闭包；不存在 Python 专用 Node 应用或检入的默认 `cordis.yml`。

## Python 模块 API

- `bundled_package_dir() -> Path` 返回已安装模块数据根目录，并校验发布元数据。
- `bundled_runtime_path() -> Path` 返回当前平台可执行程序，并校验必需伴随文件。
- `resolve_bundled_launch_args(mode=None) -> tuple[str, ...]` 默认返回可执行程序 argv。显式 `mode="node"` 或 `DSH_RUNTIME_MODE=node` 会选择仅限仓库使用的 Node 载体。
- `download_office() -> Path` 显式下载或复用 Office sidecar 及其独立 Node。
- `download_primary_runtime() -> Path` 显式下载或复用创作环境。
- `resolve_office_launch_args() -> tuple[str, str]` 定位已安装的 Node 和 Kit CLI，不执行下载；资源缺失时抛出含下载指令的 `FileNotFoundError`。
- `main()` 实现已安装的 `dsh` 控制台命令，并拒绝缺失或空白的 `DSH_HOME`。在 Windows 上，它让打包进程继承标准流，等待其结束并转发退出状态；在 POSIX 上，它替换 Python 进程。

不支持的平台以及缺失的可执行程序或伴随文件会抛出 `FileNotFoundError`，并指出构建与安装路径。未知运行时模式会抛出 `ValueError`。

## 打包后的 profile 解析

`dsh` 在显式指定的主目录下初始化随附 profile、组合其 bundle patch，并从可执行程序的虚拟文件系统加载内置插件。运行时解析使用内存中的 generation，不创建磁盘符号链接或代理包。fallback 导入使用记录的声明包路径，包括可执行程序虚拟文件系统内的路径，因此内置配置项与外部插件 peer 共享内置的 Cordis／模块实例。原生共享库与 Windows ConPTY addon 会同其他原生 addon 一起打包；ripgrep 与 macOS PTY helper 仍是可执行伴随程序。

Python 与打包的 bootstrap 共享资源布局：`<cache>/<identity>/office/`、`node/bin/node[.exe]` 与 `node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js`。自动发现 Office 缓存要求 `complete` 标记匹配清单 identity；显式 `DSH_OFFICE_SIDECAR` 要求 Node 与 CLI 文件存在。Python bootstrap 从显式下载或选择的 sidecar 解析 Office kit，让原生辅助程序与 URL Worker 使用真实文件系统路径。仓库构建与显式 Python 下载共用资源准备实现。kit 负责文档操作；Office smoke 从已加载技能获取 CLI 路径，并在空 PATH 下执行 capabilities 和 DOCX 转换。

外部 profile 管理使用 `dsh plugin --profile <name> ...`。显式调用 `download_primary_runtime()` 准备资源后，打包启动器会将所选载荷的独立 Node 和 pnpm 提供给该命令及 SDK `plugin_manager` 工具。独立 Node 目录仅加入包操作子进程（包括构建脚本）的环境；普通工具保留原有 `PATH`。`DSH_PRIMARY_RUNTIME` 覆盖缓存选择，空值禁用它。所选载荷格式错误或不完整时启动失败，不会静默改用系统 pnpm。没有选中包含 Node/pnpm 的载荷时，包操作使用 `PATH` 中的 pnpm 或显式 `plugin-manager.pnpmCommand`。不会隐式触发下载。普通 SDK／profile 运行及列举/切换现有插件不需要 pnpm。每个面向模型的管理操作仍要求完整权限或客户端审批应答方；保存的变更影响后续启动使用的共享 SDK profile。

## 构建与分发

生产部署允许工作区中不属于运行时闭包的补丁保持未使用；闭包内包的补丁仍必须成功应用。此例外仅用于部署命令，仓库安装仍拒绝未使用的补丁。

在仓库根目录运行 `pnpm exec tsx scripts/build-exe-for-python-sdk.ts`，会校验闭包、构建包、部署无符号链接的文件树、打包所选目标，并把可执行程序及伴随文件同步到本模块。可执行文件使用 Brotli 压缩存储内嵌文件。打包时只保留目标平台的 PTY 预构建文件，并排除运行时资源目录之外的包内 README、CHANGELOG、HISTORY Markdown 文档、source map 和 TypeScript 声明。部署会关闭工作区提升，打包时还会排除部署目录之外的检出依赖和工作区源码树，防止依赖扫描把开发包加入载荷。暂存步骤让使用相同 pnpm 依赖标识的嵌套消费者共享根目录的工作区包，保留服务单例，同时保留不同的对等依赖解析。`scripts/build-python-release.py` 按仓库根版本暂存发布形态的 wheel 包，并将 `deepseek-harness-sdk` 固定到完全相同的运行时版本。

已安装 wheel 包冒烟测试会在检出目录外创建干净的虚拟环境，验证分发物与可执行程序的来源，然后覆盖默认及自定义 SDK profile、外部插件、MCP、原生工具、直接 JSON-RPC、检入快照，以及可信运行中的真实提供方。Office 场景会迁移轻量目标载荷、显式下载 sidecar，并使用所需的平台引擎转换 DOCX：使用目标已声明的原生引擎，未声明原生引擎时使用 WASM。另见 [Python 贡献者工作流](../development.zh.md) 与 [installed-wheel 测试决策](../../.agents/notes/implemented/testing/2026-08-23-installed-python-wheel-black-box-ci.zh.md)。
