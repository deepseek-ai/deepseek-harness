# Agent Note: 在工具调用中用系统应用打开文件

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-tool-call-file-open-in-os.md) | 中文

## 问题

聊天工具行把整行摘要当作点击目标，点击后打开右侧 details 面板，并带有整行悬停背景。对文件系统工具而言，有用的动作是用操作系统默认应用打开所涉文件，而不是在侧栏里查看原始工具载荷。

## 决策

文件工具的路径摘要（`read`／`write`／`edit` 参数中的 `path` 或 `file_path`）渲染为静止状态下即带下划线的链接，并使用 pointer 光标。点击路径会经聊天视图的 `openFile` injection 调用 `session/openWorkspacePath`；聊天视图会在目标 Session 的 cwd 已知时据此解析相对路径。带文件链接的行关闭参数展开（左侧图标不可点）；工具行（含 bash 与 todo 注册）去掉整行点击、整行悬停底色，以及点击打开 details 的手势。details 面板及其 inject 面仍保留供程序化选择；工具行不再驱动它们。

`session/openWorkspacePath` 使用经过认证的 Remote carrier，而产品 UI 只在 loopback 页面且 `session/canOpenWorkspacePath` 结果为 true 时提供该手势。平台适配器不经 shell 打开：macOS 为 `open`，Windows 为 PowerShell `Invoke-Item`，桌面 Linux 为 `xdg-open`；浏览器可渲染的文档会在 macOS 与桌面 Linux 上优先使用指定的默认浏览器。尽管 Node 将 WSL 报告为 `linux`，WSL 仍是一种独立的宿主形态：适配器根据其环境或 Microsoft 内核 release 识别它，用 `wslpath -w` 转换 Linux 路径，并将所得 Windows/UNC 路径交给同一 PowerShell 交接。打开器的平台信息和命令运行器可在测试中注入。仅含 URL 的 read 参数（`web_fetch`）不是文件链接。

## 考虑过的替代方案

- 保留整行点击打开 details，另加文件入口 — 否决；产品要求用文件链接替换整行手势。
- 在应用内预览文件 — 否决；要求是操作系统默认应用。
- 将 WSL 当作桌面 Linux — 否决；WSL 进程报告 `linux`，但 Linux 桌面文件关联并非必有，而其常规用户桌面和浏览器位于 Windows 上。
- 复用 `host.pickDirectory` 的超时豁免 — 不必要；打开路径的交接在常规一元截止时间内即可完成。

## 后果

点击工具行中的文件路径会在宿主上打开该路径。非文件工具行只是不可交互的摘要（行内已有的展开开关仍保留）。Client 在非 loopback 页面不提供文件打开手势；每次已暴露的 Host 调用仍要求浏览器会话。Host 或操作系统拒绝由聊天视图拥有：它展示抛出的原因，并对同一路径提供重试（[打开失败](../bug-fix/2026-08-18-tool-row-file-open-failure.zh.md)）。

## 风险

- 没有 `xdg-open` 的桌面 Linux 宿主，以及 Windows 互操作（`wslpath` 加 `powershell.exe`）不可用的 WSL 宿主，会使 RPC 失败；聊天视图展示该 Host 错误并提供重试。
- 没有会话 cwd 时相对路径会原样转发，可能在宿主侧失败。
