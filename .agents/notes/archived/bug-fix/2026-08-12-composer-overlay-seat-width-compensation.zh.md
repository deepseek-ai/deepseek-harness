# Agent Note: 覆盖视图的 composer 座位改为补偿滚动条宽度，不再预留滚动条槽

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-composer-overlay-seat-width-compensation.md) | 中文

## 问题

[composer 标签页滚动条槽预留](2026-08-04-composer-tab-gutter-reservation.zh.md) 让会话列滚动容器无条件预留一条滚动条槽，使 composer 座位在 Chat 与带 composer 覆盖的视图中测得相同宽度。代价由每个覆盖视图承担：视图内容列比列右边缘窄 8px，因为滚动容器为一条它从不绘制的滚动条预留了槽——trajectory 台账由视图内部自己的滚动容器滚动，外层盒子从不滚动。

trajectory 表格让这个代价显形：整行分隔线在面板右边缘前 8px 处停止，每条线右侧以及整个内容列右侧都留下一条空白带。

## 决策

预留现在只属于 Chat。覆盖分支声明 `scrollbar-gutter: auto`，视图内容占满整列；覆盖分支的 composer 座位（相对 padding box 绝对定位）用 `right: var(--dsh-scrollbar-width)` 让出滚动条宽度，使输入卡仍与 Chat 座位测得相同宽度，切换标签页时不移动。

补偿值不是字面量：ui-theme 的 scrollbar.css 在它镜像的 `::-webkit-scrollbar` 规则旁定义 `--dsh-scrollbar-width`（WebKit 路径 8px），座位读取该变量。scrollbar-styles 规格把该变量与其镜像规则、以及补偿消费者配对检查，因此样式表滚动条宽度一变却不同步变量——或变量一变却不同步消费者——都会让门禁失败，而不只是评审时发现。

## 备选方案

**保留无条件预留，压缩每个覆盖视图。** 修复前行为。两个标签页一条声明，但每个覆盖视图都要付出 8px 内容列，trajectory 台账将其显现为可见空白。已拒绝：覆盖视图自己滚动，不应为 Chat 的滚动条买单。

**覆盖分支也预留，并让视图渗入滚动条槽。** 同样结果下更多活动部件：从不滚动的盒子上仍存在滚动条槽，视图还得突破内容盒才能取回宽度。

**接受 4px 卡片位移。** 去掉预留却不补偿座位，会在每次切换标签页时移动输入卡——正是前一份 note 修复的症状。已拒绝：卡片位置是刻意保持的跨标签页不变量。

**把 overlay 座位按滚动条宽度内缩。** [滚动条槽预留 note](2026-08-04-composer-tab-gutter-reservation.zh.md) 当初否决的正是这个方案，本 note 采纳了它；变的是否决的前提。这个数字属于引擎而不属于我们——WebKit 路径绘制样式表里的 8px 滚动条，Firefox 路径绘制 `scrollbar-width: thin` 解析出的宽度——因此硬编码的内缩会让两种状态在 Chromium 上对齐、在别处继续漂移。被否决的设计假定 overlay 分支预留引擎解析出的槽宽，内缩必须精确匹配那个宽度。overlay 分支不预留任何槽位，补偿成为覆盖侧唯一的机制；否决的字面量那一半，通过把 8px 变成与 `::-webkit-scrollbar` 规则同处一个 diff 的变量来回应。Firefox 那一半仍然存在：Chat 预留引擎解析宽度，补偿保持固定 8px，两者不等之处的残余漂移作为接受的代价记录在后果中。

## 后果

- Chat 保留滚动条槽与稳定的卡片位置；该标签页无任何变化。
- 覆盖视图（trajectory）占满整列；trajectory 台账的分隔线到达面板右边缘。
- 输入卡在 Chat 与 Trajectory 标签页间仍保持同一水平位置，现在由两种机制而非一种达成：Chat 预留，覆盖座位补偿。
- Chat 预留引擎解析宽度，覆盖座位补偿固定的 8px。两者不等之处——Firefox 路径按平台解析 `scrollbar-width: thin`，而 e2e 只在 Chromium 上运行——卡片在切换标签页时会漂移半个差值。这是接受的残余代价，如实记录于此而不断言消除：本次改动并未提供目标平台 Firefox thin 宽度的实测。
- `--dsh-scrollbar-width` 成为 ui-theme 对外、且被 ui-theme 之外读取的变量；scrollbar-styles 规格把它与镜像的 `::-webkit-scrollbar` 宽度规则、以及补偿消费者配对检查，补上了该变量本会留下的间接层门禁缺口。

## 测试

`apps/web/tests/composer-tab-geometry.e2e.ts` 仍断言输入卡在标签页间保持位置，并新增断言拆分：Chat 滚动容器保持 `scrollbar-gutter: stable` 与非零槽宽，覆盖分支解析为 `auto` 且槽宽为零。控制级联随机制改变：现在移除座位的 `right` 补偿（而非移除该分支上 Chat 从未有过的槽），测得同样的 4px 位移，证明相等的矩形并非从未到达布局的标签页切换。提交的 golden 记录两种状态。
