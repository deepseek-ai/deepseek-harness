# Agent Note: The drill claim is published before the edit that re-enters tracking

Status: implemented
Archived: 2026-09-04

[English](2026-08-29-drill-claim-precedes-the-drill-edit.md) | 中文

## Problem

在 `@` 菜单里用指针进入目录不产生 breadcrumb,而用键盘进入同一个目录则会产生(#3310)。点击 crumb——breadcrumb 存在的意义所在——不但没有重新列出它所指的那一层,反而让整个 header 消失。指针进入的列表里,每一行还会重复 header 本应承担的父目录。

这三处故障是 `InputTriggerController.settle` 中的同一个顺序缺陷。drill 声明(`drilled`)过去在 `execute()` 返回之后才赋值,前提是输入层稍后才应用下钻编辑并重新 track。该前提只对键盘成立:`KEY_TAB_COMMAND` 的处理器运行在 Lexical update 内部,`SessionInputShell.applyEdit` 因此并入外层 update,提交——以及其 update listener 驱动的 `track()` 调用——落在 `settle` 返回之后。指针的 `mousedown` 处理器不在任何 update 内,`applyEdit` 于是执行 `editor.update(fn, { discrete: true })`,该选项置起 `_flushSync` 并同步提交;`track()` 因此在 `execute()` **执行期间**重入控制器,而声明的两个读取方——`refreshHeaders` 与 `fetchCandidates`——看到的仍是未置位的值。既有测试全部按键盘顺序建模:伪造的 insert 监听器只返回 `true`,由用例事后手工重新 track,指针顺序从未被覆盖。

## Decision

`settle` 在派发编辑之前声明 drill,并且只在编辑被拒绝时撤回:

```ts ignore-check
this.reduce({ type: 'close' })
this.drilled = action === 'drill'
if (!this.execute(outcome, hit.span)) this.drilled = false
```

声明仍然排在 `reduce({ type: 'close' })` 之后,因为后者的清理会把它清掉。撤回依然精确,原因是被拒绝的编辑不做任何变更,因而不会驱动重入的 `track()`:`insertText` 在碰到编辑器之前就没通过 `draftRev` CAS,`$replaceDetectSpanWithText` 也在 `$setSelection` 之前就从 `selectSpan` 返回 `false`。[breadcrumb 决策](../feature/2026-08-27-web-at-mention-discovery-and-row-content.zh.md)所声明的可观察保证不变——header 绝不会指向一个无人进入过的目录——而两种下钻手势现在都以 drill 的身份抵达 `header` 与 `candidates`。

## Alternatives considered

**在 `execute` 返回后重新发布 header。** 否决:这只处理了缺陷中看得见的那一半。`fetchCandidates` 读取同一个声明,候选请求仍会报告 `drilled: false`,`ui-reference` 也就仍会在指针进入的列表中逐行重复父目录。

**把 `execute` 推迟到 microtask,使重入的 track 必定落在 `settle` 之后。** 否决:该编辑携带 `hit.span` 用于版本 CAS,把它推迟到当前任务之外,会让插入其间的按键作废该 span,把一次本可成功的下钻变成静默失败。

**让 `applyEdit` 永不同步 flush。** 否决:`discrete` 正是让一次程序化编辑与由它算出的 detect 坐标留在同一个任务内的机制;为了修一个菜单标志而放宽它,会为所有调用方松开整个输入机的顺序保证。

## Consequences

- Tab、行内 chevron 与 crumb 收敛到同一种行为,breadcrumb 不再取决于是哪种手势打开了列表。
- 今后凡是 source 通过 `header` 或 `candidates` 读取的状态,都必须在 `execute` 之前发布,因为输入层可能在其内部重入 `track()`。该声明是控制器上的实例状态,顺序是唯一的约束手段。
- 覆盖:一个 insert 监听器同步重新 track 的控制器用例——即指针顺序——断言两个读取方;`reference-composer.e2e.ts` 断言 chevron 下钻后的 breadcrumb 与精简后的行,并通过 crumb 点击走完两层路径的回退。键盘顺序保留原有用例,因此「修好一种手势却弄坏另一种」的回归会失败。
