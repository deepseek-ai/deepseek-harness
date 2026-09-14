# Agent Note：Sidebar 停靠面最后一个 tab 的关闭规则

Status: implemented

[English](2026-09-08-sidebar-last-tab-close-rules.md) | 中文

## 问题

settle planner 保证停靠面永不为空：关掉最后一个 tab 会重新播种当前默认页。这条保证让最后一个 tab 的关闭控件在两个方向上都走进死胡同。独自留下的引导页被关闭后，同一个引导页立刻回来——一个什么也不做的控件。任何其它 tab 独自留下时被关闭，用户面前只剩一列只显示默认页的面板——在「关掉最后一个东西」之后，一块展开着却空无内容的面板不是这个手势的本意。引导页的 chip 还画着悬停胶囊，右键菜单里唯一的条目就是那个无效的关闭。

## 决定

停靠面的最后一个 tab 带一条规则，由 Sidebar store 的 `closeTab` 决定，并经新的控制策略 prop `canCloseTab(tabId)`（与 `canSplit`、`canAddTab` 并列）镜像给套件：作为唯一停靠 tab 的引导页不可关闭——chip 上没有关闭控件，菜单里没有关闭项，编程式关闭什么都不记录；任何其它 tab 独自留下时，关闭会连同整列一起收起、把全屏重置为挤压模式并记为一条历史，布局保持为空，直到下次展开时创建当时的默认页。[stores.ts](../../../../packages/client/ui-sidebar-right/src/client/stores.ts) 里的 `soleDockedTab(state, tabId)` 命名这个条件；浮动面板不参与。按照 packages 规则「在做出决定的操作里执行它」，store 的 `closeTab` 是执行点，`canCloseTab` 只是把它镜像到界面。本规则取代[默认页决策](2026-09-08-sidebar-default-pages.zh.md)中的关闭保护部分；其默认页选择规则仍然有效。

两条套件侧的呈现规则在 [TabPanel.tsx](../../../../packages/client/ui-dockkit/src/components/TabPanel.tsx) 与 [TabMenu.tsx](../../../../packages/client/ui-dockkit/src/components/TabMenu.tsx) 里补全它：某格仅剩的一个 chip 在关闭被收起时画成安静样式——没有胶囊底色，没有悬停填充——因为既没有别的 tab 可供选择，也没有任何可对它做的事；一个连一项都没有的菜单不会产生可见弹层，于是对这样的 chip 次键按下什么都不显示，而不是画一个空框。

## 考虑过的替代方案

**让引导页保持可关闭，由 settle 重新播种。** 可见的结果是一个什么也不做的关闭控件；这个控件在按下会发生什么这件事上撒谎。

**在 Sidebar 的渲染器里藏掉关闭，而不加套件 prop。** chip 的关闭控件与菜单的关闭项都由套件绘制，没有接缝嵌入方就无法收起它们；CSS 覆盖会留下仍然生效的菜单项，把一个决定拆给两个所有者。

**由套件在最后一个 tab 关闭时收起整列。** 套件没有「列」或「展开」的概念；收起是嵌入方的意图，由 store 在同一条历史里与关闭一并记录。

## 后果

`canCloseTab` 成为每个嵌入方都可设置的第三个控制策略 prop；不设置时每个 tab 都可关闭。安静 chip 与空菜单两条规则是套件的无条件行为，键在同一策略上，任何收起了独 tab 关闭的嵌入方都得到同样的呈现。独 tab 关闭后重新展开的列显示根据当前引导入口选出的默认页。套件 spec 覆盖收起的控件、安静 chip 与自行消失的菜单；Sidebar 单元 spec 覆盖 `closeTab` 的拒绝与「关闭连带整列」的历史条目；一个[浏览器用例](../../../../apps/web/tests/sidebar-right.e2e.ts)在渲染出的面板上走完整条规则。
