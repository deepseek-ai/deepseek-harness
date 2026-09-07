# Agent Note: `dsh web` 打开已就绪页面

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-open-ready-web-ui.md) | 中文

## Problem

`dsh web` 会绑定 HTTP 服务器并打印规范本地 URL，但仍要求用户把 URL 复制到浏览器，尽管根 README 已把该命令描述为会打开 Web UI。浏览器交接也不能只以服务器绑定回调为时机：API 路由、浏览器插件名录和静态回退可能仍在挂载，第一次页面请求可能看到一个尚未完整且即将被进程判定为启动失败的应用。

## Decision

Web 应用的命令提供方为普通调用解析出 `openBrowser: true`，为 `--no-open` 解析出 `false`。组合包把该值传给自己的 `web-runtime` 行；部署仍可显式替换该行的完整配置。运行时在激活期间对继承的 `SSH_CONNECTION` 与 `SSH_TTY` 采样一次，只要其中一项非空就会跳过浏览器交接，因为此时进程提供的是远端宿主机 loopback，而用户的本地转发地址由 SSH 客户端或编辑器持有。

Web 运行时把 URL 打印与浏览器打开作为同一就绪点上的两个独立动作。它等待完整 Loader 配置树结算，并确认 `webServer` 仍在线，然后打印已配置的 URL 行；非 SSH 环境下还会在把规范 loopback URL 交给操作系统默认浏览器之前立即打印英文提示 `dsh web: opening the default browser; pass --no-open to disable`。SSH 启动会保留宿主机 URL 行，以便操作者识别远端端口，但进程无法推导或打开转发持有方的本地地址。部署显式绑定所有网络接口时，本机仍打开 loopback，打印出的 LAN URL 只用于告知；CLI 会拒绝 `--host 0.0.0.0`。`openBrowser` 与 `printUrl` 可以分别关闭。

交接使用维护中的 `open` 包处理 macOS、Windows、Linux、容器和 WSL。一个短生命周期 Node helper 使用规范的脱敏子进程环境调用该包，因此 Harness 凭据和 `DSH_*` 状态不会进入操作系统启动器或新启动的浏览器。`BROWSER` 是只能来自启动环境的命令选择器：应用启动过程会拒绝被发现的 `.env` 中的该变量，只有继承值才能抵达会读取该变量的兼容 opener 路径。在 Windows 上，helper 会等待短生命周期 PowerShell launcher 退出，因为 `open` 会在该进程 spawn 时、尚未把 URL 交给 shell 之前返回；其他平台则在 opener 接受 spawn 后结束。运行时绝不等待浏览器退出。父进程会读取 helper stderr，因此失败时只向 stderr 写入一条包含具体原因和手动访问 URL 的英文诊断，不会 dispose 已就绪的服务器；浏览器之后退出不属于本次交接结果。

单元覆盖钉住命令默认值、`--no-open`、SSH 抑制、就绪顺序、资源释放与失败抑制、helper 结果、stderr 原因传播、Windows launcher 生命周期、helper 的脱敏环境、`BROWSER` 仅可继承的规则、交接前 opt-out 提示以及包含原因的非致命诊断。真实 Loader 组合会绑定由操作系统分配的端口、提供实际静态回退，只替换操作系统交接，并立即请求被交接的 URL，以证明页面此时已可访问。无密钥的整体快照会分别在本机环境、opener 失败环境、带 VS Code 与 SSH 标记的环境，以及声明了 `BROWSER` 的项目中运行构建后的 `dsh web` 命令：本机用例验证被交接的页面就是打印出的、已可访问且包含启动清单的页面，同时 opener 中不存在凭据与 Harness 状态变量；失败用例验证就绪后的 stderr 原因和手动 URL；远端用例验证宿主机 URL 仍可见，但不会启动浏览器；文件层命令用例则在就绪或交接前失败。仓库内浏览器与打包测试会传入 `--no-open`，因为它们自行持有浏览器或在无人值守环境运行。

## Alternatives considered

**从 CLI 启动器打开** — 否决，因为启动器刻意只了解 profile 选择，无法取得操作系统分配的端口或应用自有的 Loader 结算点；让它了解这些事实会推翻应用自有命令行决策。

**在 `dsh-host-webserver` 绑定 socket 时打开** — 否决，因为该包是不了解 shell 与前端的通用路由载体，而且 socket 就绪早于应用就绪。

**根据 TTY、CI、编辑器、显示、容器或 WSL 环境变量推断是否打开** — 否决，因为这些信号不能证明宿主机与浏览器分离，并会误判分离终端和桌面启动。非空的 `SSH_CONNECTION` 或 `SSH_TTY` 是更窄的证据：它表明远端宿主机 loopback URL 并不是转发持有方的本地 URL。非 SSH 启动仍保持默认打开并提供显式 `--no-open`。

**打开浏览器前要求按下 Enter** — 不作为本机默认行为，因为它会把普通服务器启动变成由 stdin 持有的第二次交互，并排除没有可用终端的桌面启动或受监督启动。调用方自行持有浏览器或只需要服务器时，仍通过 `--no-open` 显式退出。

**手写各平台命令** — 否决，因为 URL 打开在 macOS、Windows、Linux、容器和 WSL 上各有不同。维护中的依赖持有这些平台分支，本包只保留就绪与失败语义。

## Consequences

普通的本机 `dsh web` 调用会先公告自动交接及其 `--no-open` 退出方式，再打开一个已就绪的页面，同时不会让通用 HTTP 载体感知桌面环境，也不会向桌面启动器暴露环境凭据。SSH 调用会打印远端宿主机 URL，但由 SSH 客户端或编辑器负责打开转发后的本地地址。被发现的 `.env` 如果设置 `BROWSER`，启动就会失败，而不是选择一个可执行文件；会读取该变量的平台 opener 只有在操作者从启动 shell 中 export 时才能取得它。其他无人值守消费方必须传入 `--no-open`；交接失败时会向 stderr 写入原因与手动访问 URL，同时保留可用服务器。Web 应用新增锁定的 `open` 依赖、共享子进程环境脱敏器及 opener 的传递平台辅助包；操作系统交接成功后，本应用不持有、不等待也不终止浏览器。
