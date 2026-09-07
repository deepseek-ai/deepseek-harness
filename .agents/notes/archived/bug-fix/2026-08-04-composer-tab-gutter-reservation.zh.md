# Agent Note: 会话列为每个视图预留同一条滚动条槽

Status: implemented
Archived: 2026-09-04

[English](2026-08-04-composer-tab-gutter-reservation.md) | 中文

## 问题

composer 座位在组件树中只有一个节点、一个位置，但它究竟对齐到哪条边，取决于当前展示的是哪个视图标签页。

在 Chat 中它是会话列滚动容器（`[data-conversation-scroll]`）的 sticky **子元素**，因而依附于该容器的 content box——而占布局宽度的滚动条会把这个盒子收窄一条滚动条的宽度。声明了 `data-conversation-composer-overlay` 的视图（Trajectory 即是其一）会把会话列的滚动搬进视图自身：以该属性为条件的那条分支把滚动容器留作 `overflow: hidden`，并把座位改为绝对定位——对齐的是 padding box，而滚动条从不收窄这个盒子。

于是只要 transcript（文本记录）超出一屏——任何带历史的会话的常态——两个标签页就恰好相差一条滚动条的宽度。输入卡片是居中的，因此在 8px 的滚动条下切换标签页会让它横向移动 4px，而右侧留白整整变化 8px。同一位移也出现在 Chat 内部：transcript 增长到开始滚动的那一刻，以及从 hero 态进入第一个可滚动轮次时。

## 决策

`.scrollBody` 为 Chat 状态声明 `scrollbar-gutter: stable`，覆盖分支则将其覆盖为 `scrollbar-gutter: auto`，同时保持为双轴滚动容器——`overflow-x: hidden; overflow-y: auto`。这条预留只属于 Chat：它让座位的内容盒在 transcript 是否溢出时都保持同一宽度，因此卡片不会在 transcript 增长到开始滚动的那一刻跳动，也不会在 hero 态与第一个可滚动轮次之间跳动。覆盖分支不预留任何槽位——视图自己滚动，槽位只会白白收窄视图内容——它的座位改为补偿滚动条宽度（[座位宽度补偿](2026-08-12-composer-overlay-seat-width-compensation.zh.md)）。

选 `stable` 而非 `auto`，是因为 `auto` 只在盒子确实溢出时才预留，而「溢出与否」恰恰就是 Chat 两种相位之间的那点差别——`auto` 的写法只是把缺陷重述一遍，并不能修掉它。

这条预留位于 `overflow-y: auto` 的盒子上，而这个形式是承重的：WebKit 对 `overflow-y: auto` 的盒子应用 `scrollbar-gutter`，对 hidden 的盒子则忽略它——这是在本应用 composer 自身的图层上实测所得，并记录于 [composer 滚动视口记录](../../archived/bug-fix/2026-07-31-composer-text-layers-share-one-scrollport.md)——所以把预留放在 hidden 盒子上，会在 Chromium 上成立，在 Safari 上悄无声息地不成立。覆盖分支同样保留 `overflow-y: auto` 的形式，作为没有任何内容会滚出去的裁剪盒：单轴滚动的盒子会把另一轴的 `visible` 计算为 `auto`，因此横向轴显式声明为 `hidden` 而不是交给推导，否则某个视图的内容第一次伸出列外时，它就会长出自己的横向滚动条。

这条预留之所以值回它的代价，前提是滚动条在这里确实占布局空间——这并非浏览器的默认行为，而是本客户端的选择：ui-theme 的样式表给 `::-webkit-scrollbar` 声明了宽度（[滚动条主题化](2026-07-28-themed-scrollbars-and-reserved-gutter.zh.md)），侧边栏的会话列表也正是出于同一原因预留了自己的滚动条槽。

## 曾考虑的替代方案

