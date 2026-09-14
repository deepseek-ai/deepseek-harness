---
description: "用户交互式终端：执行环境默认 shell、有界屏幕恢复和类型化 Remote 控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-terminal-controller

[English](README.md) | 中文

## 概述

从 Web 侧栏在会话工作区打开执行环境的默认 shell。重新连接已有进程，并关闭 provider 管理的完整进程范围。终端输出不进入 Agent 对话记录。保留终端会占用进程和有界屏幕缓存。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Web bundle 将此包与 subprocess provider、sandbox policy 和 Typert Gateway 一起挂载。`remote.terminal` 提供 `environment`、`shells`、`list`、`create`、`follow`、`write`、`resize`、`rename` 和 `close`；每个操作均按 Session 标识限定范围。列表直接读取 Host 保留的终端，因此查看离线 Session 不会激活 Agent，也不会产生恢复错误。

Shell 探测结果首先列出执行环境声明的默认 shell。仅当 provider 未声明默认值时，才在 POSIX 使用 `/bin/sh`，在 Windows 使用 `cmd.exe`。可选的 `shell` profile 通过可执行路径 `path`、显示名称 `name` 和参数 `args`（默认 `[]`）覆盖这一选择。选择器还会通过执行 provider 探测 `shellCandidates`，仅省略确定未找到的候选。创建请求接受探测返回的 `shellPath` 并再次验证；解析或传输失败会直接报告，不启动其他 shell。环境查询只返回工作目录和限制，不解析 shell，因此默认 shell 不可用时仍可重新连接已有进程。POSIX 自动 profile 以交互模式启动，PowerShell 使用 `-NoLogo`，补全和启动配置仍由 shell 提供。初始目录来自 Session 工作区，终端遵循同一 sandbox policy。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `shell` | 省略 | 使用执行环境默认 shell，或指定一个 profile |
| `shellCandidates` | `zsh`、`bash`、`fish`、`pwsh`、`powershell`、`cmd` | 已安装时供用户选择的额外可执行名称或路径 |
| `maxTerminals` | `8` | 每个 Session 保留的终端和创建请求上限 |
| `maxCols`、`maxRows` | `500`、`200` | PTY 最大尺寸 |
| `scrollback` | `1000` | 屏幕历史行数 |
| `maxBufferedBytes` | `2097152` | 单个订阅者的输出排队上限 |
| `maxInputBytes` | `65536` | 单次输入请求的字节上限 |
| `disposeGraceMs` | `1000` | provider 终止宽限期，单位毫秒 |

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

Host 通过 `ctx.subprocess.spawnTerminal` 创建 `TERM=xterm-256color` 的终端，不启动桌面终端应用。流式 UTF-8 解码保留跨块字符和开头的 BOM，并在 EOF 将不完整的尾部字节替换为替代字符。控制请求走 Gateway，`follow` 使用其复用的 Remote stream。Headless xterm 和序列化 addon 在此前输出写入后生成初始屏幕，后续增量携带单调序号。过慢的订阅者明确失败；重新连接恢复当前屏幕。

最新连接持有输入和尺寸控制权。断开连接只释放输入权，不结束进程。显式关闭等待进程清理和最后输出；清理失败时保留资源以便重试。Session 记住已关闭的标识并拒绝迟到或重复的创建请求，包括关闭到达时仍在进行的创建。新终端使用新标识。取消创建且清理失败时，已分配的进程仍有所有者。Session owner 和 controller 卸载也会终止所拥有的进程。存在终端或创建请求时不能改变该 Session 的 sandbox mode。 控制权转移或进程退出后被拒绝的输入和尺寸请求保留输出连接并禁用输入，不重发被拒绝的输入。

Client 视图只在内存中关联侧栏标签页与终端标识。恢复操作查询 Host 保留的终端；新视图可以创建进程，恢复视图在目标缺失时显示错误，不创建替代进程。Client 模型在浏览器完成屏幕解析后确认帧，按序发送输入，并忽略旧连接迟到的响应。 Client 自产错误携带本地化键。插件卸载等待活跃及先前断开的输出流结束，不关闭 Host 进程。

新视图等待用户选择 shell 并启动。上次选择的 shell 路径保存在当前站点 localStorage 的 `dsh.terminal.shell` 中。仅当 Host 探测仍列出该路径时才预选它，否则选择当前默认项。存储失败不影响启动。恢复已有终端既不读取这一偏好，也不探测 shell。

关闭时先保存未完成的清理请求并释放标签页，再在后台等待 Host 清理。失败时提供重试通知。每个请求使用独立的终端 ID localStorage key，清理成功或收到明确的 `session/not-found` 响应后删除；启动时重试已保存的请求。传输失败时保留请求。保存的是清理意图，不是侧栏布局、打开标签页映射、选中标签页或进程 PID。浏览器存储不可用时，内存中的清理仍可工作，但刷新后无法恢复该请求。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Subprocess](../../subprocess/subprocess/README.zh.md)
- [Right Sidebar](../../client/ui-sidebar-right/README.zh.md)
- [Web terminal decision](../../../.agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.zh.md)

<a id="model-experience"></a>
## 模型体验

无；此包只处理用户交互式终端，不向模型请求添加内容。

#### KV 缓存影响

无；终端输出只在浏览器与 Host 之间传输。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器刷新保留进程和屏幕；Host 或 Session owner 卸载不保留。不提供持久终端恢复或自动重启 shell。 已退出的终端仍计入 `maxTerminals`；关闭不用的标签页可释放其屏幕和名额。
- 原生 PTY 可用性和进程树清理保证由 subprocess provider 决定。找到可执行文件并不保证 PTY 分配成功。
- 屏幕恢复只保留有界历史，不保留完整记录。同一时刻只有一个连接可输入或调整尺寸。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

不发布运行时 invariant companion。终端元数据与屏幕更新由同一对象按序写入，没有独立的进程尺寸观测可供比较。

</details>
