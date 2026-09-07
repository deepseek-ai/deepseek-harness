# Agent Note: 持久化 PTY 会话

Status: implemented

[English](2026-07-16-persistent-pty-sessions.md) | 中文

## 问题

harness 可以运行前台与后台命令、编辑文件和委派工作，但无法跨工具调用延续一次交互式终端对话。每次 `bash` 前台运行都会启动一个新 shell，因此 shell 内的 cwd、导出变量、虚拟环境激活状态、函数、job control 状态和交互式子进程都会随本次调用结束。

这个缺口排除了状态驻留在终端而不是文件中的工作流，例如单步调试 `gdb`、在 Python 或 Node REPL 中探索、驱动 `ed` 这类行式编辑器，或者中断前台命令后回到原 shell。通用的 [`ctx.jobs`](../../../../packages/jobs/README.zh.md) 运行时可以保留后台操作句柄和输出，但不提供交互式 stdin 或终端语义。

现有 `bash`、`read`、`write` 和 `edit` 工具仍是有界、可审计操作的可靠默认选项。PTY 是对确实需要终端状态的工作的补充能力，不说明这些工具有缺陷，更不意味着要移除它们。

## 决策

可选的 `packages/terminal/` 能力家族提供由 agent（智能体）拥有、持久化且面向行式交互的 PTY 会话。它遵循仓库的 [能力模式](../../implemented/architecture/2026-06-13-capability-seams.zh.md)，与现有命令和文件系统工具并存，并且不修改 `agent-loop`。

当前实现在 Linux 和 macOS 上支持交互式 shell 与行式 REPL。全屏终端应用、按键序列、BEL 触发的控制流、进程丢失后的会话恢复以及跨 agent 共享会话都明确推迟。

### 包拓扑

| 包 | 角色 | ctx key |
|---|---|---|
| `dsh-terminal` | `TerminalSessionService`、branded `TerminalSessionId`、后端注册表、按 owner 隔离的会话约定和结果类型 | `ctx.terminals` |
| `dsh-terminal-bash` | 基于 `ctx.subprocess.spawnTerminal()` 的持久 shell 后端：就绪状态、有界终端缓冲、沙箱解析和感知 owner 的会话生命周期 | 在 `ctx.terminals` 上注册后端 |
| `dsh-tool-terminal` | 6 个面向模型的工具、后台发送的 task 运行时集成、使用指引和 UI 渲染意图 | 注册到 `ctx.tools` |

就绪判定仍属于 PTY 后端行为，不是第二条公共约定。终端进程提供方只提供基底事实，例如前台进程组，以及能否证明该组正在等待输入；`dsh-terminal-bash` 将这些事实与提示符和静默证据组合成统一的发送结果。

### agent 所有权与身份

`TerminalSessionService` 在进程内保存活会话，但每个会话都由工具执行上下文传入的确切 `Agent` 拥有。服务铸造不透明的 `TerminalSessionId`；模型可选填的 `name` 只是显示元数据，仅在该 owner 内唯一。所有操作都以 `sessionId` 为目标，`list`/`read`/`signal`/`kill` 会拒绝 owner 之外的调用方。

实现不提供插件加载期 auto-start 会话。`terminal_open` 只在 agent 工具调用期间创建会话，此时所有权和所属的事件溯源会话都已确定。未来的声明式启动功能必须通过尚未发布的 agent setup 组合，而不能创建全局共享终端。

