---
description: "用户交互式终端：执行环境默认 shell、有界屏幕恢复和类型化 Remote 控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-terminal-controller

[English](README.md) | 中文

## 概述

从 Web 侧栏在 Session 当前工作目录打开执行环境的默认 shell。重新连接已有进程，并关闭 provider 管理的完整进程范围。Agent 工具也能在这里打开终端：终端以侧栏标签出现，在 Session 沙箱策略下启动，人在其中第一次输入时即转由人控制。控制器本身不产生模型输入，Agent 能读到什么由工具包决定。保留终端会占用进程和有界屏幕缓存。

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

Web bundle 将此包与 subprocess provider、working-directory 服务、sandbox policy 和 Typert Gateway 一起挂载。`remote.terminal` 提供 `environment`、`shells`、`list`、`watch`、`create`、`retain`、`attach`、`rename` 和 `close`；每个操作均按 Session 标识限定范围。列表直接读取 Host 保留的终端，因此查看离线 Session 不会激活 Agent，也不会产生恢复错误。`watch` 在终端创建、移除以及每次状态发布后，以完整集合推送同一列表。

Shell 探测结果首先列出执行环境声明的默认 shell。仅当 provider 未声明默认值时，才在 POSIX 使用 `/bin/sh`，在 Windows 使用 `cmd.exe`。可选的 `shell` profile 通过可执行路径 `path`、显示名称 `name` 和参数 `args`（默认 `[]`）覆盖这一选择。选择器还会通过执行 provider 探测 `shellCandidates`，并省略确定未找到的候选。同一可执行文件名（不区分大小写，忽略 `.exe`）只列出最早的一项，因为 PATH 查找可能经由其他目录找到默认 shell，例如 merged-`/usr` 系统上 `/bin/bash` 对应的 `/usr/bin/bash`。创建请求接受探测返回的 `shellPath` 并再次验证；解析或传输失败会直接报告，不启动其他 shell。环境查询读取当前目录和限制，不校验文件系统或解析 shell，因此目录或默认 shell 不可用时仍可重新连接已有进程。POSIX 自动 profile 以交互模式启动，PowerShell 使用 `-NoLogo`，补全和启动配置仍由 shell 提供。新终端启动前通过[工作目录服务](../../session/working-directory/README.zh.md)校验当前目录，并采用该服务的恢复行为。已有终端保留其进程目录。用户终端使用执行环境中系统用户的权限，独立于 Agent 的沙箱模式和审批策略。操作系统和容器的限制仍然生效；DSH 不提升用户权限。Subprocess provider 继续清除环境中的凭据变量。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `shell` | 省略 | 使用执行环境默认 shell，或指定一个 profile |
| `shellCandidates` | `zsh`、`bash`、`fish`、`pwsh`、`powershell`、`cmd` | 已安装时供用户选择的额外可执行名称或路径 |
| `maxTerminals` | `8` | 每个 Session 保留的终端和创建请求上限 |
| `maxAgentTerminals` | `4` | 每个 Session 中由 Agent 控制且仍在运行的终端和 Agent 创建请求上限；`maxTerminals` 仍限制全部终端，包括已退出的终端和等待清理的失败分配 |
| `maxCols`、`maxRows` | `500`、`200` | PTY 最大尺寸 |
| `scrollback` | `1000` | 屏幕历史行数 |
| `maxBufferedBytes` | `2097152` | 单个订阅者输出及 Client 输入帧的缓存上限 |
| `maxInputBytes` | `65536` | 每条输入命令及 Client 未确认输入总量的原始 UTF-8 字节上限 |
| `disposeGraceMs` | `1000` | provider 终止宽限期，单位毫秒 |
| `unattendedTimeoutMs` | `7200000` | 无窗口持有且持续确认空闲后开始清理的时长；`0` 禁用自动回收 |
| `activityPollIntervalMs` | `30000` | 无窗口持有时的活动观察间隔 |
| `cleanupRetryMs` | `60000` | 清理失败后的重试间隔 |

任何已连接窗口中的打开标签页都会持有其终端，包括隐藏标签和非当前 Session。最后一个持有关系消失后，只有明确确认空闲的时间才计入回收期限。运行中、停止、等待输入和后台执行的任务都会受到保护；活动状态未知时清除空闲截止时间。任务完成后重新给予完整宽限期。Host 使用单调时钟，在清理前重新检查持有关系和当前活动；观察间隔超过轮询周期的两倍时丢弃旧证据。时间字段使用毫秒和安全整数，轮询及重试间隔必须为正数。

### Agent 终端

