# Agent Note: Windows 上基于 terminal seam 的持久化 pwsh

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-pwsh-persistent-pty.md) | 中文

## 问题

harness 在 Windows 上没有持久 shell。持久 `bash` 栈按构造就是 POSIX-only：`@deepseek-ai/dsh-subprocess-local` 在终端分配时直接抛错（`createProcessInspector()` 拒绝 win32），`@deepseek-ai/dsh-terminal-bash` 是 bash 形态（`/bin/bash` 默认值、`PS1`/`PROMPT_COMMAND` 环境标记），`@deepseek-ai/dsh-tool-bash-persistent` 用 bash 语法包装命令，pty 测试全部在 win32 上 skip。一次性 `pwsh` 工具（`@deepseek-ai/dsh-tool-pwsh` + `@deepseek-ai/dsh-pwsh-local`）已经能在 Windows 运行，但每次调用都是全新的 `pwsh -Command` 进程：cwd、`$env:` 变量、函数和交互式子进程都随调用结束，其 README 把 "No persistent shell or PTY" 记为 deferred work。

这个缺口排除了状态驻留在终端里的 Windows 工作流：单步调试、在 Python 或 Node REPL 中探索、中断前台命令后回到原 shell —— 正是持久 bash pty 在 POSIX 上服务的同一类工作。

两个基础已经存在。PTY 服务本身（`ctx.terminals` 注册表、owner 作用域、send/read/signal/kill 契约）是平台无关的。Loader 的 `disabled: !!js` 插值（PR #2234）按平台门控 shell 行，并钉死了"每宿主恰好挂载一个 shell 栈"的不变量；持久 pwsh 栈通过同一行机制组合。

## 决定

模型侧持久 `pwsh` 工具在 Windows 上交付，契约与 `tool-bash-persistent` 逐项对齐：每个 Agent 一个 owner 作用域的持久 shell、标记检测的命令完成、精确的原生退出码、有界输出，以及超时/取消/`exit` 时重置 shell 并告知模型的语义。三块交付：`subprocess-local` 的 Windows 基座、`terminal-bash` 的 shell 方言选项、新的 `tool-pwsh-persistent` 包加 minimal 预设组合行。

### `@deepseek-ai/dsh-subprocess-local` 的 Windows 基座

`createProcessInspector()` 在 win32 返回 `WindowsProcessInspector` 而不是抛错。基于 koffi 的检查器通过 Toolhelp32 枚举进程表，把 GetProcessTimes 创建身份与进程句柄零时等待结合起来（同时防止 PID 复用并识别已终止的进程对象），把 **shell pid 作为伪前台进程组**（Windows 没有 POSIX 进程组；这个稳定值让 prompt-marker 就绪快路径在一个轮询间隔内结算），不报告 stdin-wait 证据（就绪与 macOS 同档），信号走 `taskkill /T` 升级（仅 SIGKILL 加 `/F`）。koffi（`^3.1.0`，`sandbox-windows-acl` 已固定的版本）仅在 win32 惰性加载。

`LocalTerminalHandle` 为 win32 分支，因为 node-pty 的 `kill(signal)` 会抛错（"Signals not supported on windows"），其无参 kill 委托的 console-list agent 在没有父控制台时失败。拆卸经 taskkill 升级并以 shell 的启动身份作栅栏；由于被外部 taskkill 的 shell 可能永远不会触发 node-pty 的退出通知，句柄从 inspector 验证的消失状态结算 `done`（`settleExitIfGone`）。`signalForeground` 把 SIGINT 映射为 `\x03` Ctrl-C 输入写入（conhost 转为控制台级 CTRL_C 事件的投递方式；实测可中断运行中的命令），SIGTERM/SIGKILL 路由到 taskkill，SIGTSTP/SIGHUP 以 Windows 不可用为由拒绝。公共 `PtySignal` 集合与 seam 类型不变；映射全部留在 backend。

### `@deepseek-ai/dsh-terminal-bash` 的 shell 方言