agent scope dispose（资源释放）时先撤销注册，再等待全部所属 PTY 完全停稳。未发布的后端 setup 同样是受追踪的生命周期操作：owner 或服务 dispose 会中止服务自有的 signal，等待后端结算与回滚完成后才返回。即使后端 reject，或返回的会话在回滚 close 时失败，调用方取消仍会原样保留其 `AbortSignal.reason`；该清理失败不会替换调用方原因，而会继续受追踪，留待后续 owner 或服务 dispose 处理。由 lifecycle dispose 触发的回滚 close 失败会使 spawn 与该 lifecycle dispose 都 reject，而 `TerminalBackendCleanupError` 让后端在不替换调用方取消的前提下，为该 lifecycle dispose 保留自身的启动清理失败。若调用方取消在 dispose 开始前已经结算，该清理失败会继续作为受追踪的 owner activity 保留，直到后续 owner 或服务 dispose 消费并报告它，因此沙箱模式策略不会把清理失败误判为完全停稳。后端或工具插件 reload 不会遗留会话：所有权持续存放在 `TerminalSessionService` 中，直到 agent 结束，与 [`ctx.jobs`](../../../../packages/jobs/jobs/README.zh.md) 的服务持有记录模式一致。服务会先同步把会话预留给一次活跃发送，再返回该操作；后台发送同样会在 job id 对外可见前完成预留。第二次发送会以 `SEND_ACTIVE` 失败，因此输出与取消无法跨越操作所有权。

### 安全与进程边界

注册的 `shell` 后端只约束终端如何启动，不约束启动后输入的命令。因此 `dsh-terminal-bash` 在 spawn 前应用两层保护：

- 它只提供终端专用的环境覆盖；挂载的子进程提供方先清除名称形似凭据的环境变量，再合并这些覆盖。
- 它要求共享的 `ctx.sandboxPolicy`。后端在 spawn 时，以部署默认值为底折叠 owner 的有效会话模式；`danger-full-access` 会直接启动 shell，受限模式则要求同一执行世界中存在 `ctx.sandbox` 提供方，并只包装一次 shell argv。该模式与 workspace root 在 PTY 的整个生命周期中充当进程边界。只要 owner 有任何已打开的 PTY 或尚未发布的 spawn，任何会改变生效 `sandbox/mode` 的写入都会在提交前被拒绝，并提示先等待创建操作结算，再关闭这些会话；不会改变生效模式的写入仍然有效。这项进行中的预留从后端 setup 持续到发布完成，因此不存在降级后又出现权限更宽的终端这一竞态。`danger-full-access` 是现有的显式无约束选择，不另设 PTY 私有 bypass。

沙箱限制本地进程副作用，但不会让任意 shell 输入自动安全：网络调用和其他外部副作用仍由部署策略治理。工具描述会说明 PTY 会话比一次性工具更难审计，只应在确实需要持久状态或交互式 stdin 时使用。

本地子进程终端原语只使用 `node-pty` 的公开能力：子进程 PID、`data` 与 `exit` 通知、`write` 和 `kill`。它不假设能访问原生 master fd，也不从 TypeScript 调用 `waitpid`。在受支持的 Linux 宿主上，[原生收容 owner](../architecture/2026-08-28-subprocess-native-containment.zh.md)会在 user-systemd scope 内启动同一条 PTY 命令，同时保持 PID、session、控制终端、前台进程组与就绪语义。该原语下的平台进程检查器仍在 Linux 上通过 `/proc`、在 macOS 上通过 `ps` 推导前台进程组和 fallback 父子进程身份。[可移植执行环境决策](../architecture/2026-07-28-portable-execution-world-consumers.zh.md)负责定义这种进程／消费方拆分。

### 6 个面向模型的工具

| 工具 | 用途 | 结果 |
|---|---|---|
| `terminal_open` | 从已注册的后端类型创建按 owner 隔离的会话 | `{ sessionId, name, type, motd }` |
| `terminal_send` | 发送文本、可选提交 Enter，并等待就绪或注册一个后台任务 | 有界 viewport、等待状态和会话状态；后台模式还返回 `jobId` |
| `terminal_read` | 从保留的 scrollback 读取一个有界页 | `{ text, totalLines, lineBegin, lineEnd, truncated }` |
| `terminal_signal` | 向当前前台进程组发送一种允许的信号 | `{ delivered, targetPgid }` |
| `terminal_close` | 关闭一个会话并等待进程树完全停稳 | `{ killed }` |
| `terminal_list` | 列出调用方的活会话 | 按 owner 隔离的会话摘要 |

