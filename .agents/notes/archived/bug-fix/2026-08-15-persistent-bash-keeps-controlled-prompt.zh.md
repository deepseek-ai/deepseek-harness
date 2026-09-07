# Agent Note: 持久 bash 保留后端的受控提示符

Status: implemented
Archived: 2026-09-04

[English](2026-08-15-persistent-bash-keeps-controlled-prompt.md) | 中文

## Problem

`dsh-tool-bash-persistent` 用 `stty -echo; PS1='__DSH_PERSISTENT_BASH_PROMPT__ '` 初始化其 shell，覆盖了 `dsh-terminal-bash` 在 spawn 环境中设定的 `PS1`。后端的提示符就绪检测要求 OSC `133;D` 标记之后的可打印尾部与受控提示符完全相等（[设计](../feature/2026-07-16-persistent-pty-sessions.zh.md)），因此初始化之后任何 send 都无法经由该路径结算。`PROMPT_COMMAND` 未被覆盖，标记仍持续到达，于是每次 send 都要支付静默层加交接宽限——生产默认值下每次工具调用 3.5 秒；首次调用 7.2 秒，因为初始化 send 同样退化；每条长命令结束后还要多等 3.5 秒。macOS 没有精确 stdin 等待层，而 Linux 的精确探测无法观察到在一个轮询周期内完成的命令脱离其 stdin 等待，因此退化实际覆盖了几乎每次调用。包测试把 `idleSilenceMs` 配成 100 毫秒，掩盖了该问题。

这个覆盖存在的目的是给工具一个已知提示符，服务两个消费点：用视口后缀检测「shell 已回到提示符但没有结束标记」的回退判定，以及从部分输出中剥离提示符文本的美化。

## Decision

后端拥有自己的提示符协议并自行修复：受控 `PROMPT_COMMAND` 在打印标记后重新设定 `PS1`，因此任何 shell 内的提示符覆盖——本工具从前的初始化、模型命令、被 source 的脚本——都存活不到下一个提示符。这同时保护了无法报告前台状态的提供方：在那里，确切的提示符文本是唯一的就绪证据。

工具不再覆盖 `PS1`（初始化只剩 `stty -echo`），并用 seam 已有的信号替换其视口后缀回退：一次以 `stdin_read` 结算而 scrollback 中没有结束标记的 send，返回已捕获的部分输出。私有提示符常量及其剥离逻辑删除；部分输出现在可能以后端自己的提示符文本结尾，工具无法也不应知道该文本。

## Alternatives considered

**只改工具，不动 `PROMPT_COMMAND`。** 被拒绝：seam 仍然静默脆弱——之后任何触碰 `PS1` 的消费方或模型命令都会在没有失败信号的情况下重新引入 3.5 秒退化，且无前台检查的提供方失去唯一的就绪因子。

**把受控提示符导入工具。** 被拒绝：提示符是单个提供方的协议常量；Consumer 匹配它就把工具与 `dsh-terminal-bash` 具体耦合，换任何其他后端都会再次损坏。

**从后端就绪检测中去掉提示符文本因子。** 被拒绝：对 `inspectForeground` 无法报告任何信息的提供方而言，标记加文本是对抗「命令输出中嵌入原始 OSC 标记序列」的防御；削弱它是拿误结算风险换快速路径。

**改为调大 `handoffGraceMs`/`idleSilenceMs`。** 被拒绝：任何静默值都修不好已死的快速路径，只是重新分配每次调用多付多少。

## Consequences

darwin 上以生产默认值实测：受控提示符完好时裸 send 约 86 毫秒结算，覆盖后约 3540 毫秒；工具调用从 7180/3560/3566 毫秒（spawn+init+echo、echo、pwd）降至 355/88/91 毫秒。

`stdin_read` 回退是行为而不只是美化：在 `exec`、中断，或提供方能证明其 stdin 等待的交互式前台子进程（Linux 精确层）之后，调用现在返回已捕获的部分输出，而不是空转到命令期限。没有提供方证明该等待时（macOS），交互式子进程仍会运行到 `timeoutMs`——已记入工具 README 的已知限制。部分输出可能带有后端的尾部提示符；由标记界定的完整输出与之前逐字节相同，无密钥 jsonrpc-agent 快照确认了这一点。

loader 组合套件现在把 `idleSilenceMs` 设在 send 上限之上，静默无法结算任何 send，提示符就绪一旦回归，每个用例都会失败；一个真实 PTY 用例在 shell 内覆盖 `PS1`，并要求下一次 send 以 `stdin_read` 结算且提示符已修复。自我修复无法在 `PROMPT_COMMAND` 本身被覆盖的命令后存活；那里静默层仍是边界，与先前设计一致。
