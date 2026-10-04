# Agent Note: Desktop 安装的 CLI 运行时

Status: implemented
Archived: 2026-09-30

[English](2026-09-27-desktop-cli-runtime.md) | 中文

## 问题

Desktop 已包含 dsh 及其生产依赖。用户需要在终端中管理插件并使用其他 CLI（命令行界面）功能，无需维护另一份安装。

## 决策

macOS 的 shell 脚本与 Windows 的命令脚本使用已安装 Electron 的 Node 模式运行私有 Desktop CLI 入口。该入口委托给普通 CLI 分派器，通过包操作选项提供内置 pnpm。Desktop Host 启动与 ASAR 打包保留现有行为。

Desktop 内置命令可在应用退出时管理已初始化的 `desktop` profile。它与现有插件操作使用相同的 profile 写锁、包兼容性检查和协调逻辑。Desktop 拥有 profile 初始化流程；CLI 拒绝将缺失的 Desktop profile 初始化为普通 CLI profile。npm 安装的 dsh 不能管理此保留 profile，两种 CLI 都不会启动它。

Windows 通过 Koffi 注册控制台回调，将 SIGINT 和 SIGBREAK 送到 CLI 的 JavaScript 监听器以完成异步退出。Electron 原生默认行为会在这些监听器运行前退出。现有 Office 引擎解析器为 Web 附件转换提供物理路径；CLI profile 启动不注入 Office 创作 skill（技能）的配置。

## 影响

用户须在更新或卸载 Desktop 前结束 CLI 命令。安装程序不与 CLI 进程协调，也不为运行中的命令保留多个运行时版本。重叠的更新可能中断命令，或使其运行时文件不可用。

命令的运行时版本随 Desktop 变化。[Electron 运行时决策](../architecture/2026-09-11-desktop-electron-node-runtime.zh.md)说明 Electron/OpenSSL 与第三方原生 addon 的限制。Desktop 现有 Office 资源保持不变；CLI 不会自动向用户启用的插件提供创作资源路径。

## 命令注册

固定的**管理 dsh 命令…**菜单显示状态，并提供安装、修复和移除操作。macOS 使用固定的 `/usr/local/bin/dsh` 链接，必要时请求管理员认证，不修改 shell 启动文件。Windows 将专门存放公开启动器的目录注册到当前用户的 PATH。注册与移除是应用安装后的可选菜单操作，安装程序和卸载程序不执行这些操作。私有安装辅助程序不在这个 PATH 目录中。

切换已有命令需要确认。执行器重新核对展示过的指纹，并在移走命令时一直使用该次观察到的条目；并发替换的命令会被保留。所有权记录保存之前的 macOS 启动器。若其他安装在重新安装前替换了 Desktop 链接，旧备份会保留并报告；移除操作只恢复当前所有权记录中的备份。Windows 插入一个自有 PATH 条目，并记录此前完全相同条目的数量，移除时保留它们。其他命令位置只展示，不修改。并发对话框共享一个操作，更新准备会等待该操作完成。

macOS worker 以 JSON 响应报告操作失败，同时以成功状态退出进程，使 AppleScript 保留错误码和消息。取消管理员认证会结束操作，不显示错误对话框。Windows 将无效 PATH 条目视为不可用候选并保留其文本；环境变更通知不会改变已经提交的注册表写入结果。

## 考虑过的替代方案

**再次通过 npm 安装。** 这会重复依赖，并可能偏离 Desktop 的运行时。

**CLI 使用独立 Node。** 普通 Node 无法加载现有 ASAR 依赖树。移动或复制该树会扩大打包改动。

**将命令转发给运行中的 Desktop Host。** 这要求 GUI 保持运行，并增加运行中插件的生命周期集成。直接包操作支持文档约定的退出后重新打开流程。

**协调每个 CLI 进程与更新。** 原生启动锁和安装程序交接记录增加了初始命令集成以外的生命周期行为。CLI 使用应用现有的更新策略。