UI 渲染约定精确且不携带位置信息。`terminal_send` 只为前台发送使用 terminal 调用卡片和结果卡片；后台形式使用通用 `execute` 卡片。`terminal_open`、`terminal_read`、`terminal_signal`、`terminal_close` 和 `terminal_list` 分别使用通用 `execute`、`read`、`execute`、`delete` 和 `read` 卡片。所有 PTY 工具都不发出 `locations`。

`terminal_send({ sessionId, text, submit?, run_in_background? })` 将 `text` 视为 UTF-8 字节，并由工具实现在解析阶段把 `submit` 默认成 `true`。`submit` 为 true 时先写入文本，再写入平台 Enter 序列；为 false 时只写文本，使控制字符和 REPL 片段无需隐藏的内容启发式即可发送。取消会在向真实前台进程组发送信号前将排队输入标记为已取消，因此即使异步的写入前检查随后才结算，该输入也无法执行。被取消的发送会保留其预留，直至异步前台信号发送结算，因此后续发送不会成为该信号的目标。`enableRunInBackground` 默认为 true；设为 false 时，schema 中会移除 `run_in_background`，调用方即使强行把这个未声明参数传入执行流程，也会被拒绝。

前台发送返回有界的渲染增量和两个独立事实：`waitReason`（`stdin_read | inferred_idle | timeout | session_exit`）与 `sessionStatus`（`running`，或携带退出码或信号的 `exited`）。`session_exit` 指 PTY 顶层 shell 进程退出，不指由 shell 消费状态的任意前台命令。timeout 从不意味着进程已经退出。`dsh-tool-terminal.maxResultBytes` 默认为 262144；低于 64 的值会被拒绝，以确保创建确认保留注册表签发的 id；每个单文本 UTF-8 结果在加入规范化的工具或流水线错误、等待、会话、分页、截断、通用 task 状态包装、策略拒绝或短路以及 post-execute 替换或阻断后，仍受该值限制；终端定义自有的末端 `finalizeContent` callback 会原样保留策略刻意返回的结构化多块内容。渲染器会为后缀预留空间并保持代码点边界，而不会把后端载荷上限当作面向模型结果的最终上限。

当 `run_in_background: true` 时，`dsh-tool-terminal` 在 `ctx.jobs` 上注册进行中的发送，并立即返回 `jobId`。生产方把 `maxResultBytes` 写入 task 快照，使 `job_output`、kill 返回的终态状态和完成通知在加上通用元数据后，仍对完整结果执行同一上限。`job_output(wait: true)` 负责等待、读取增量输出并记录最终结果；`job_kill` 会解析当前前台 PGID 并发送真正的 `SIGINT`，即使应用已禁用终端 `ISIG` 也同样如此，且后续升级仍只通过 PTY 后端拥有的 teardown 路径进行。若 task 对外接口不存在，后台模式必须在写入输入前失败。设计不新增 PTY 专用的 `sleep` 工具或通用唤醒 API。

`terminal_read` 从最新保留行向后分页。后端同时对保留的 scrollback 和返回页载荷执行行数与 UTF-8 字节上限，因此单个超长行无法绕过后端上限；工具随后再限制包含分页与截断元数据的完整渲染页。`truncated` 用于区分保留数据丢失与普通 viewport 增量。

`terminal_signal` 接受闭合集 `SIGINT | SIGTERM | SIGKILL | SIGTSTP | SIGHUP`。后端在执行时解析终端前台进程组。当目标组是顶层 shell 时拒绝 `SIGKILL`，并指引调用方使用 `terminal_close`；进程组解析失败时操作直接失败，而不是向猜测的 PID 发送信号。

### 本地就绪检测

