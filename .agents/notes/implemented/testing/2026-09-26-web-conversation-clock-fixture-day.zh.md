# Agent Note: Web conversation clocks on the fixture day

Status: implemented

[English](2026-09-26-web-conversation-clock-fixture-day.md) | 中文

## Problem

运行 36157253018（作业 108144715986，`node 24 / snapshots and artifacts`）在一次执行中让四个浏览器场景失败——[steering](../../../../apps/web/tests/steering.e2e.ts)、[markdown-images](../../../../apps/web/tests/markdown-images.e2e.ts)、[message-actions](../../../../apps/web/tests/message-actions.e2e.ts) 与 [reference-composer](../../../../apps/web/tests/reference-composer.e2e.ts)——且是同一处 aria 差异：消息渲染为 `… and stop. 9/25 23:58`，而 golden 记录为 `… and stop. {{clock}}`。

[`newEnglishPage`](../../../../apps/web/tests/support.ts) 将浏览器时区固定为 `Asia/Shanghai`，而 [`formatMessageClock`](../../../../packages/client/ui-chat/src/client/chat/message-chrome.ts) 一旦消息的本地日历日或年份与渲染时不同，就会在时钟前拼接 `clock.md` / `clock.ymd`。这些场景把两个时钟都留在墙上时钟上，而它们的消息时间是在运行期盖章的：实时输入由 Host 盖章，fixture 头部为 `createdAt: 0` 的种子由 `seedSession` 以 `Date.now() - 60_000` 为锚点。失败的作业于 15:54Z 启动，距本地午夜还有六分钟，于是午夜前盖章的行在午夜后捕获并渲染出日期前缀；同一场景的下一次运行在午夜后数分钟通过。

通道本已具备对策——[`WEB_FIXTURE_TIME`](../../../../apps/web/tests/support.ts)，其文档写明它是种子事件时间与 `Asia/Shanghai` 浏览器时钟的同日锚点，另有七个场景在使用它——但这四个场景从未采用。

## Decision

这四个场景让两个时钟都读取 fixture 日。

实时盖章的场景用 `pinHostClock()` 固定 Host 时钟（一个从锚点起按真实流逝时间推进的 `Date.now` spy），并用 [`pinBrowserClock(page)`](../../../../apps/web/tests/support.ts) 固定浏览器时钟。种子场景通过 `seedSession` 的 `createdAt` 参数锚定种子，并用同样方式固定浏览器时钟。

种子锚点不只影响渲染出的时钟：侧边栏的相对时间也以浏览器时钟为基准计算，因此固定浏览器却用实时锚点的种子会读出 `8mo`，而 [message-actions](../../../../apps/web/tests/message-actions.e2e.ts) 的 fork golden 断言的是 `now` 与 `1min`。

`pinBrowserClock` 按固定间隔从锚点重新施加同一个冻结时刻，而不是让时钟停在单一数值上，因为产品代码要靠读取两个 `Date.now()` 值来决定一个已渲染值要保持多久：步骤进程会把上一个标题保持 `PROCESS_TITLE_MINIMUM_MS` = 150 ms（[ChatGroupSeat](../../../../packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx)），输入框 keymap 会在 `compositionend` 后再保持 10 ms 的合成守卫（[keymap](../../../../packages/client/ui-conversation/src/client/input/editor/keymap.ts)）。两者都把剩余保持时间算作 `Date.now() - previousReading`，而永久冻结的时钟永远不会让它推进，于是保持期不会结束，golden 里那行稳定文案始终不出现。CI 运行 36179748541（作业 108218939163）在第一个冻结时钟的修订上正是抓到了这一点：steering 的 mid golden 记录的是 `Waiting for your action · Ready to continue?`，实际捕获到 `Preparing questions`。

steering 的 mid 捕获在截图前等待该稳定标题出现；[整队场景](../../../../apps/web/tests/steering.e2e.ts) 则只在运行中回合的停止控件出现后才做排队手势，因此 Enter 的排队判定总是相对一个已上报忙碌的 agent 解析。

## Alternatives considered

**在 aria normalizer 中折叠渲染出的日期前缀。** 在 `normalizeAria` 中把 `9/25 23:58` 折叠为 `{{clock}}` 只需两行即可修好这四个场景，且已实测：它让四个文件通过，随后在一次 `DSH_WEB_SNAPSHOT_WORKERS=16` 的通道运行中让 `cordis-tool-round`、`stats-paged-history` 与 `navigation-panes` 失败，因为这些 golden 有意记录带日期的形式（`9/1 {{clock}}`，以及 Timing 面板中的年份形式），而 `skill-tool-row` 早已把该形式 token 化为 `{{date}} {{clock}}`。两种渲染陈述的是不同事实——此行来自另一天，此行来自今天——因此折叠它们是在删除断言，而不是在稳定断言。

**让浏览器时钟保持冻结。** 整个场景固定单一时刻更简单，也能让四个文件通过，但它抽掉了页面中所有“读两次”保持逻辑的时间流逝，上面的 `Preparing questions` 捕获就是这样发生的。重新施加锚点既保持日历固定，又不改变已渲染值的保持时长。

**为整条通道固定时钟。** 在 `launchWebScaffold` 与 `newEnglishPage` 内固定时钟可以一次覆盖所有场景，包括将来以同样方式失败的场景。它因影响面而落选：83 个 golden 带有时钟，且会话树 golden 断言字面相对时间，因此通道级的 now 会同时把所有场景移离各自的会话与 fixture 时间，而每个场景仍需自己的锚点才能读出录制时的分桶。

**让场景避开本地午夜。** 在边界附近调度或拒绝运行会把依赖留在原处，并让运行而非被测代码失败。[CI 就绪与完成决策](2026-09-08-ci-readiness-and-completion.zh.md) 已经拒绝用预算或重试替代受控观察。

## Verification

两个负向对照各固定一个时钟、把另一个留在墙上时钟，精确复现了记录到的特征：`steering` 固定浏览器时钟而 Host 时钟实时时，两个 golden 用例以 `… and stop. 9/26 {{clock}}` 失败；`message-actions` 固定浏览器时钟但仍用实时锚点的种子时，每行时钟都以 `9/26 {{clock}}` 失败，且本应断言 `1min` 的 fork golden 读出 `now`。两个时钟都固定后两个文件均通过，且它们的 golden 未改动。

排队场景的启动竞态是实测而非推断：固定时钟且不等待忙碌状态时，`vitest run … -t "queues two messages"` 在 61 次中失败 10 次，全部停在同一个 `2 queued messages` 等待上；未加固定时钟的 `origin/master` 在 41 次中失败 0 次；加上该观察后 20 次全部通过。

CI 运行 36179748541（作业 108218939163）显示日历修复在通道自身的拓扑下成立：提示行匹配 `{{clock}}`，而运行 36157253018 渲染的是 `9/25 {{clock}}`。

## Consequences

这四个场景无论何时运行都渲染同一行 aria，其 golden 继续断言不带日期前缀的时钟。日历事实现在按场景归属：自行输入消息、或种子 fixture 头部为 `createdAt: 0` 的场景必须让两个时钟都读取 fixture 日，否则会继承午夜暴露。产品时钟渲染、`Asia/Shanghai` 浏览器时区、所有已提交的 golden，以及本说明未列出的场景的断言均不变。
