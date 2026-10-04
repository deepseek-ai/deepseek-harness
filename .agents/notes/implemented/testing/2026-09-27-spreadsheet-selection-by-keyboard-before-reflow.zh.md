# Agent Note: Web lane moves spreadsheet selections by keyboard before reflow assertions

Status: implemented

[English](2026-09-27-spreadsheet-selection-by-keyboard-before-reflow.md) | 中文

## Problem

[document-preview.e2e.ts](../../../../apps/web/tests/document-preview.e2e.ts) 打开 `meeting.xlsx`，在表格 overlay 的 `{ x: 60, y: 40 }` 处点击以选中 `A1`，随后把侧栏加宽、收窄各两次，并在每次重排后断言名称框仍显示 `A1`。2026-09-24 到 2026-09-27 之间 `CI master` 的 serial 自托管 Linux lane 的 11 次运行中有 10 次在第一次重排处以 `expected 'B1' to be 'A1'` 失败该场景的一个或两个 locale 用例，托管的 `node 24 / snapshots and artifacts` 也以同样方式失败（run 36110572677 与 36213089675）。失败与 locale 无关：四次 master 运行只有 en-US 失败，三次两者都失败，三次只有 zh-CN 失败。把读取改为轮询（#5243）没有作用，因为 `B1` 是已提交的选区，不是过期采样。

`A1` 是工作簿的初始选区，所以点击之后的两个轮询在点击提交前就已满足，从未验证点击选中了什么。FortuneSheet 的 `SheetOverlay` 以 `setContext(draft => handleCellAreaMouseDown(draft, globalCache, nativeEvent, cellInput, cellArea, …))` 处理按下，而 `handleCellAreaMouseDown` 在 updater 执行的那一刻用 `cellArea.getBoundingClientRect()` 与事件的页面坐标解析目标单元格。React 在渲染期间运行 `useState` 的 updater，并且当 hook 队列里有更低优先级的更新排在它前面时会再次运行它；刚挂载的工作簿仍有这类更新待处理，而 Playwright 在按下之前先派发一次 `mousemove`，其 FortuneSheet 处理器是同一状态上的 continuous 优先级更新。在 Blacksmith runner 上运行的带探针的逐字副本记录到这一次点击触发了四次 `handleCellAreaMouseDown`：两次在点击返回前读到 `left=969.5`，两次在场景已把面板设为 `1000px` 之后读到 `left=725.5`。保存下来的指针 x 985 于是在网格内解析为 259.5，而会议表只有两列，`colLocation` 把它钳到最后一列：`B1`。在点击前就已提交工作簿初始选区归一化的机器上，同一位置落在 A1 自身的选区框上，其 `onMouseDown` 阻止了传播；点击于是什么也没选中，没有几何绑定的 updater 入队，场景在没有测试到点击的情况下通过。

## Decision

会议表这一步改为键盘选择。场景聚焦表格 overlay（`tabindex="-1"`），断言焦点已落在其上，按 `ArrowRight` 并断言 `B1` 且公式栏为空，再按 `ArrowLeft` 并断言 `A1` 且公式栏为 `会议纪要`，然后才开始重排循环。`handleArrowKey` → `moveHighlightCell` 只依据已提交状态（当前选区与 `visibledatacolumn`）计算目标，所以被重新执行的 updater 无论此时网格几何如何都得到同一单元格，而两次移动使交互可观察，因为 `B1` 与初始选区不同。重排循环、其中的 `A1` 断言、表页滚动控件计数与 canvas 身份检查保持不变。

场景开头预算表的点击仍是指针点击：它的目标不是初始选区，其结果由 `46281` 公式读取验证，而键盘、剪贴板和布局读取把它与第一次重排隔开远超一次延迟渲染。`values.csv` 的点击及其后的收窄也保持不变：针对收窄后的网格重新执行会解析出负的 x，`colLocation` 把它钳到 A 列，即同一单元格。

## Alternatives considered

**每次重排后轮询名称框。** #5243 这样做了。被重新执行的 updater 的结果就是最终提交状态，所以轮询在整个预算内都观察到 `B1`；没有更晚的状态可等。

**点击前等待选区框渲染。** 这会恢复点击落在 A1 自身拖拽手柄上、什么也不选的通过路径，断言于是验证的是初始选区而不是一次交互。改为点击初始选区以外的单元格则会保留几何绑定的 updater，其重新执行窗口跨越随后的重排。

**第一次重排前等待渲染器空闲。** 没有产品状态能表达“React 没有待重新执行的更新”；按 runner 调校的空闲等待或固定等待正是 [dsh-ci-test-reliability](../../../skills/dsh-ci-test-reliability/SKILL.md) 拒绝的掩盖式等待。

**扩展既有的 `@fortune-sheet/react` 补丁，在 updater 之外解析单元格。** `handleCellAreaMouseDown` 位于 `@fortune-sheet/core`，而用户需要命中的窗口是一次指针按下与一次侧栏重排落在同一次延迟渲染内。它仍是上游问题；产品改动不在本次测试修复范围内。

## Verification

PR #5291 处于草稿阶段时在托管 Linux lane 上运行的带探针逐字副本，在三次 lane 运行共 38 次中有 7 次（2/6、1/6、4/20）在第一次重排处复现 `expected 'B1' to be 'A1'`。每次失败都记录到 `mousedown` 的目标是 `#luckysheet-sheettable_0` 而不是拖拽手柄，且 `B1` 的提交先于只有按下 updater 才会安排的延迟 `cellInput.focus()`；在同时给 cell area 的 `getBoundingClientRect` 加了钩子的两次 lane 运行里，5 次失败全部带有上述四次执行的特征。键盘驱动的副本在这两次 lane 运行中 26 次全部通过。本地以 20× 的 `Emulation.setCPUThrottlingRate` 运行可让点击到达 cell area，并记录到每次点击三次 `handleCellAreaMouseDown` 执行；键盘驱动的副本在该限速下 6 次全部通过，在 React 调度器唤醒被推迟 200 ms 时也 6 次全部通过。

`env -u TSX_TSCONFIG_PATH DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/document-preview.e2e.ts -t "fills the spreadsheet pane"` 在本地 10 次重复中 10 次都通过两个 locale 用例；整个文件的 6 个用例在 3 次本地运行中 2 次通过，第 3 次在文档 gate 并行运行时失败于无关的 `:849` `Coding Tools` 开关轮询，失败截图显示开关已打开。

## Consequences

场景验证的是键盘做出的选区在侧栏重排后仍然保留，不再依赖 React 的延迟渲染落在重排之前还是之后。此 lane 中的指针点击在目标不同于当前选区、且其效果在任何布局变化之前被断言时仍然有效，或者在针对变化后布局重新执行可证明解析为同一单元格时也有效；而结果在几个往返之内就被送入重排断言的点击则无效。FortuneSheet 的几何绑定 updater 未改动，所以产品中一次真实的指针按下若在一次延迟渲染内紧跟着侧栏重排，仍可能移动选区。