本地后端先识别受控 bash 启动时发出的私有 OSC prompt marker，并且只有在最近一个 marker 后的可打印尾部与受控 `PS1` 完全相等时才声明 prompt 就绪；除此之外，它还运行 3 个有界 fallback 层级。在 data callback 之间保留该尾部，可以适配 marker 与 prompt 被分开交付的情况；如果回显的输入或输出跟在延迟到达的先前 prompt 之后，要求尾部完全相等会拒绝该 prompt，使其无法完成当前 send。marker 在输出到达模型前被移除，使两个平台上的普通 shell 命令都无需固定等待静默阈值。尚未发布的 startup 不会把零输出静默视为就绪；timeout 会拒绝 spawn。若调用方取消在 startup 期间胜出，后端会关闭私有会话并原样抛出 `AbortSignal.reason`；尚不可观察的前台 PGID 不会再用查找错误覆盖取消原因。所有时间参数都是经校验的配置字段：`pollIntervalMs`、`exactProbeAfterMs`、`idleSilenceMs`、`handoffGraceMs` 和 `timeoutMs`。

在 Linux 上，检查器从 `/proc/<shellPid>/stat` 读取 shell 的终端前台 PGID，枚举该进程组中的每个进程与线程，并检查它们当前的 syscall。Tier 1 只有观察到 stdin 等待才返回正结果：直接 `read(0)`、获准读取且含 fd 0 的 `select`/`pselect6` 或 `poll`/`ppoll` 参数，或者含 fd 0 的 epoll interest list。等待线程的 `/proc/<pid>/task/<tid>/fd/0` 还必须标识 shell 的控制终端设备，因此线程本地 fd 表无法用 leader 的终端描述符冒充自身 fd，阻塞于管道的流水线读取端仍属于正在运行的命令。直接 PTY 描述符使用其设备号；`/dev/tty` 则使用所属进程的 `tty_nr`，因为 `stat` 报告的是别名设备而非选定的 PTY。终端输入前就已存在的等待并不代表写入后就绪：必须先观察到同一 PGID 脱离该等待，之后再次进入等待才能使该次 send 完成；前台 PGID 发生变化则构成新的证据。无法读取的进程内存和未识别的 syscall 都是 miss，绝不作为正向猜测。宿主策略（包括加固的 ptrace 策略）若拒绝读取 `/proc/<pid>/task/<tid>/syscall`，同样会跳过 Tier 1 并保留有界的 Tier 2 idle 推断；进程休眠状态绝不会代替不可访问的 syscall 证据。架构表只包含对应 Linux UAPI 定义的 syscall number；检查器先准入运行时架构，再检查每个受支持的内核 ABI，因为在用户态模拟下，`/proc` 可能报告不同的 ABI。不受支持的运行时架构会跳过 Tier 1。

macOS 没有精确 syscall 层。任何前台进程组输出静默都会返回 `inferred_idle`，包括 Python 和 `gdb`；从 `ps` 推导的终端 PGID 只用于发送信号，不作为「只有 shell 才能 idle」的证明。纯进程检查逻辑可注入，并在 Linux 上经过单元测试，同时由 macOS CI job 驱动真实 PTY 和进程表路径。

Tier 2 在持续 `idleSilenceMs` 没有输出后返回 `inferred_idle`，因此 sleep 或网络阻塞的命令可能看似 ready。如果此前已经见过 prompt marker，Tier 2 会再等待 `handoffGraceMs`，使恰好落在静默边界上的 bash 前台交接仍然以精确的 `stdin_read` 归因结束，而不是退到较弱的推断；该宽限是由部署方拥有的配置字段，并被校验为至少覆盖一个 `pollIntervalMs`——短于轮询周期的宽限装不下一次就绪轮询，因此不可能改变任何结果。它只约束见过 marker 的 send，代价是这一种情况的交互返回延迟，而不是每一次 send。Tier 3 在 `timeoutMs` 后返回 `timeout`，避免前台工具调用无限占住 agent。结果保留这些区别；调用方可以通过 `ctx.jobs` 等待、向前台组发信号，或从另一个会话排查。

