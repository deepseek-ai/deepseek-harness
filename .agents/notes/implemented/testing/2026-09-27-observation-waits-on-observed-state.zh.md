# Agent Note: Windows lane 的观测等待它所读取的状态

Status: implemented

[English](2026-09-27-observation-waits-on-observed-state.md) | 中文

## Problem

自托管 Windows lane 的两个用例用墙钟窗口观测状态，而不是等待它们真正断言的那个状态。

`packages/boot/plugin-manager/tests/operations.spec.ts` 在用例开始时启动一个 100 毫秒定时器，并在它触发时读取 profile 的 `run.json`，以此在该 run 仍在进行时观测 run 记录。它要观测的「修复安装」只有在一次被拒绝的安装、一次 `pnpm view` 查询、profile 文件恢复以及第二次 `launch` 之后才会发生，因此该定时器度量的是这整段前缀，而不是记录写入本身。在负载较高的 runner 上修复安装晚于该截止时刻才开始，用例因而以 `expected null to deeply equal { pid: 4343, grouped: false }` 失败（PR #4595 的 `windows node 24 / coverage`，job 108402945554，2026-09-26；该用例耗时 345 毫秒，而相邻的单 run 用例不需要这段前缀，分别以 113 毫秒和 116 毫秒通过）。

`packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` 统计每次 send 的结算层级并要求受控提示符快路径，但只报告数量，失败时无法说明哪一层级结算了哪一次 send——而这正是区分「就绪路径退化」与「窗口取值不当」的唯一事实。

## Decision

`observingChild` 会保持该 run 在进行中，直到测试读到 run 记录，因此读取不可能与 run 结束竞争；其有界等待从被 mock 的启动器交接处开始，而不是从用例开始处开始：被记录的 run 只是紧随启动之后的一次原子写入，因此等待上界只需覆盖这次写入。`RECORD_WAIT_MS`（2 秒）刻意低于用例预算，于是一条始终没有出现的记录会以指名它的断言报告，而不是以 runner 超时报告。修复安装用例与单 run 用例都通过同一个 `spawned` 钩子交接子进程。

loader-composition 的结算层级断言把记录到的结算原因与一份逐 send 的就绪时间线放进失败信息：每个解码后的 pty 分块及 sanitizer 对它的标记判定与提示符尾部、每次前台轮询的结果、每次输入写入、每次 send 的结算原因与耗时、由这些分块回放出的会话提示符证据，以及宿主机、shell、PSReadLine 与控制台宿主的版本。当 runner 预算在断言之前结束用例时，`onTestFailed` 打印同一份时间线。阈值与断言本身不变。

## Alternatives considered

**提高固定定时器的时长，或从用例开始处轮询记录。** 不采纳：两者都把窗口锚定在操作尚未到达它所观测的 run 之前，于是上界必须覆盖整段前缀，并随 runner 在修复 run 之前的行为一起增长——同样的错误，只是更大。锚定在交接处则只度量真正要等待的那个状态转换。

**无上界地等待记录。** 不采纳：若操作永不写入记录，用例会挂到 runner 自身的超时，且对记录本身不给出任何信息。

**只记录关键的那几次结算，或断言 send 的子集。** 不采纳：这会把该套件所固定的内容——任何 send 都不得回退到静默层——削弱成让失败消失。

## Consequences

在负载较高的 runner 上，两个插件管理器记录用例现在都能在该 run 仍在进行时观测到记录，而真正缺失的记录仍会以同一条断言失败。只有在操作始终不写记录时，这段有界等待才会付出 2 秒。

[已归档的任务详情关闭诊断](../../archived/testing/2026-09-28-detail-close-waits-on-observed-state.md)记录了同一条规则在 Web 客户端用例中的应用：被采样的状态落在该用例等待的列表之后一个 commit 的被动 effect 里。

## Deferred

自托管 Windows lane 上 loader-composition 的失败（2026-09-25..27，issue #2487）仍未关闭，其机制不是提示符尾部停摆。[提示符尾部宽限](../bug-fix/2026-09-27-pwsh-prompt-tail-grace.zh.md)合入前的 master run（run 36309006133，2026-09-27 09:19Z）与首个带着该字段、且本组合设置了 `promptTailGraceMs: 5000` 的 run（run 36326153388，14:30Z，结算原因为 `["stdin_read","inferred_idle","inferred_idle","inferred_idle","inferred_idle","session_exit","inferred_idle"]`）都耗时 20.8 秒，因此退化的 send 是按普通的 `idleSilenceMs + handoffGraceMs` 上界结算的：要么根本没看到标记，要么看到了标记但其尾部被随后的可打印文本失效——这正是该宽限不覆盖的两种状态。前台比较在 Windows 上不是候选：`WindowsProcessInspector.foregroundPgid` 无条件返回 shell pid、`isStdinWaiting` 返回 false，因此 `shellPgid` 总是匹配，`stdin_read` 只能来自受控提示符尾部。于是该组合把字段保持在 product 默认值 `0`，下一次该 lane 失败时，失败信息里的时间线会直接点名所处的状态；2026-09-27 12:51Z 的 run（36320394583）则是在任何断言之前就撞上 120 秒的用例预算，同一份打印也覆盖这条路径。

在 Windows 11 25H2（conhost 10.0.26100.1）上以 pwsh 7.6.6 与 PSReadLine 2.4.5 取得的原生证据（尾部宽限笔记所引用的探测运行在 Windows PowerShell 5.1 之下，那是 guest 唯一预装的 shell）：基线、8 个 CPU burner 加磁盘反复读写、模拟 x64 Node、`vitest run --coverage --maxWorkers=1`、以及从第二条命令起就滚动的 12 行视口下，用例的每次 send 都按提示符结算，每个提示符都是一个按序到达的标记分块紧跟 5 字节尾部。在 8 行 60 列的视口下，ConPTY 会在重绘帧内重新发出已存储的 `133;D` 标记——一次 send 内出现五个标记，其中一个后面紧跟重绘的行文本（`\x07\e[Hdsh> Write-Output …`）——这使尾部不再是受控提示符的前缀；在该控制台宿主上，真正提示符的标记仍然最后到达，因此该 send 仍按 `stdin_read` 结算。这条重绘路径是该 lane 的首要假设，而该 lane 的 Windows 版本与控制台宿主版本未知（job 日志两者都没有，该 pool 也没有可手动触发的 job）；失败信息会记录 `os.release()`、`os.version()`、pwsh 与 PSReadLine 版本以及 `conhost.exe` 的文件版本，而 `dsh-subprocess-local` 启动 node-pty 时未设置 `useConptyDll`，因此起作用的是系统控制台宿主。这些探测同时暴露的 Windows 上 pid 为 `0` 的问题是另一个缺陷，由 issue #5297 跟踪。
