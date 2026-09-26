# Agent Note: 持久 pwsh 保留后端的受控提示符

Status: implemented

[English](2026-09-21-persistent-pwsh-keeps-controlled-prompt.md) | 中文

## Problem

`dsh-tool-pwsh-persistent` 用自己安装的 `prompt` 函数（`'__DSH_PERSISTENT_PWSH_PROMPT__ '`）初始化其 shell，覆盖了 `dsh-terminal-bash` 在 pwsh 启动序列中安装的 `prompt`。后端的提示符就绪检测要求 OSC `133;D` 标记之后的可打印尾部与受控提示符 `dsh> ` 完全相等（[设计](../feature/2026-07-16-persistent-pty-sessions.zh.md)），因此初始化之后任何 send 都无法经由该路径结算，每次 send 都要支付静默层加交接宽限。在 Windows 上通过真实 Loader 组合以生产默认值实测：首次调用（spawn、初始化与命令）8493 毫秒，随后三次为 3722/3832/3759 毫秒；受控提示符完好时为 1340/255/251/241 毫秒。包测试把 `idleSilenceMs` 配成 300，掩盖了该问题。

[持久 bash 工具已修复同一缺陷](../../archived/bug-fix/2026-08-15-persistent-bash-keeps-controlled-prompt.md)，方式是放弃自己的提示符覆盖；pwsh 孪生工具保留了它。该覆盖在两个工具中服务同样的两个消费点：用视口后缀检测「shell 已回到提示符但没有结束标记」的回退判定，以及从部分输出中剥离提示符文本的美化。

## Decision

工具不再安装提示符。pwsh 的 `prompt` 函数由 `dsh-terminal-bash` 拥有，在 `spawn` 期间安装，且只在该启动流程达到 `stdin_read` 就绪后才返回会话，因此工具的初始化 send 已无可确立之事，与其 `PWSH_PROMPT_SETUP` 命令一并删除。

视口后缀回退替换为 seam 自己的信号：一次以 `stdin_read` 结算而 scrollback 中没有结束标记的 send，返回已捕获的部分输出。私有提示符常量及其剥离逻辑删除；部分输出现在可能以后端自己的提示符文本结尾，工具无法也不应知道该文本。`stripPrompt` 收敛为 `trimTrailingNewline`，与 `dsh-tool-bash-persistent` 一致。

## Alternatives considered

**把工具的提示符文本对齐到后端的 `dsh> `。** 被拒绝：这保留了同一个协议常量的第二份安装与第二个拥有者，而且该 send 是多余的——后端在 `spawn` 返回前就已安装相同的提示符。

**把受控提示符导入工具。** 被拒绝：提示符是单个提供方的协议常量；Consumer 匹配它就把工具与 `dsh-terminal-bash` 具体耦合，换任何其他 pwsh 方言后端都会再次损坏。

**改为调小 `handoffGraceMs`/`idleSilenceMs`。** 被拒绝：任何静默值都修不好已死的快速路径，只是重新分配每次调用多付多少；而静默层同时也是吸收真正损坏提示符的那一层。

**像 bash 的 `PROMPT_COMMAND` 那样在每个提示符处重新设定 pwsh 提示符。** 被拒绝：除 `prompt` 函数本身之外，PowerShell 没有每提示符钩子，因此重定义无法像 bash 的变量那样被治好；该残余已记入已知限制。

## Consequences

Windows、生产默认值、真实 Loader 组合：工具调用从 8493/3722/3832/3759 毫秒降至 1340/255/251/241 毫秒（spawn + 初始化 + 首条命令，随后三条热命令）。

`stdin_read` 回退是行为而不只是美化：在提供方能证明前台 stdin 等待之处，交互式子进程会返回已捕获的部分输出，而不是空转到命令期限；其他情况下调用仍会运行到 `timeoutMs`。该提前返回保留会话，因此仍在读取 stdin 的子进程可能吞掉下一次调用的命令，直到那次调用到达 `timeoutMs` 并重置 shell；`dsh-tool-bash-persistent` 行为相同，而区分「shell 自身的提示符就绪」与「子进程的 stdin 等待」属于 seam，而不是任一工具。由标记界定的完整输出保持不变。

loader 组合套件记录每次 send 的 `waitReason`，要求至少六次 `stdin_read` 且没有 `inferred_idle`：回归由结算原因本身报告，而不是靠静默层耗时。把删掉的提示符覆盖加回去，该断言会在 30 秒后以 `expected 0 to be greater than or equal to 6` 失败，而同一用例的输出断言仍然通过。stub 套件删除了初始化握手模式，并改为锚定部分输出中保留的提示符文本，而不是它的缺席。

重定义 `prompt` 的模型命令仍会移除就绪标记，并把后续 send 降级到静默层：后端只在启动时安装一次提示符，无法重新设定。