一个 backend、两种方言：`shellDialect: 'bash' | 'pwsh'`（默认 `'bash'`；bash 的 argv 和环境默认值保持不变）。有效 `shellPath`/`shellArgs` 按方言解析（bash `/bin/bash --noprofile --norc -i`；pwsh 经共享的 `dsh-pwsh-local` 解析器取 `-NoLogo -NoProfile`，保留交互宿主供子 REPL）。子环境去掉 bash 专属 `PS1`/`PROMPT_COMMAND` 标记并为 pwsh 加 `NO_COLOR`。pwsh 无法从环境安装提示符，因此 backend 在启动时通过会话写入 prompt 函数，并且只接受 backend 的 `stdin_read` 结果；回显引导输入中的可打印提示符字面量不代表就绪。一条 `timeoutMs` 绝对超时计时器负责限制完整启动重试循环，因此 `inferred_idle` 后续 send 无法重新计时。一个不保留 scrollback 的 `@xterm/headless` 实例会消费原始 PTY 数据，并通过 `SubprocessTerminalHandle` 发出终端协议响应；backend 会在调用方输入前排空这些写入，并且只接受协议工作在整次检查期间保持静止时的前台状态，因此调用方输入不会被当作光标位置响应而消费。一个 parser 写入保持活跃，随后到达的原始 chunk 会合并为下一批，从而避免高输出量为每个 chunk 分别调度解析。现有 sanitizer 与有界缓冲区仍负责输出投影。两种方言发出相同的 BEL 终结 OSC `133;D;` 标记，因此 `PROMPT_MARKER_PREFIX`、`CONTROLLED_PROMPT` 与精确尾部就绪逻辑保持共享——标记仍是载荷不被消费的就绪信号，延后的 BEL 事件通道也继续保持延后。

### `@deepseek-ai/dsh-tool-pwsh-persistent`

新包镜像 `tool-bash-persistent`：同样的 `Config`（`backendType` 默认 `shell`、`timeoutMs`、`maxOutputChars`、`description`）、同样的 owner 作用域 shell 注册表与每 owner 串行队列、同样的超时/中止/退出/重置路径。工具名是 `pwsh`；它与一次性 `tool-pwsh` 永不共挂，因为预设行按平台互斥。

命令经包装器执行：先重置 `$LASTEXITCODE`（可赋值，已实测），通过 `Invoke-Expression` 在反引号转义的双引号字符串中执行 body（`quoteForPwsh`：反引号、引号、`$`、CRLF 与 ESC 转义，输入行上不携带裸控制字符，包装器可在 ConstrainedLanguage 下存活），报告精确原生退出码、PowerShell 终止性错误的 `1` 或成功的 `0`。PSReadLine 会把提交的包装器回显进流——没有 `stty -echo` 的对应物——因此提取会从捕获输出中剥离包装器原文；回显无法伪造完成，因为状态正则要求 END nonce 后紧跟数字，而回显继续是引号字符。prompt 函数安装工具自有提示符（`__DSH_PERSISTENT_PWSH_PROMPT__ `）覆盖 backend 引导值，与 bash 的双层结构相同。

### 组合

minimal 预设用 #2234 的 `disabled: !!js` 插值按平台门控持久 shell 栈：bash 行（`terminal-bash` + `tool-bash-persistent`）在 POSIX 挂载，pwsh 行（`shellDialect: pwsh` 的 `terminal-bash` + `tool-pwsh-persistent`）在 win32 挂载——每宿主恰好一个持久 shell。`windows-shell.spec` 钉死按平台的花名册；真实 Loader 组合在真实 ConPTY pwsh 上跑通整条栈。

### 测试

Windows 测试面沿用 master 的豁免结构：terminal-bash 与 subprocess-local 的测试在 win32 上继续排除（`windowsUnsupportedTests`），其源码在 win32 上继续覆盖豁免（`windowsUnsupportedCoveragePackages`），平台门控 fixture 与 node 翻译命令因此仍是 win32 开发车道的证据；koffi-backed inspector 在 Linux 侧加入 windows-only 覆盖豁免。`tool-pwsh-persistent` 不在豁免之列：其套件在 windows-native 车道上运行、源码受覆盖约束，镜像 `tool-bash-persistent` 的 stub 模式矩阵并加回显剥离模式。session 套件无需真实 shell 即可固定拆分的光标位置查询、响应写入顺序与解析批处理；macOS 和 Windows 上的真实 pwsh 套件证明持久 cwd/env、密钥清洗、UTF-8 输出、多行与 here-string 命令、大输出裁剪及退出/重置。ACP keyless snapshot 通过真实 Loader 组合启动持久工具，并固定模型可见的 schema 与结果。

## 备选方案