Host 代码通过 `openForAgent(agent, request, signal)` 为 Session 的 Agent 打开终端。调用方传入它为该 Session 解析出的沙箱策略：`danger-full-access` 直接启动 shell，受限模式通过执行环境的 `ctx.sandbox` provider 包裹 shell，缺少 provider 时在分配前失败。受限的 POSIX shell 不会读写人的历史文件，因为它不在可写目录内：`workspace-write` 下的 shell 把历史保存在 `/tmp/dsh-agent-history-<id>`，shell 结束后由控制器删除；`read-only` 下的 shell 得到空的 `HISTFILE`，不保存历史。`preferredShells` 列出在已探测 shell 中优先尝试的可执行文件，之后才用默认 shell；`env` 向 shell 环境添加变量，但不能替换 `DSH_SESSION_ID`，也不能替换受限 POSIX shell 的 `HISTFILE`；不受限的 shell 沿用继承的 `HISTFILE`，除非 `env` 另行设置。终端记录 `origin: 'agent'`、`control: 'agent'` 和 `sandboxMode`；它计入 `maxTerminals`，在 Agent 控制且仍在运行期间也计入 `maxAgentTerminals`。标题去掉首尾空白后必须为 1–120 个字符。

返回的 `AgentTerminal` 提供顶层进程 id，可以写入输入、把屏幕渲染为文本、标记屏幕位置以便之后渲染新输出、等待输出或状态变化、查询并向前台进程组发信号，以及关闭终端。它的读屏和标记是同步的，只看到已处理的输出；`drain` 会等到调用前收到的输出处理完。Agent 输入既不需要也不抢占 Web 的输入控制权。浏览器第一次发出标记为 `typed` 的写入后，控制权转给人；此后写入、发信号和关闭都会以 `AgentTerminalError` 的 `user-control` 代码失败，读取不受影响。控制器的 `readScreen` 会先等输出处理完再渲染；它和 `inspectActivity` 可读取 Agent 所在 Session 的任意终端，包括人自己打开的终端。终端不存在或在读取屏幕前关闭时，`readScreen` 以 `RemoteError` 失败，错误码为 `terminal/unavailable`。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

Host 通过 `ctx.subprocess.spawnTerminal` 创建 `TERM=xterm-256color` 的终端，不启动桌面终端应用。流式 UTF-8 解码保留跨块字符和开头的 BOM，并在 EOF 将不完整的尾部字节替换为替代字符。双工 `attach` Remote 流通过 Gateway mux 传输输出和有序的 `write`/`resize` 命令。每条命令使用附件内连续递增的序号；`ack` 确认提供者已接受操作，或报告控制权拒绝。快照和状态帧携带接收附件的 `writable` 标记。Headless xterm 和序列化 addon 在此前输出写入后生成初始屏幕，后续增量携带单调序号。过慢的订阅者明确失败；重新连接恢复当前屏幕。

Agent 终端复用同一套分配、回滚和保留流程，标识由 Host 生成。Agent 输入与浏览器输入和输出一起排队，但不经过附件的输入控制权。读屏渲染 headless 缓冲区：软换行的行会拼接，备用屏按当前显示读取，分页在调用方给出的字节上限内保留最新内容。屏幕标记把模拟器的 marker 放在光标所在逻辑行的起始行，因此滚动缓冲区截掉标记行时会报告截断。每处理一段输出或发布一次状态，变更版本号就加一，`changed` 据此等待。Client 只在键盘、粘贴、输入法、拖放、指针或触摸操作之后的短时间窗口内把写入标记为 `typed`，因为 xterm.js 通过同一个数据事件报告终端协议应答；焦点上报和滚轮产生的输入一律不标记为 `typed`。

最新连接持有输入和尺寸控制权。断开连接只释放输入权，不结束进程。显式关闭等待进程清理和最后输出；清理失败时保留资源以便重试。Session 记住已关闭的标识并拒绝迟到或重复的创建请求，包括关闭到达时仍在进行的创建。新终端使用新标识。取消创建且清理失败时，已分配的进程仍有所有者。Session owner 和 controller 卸载也会终止所拥有的进程。改变 Session 的沙箱模式时，用户终端继续以原有权限运行。控制权转移或进程退出后被拒绝的输入和尺寸请求保留输出连接并禁用输入，不重发被拒绝的输入。提供者完成时即禁用输入，无须等待输出排空；迟到的输入失败不能丢弃已正常结束的订阅者所保留的尾部帧。

初始快照公布载体的完整帧 `inputWindow`；没有 inbox 限额的进程内载体省略该字段。Client 对输入和尺寸调整都计入 JSON 转义、命令字段及载体封装的开销。未确认帧占满窗口时，命令在本地等待；提供者确认后释放额度。`maxInputBytes` 限制原始 UTF-8 输入，`maxBufferedBytes` 限制全部排队及未确认的编码输入帧。单帧无法容纳于载体窗口或 Client 缓存耗尽时，报告 `inputFull` 并取消附件，不重放排队命令。

