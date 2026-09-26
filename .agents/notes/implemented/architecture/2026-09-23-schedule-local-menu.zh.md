# Agent Note: Schedule 详情菜单由 Schedule 客户端自己拥有

Status: implemented

[English](2026-09-23-schedule-local-menu.md) | 中文

## Problem

Automation tasks 详情需要一个列表顶部钉住控件的菜单：Time zone 行的搜索框必须停在滚动时区行之上。`@deepseek-ai/dsh-client-ui-primitives` 里的共享 `Menu` 会渲染行、分隔线、标题行、选中标记和键盘走位，但没有 header 槽。Delivery records 页把一条已保存记录的 message id 放在 info 图标背后，读者要能读到并复制这个 id。

用扩展 `ui-primitives` 来满足其中任一需求，都会把单个功能的行为放进每个 client 插件都消费的包里。同一条分支此前已经因为 review 质询“Schedule 的改动为什么碰它们”而撤掉了无关的 `ui-layout` 与 `ui-sidebar-right` 编辑；而一个只为单一调用方扩展的共享原语，对之后每一个读它的人都是成本。

## Decision

`packages/client/ui-schedule` 自己拥有菜单。`src/client/TaskMenu.tsx` 与 `TaskMenu.module.css` 保存一份 schedule 本地副本，渲染行、分隔线、标题行、disabled 与 dangerous 行、`selectedId` 尾随标记、指针与键盘走位、portal 定位、钉住的 `header` 槽，以及 `data-menu-field` 焦点交接。它导入共享的 `useAnchoredPosition` 与 `useDismissOnOutsidePointer` hook——任何锚定面板都需要的定位与关闭行为——不从 `ui-primitives` 导入任何运行时值。详情的四个菜单都改用它。

Delivery records 页用一个 info 按钮给出并复制记录的消息 id。该按钮的可访问名称同时说明动作与记录（`Copy message ID: <id>`），共享 `Tooltip` 在悬停与键盘聚焦时给出该 id，激活时通过共享的 `writeClipboard` 复制，并在图标旁用 status 区域报告 `Copied`。因此 `Tooltip` 保持 master 形态：那个让气泡在指针下保持展开的模式已不存在，Delivery records 页也不使用只在指针下打开的 `HoverCard`。

`packages/client/ui-primitives` 除时钟图标描边外回到 master。`packages/client/tsdown.client.ts` 的 client bundle purity gate 是这条边界另一方向上的相邻规则：client 插件只能以类型或 module-table request 的形式导入另一个插件的包，因此共享运行时词汇要么走 inline-safe 层，要么走 cordis service，而不是包与包之间的边。

## Alternatives considered

**给共享 `Menu` 加 `header` prop。** 这是分支最初的做法：一个可选槽加 `data-menu-field` 焦点交接，并在共享包里带测试。它的 diff 最小、只保留一份菜单实现；被否决是因为唯一的调用方是 Schedule 详情：`ui-primitives` 会背上只为单个功能存在的 API，而每个 client 插件的 bundle 都要读一份没人使用的 header 契约。

**给共享 `Tooltip` 加 `interactive` 模式。** 先落地后撤除：锚点与气泡之间的宽限期、指针停留、点击切换、可选中的文字，外加六个测试。被否决是因为共享 tooltip 本来就支持聚焦展开、共享剪贴板助手本来就负责复制，这个模式只是为单一调用方多出了一种保持气泡展开的方式。

**用 `HoverCard` 给出并复制消息 id。** 第二个落地又被替换的版本：指针停在卡片上时保持展开、文字可选中、激活即复制。被否决是因为 `HoverCard` 只在 `onPointerEnter` 打开，于是那个本来就可聚焦的图标对键盘读者什么都不显示，也没有复制入口。

**把时区搜索框渲染在菜单列表之外。** 放在触发器上方的输入框，或规则卡里的独立一行，都不需要改原语。被否决是因为该输入框会与它所过滤的列表分离滚动，或落在与它过滤的行不同的界面层上。

**用 schedule 本地的 `PickerPopover` 实现时区选择器。** Date 与 Time picker 已经用它。被否决是因为 `PickerPopover` 只负责定位与关闭面板，不渲染列表语义：键盘走位、行 role、选中行标记都要在 Schedule 客户端里重建，那正是本 note 描述的副本，而且比它所替代的菜单要维护更多东西。

## Consequences

Schedule 客户端多出一份菜单实现：346 行组件、189 行 CSS、403 行测试，换来 `ui-primitives` 除时钟图标描边外回到 master。副本按详情实际使用裁剪，缺失的能力保持缺失：submenu、组件渲染行、钉住的 footer、多个 selectedId、fill 选中模式、dense 与 compact 间距、挂载时 autofocus、调用方提供锚点矩形、指针离开即关闭，以及 side 参数。日后某个 Schedule 菜单需要其中一项时，要么扩展副本，要么重新审视这个决定。

复制是一次激活，而不是选中文本：tooltip 给出 id 但不接受指针，所以桌面端复制该 id 的手势是点击图标；这正是被撤掉的交互模式所具备、而当前形态放弃的能力。共享行为仍是共享的：定位、关闭、焦点交接、点名两个 owner 的 duplication gate 排除标记，以及 per-file 覆盖率都适用于这份副本。被拷贝的区域带 `jscpd:ignore-start` 与 `jscpd:ignore-end` 并点名两个 owner，遵循 [cross-package value dependencies note](../../archived/process/2026-08-23-client-cross-package-value-dependencies.md)；schedule 专有的 header、交接与 Tab 语义不在该区域内。

副本用 `useAnchoredPosition` 定位列表，它对四条边都用同一个 12px margin，而共享菜单的顶边用的是 frame-top clearance helper。因此在 macOS 窗口顶部需要向上钳制的列表，可能比共享菜单原先的位置低约 12px；样式表仍为该列表自身的最大高度保留 clearance，常见情形不变。

## Testing

`packages/client/ui-schedule/tests/task-menu.client.spec.tsx` 钉住指针与键盘走位、`header` 输入框对 Home/End 的独占、落位后的 `data-menu-field` 交接、选中行标记、disabled 行、portal 定位、外部关闭与焦点回返；原先位于 `ui-primitives` 的三个菜单 header 测试随该能力一起迁入。`delivery-history.client.spec.tsx` 钉住键盘聚焦展开的工具提示、按钮的可访问名称、剪贴板写入，以及会自行清除的复制确认。覆盖率门禁对 `packages/client/ui-schedule/src` 报告 per-file 100%，duplication 门禁在 `packages/client/ui-schedule` 与 `packages/client/ui-primitives` 上报告 0 克隆。