**把 overlay 座位按滚动条宽度内缩。** 这是对该缺陷最窄的一种解读——两种状态差 8px，那就从一侧减去 8px。之所以否决，是因为这个数字属于引擎而不属于我们：WebKit 路径绘制样式表里的 8px 滚动条，Firefox 路径绘制 `scrollbar-width: thin` 解析出的宽度，硬编码的内缩会让两种状态在 Chromium 上对齐、在别处继续漂移。滚动条槽是请引擎按它自己那条滚动条的宽度去预留，无论那是多少。

**保留 `overflow: hidden`，只加 `scrollbar-gutter: stable`。** 单行版本。它能在浏览器车道所用的引擎上修掉可见症状，却把症状原封不动留在 Safari 上，而且任何测试都不会失败——这正是改动的后一半所要防的失效模式。

**让 Chat 的 composer 座位也移出滚动容器，使 overlay 的几何成为唯一的几何。** 这是从根上删掉差异，而不是调和它，代价是放弃一项刻意的性质：sticky 座位位于滚动流之内，因此在 composer 上滚轮会带动对话记录（[sticky composer](2026-07-29-sticky-composer-conversation-scroll.zh.md)），其上方的渐隐遮罩也由座位自身的背景绘制。两者都是已有明确归属且各有测试覆盖的行为；为了消除 8px 的不对称而重建它们，是更大的改动而非更小的。

**给会话列加上一条滚动条宽度的内边距，而不是预留滚动条槽。** 内边距无论是否存在滚动条都会生效，因此在每种状态下都无条件付出这份宽度，而且它把一个由引擎在布局期决定的值钉死在样式表里。否决理由与侧边栏列表当初否决它时相同。

## 后果

- Chat 的内容列永久变窄 8px——hero 态与 transcript 尚短、根本不绘制滚动条时同样如此。这就是这笔交易：以最宽的列换取卡片在任何内容高度下都只有一个位置。
- 卡片在三种切换下保持同一位置，由两种机制达成：预留让 Chat 的座位在自身各相位间保持同一宽度（transcript 较短 ↔ 可滚动、hero ↔ 第一个可滚动轮次），Chat ↔ Trajectory 的切换则由覆盖座位的补偿来对齐（[座位宽度补偿](2026-08-12-composer-overlay-seat-width-compensation.zh.md)）。
- overlay 状态现在是一个滚动容器。其中没有已交付内容会溢出；将来若有视图允许自身内容超出会话列，这个盒子会滚动而不是裁剪，那个视图就需要像 Trajectory 视图那样自带裁剪。
- 提交的 golden 记录了预留条带，因此样式表中 `::-webkit-scrollbar` 宽度的变化——决定这条预留有多宽的那个值——会在本场景中与在侧边栏场景中一样，以可评审的 diff 形式出现。

## 测试

`apps/web/tests/composer-tab-geometry.e2e.ts` 在两个标签页下测量输入卡片的矩形，分别取卡片处于宽度上限的视口与卡片随列收缩的视口，并断言这两个矩形是同一个矩形。只有真实引擎能报告这件事：jsdom 给每个元素的盒子尺寸都是零，也没有滚动条，因此单元测试只能断言那些声明存在，无法断言两种状态落在同一位置。出于同一原因，本次没有附带读取 CSS 文本的单元测试——它只会把声明复述一遍，并不会补上浏览器车道尚未确立的事实。

该场景启动 chromium 时去掉了 Playwright 默认的 `--hide-scrollbars`，这一点是承重的：带上该参数时滚动条不占任何布局宽度，因此两个标签页在有补偿与无补偿时同样一致，文件中的每一处比较都会空洞地通过。实测：带上该参数时两条预留带的宽度都是 0；去掉它则分别是 8 与 0。

随后，未补偿的级联会被注入页面——通过 `!important` 把覆盖座位的 `right` 补偿降为 0，Chat 的预留保持不变——并在其下测量同样的两个标签页，这正是把「卡片确实没动」与「标签页切换根本没到达布局」区分开的那一步。它把上报的症状复现为一个数字：每条边 4px，恰是 8px 带宽的一半。golden 把这份对照与修复后的状态并排记录，因此 fixture（测试前置数据）承载的是这次改动所消除的那个差值，而不仅仅是它的缺席。