一次 send 在任一层级 settle 之后，`TerminalSendOperation.append` 就不再接受输出，此后子进程的输出不会再进入那个已 settle 的 operation；它仍然会进入 scrollback，以及此时恰好处于活跃状态的任何 send。因此，等待自己所启动的 operation 上出现标记的测试，必须把 `idleSilenceMs` 与 `timeoutMs` 设得高于子进程自身的启动耗时；否则在负载较高的 macOS runner 上，解释器启动会在标记打印之前就结束这次 send。

`node-pty` data 通知进入同一个终端 parser。parser 的 carry state 会处理跨 callback 的控制序列和位于 callback 末尾的回车；因此，即使 CRLF 被拆开，也只会生成一个换行，而不会产生改变分页的空行。实现会规范化行式输出，但不承诺正确操作全屏应用。

### 模型可见输出与持久性

现有持久化 `tool/call` 与 `tool/result` 事件是模型发送文本和返回给模型的渲染输出的真源。`terminal_open` 通过已记录的工具结果返回 MOTD；前台 `send`/`read`/`list`/`signal`/`close` 结果走同一路径记录。PTY 包不会把原始字节流重复写入自定义会话事件。

后台发送复用现有后台任务完成通知和 `job_output` 结果路径，因此进入后续模型请求的任何输出同样持久化。原始终端字节只作为有界的进程内状态存在，既不持久化也不可恢复。未来的 opt-in transcript（文本记录）sink 必须拥有独立的保留、凭证和隐私约定。

### 进程树 teardown

在受支持的 Linux 宿主上，subprocess 终端句柄会把顶层 PTY 进程绑定到临时 user-systemd scope。建立前，close 通过 direct PTY fallback 发送 `SIGTERM`，阻止 bootstrap 继续；建立后只向 scope 发送信号，并且仅在 scope signalling 失败时使用 direct fallback。随后它等待 manager 证明该 range 为空，并在配置的宽限期后升级到 `SIGKILL`。调用 `setsid` 或发生 reparent 的后代仍属于 scope，而 PTY 的 direct exit 通知继续作为终端结果。

fallback 宿主保留观察式进程 session 清理。句柄会按父 PID 以子进程优先顺序捕获传递后代、发送 `SIGTERM` 并等待，然后重新扫描关停期间 fork 出的子进程，向二者并集发送 `SIGKILL`，并在停止顶层进程前验证每个非僵尸后代都已离开进程表。身份匹配的 Linux 僵尸进程已无可执行工作，因此视为完全停稳。每个捕获的 PID 都包含进程启动身份，避免 PID 复用把升级信号发给无关进程。

teardown 独立报告顶层进程退出与存活进程清理。PTY 会话不会只因 shell 退出就声称成功：它会调用 `SubprocessTerminalHandle.terminate()` 并等待整个会话完全停稳，若清理失败则向外传播并列出存活者。失败的 close 不会永久缓存：注册表与本地会话各自仅在关闭围栏仍指向该次失败尝试时才将其清除，因此后续的显式 close 或生命周期 close 会重试，且不会干扰较新的并发尝试。即使某个 close 失败，服务 dispose 仍会清空其后端、预留与 owner detacher 注册表。

### 组合与推行

示例组合保持 opt-in，并采用安全默认值：

```yaml
plugins:
  '@deepseek-ai/dsh-sandbox-local':
  '@deepseek-ai/dsh-sandbox-policy':
    config:
      mode: workspace-write
      workspaceRoot: .
  '@deepseek-ai/dsh-terminal':
  '@deepseek-ai/dsh-subprocess-local':
  '@deepseek-ai/dsh-terminal-bash':
    config:
      scrollbackLines: 10000
      scrollbackMaxBytes: 4194304
      maxReadBytes: 262144
      pollIntervalMs: 50
      exactProbeAfterMs: 150
      idleSilenceMs: 3000
      handoffGraceMs: 500
      timeoutMs: 30000
      disposeGraceMs: 3000
  '@deepseek-ai/dsh-tool-terminal':
    config:
      enableRunInBackground: true
      maxResultBytes: 262144
```

