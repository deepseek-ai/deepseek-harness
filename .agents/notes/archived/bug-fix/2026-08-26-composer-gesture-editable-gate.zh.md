# Agent Note: Composer e2e 手势以 contenteditable 属性为门

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-composer-gesture-editable-gate.md) | 中文

## 问题

composer 变为 Lexical `contenteditable` `<div>` 后，两个 Playwright 手势语义悄然改变，且都只在 CI 高负载下咬人。输入机在裁决或发送一次提交期间——以及所有 locked 状态下——composer 通过把同一元素的 `contenteditable` 翻成 `"false"` 呈现只读。在该元素上 `fill()` 立即抛错（`Element is not an <input>, <textarea> or [contenteditable] element`）而不再经 actionability 等待；`expect.poll(() => input.isEnabled())` 则是无效护栏：Playwright 的 enablement 检查对 `<div>` 同时无视 `aria-disabled` 与 `contenteditable`，整个只读窗口内一律报 `true`。暴露的竞态只有几帧宽——permission-policy 场景绿了数周，直到 subagent 控制 Remote 化把提交 settle 拉长，CI 才落进窗口。

## 决策

composer 的 e2e 手势统一走 `apps/web/tests/support.ts` 的 `writeComposerDraft`：动作前在手势自身的目标上等待可编辑属性（`input.and(page.locator('[contenteditable="true"]'))`），再以逐键击键替换草稿。场景代码若需等待提交后 composer 重新开放，一律以 `contenteditable` 属性为门，永不使用 `isEnabled()`。

## 曾考虑的替代方案

- **在各场景内各自等待**而不是收进 helper：否决——每个新场景都会以最痛的方式重新发现这个陷阱，而促成本 note 的修复本身已是第二个踩点。
- **保留 `fill()`、每次调用前 poll `aria-disabled`**：否决——这仍留着 `fill()` 在触发菜单与 chip 交互之后的丢编辑竞态（单 task 内 Lexical 内部 selection 落后于 DOM selection），逐键 helper 同时覆盖了它。
- **让产品表面容忍 `fill()`**（只读期间接受合成编辑）：否决——只读窗口是提交裁决期间刻意的 UI 事实；为测试放松它会改变用户可见行为。

## 后果

- 对 `[data-composer-input]` 裸写 `input.fill(...)` 即使本地全绿也是潜伏的 CI 竞态；helper 是受支持的手势。
- 对 composer 调用 `isEnabled()` 断言不了任何东西。既有的此类 poll 不护任何路径，却读起来像提供了覆盖。
- turn 运行本身保持 composer 可编辑——排队输入正是打进这里——因此该门只等待提交裁决与 locked 状态，不等待 turn 完成。