- **独立的 `pty-pwsh-local` backend 包。** 拒绝：本地 session、sanitizer、就绪档位和沙箱栅栏是共享机制；为一个 config 字段复制 500 行 session 换来的是一包复制粘贴，与 bash 组并置薄 executor 的情形不同。
- **tasklist 或 wmic 轮询进程树。** 拒绝：`inspectForeground` 每次就绪轮询（约 50ms）都跑，每 tick 生成一次探测进程不可行；wmic 已从现行 Windows 移除。koffi + Toolhelp32 是进程内、廉价的。
- **为 SIGINT 加原生 helper 或 `GenerateConsoleCtrlEvent`。** 拒绝：向 ConPTY 输入写 `\x03` 即可中断运行中的命令（已实测），零新增代码。语义差异——在提示符处 `\x03` 取消当前行而不是给进程发信号——文档化而不是绕开。
- **包装器 body 用 base64 编码。** 拒绝：解码需要 `[Convert]`/`[System.Text.Encoding]` 调用，其在 ConstrainedLanguage 下的可用性未证实；反引号转义的双引号字符串只用语言级构造，且已端到端实测。
- **手写光标位置响应。** 拒绝：响应必须反映 shell 已经发出的光标移动、换行折叠和控制序列。固定坐标会放大控制台重绘并可能耗尽有界输出；`@xterm/headless` 会维护这份协议状态，但不取代逐行输出投影。
- **容忍回显而不剥离包装器。** 拒绝：完整路径和提示符就绪路径下回显天然被排除，但超时和 START 丢失的回退会把包装器源码（含 marker nonce）泄漏进模型可见文本。
- **复活 BEL 模型通知通道。** 拒绝：当前实现不消费任何 marker 载荷、不投递任何 BEL 事件；设计对齐当前实现，deferred 项保持 deferred。
- **把 Windows PowerShell 5.1 当一等目标。** 拒绝：pwsh 7（含 Store 安装）是目标；`resolvePwshPath` 保留 5.1 作为最后的可执行回退，但不承诺持久 shell 在其上的完整行为。

## 后果

**Windows 成为一等公民的持久 shell 宿主。** 持久 pwsh 栈在 windows-native 车道上运行并受覆盖门禁约束；一次性/持久 shell 的划分与 POSIX 镜像，预设 spec 在两种平台上都钉死每宿主恰好一个 shell 栈。

**Windows 覆盖沿用 master 的豁免结构。** subprocess-local 与 terminal-bash 源码在 win32 上保持覆盖豁免、其套件保持测试排除，与 master 完全一致；Windows 代码路径经 win32 开发车道与真实 pwsh 工具套件验证，新表面的覆盖义务在 windows-native 车道上落在 `tool-pwsh-persistent`。

**Windows 就绪弱于 Linux。** 伪 pgid marker 快路径覆盖 shell 提示符，但没有提示符的子进程按静默档结算（约 3s），与 macOS 完全一致；没有精确的 stdin-wait 档。

**Windows 的拆卸与信号不同于 POSIX。** 不带 `/F` 的 taskkill 无法终止控制台进程（TERM 档是 `/F` 升级前的宽限等待）、SIGINT 是控制台级 Ctrl-C、SIGTSTP/SIGHUP 不可用，且被外部 taskkill 的 shell 可能不触发 node-pty 的退出通知——句柄改从验证的消失状态结算。

**输入回显是接受的平台事实。** PSReadLine 回显提交的输入；marker 锚定提取与包装器原文剥离在完整结果中移除它，部分输出回退中残留有界。

**终端协议响应先于调用方输入。** headless 模拟器不保留 scrollback，也不贡献模型可见文本；它跟踪终端控制状态，并通过已挂载的进程管理提供方发出响应。这会增加受维护的 `@xterm/headless` 运行时依赖，并避免光标查询消费后续工具命令。

**携带的风险。** Windows ACL 沙箱只读模式下，ConstrainedLanguage 可能拒绝引导代码通过 `[Console]::` 固定编码并写入 prompt marker；若 marker 就绪持续不可用，启动会在 `timeoutMs` 到期时拒绝，而不会发布引导未完成的 shell。模型后来重定义 `prompt` 函数会使命令就绪降级到静默档。模型命令中的裸 ESC 字符不受支持（PSReadLine 会吞掉）。koffi 与 `@xterm/headless` 分别增加进程基座和终端后端的依赖评审。
