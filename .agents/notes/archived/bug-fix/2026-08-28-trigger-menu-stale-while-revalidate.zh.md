# Agent Note: The trigger menu keeps previous rows through refinement

Status: implemented
Archived: 2026-09-04

[English](2026-08-28-trigger-menu-stale-while-revalidate.md) | 中文

## Problem

在已打开的 `@`/`/` 触发菜单里,每个按键都会发起一次新的候选请求。菜单 reducer 的 `hit` 分支过去会把各组重置为 pending-空,于是列表在 100–460ms 的请求往返期间塌缩成骨架屏,每输入一个字符就重绘一次——细化查询时肉眼可见的闪烁(#3234)。

## Decision

reducer 的 `hit` 分支(`core/menu.ts`)现在保留上一次查询的行和高亮,并把各组标记为 `pending`——即 stale-while-revalidate。首次打开(`seedGroups`)仍从空开始,首帧保持骨架屏;`allReadyEmpty` 仍在结算后自动关闭。

旧行仅用于显示。`pick()` 要求候选所在组为 `ready`,`enter` 仲裁在 pick 前检查高亮组的状态:pending 窗口内 Enter 是显式 no-op(`'consumed'`)——既不选中旧行,也不落到草稿发送。Tab 的下钻早已带有相同的 `ready` 检查。

## Alternatives considered

**每次细化都清空为骨架屏。** 拒绝;这正是闪烁的现状。线上 chat 前端的会话搜索确实是清空(每次防抖查询重置结果和活动索引),其 Enter 因此天然安全——但那个列表在独立弹窗里,而本菜单直接在光标下随每个按键重绘,闪烁正是用户所报告的问题。

**pending 窗口内让 Enter 透传到发送。** 拒绝。改动前该窗口显示空骨架屏,Enter 落到发送在视觉上是自洽的;保留旧行后用户正看着一个高亮候选,此时把整条草稿发出去比几百毫秒的按键失效是更糟的误触。线上搜索在 pending 窗口的 Enter 同样是 no-op。

**把 Enter 排队,请求结算后再选中。** 拒绝。对用户尚未见到的行执行按键会重新引入选中旧数据的竞态,还额外增加时序机制。

## Consequences

细化按键不再闪烁;请求结算时列表内容原位替换。代价:pending 窗口内 Enter 失效(结算后再按即正常选中);行按 index 作为 key,结算时 DOM 节点内容原位替换——指针类测试点击前必须等待仅旧查询匹配的行消失(`reference-composer.e2e.ts` 轮询 `folderx/` 消失)。细化期间已存在的高亮闪动问题仍未解决,留待后续 PR。
