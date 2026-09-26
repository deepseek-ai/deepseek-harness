# Agent Note: Session 行 action 即 slot 列表

Status: implemented

[English](2026-09-17-session-row-menu-actions-slot.md) | 中文

## 问题

Session 行的 "..." 菜单和行尾悬停按钮原本是 `ui-workspace` 持有的封闭列表：browser 按行状态拼菜单 `items`、自己渲染置顶和归档按钮、把每个动作的回调一路传下去，连这些动作需要的 toast 和重命名对话框也由它持有。客户端插件可以自己添加侧边栏控件，却无法在不修改 owner 包或复制菜单交互的情况下把 action 放到内置项旁边。

## 决策

`ui-workspace` 在其 `sidebar.workspaces` 注册项下声明两个 root-scoped `list` slot——菜单行用 `sidebar.workspaces.session.menu.item`，悬停按钮用 `sidebar.workspaces.session.row.action`——并在 `apply` 里以客户端插件的同一方式注册自己的 action：`pin`（菜单 100、按钮 200）、`rename`（200）、`fork`（300）、`archive`（菜单 400、按钮 100）。列表就是菜单和按钮条：条目按 `order` 升序渲染，插件 action 落在其 order 所指的位置，以另一个 `priority` 复用内置 id 则按注册表的普通 cell 规则遮蔽。没有单独的"扩展分组"：owner 不画分隔线，分组起点是条目自己的 `separatorBefore`。

条目只接收行身份 `{ sessionId, displayTitle }`，其余一切自己负责。它用自己 face 注入的 hook 读自己关心的 Host 状态（`usePinned` 与 `useArchived`，每次 Workspace 快照只派生一次的 Set），并据此决定是否显示：Host 规定两个集合互斥，所以 pin 在归档行上不渲染；archive 从不参考 pin。整套行为放在注册项自己的 `inject` face 里，组件只调一个回调：`pinSession` 委托给 `uiWorkspace.pinSession`——先做 Host 置顶，成功后用 `pinSessionOrder` 把会话推到其记账保存顺序的最前，成员关系在完成时刻从对象层快照读取（`pin-order.ts`）——和这个服务原本就持有的 `archiveSession` 并列；归档 action 的回调在此之上加上提示。服务经 apply 自己创建、并作为 handle 交给 browser 注册项的那个 viewing store 实例写入视图顺序，与 `ui-layout` 处理 layout store 的方式相同。置顶与归档集合以 Set 形式经 face 的 `hooks` 到达条目，每次 Workspace 快照变化只重建一次，行读自己那一位只需一次查找。

action 发起的浮层必须活得比行菜单久，所以它们是本包注册在 `shell.overlay` 的条目：重命名对话框和行 action 提示。action 经本插件 apply 闭包里的观察源到达自己的浮层：action 一侧注入为回调（`requestSessionRename`、`notify`），浮层一侧注入为 `hooks` 源（`useRenameRequest`、`useToast`）。browser 在标题双击时发出同一个重命名请求，在点击归档行时发出同一种提示；归档提示的第二个动作经同一个 store 实例把归档筛选切到"显示"，因为 browser 的视图选项菜单已不在链路上。

本包自己的菜单条目渲染 `MenuItemButton`——`ui-primitives` 为"行是组件"的菜单提供的行组件，只是一行普通 markup 与样式。任何 `role="menuitem"` 的按钮都能加入菜单的键盘走位、子菜单互斥与焦点归还，因为 `Menu` 从 DOM 上统一决定这三件事（方向键走位查询行元素；子菜单收起与选中后的焦点归还都在列表自己的冒泡上执行，数据行与组件行一视同仁）——无法 import 该 primitive 的 `cordis-client-runner` 闭包直接渲染这样一个按钮。两类行的关闭都是 owner 的状态：数据行通过 owner 的 `onSelect`，组件行通过 slot 级 `useMenuOpenState` hook——声明带 `inject: { hooks: { menuOpenState } }`，`SessionNodeItem` 把自己的 `[open, setOpen]` 作为该次渲染的 `hookContext` 传入，factory 把这一对原样交回。这正是 `sidebar.right.pane.tab` 用于 `useTabInfo` 的通道。

## 考虑过的替代方案

**在 `Menu` 与行组件之间放一个 React context。** 否决：业务组件不接触任何 React context（[client 规则](../../../../packages/client/AGENTS.md)）；Menu 与行是经 slot 系统建立的父子关系，控制权就该走 slot 的通道。

**由 owner 提供行能力。** 把 `pinned`/`archived` 和 `pin`/`archive`/`rename`/`fork` 回调经 owner props 或 slot 级 hook 交给条目，会让 browser 继续拥有每个动作，内置 action 沦为薄封装。否决：这些不是菜单的能力，每个 action 的行为属于它自己，需要的 Host 状态条目可以直接读。

**在内置行下方追加一个专用 slot。** 否决：它把内置行变成插件只能跟在后面的特权分组，还要在 primitive 里为本来只是一个有序列表的东西开第二条渲染路径。

**让条目自己算置顶顺序写入。** pin 条目为了拼 `pinSessionOrder` 的输入订阅整个 Session 列表和 Workspace 快照，列表一变所有可见行都重渲染，排序细节还进了菜单行。否决：写入归注入的回调，在完成时刻读一次快照。

**用声明式共享 store 传重命名请求与提示。** 请求与提示是本插件自己的瞬时事实，所以经条目自己的 inject face 以 apply 闭包观察源传递。

## 后果

插件无需修改 `ui-workspace` 即可在菜单和悬停条里添加、重排或遮蔽 Session 行 action，内置 action 遵循相同规则、走相同注册路径。`WorkspaceBrowser` 不再传递 action 回调、渲染 toast 或承载重命名对话框；`Menu` 新增 `children`，`items`/`onSelect` 变为可选；`shell.overlay` 多了两个 `ui-workspace` 条目。归档提示直接应用"显示已归档"筛选，不再打开视图选项菜单。
