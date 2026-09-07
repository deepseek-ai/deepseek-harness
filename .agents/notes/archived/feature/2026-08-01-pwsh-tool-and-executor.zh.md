# Agent Note: PowerShell 执行器与 pwsh 工具

Status: implemented
Archived: 2026-09-04

[English](2026-08-01-pwsh-tool-and-executor.md) | 中文

## 问题

harness 在每个平台只说一种 shell 方言：`bash`。Windows 主机只能通过 WSL 或 Git-Bash 垫片运行它，而交付的 `dsh-bash-local` 执行器仅限 POSIX（硬编码 `bash`，进程组语义是 POSIX 的）。Windows 路线图——让主机默认 `pwsh`，之后再做 pwsh TUI/GUI 渲染——没有执行基础：既没有 bash 执行器 seam 的 PowerShell 实现，也没有教模型 PowerShell 方言的面向模型工具。bash 工具也大于 Windows 优先画像的严格所需——尤其持久 PTY 孪生是 `pwsh` 工具至今仍不背负的 bash 形状表面。最初的最小画像也没有后台任务与沙箱升级：后台随 [parity 决策](2026-08-02-pwsh-tool-bash-parity.zh.md) 到来，沙箱面（拒绝渲染加 `sandbox_permissions` 升级）随 [Windows ACL sandbox 决策](2026-08-08-windows-acl-restricted-token-sandbox.zh.md) 到来——最小工具当初按 danger-full-access 的 Windows 姿态裁剪，这一前提在 sandbox PR（Pull Request）于 Windows 上重新启用隔离与审批时终结。

## 决策

在 `packages/shell/` 下新增两个包：

- **`@deepseek-ai/dsh-pwsh-local`** —— `ctx.shell` 执行器 seam 的本地实现，基于 `ctx.subprocess`，逐调用镜像 `dsh-bash-local`：`resolve()` 从配置默认化并设上限，`run()` 通过一个 deadline 融合配置夹取的超时与调用方信号，`start()` 返回消费式后台句柄，其进程归属于 subprocess 服务。命令字符串作为单个 argv 参数传给 `pwsh -NoLogo -NoProfile -NonInteractive -Command`，由 PowerShell 解析，不存在 shell 引号层。可执行文件解析（`resolvePwshPath`）是 `(configured, env, platform)` 的纯函数：先显式配置，再在 Windows 上探测 PowerShell 7 安装位置、PATH 条目（剥离引号）与 Windows PowerShell 5.1，否则返回裸命令名 `pwsh`，交由进程启动时按 PATH 解析。
- **`@deepseek-ai/dsh-tool-pwsh`** —— 基于 `ctx.shell` 的面向模型工具，约定是 PowerShell 方言，逐调用镜像 `dsh-tool-bash`：经通用任务运行时执行前台与 `run_in_background`，经共享 [`dsh-shell-env`](../feature/2026-08-02-pwsh-tool-bash-parity.zh.md) 注册表管理 `DSH_*` 环境，bash 的 marker/截断渲染机制（干净退出不产生 marker），以及——自 Windows ACL sandbox 决策以来——沙箱拒绝渲染与 `sandbox_permissions` 升级面，外加工具描述中的 Windows 专属 ConstrainedLanguage 与命名管道约定。parity 决策取代了本 Agent Note 的最小画像工具描述。

Windows vitest 覆盖率刻意不属本次改动：仓库的 Windows CI 通道负责构建/静态门禁，单元覆盖在 Linux 上运行，两个包的套件在那里以真实 `pwsh` 运行（GitHub 托管 runner 预装）或缺失时自行跳过。vitest 的 `windowsUnsupportedPackages` 排除从 `packages/shell/*` 收窄为真正需要 bash 的包，使 pwsh 套件也能在 Windows 开发机上原生运行。

本决策之后的路线图——让 Windows 主机默认 `pwsh`（关闭 bash）与 pwsh TUI/GUI 渲染——已另行记录为 [Windows 默认 pwsh 决策](2026-08-01-windows-pwsh-default.zh.md)。

## 备选方案

**给 `dsh-bash-local` 增加 pwsh 模式。** 否决：执行器的身份就是它 spawn 的 shell；在一个包内塞第二种方言会翻倍配置面（`shell` 开关）与测试矩阵，且两种方言的怪癖（Windows 上的信号信息、引号域）应各自归入自己包的文档。

**给 `dsh-tool-bash` 增加方言参数。** 否决：模型可见约定本身就是方言（路径、变量、退出事实都不同），因此方言参数要么让 schema 随条件变化，要么逼一个工具教两种方言；独立的孪生让模型约定保持诚实——并以镜像而非共享实现的方式携带共享表面（后台、沙箱、渲染）。

**现在就接入交付的 CLI（命令行界面）组合。** 否决：在 Windows 默认决策落地前把 `tool-pwsh` + `pwsh-local` 挂进 `base.cordis.yml` 会改变交付清单；本改动交付能力与接线点（`apps/cli` 依赖、tsconfig 工程），不切换任何默认。

## 后果

- bash 执行器 seam 有了第二个、Windows 原生的实现，请求/规范约定一致，因此 `tool-pwsh` 之外的面向模型消费方（钩子桥、进程内插件）无需方言垫片即可运行 PowerShell。
- `tool-pwsh` 是模型可见的 Windows 优先 shell 工具：在前台、后台与沙箱化工作上与 bash 工具行为可互换——包括经 `ctx.approval` 的同轮次 `sandbox_permissions` 升级——提示词指导精确陈述 marker 约定、沙箱拒绝/升级词汇，以及 ConstrainedLanguage 与命名管道边界。
- Windows 语义在平台差异处不同：强制终止报告退出码 1 且无信号（因此 `signal`/`killed` 状态信息仅限 POSIX），PowerShell 输出 CRLF，测试做归一化。
- CLI 增加两个 workspace 依赖与两个 tsconfig 工程，但不挂载任一插件——组合决策留给 Windows 默认提案。