包提供简洁的工具指引，说明持久状态、owner 隔离、不确定的 idle 结果、清理，以及无需交互时优先使用现有一次性工具。已发布的基础示例不挂载 PTY：PTY 仅通过专用组合 opt-in，而 ACP（Agent Client Protocol）与 headless 快照 overlay 会对其进行验证。`dsh-tool-terminal` 实例一旦启用，6 个工具和 `run_in_background` 就会默认启用；部署可通过配置仅禁用后台参数。

### 推迟的工作

- 全屏 TUI 支持、命名按键序列、BEL 中断、终端 resize 工具和 alternate-screen 快照需要另行验证面向模型的约定。
- 声明式 per-agent 启动需要 agent-setup 组合点；仍然禁止插件加载期全局会话。
- harness 进程丢失后的会话恢复需要进程外 owner 和版本化协议。
- 网络出口策略与外部副作用回滚超出 PTY 范围，继续作为独立安全工作。
- Windows/ConPTY 会话经由 subprocess-local 的 Windows inspector（Toolhelp32 身份、伪前台进程组、taskkill 拆卸）与 `pty-local` 的 pwsh 方言运行；见 [pwsh 持久工具 note](../../archived/architecture/2026-08-11-pwsh-persistent-pty.md)。

## 备选方案

**用 PTY 替换 `bash`、文件系统工具或 task 工具。**拒绝。一次性工具拥有更强的校验、审批、沙箱、输出上限和回放约定。PTY 只服务交互式状态。

**给 `bash` 增加持久模式。**拒绝。按就绪而不是进程退出返回、跨调用保留进程树、暴露交互式 stdin 会形成不同的所有权和失败约定。

**要求从 `node-pty` 获取原生 master fd。**拒绝。它的公共 API 不暴露 master fd。本地子进程终端适配器改为从受支持的 OS 进程元数据推导前台组与子孙进程，并把不可读元数据视为 detector miss。

**向根 PID 所属 POSIX 会话的全部成员发送信号。**拒绝。`node-pty` 可能暴露属于启动器会话的 helper PID，因此按 SID 清理可能向无关的 harness 或桌面进程发送信号。带 PID 启动身份校验的子孙进程树范围更窄，其安全边界由结构保证。

**发布可替换注册表 `TerminalIdleDetector`。**拒绝。基底专用的前台事实来自挂载的终端进程原语，提示符／静默就绪判定则仍是 `dsh-terminal-bash` 内部的一项私有策略。替换文件系统／子进程执行环境就是所需扩展点。

**新增 PTY 专用 `sleep` 工具。**拒绝。`ctx.jobs` 已经拥有有界等待、取消、完成通知和面向模型的收集。第二套通用唤醒机制会跨越 agent loop（智能体循环）边界并重复该约定。

**包含 TUI sequence 与 BEL 处理。**拒绝。源 prototype 将这些路径视为 timing-sensitive，且仍记录未解决的 alternate-screen 和交互失败。行式 PTY 已能证明核心价值，无需把未经验证的行为放进基础层。

**立即采用进程外 daemon。**初始的进程内能力不采用，因为当前长驻的运行入口已能维持 Cordis 上下文。跨进程恢复或多客户端附加会让 daemon 变得合理，但两者都已推迟。

## 验证