Client 在分配前将每条 Session/内容与终端身份的关联保存到独立的 localStorage key `dsh.terminal.binding.v1.*`。内容身份全局唯一；布局内的 tab id 只标识活动视图 occurrence。逐条记录的写入和删除会保留其他窗口的关联。恢复视图复用该身份；侧栏 terminal provider 先恢复自己的视图，再查询尚无视图的 Host 终端。新视图可以创建进程，恢复视图在目标缺失时显示错误，不创建替代进程。显式关闭先保存清理请求，再删除关联。当前进程元数据和屏幕内容由 Host 提供，不保存在浏览器中。Client 模型在浏览器完成屏幕解析后确认帧，在未确认 UTF-8 字节预算内连续发送输入，并忽略旧连接迟到的响应。重连建立新的命令序列，绝不重放未确认输入。提供者输入失败会结束附件；进程和恢复屏幕仍可供显式重连使用。Client 自产错误携带本地化键。插件卸载等待活跃及先前断开的输出流结束，不关闭 Host 进程。

客户端发现状态由当前窗口中的各个 Session 持有。并发及稍后恢复的视图共享一次列表查询，包括空结果；新标识直接通过 `create` 分配终端。显式重试会替换已完成的结果或失败，重连则为每个已经查询过的 Session 刷新一次列表。失败视图重新挂载时保留错误，不会重试。已确认的操作和 attachment 元数据优先于较早发起的列表响应，被替换连接的响应不能发布状态。单个视图释放 DOM 或结束生命周期不会取消其他视图的查询。插件卸载会丢弃缓存元数据并等待未完成的发现请求结束。其他窗口中尚未出现在本窗口的终端可通过显式刷新或重连发现；当前 attachment 自行传递实时元数据。`watch(sessionId, listener)` 在一个窗口内为每个 Session 共享一条终端列表流，并在调用监听者前把每份完整列表应用到共享列表，移除列表中已不存在的终端；`boundTerminal` 读取标签绑定的终端；监听期间失败的列表流会在该 Session 下一次被监听时或连接重置后为剩余监听者重新打开；`bind` 在标签内容挂载前保存标签与已有终端的关联。环境查询保持独立，因为工作目录可能变化。

独立的 `retain(sessionId, id, signal)` Remote 流确认窗口持有关系，不激活 Agent、发送屏幕输出、转移输入权或创建进程。终端 provider 提供侧栏的完整打开标签清单，Client 将其与自己保存的身份取交集。同一窗口中的重复 occurrence 共用一个持有流；孤立的旧关联不会保活任何终端。恢复输出连接前必须等待当前持有关系确认。传输取消只释放对应的物理流代次；插件卸载等待全部持有流结束。清理失败时保留所有权并重试，不重新接受连接，也不重新计算空闲宽限期。

新视图自动启动，使用开始页明确选中的 shell，或上次选择且仍可用的 shell。上次选择的路径保存在当前站点 localStorage 的 `dsh.terminal.shell` 中。默认启动通过 Host 探测验证保存的路径，不可用时回到当前默认项。开始页在打开标签页前记录选择，每个新标签页保留自己的 shell 路径和分配身份。存储失败不影响启动。恢复已有终端既不读取这一偏好，也不探测 shell。

关闭时先保存未完成的清理请求并释放标签页，再在后台等待 Host 清理。失败时提供重试通知。每个请求使用独立的终端 ID localStorage key，清理成功或收到明确的 `session/not-found` 响应后删除；启动时重试已保存的请求。传输失败时保留请求。清理请求独立于标签关联和侧栏布局持久化。浏览器存储不可用时，内存中的清理仍可工作，但刷新后无法恢复该请求。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Subprocess](../../subprocess/subprocess/README.zh.md)
- [Right Sidebar](../../client/ui-sidebar-right/README.zh.md)
- [用户终端权限](../../../.agents/notes/implemented/architecture/2026-09-16-user-terminal-permissions.zh.md)
- [Web terminal decision](../../../.agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.zh.md)

<a id="model-experience"></a>
## 模型体验

间接影响由[工作目录恢复](../../session/working-directory/README.zh.md)拥有：创建终端可能更新目录用户上下文，终端文本只经 Agent 终端接口的使用方进入模型历史。

#### KV 缓存影响

目录恢复追加用户上下文，不替换 system-prompt 前缀；控制器不向模型请求添加其他内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器刷新保留进程和屏幕；Host 或 Session owner 卸载不保留。不提供持久终端恢复或自动重启 shell。 已退出的终端仍计入 `maxTerminals`；关闭不用的标签页可释放其屏幕和名额。
- 原生 PTY 可用性和进程树清理保证由 subprocess provider 决定。找到可执行文件并不保证 PTY 分配成功。
- 自动回收依赖 provider [支持的 shell 活动观察](../../subprocess/subprocess-local/README.zh.md#running-terminal-sessions)。不支持的 shell、自定义启动参数和不确定的进程观察可能让资源一直保留到明确关闭或 owner 卸载。运行中的命令没有强制最长执行时间。
- 屏幕恢复只保留有界历史，不保留完整记录。同一时刻只有一个连接可输入或调整尺寸。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

无。

</details>
