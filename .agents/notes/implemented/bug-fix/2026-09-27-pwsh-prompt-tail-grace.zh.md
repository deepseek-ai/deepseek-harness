# Agent Note: 已看到的提示符标记保留自己的尾部宽限

Status: implemented

[English](2026-09-27-pwsh-prompt-tail-grace.md) | 中文

## Problem

自托管 lane 上的 Windows 会话在七次 send 中只有一到两次按受控提示符结算，其余都要支付静默层（2026-09-25/26，issue #2487）。精确的就绪证据是 OSC `133;D` 标记之后受控提示符的可打印尾部，而等待它的上界是 `idleSilenceMs + handoffGraceMs`。原生 Windows 探测表明该渲染以两个 pty 分块到达：先是标记本身，2–28 毫秒后是 5 字节的 `dsh> `（Windows PowerShell 5.1 下 56 次渲染，pwsh 7.6.6 下同样是两分块渲染），任何提示符之后都没有可打印文本，输出中也没有终端查询。标记由 shell 自己的 prompt 函数写出、尾部由同一次渲染写出，因此尾部晚于上界到达意味着宿主机拖慢了这次投递，而不是提示符缺失。会话此前仍会按 `inferred_idle` 结算，每次这样的 send 让工具调用多付约三秒。该 lane 自身的失败不是这种状态：首个带着该字段的 master run（run 36326153388，2026-09-27 14:30Z）与其前一个 run（36309006133）同样耗时 20.8 秒，因此其退化的 send 是在宽限不起作用的情况下按普通上界结算的；[Windows lane 观测笔记](../testing/2026-09-27-observation-waits-on-observed-state.zh.md)记录了该调查，而[自带控制台宿主说明](2026-09-28-pty-bundled-console-host.zh.md)实测该池的尾部以已经畸形的形态到达（`\ndsh>\x1b[1C`），任何针对良构尾部的上界都覆盖不了。本字段仍然负责真正迟到的尾部。

## Decision

`dsh-terminal-bash` 新增一个经过校验的 `promptTailGraceMs` 配置字段，默认 `0`。当某次 send 已看到提示符标记而其可打印尾部尚未到达时，静默上界变为 `idleSilenceMs + handoffGraceMs + promptTailGraceMs`；其他上界、等待原因与代码路径均不变。该上界所扩展的层级阶梯由[持久 PTY 就绪设计](../feature/2026-07-16-persistent-pty-sessions.zh.md)拥有。零精确复现此前的上界，因此升级不改变任何部署的行为。持久 pwsh 的 Loader 组合用例保持默认值：自托管 lane 上退化的 send 无论有没有该宽限都按普通上界结算，因此在那里设置非零值只会把尾部永不到达时的回退从每次 send 3.3 秒拉长到 8.3 秒，并把真正迟到的尾部报告成一次缓慢的通过，而不是一次点名状态的失败。`validateConfig` 允许该字段取零——这是唯一一个零为文档化取值的数值上界——并拒绝负数与小数。

## Alternatives considered

**不加字段，直接提高默认值。** 不采纳：那是把一种固定成本换成另一种，且对所有宿主机生效。尾部永不到达的标记（子进程打印的杂散标记、损坏的 prompt 函数）会在所有地方都多等那么久，而真正重要的时序因部署而异。

**让观测变为粘性：一旦看到精确尾部，后续输出不再使其失效。** 不采纳：尾部规则的存在就是为了证明标记之后跟着的是提示符文本而不是命令输出；粘性标志会在命令仍在打印时结算该 send。

**看到标记后一直等到绝对 `timeoutMs`。** 不采纳：渲染永不完成的提示符会让每次 send 都挂到工具截止时间，而不是在有界静默后回退，而 send 预算属于调用方。

**在测试里检测停摆并重试该 send。** 不采纳：重试会掩盖究竟是哪一层结算的，而持久的修复属于解释证据的地方，而不是测量证据的地方。

## Consequences

控制台渲染器会停摆的部署通过设置 `promptTailGraceMs` 让这些 send 留在精确路径上；默认路径与此前的上界逐位一致，因此负控——同样的尾部延迟、字段为零——仍然按 `inferred_idle` 结算。该宽限只在看到标记之后生效：提示符缺失时保持普通静默上界，所以 Loader 组合用例所固定的回归（提示符丢失必须失败）仍会被抓住，而尾部永不到达的标记只会晚一个配置区间回退。

## Testing

`packages/terminal/terminal-bash/tests/session.spec.ts` 用假定时器固定每一种状态：设置 `promptTailGraceMs` 时，尾部晚于普通上界到达的标记保持挂起，随后按 `stdin_read` 结算；尾部始终不到时在扩展上界处回落到 `inferred_idle`；尾部已到达但被后续输出失效时保持普通上界；字段为零时，同样的延迟投递按 `inferred_idle` 结算。`packages/terminal/terminal-bash/tests/config.spec.ts` 接受零、拒绝负数或小数，并拒绝非零但短于一个 `pollIntervalMs` 的宽限。原生 Windows 上的端到端证据来自 guest 内打过补丁的 `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` 副本（Windows PowerShell 5.1，2026-09-27）：把每个 session 的提示符尾部扣留四秒且宽限设为 5000 毫秒时用例通过——九次结算、八次 `stdin_read` 加 `exit` 命令的 `session_exit`，耗时 33.4 秒与 37.5 秒；宽限为零时两次 send 以 `inferred_idle` 结算，`promptSeen` 为 true、`promptTextSeen` 为 false、尾部为空且 `idleFor` 为 3312–3316 毫秒。提交的用例以默认值运行，并在失败时打印逐 send 的就绪时间线，因此该状态一旦出现就会被点名，而不是从墙钟时间推断。