- 逐文件覆盖测试锁定了 owner 隔离、并发预留、写入前检查期间的取消、未发布 spawn 的取消与等待式 teardown、沙箱模式变更拒绝、可重试的生命周期清理、就绪层级、对写入前 stdin 等待与延迟到达的先前 prompt 的拒绝、配置化交接宽限把 idle fallback 顶过一次轮询以及低于 `pollIntervalMs` 时的拒绝、sanitizer carry state、完整 UTF-8 结果上限、task 集成、schema 和精确 render intent。
- 子进程 fixture（测试前置数据）覆盖非 leader 与非主线程的 stdin 等待、线程本地 fd 表、`/dev/tty` 别名、用户态模拟下受支持的内核 ABI、拒绝把指向管道的 fd 0 当作终端输入、僵尸进程完全停稳、不可读进程状态、不支持的架构和其他误报拒绝；同一单元测试套件通过注入覆盖 macOS 检查器逻辑。
- 真实 `node-pty` 与 PTY 消费方测试共同覆盖 shell 状态、通过 `/dev/tty` 读取控制终端输入、进程 syscall 可读时的精确归因、宿主策略拒绝读取时的有界 idle fallback、共享沙箱策略、环境清洗、raw mode 前台 `SIGINT`、忽略 `SIGTERM` 的后代进程，以及 dispose 返回后立即完全停稳。Linux native 冒烟测试会在一个 reparent 的 `setsid` 后代仍由 scope 拥有时，保持 PTY PID、session leader、控制终端、前台 `inputWaiting` 与 readiness；fallback 测试套件继续覆盖带身份围栏的观察式清理。
- Loader 驱动的 `cordis.yml` 测试挂载真实三包组合，并验证延迟到达的流水线输出随已完成命令返回，而不会被归类为终端输入就绪。SDK minimal 快照通过持久 Bash 工具固定该输出；ACP 与 headless 快照通过 opt-in overlay 固定 6 个终端 schema、有界结果和错误；TUI 快照固定 terminal 与 generic 卡片展示。
- 包约定、架构图、子系统页面、生成目录和 website API 描述同一个已发布接口。

## 后果

**无需削弱一次性工具即可获得持久终端状态。**Shell 与 REPL 状态可以跨工具调用保留，而 `bash`、`read`、`write` 和 `edit` 继续拥有更窄的校验、审批与回放约定。

**Linux Tier 1 之外的 idle 都是启发式结果。**输出静默无法区分 prompt、sleep 和网络 I/O。类型化结果保留不确定性，有界 timeout、task 等待与信号让模型仍能掌握控制权。

**精确归因与推断归因的边界是延迟取舍，不是可消除的竞态。**归因取决于内核在静默上限到达之前还是之后发布前台交接，因此任何固定宽限都是一次调度上的赌注。`handoffGraceMs` 把这个赌注交给部署配置：调大它可以在慢速或高负载主机上换到精确的 `stdin_read` 归因，代价是见过 prompt marker 之后的交互返回延迟；调小则相反。不应依赖胜负结果的测试使用不会出现在输入回显中的 token，断言下一次 send 中由子进程产生的输出，而不是断言归因路径。

**持久状态可能偏离模型认知。**模型可能忘记 cwd 或活跃 REPL。会话摘要和保留输出有助恢复，但任何提示词都无法让状态持久化变成确定行为。

**Linux native ownership 消除了进程树观察缺口，fallback ownership 没有。**受支持的 user-systemd scope 会持续保有 daemonized 或 reparent 后代，直到 scope 为空。在 macOS、Windows ConPTY，以及无法建立 scope 的 Linux 宿主上，观察式 teardown 开始前已经逃逸的进程仍可能避开捕获树；fallback 接受这个缺口，不冒险按 SID 向无关进程发送信号。

**Shell 可以造成外部副作用。**会话沙箱和环境清洗降低本地暴露，但无法撤销 push、API 调用或消息发送。无法容忍这些副作用的部署必须省略 PTY 或增加网络策略。

**进程丢失会销毁终端状态。**进程内会话无法跨 harness crash 或 restart 存活，原始 scrollback 也不持久化。重要工作必须提交到文件或其他持久系统。

**`node-pty` 是 `dsh-subprocess-local` 的原生依赖。**安装、支持的 Node 版本、prebuild 可用性和平台行为都需要在每个支持 OS 上运行构建产物冒烟测试。
