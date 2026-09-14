# Agent Note: Keep the room reading independent of hidden split controls

Status: implemented

[English](2026-09-08-stable-room-reading-under-hidden-split-controls.md) | 中文

## Problem

dockkit 的空间规则在每次 commit 后测量各 pane 的标签条，判断等分后的两半是否仍可用。开启 `hideSplitWhenBlocked` 时，宽度不足的 pane 会卸载自己的分屏控件——而这次卸载恰恰改变了规则所测量的标签条：标签条少了控件的 28px 盒子加 4px 间距，固定部分随之变小，同一个 pane 又被读成"够宽"。控件重新挂载后读数再次反转。在约 32px 的 pane 宽度区间内，两种状态在嵌套 layout effect 中来回切换，直到 React 中止更新循环（错误 #185）；slot 运行时捕获崩溃后卸载 Sidebar 的条目，而列状态仍记录为展开，于是面板和 header 上仅折叠时显示的展开按钮都不再渲染。在收窄的视口上拖动把手会让面板扫过该区间，表现为整个侧栏消失且无法再打开。

## Decision

当嵌入方选择隐藏被阻止的分屏控件时，空间规则无条件将分屏控件的占位排除在标签条固定部分之外，使读数与控件当前是否挂载无关。[`measurePaneFits`](../../../../packages/client/ui-dockkit/src/components/measure.ts) 接收嵌入方的 `hideSplitWhenBlocked` 选择，测量已渲染控件的盒子加标签条的列间距（`splitControlFootprint`），并作为 [`PaneMeasure.splitControlWidth`](../../../../packages/client/ui-dockkit/src/engine/geometry.ts) 传入，由 `halvesFit` 从固定部分中减去。排除该占位本身也是正确的：窄到无法分屏的一半会隐藏自己的控件，所以这份占位并不属于一半必须承载的内容。将被阻止控件渲染为禁用态的嵌入方不传该值，控件照旧计入固定部分。

## Alternatives considered

**只隐藏预算受限的控件，宽度受限的渲染为禁用态。** 这是 `hideSplitAtCapacity` 扩展为 `hideSplitWhenBlocked` 之前的做法：预算由状态驱动，不会经测量反馈回来。它避免了循环，但放弃了 Sidebar 想要的呈现——无法分屏的 pane 上不出现禁用的分屏控件。

**在振荡期间对重新测量做防抖或冻结。** 阻尼只是掩盖不稳定而非消除它：读数仍依赖控件的可见性，会任意停在两种状态之一，并在下次 resize 时再次翻转。

**用常量表示控件占位。** 硬编码的 32px 会与样式表漂移；测量实际渲染的控件和标签条真实的 `column-gap`，才能保证减去的量恰好等于标签条实际卸下的量，这正是读数稳定的确切条件。

## Consequences

空间读数在控件可见性变化下是不动点，`hideSplitWhenBlocked` 的嵌入方获得隐藏控件的呈现且无反馈循环。临界宽度附近的 pane 会比禁用态嵌入方的报告稍早读成可分屏，因为被询问的那一半不会承载控件。[dockkit 回归测试](../../../../packages/client/ui-dockkit/tests/components.client.spec.tsx) 模拟标签条卸下控件占位的反馈，在未修复的代码上以 React 更新深度错误失败；[Sidebar 浏览器用例](../../../../apps/web/tests/sidebar-right.e2e.ts) 在收窄视口上把面板把手拖过两侧钳位，断言面板、把手与干净的 console 均存活——崩溃只以 console error 形式出现，而脚手架的 tripwire 不监听它。
