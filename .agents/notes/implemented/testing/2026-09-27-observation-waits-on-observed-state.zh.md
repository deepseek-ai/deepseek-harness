# Agent Note: Windows lane 的观测等待它所读取的状态

Status: implemented

[English](2026-09-27-observation-waits-on-observed-state.md) | 中文

## Problem

自托管 Windows lane 的两个用例用墙钟窗口观测状态，而不是等待它们真正断言的那个状态。

`packages/boot/plugin-manager/tests/operations.spec.ts` 在用例开始时启动一个 100 毫秒定时器，并在它触发时读取 profile 的 `run.json`，以此在该 run 仍在进行时观测 run 记录。它要观测的「修复安装」只有在一次被拒绝的安装、一次 `pnpm view` 查询、profile 文件恢复以及第二次 `launch` 之后才会发生，因此该定时器度量的是这整段前缀，而不是记录写入本身。在负载较高的 runner 上修复安装晚于该截止时刻才开始，用例因而以 `expected null to deeply equal { pid: 4343, grouped: false }` 失败（PR #4595 的 `windows node 24 / coverage`，job 108402945554，2026-09-26；该用例耗时 345 毫秒，而相邻的单 run 用例不需要这段前缀，分别以 113 毫秒和 116 毫秒通过）。

`packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` 统计每次 send 的结算层级并要求受控提示符快路径，但只报告数量，失败时无法说明哪一层级结算了哪一次 send——而这正是区分「就绪路径退化」与「窗口取值不当」的唯一事实。

## Decision

`observingChild` 会保持该 run 在进行中，直到测试读到 run 记录，因此读取不可能与 run 结束竞争；其有界等待从被 mock 的启动器交接处开始，而不是从用例开始处开始：被记录的 run 只是紧随启动之后的一次原子写入，因此等待上界只需覆盖这次写入。`RECORD_WAIT_MS`（2 秒）刻意低于用例预算，于是一条始终没有出现的记录会以指名它的断言报告，而不是以 runner 超时报告。修复安装用例与单 run 用例都通过同一个 `spawned` 钩子交接子进程。

loader-composition 的结算层级断言把 `JSON.stringify(settleReasons)` 作为失败信息。阈值与断言本身不变。

## Alternatives considered

**提高固定定时器的时长，或从用例开始处轮询记录。** 不采纳：两者都把窗口锚定在操作尚未到达它所观测的 run 之前，于是上界必须覆盖整段前缀，并随 runner 在修复 run 之前的行为一起增长——同样的错误，只是更大。锚定在交接处则只度量真正要等待的那个状态转换。

**无上界地等待记录。** 不采纳：若操作永不写入记录，用例会挂到 runner 自身的超时，且对记录本身不给出任何信息。

**只记录关键的那几次结算，或断言 send 的子集。** 不采纳：这会把该套件所固定的内容——任何 send 都不得回退到静默层——削弱成让失败消失。

## Consequences

在负载较高的 runner 上，两个插件管理器记录用例现在都能在该 run 仍在进行时观测到记录，而真正缺失的记录仍会以同一条断言失败。只有在操作始终不写记录时，这段有界等待才会付出 2 秒。

## Deferred

loader-composition 于 2026-09-25/26 的失败仍未解释。在 Windows 上 `isStdinWaiting` 返回 false，`foregroundPgid` 返回 shell 自身的 pid，因此 `stdin_read` 只能来自受控提示符尾部；三次失败运行中七次 send 只有一到两次按该提示符结算，而其耗时（17.5 秒、20.9 秒，对照健康时的 4.7 秒）与「每次退化 send 支付一层静默」相符，同时所有输出断言都通过。第四次运行在用例上界处超时。本次改动无法获得原生 Windows 复现（本机 guest 拒绝其 guest operations 凭据），因此断言、会话的就绪路径与提示符安装均未改动；下一次失败会指明各次 send 结算在哪些层级上。
