# Agent Note: 插件入口自定义：区域自管的 Pin 与“更多”菜单

Status: implemented

[English](2026-10-14-plugin-entry-customization.md) | 中文

## 问题

`release/dsh-0.2.1` 的 Web 应用在三个区域显示插件入口：左侧栏的面板按钮（`sidebar.panellist`）、会话头部的 View 标签（`conversation.view`）和右侧栏起始页的工具卡片（右侧栏 tab 注册表的 guide 入口）。三处都按注册顺序显示全部入口，用户不能收起不常用的入口，插件越多三处越挤；用户也不能在这些位置直接浏览更多插件或开始创建插件。

该功能随 `release/dsh-0.2.1` 发布，之后随 release 合回 master，因此相对 release 的改动要尽量少：不修改 slot 框架（`ui-slots`、`ui-renderer`），不新增 Cordis 服务，`ui-layout` 保持不变，client 插件包之间只共享类型（[Client 包导出规则](../../../../packages/client/AGENTS.md)）。持久化的数据要能被以后在 slot 层统一保存手动顺序与 Pin 状态的实现直接沿用。

## 决策

三个区域各自保存本区域被收起入口的列表并持久化，用它过滤自己的入口按钮；各自画自己的“更多”按钮，用共用的 `Menu` 组件弹出菜单，菜单里渲染本区域的 actions slot。默认加载的插件包 `ui-entry-customization` 往三个 actions slot 注册同一个菜单内容组件：入口列表与 Pin 按钮、“浏览更多插件”和“创建你的插件”。做法与插件页的“添加插件”菜单一致：页面画按钮和菜单，`ui-agent-preset` 通过 `plugins.add.actions` 往菜单里加“创建插件”。不提供排序。

### 用户可见行为

- 左侧栏、会话头部、右侧栏起始页各有一个“更多”按钮，打开后的菜单列出该区域可自定义的入口。点入口名称打开它；点 Pin 让它在区域里显示或收起；底部有“浏览更多插件”（打开插件页主列表）和“创建你的插件”（用 Creator 预设新开或复用空白会话，填入该区域对应的提示语，不发送）。
- 入口按注册顺序显示，与 release 一致；不提供排序。
- 默认绑定的入口始终显示，不进入菜单：左侧栏的插件管理、会话头部的 Chat、右侧栏的文件。
- Pin 状态在刷新页面后保留，所有会话共用。
- 收起当前选中的入口不会切走当前内容；左侧栏行或 View 标签在选中其他入口之前保持显示，并标为当前项。
- 左侧栏 `<nav>` 与会话头部标签条的显示条件与 release 一致：`<nav>` 在有已注册面板时显示，标签条在注册的 View 多于一个时显示。条件按已注册的入口计算，不按 Pin 后可见的入口计算，因此只有 Chat 时不显示标签条；有其他 View 时即使全部收起，标签条和其中的“更多”仍然显示，用户可以重新固定。
- actions slot 没有注册项时（例如 `ui-entry-customization` 未加载），区域不显示“更多”。

### 结构与职责

```text
ui-sidebar / ui-conversation / ui-sidebar-right (each region)
  apply: the region's unpinned list (createSnapshotStore + persist) and setPinned
         whether the actions slot has registrations (entriesOfSlot + subscribe)
  root component: draws only fixed or pinned entries
          while the actions slot has registrations, draws the region's More button and Menu:
            <Menu anchor={region's More button} …>
              renderSlot('<region>.actions', { entries, onOpen, onPinnedChange, onDismiss })
            </Menu>

ui-entry-customization (default-loaded)
  registers one menu-content component into each actions slot (id 'entry-customization')
  content: non-fixed entries with pin buttons, Browse other plugins, Create your plugin; keeps no state
```

依赖方向：三个区域不依赖插件包，只增加 `client-store` 与 `ui-primitives` 的既有用法；`ui-entry-customization` 依赖三个区域（slot 类型）、`ui-plugin-manager` 与 `ui-workspace`（服务类型），运行时通过 `ctx.pluginNavigation` 与 `ctx.uiWorkspace` 调用。各包之间不新增运行时值导入。

### 各包改动（相对 release/dsh-0.2.1）

| 包 | 改动 |
|---|---|
| `ui-sidebar` | 新增 `sidebar.panellist.actions`；apply 中新增 unpinned 列表、`setPinned` 和 actions slot 注册状态；`SidebarRoot` 过滤入口，并在 `<nav>` 末尾画“更多”按钮与菜单；展开态面板行间距由 4px 改为 2px |
| `ui-conversation` | 新增 `conversation.session.header.views.actions`；apply 中新增同样三项；会话头部过滤 View 标签，并在标签条内、tablist 之后画“更多”按钮与菜单；View 标签间距由 36px 改为 32px，与“更多”间隔 20px |
| `ui-sidebar-right` | 新增 `sidebar.right.tab.guide.actions`；apply 中新增同样三项；起始页过滤卡片，并在卡片之后画“更多”卡片与菜单；guide 注册声明 `sidebarRight` 文案命名空间 |
| `ui-entry-customization`（新包） | 往三个 actions slot 注册菜单内容组件；`entryCustomization` 文案命名空间；不保存状态 |
| `ui-plugin-manager` | `pluginNavigation` 增加 `openList()`：切到插件页主列表的“已安装”标签，不打开对话框，不改变当前会话 |
| `ui-primitives` | `Menu` 增加 `minWidthFromAnchor`，让右侧栏菜单不窄于卡片；新增 `IconAppsAddOutlineRegular` / `IconAppsAddOutlineMedium`（`compact` 用于卡片尺寸），供左侧栏和右侧栏的按钮共用 |
| `@deepseek-ai/dsh-web-app` | 默认加载 `ui-entry-customization` |

### actions slot 与菜单内容

三个 actions slot 都是 root 级 list slot，由各区域声明，渲染在本区域的“更多”菜单里，其他插件也可以往里注册菜单项，排列顺序按注册项的 `order`。owner props 由各区域在自己的 contract 中声明（`SidebarPanelActionsOwnerProps`、`ConversationViewActionsOwnerProps`、`SidebarRightGuideActionsOwnerProps`），三处字段相同，以左侧栏为例：

```ts
interface SidebarPanelActionsOwnerProps {
  /** The region's customizable entries in registration order; fixed entries are excluded. */
  readonly entries: readonly { readonly id: string; readonly label: string; readonly pinned: boolean }[]
  /** Open an entry without changing its pin state. */
  readonly onOpen: (id: string) => void
  /** Show (true) or hide (false) an entry. */
  readonly onPinnedChange: (id: string, pinned: boolean) => void
  /** Close the More menu. */
  readonly onDismiss: () => void
}
```

`ui-entry-customization` 的菜单内容组件按上述字段渲染：每个入口一行（`EntryPickerRow`，名称与 Pin 按钮各自可聚焦），点名称先 `onDismiss` 再 `onOpen`，点 Pin 调 `onPinnedChange`；其后是“浏览更多插件”和“创建你的插件”，先 `onDismiss` 再执行。每个注册项通过 registration `inject` 得到所属区域（只用于选择 Pin 提示与创建提示语）和两个底部操作：“浏览更多插件”调用 `ctx.pluginNavigation.openList()`；“创建你的插件”调用 `ctx.uiWorkspace.startSession(undefined, { agentPreset: 'cordis', prompt, whenDraftExists: 'append' })`，`prompt` 按区域取本地化文案。该调用不经过 `ui-agent-preset`，预设标签不播放介绍动画；Creator 预设不存在时会话创建失败，Workspace 显示创建失败提示，不产生草稿。

“更多”按钮的样式、无障碍名称（“更多”“更多会话视图”“更多工具”，分别来自各区域的 `panels.more`、`session.moreViews`、`tab.guide.more` 文案）、Tooltip、菜单的弹出方向与宽度都由区域决定；菜单外框统一使用 `ui-primitives` 的 `Menu`。

### 三个区域

| | 左侧栏（`ui-sidebar`） | 会话头部（`ui-conversation`） | 右侧栏起始页（`ui-sidebar-right`） |
|---|---|---|---|
| 入口来源 | 现有的 `panels`（来自 `sidebar.panellist`） | 现有的 View 列表（来自 `conversation.view`，未开启开发者工具时去掉 Trajectory） | 现有的 tab 注册表 `guide()` |
| 入口 id | 面板 id | View id | `kind:入口id` |
| fixed | `plugins` | `chat` | kind 为 `files` 的入口 |
| localStorage 键 | `dsh.slot.manual-order.sidebar.panellist.v1` | `dsh.slot.manual-order.conversation.view.v1` | `dsh.slot.manual-order.sidebar.right.tab.guide.list.v1` |
| actions slot | `sidebar.panellist.actions` | `conversation.session.header.views.actions` | `sidebar.right.tab.guide.actions` |
| “更多”按钮 | 与面板按钮同样式；展开时显示文字，收起时显示 Tooltip | 头部样式的小按钮，带 Tooltip | 卡片样式，菜单不窄于卡片并右对齐 |
| `onOpen` | `selectPanel(id)` | 本会话的 `selectView(id)` | 按 id 找到入口后 `openTab(kind, { replaceTab: true })` |

每个区域用一个模块常量定义 fixed。unpinned 列表在 apply 中用 client-store 的 `createSnapshotStore(…, { persist })` 创建，与会话无关，值为 `{ "unpinned": string[] }`，经 inject 的 `hooks.entryPins` 交给区域根组件，`setPinned` 作为 inject 回调，对 fixed 入口不生效。读取时只接受字符串数组，其他值按空列表处理，避免损坏的 localStorage 内容影响渲染。`unpinned` 中已不存在的 id 保留，同一入口重新注册后保持收起。actions slot 是否有注册项经 `hooks.entryActions` 交给根组件。

localStorage 键统一为 `dsh.slot.manual-order.<list slot key>.v1`，按入口所在的 list slot 命名，不按区域包命名：左侧栏与会话头部使用现有的 `sidebar.panellist`、`conversation.view`；右侧栏的 guide 入口来自 tab 注册表，release 中还没有对应的 list slot，键名使用为它预留的 `sidebar.right.tab.guide.list`。以后在 slot 层统一保存同一 list slot 的手动顺序与 Pin 状态时，直接沿用这些键和 id，已保存的 `unpinned` 不需要迁移；新增的字段在旧值中缺失时按空列表处理。

右侧栏 id 使用 `kind` 而不是 `providerId`：扩展接管某个 kind 时 `providerId` 会改变，`kind` 不变，持久化的 Pin 状态在接管后仍然有效。

## 考虑过的替代方案

**由一个 Cordis 服务保存 Pin 状态（在 `ui-layout` 或插件中提供）。** 区域画自己的按钮时要读到 Pin 状态，而 slot 只能把数据从区域传给插件；由插件保存就必须新增公开服务。放在 `ui-layout` 会让布局服务承担与布局无关的状态；由插件提供时，区域还要处理服务时有时无。区域自己保存只需几行。

**三个区域各提供一个 Pin 服务。** 新增三个形态不同的公开服务，而 Pin 状态只被所在区域和它的菜单使用。

**在 slot 框架中提供 `useSlotEntries` / `useManualOrderedListSlot`。** 需要修改 `ui-slots` 与 `ui-renderer`，让 `ui-renderer` 持有用户偏好并读写 localStorage，右侧栏还要在内部同步成 list slot；不提供排序时，各区域的 Pin 逻辑只有几行，不值得为 release 修改框架。

**左侧栏拖动排序。** 只有左侧栏使用，三个区域的交互不一致；本版本不提供排序。

**把弹出框做成 Component Factory，“更多”按钮作为局部 slot。** 调用方是三个区域，实现方是插件：Factory 声明放在插件包会形成依赖环（插件依赖的 `ui-plugin-manager`、`ui-workspace` 依赖区域），放在 `ui-layout` 又引用不到插件的文案命名空间，只能把声明拆在两个包里用声明合并补齐。

**插件画整个“更多”（按钮与菜单），区域只提供数据。** 插件要复制三个区域的按钮样式（CSS Module 不能跨包复用），并从区域取得布局状态；按钮样式带有区域的业务特点，应留在各自的区域。

**由插件渲染区域入口。** 左侧栏图标和右侧栏卡片依赖各自的子 slot，插件拿不到区域的 `renderSlot`；ReactNode 也不能作为 props 传递。

**插件未加载时停止应用 Pin 状态。** 唯一收益是插件在用户收起入口后被禁用或加载失败时，入口仍能显示；该情形需要显式禁用默认加载的插件，接受这一限制并在 README 中说明。

**按 Pin 后可见的入口数决定标签条是否显示。** 有其他 View 时全部收起后，标签条和其中的“更多”一起消失，用户无法重新固定。

**公开 `agentPresetNavigation`，或让 `ui-agent-preset` 响应带 `agentPreset` 的 `startSession` 并播放介绍动画。** 前者只为转调 `startSession` 新增服务；后者要修改 `ui-workspace` 与 `ui-agent-preset` 的接口，介绍动画不是本功能的必要部分。

**按区域包命名 localStorage 键。** 以后在 slot 层按 list slot 统一保存时需要迁移已保存的数据。

## 验证

- 三个区域的单元测试覆盖：入口按钮只显示 fixed 或未收起的入口；对 fixed 入口调用 `setPinned` 不生效；`setPinned` 写入并持久化到对应键；localStorage 内容损坏时按空列表处理；已不存在的 id 被保留；actions slot 有注册项时显示“更多”并传入不含 fixed 入口的 `entries` 与回调，没有注册项时不显示；会话头部标签条在只有 Chat 时不显示，有其他 View 时全部收起后仍然显示；右侧栏 id 为 `kind:入口id`。
- 菜单内容组件的单元测试覆盖：入口打开、Pin 切换、空列表时只有底部操作、浏览更多插件与创建插件的调用参数，以及三个注册项在插件释放后移除。
- Web e2e `entry-customization.e2e.ts` 通过真实 Web 组合验证左侧栏：默认显示“更多”，收起后面板按钮消失，仍可从菜单打开，刷新后保持收起，重新固定后恢复。会话头部与右侧栏的“更多”由录制会话的 Web golden 覆盖；`changed-files-turn.e2e.ts` 与 `document-preview.e2e.ts` 断言只有 Chat 时紧凑头部没有标签条。
- 改动的源文件逐文件覆盖率 100%。

## 后果

- 用户收起入口后，若插件被显式禁用或加载失败，被收起的入口保持隐藏且没有菜单可以恢复；恢复方式是重新启用插件或清除对应 localStorage 键。
- localStorage 按协议、主机和端口隔离，更换 Web 端口或在 Web 与 Desktop 之间切换时 Pin 状态不共享。
- client-store 的 persist 读回时不校验格式，三个区域各自在读取处校验；校验逻辑与 owner props 类型在三处各有一份。
- actions slot 位于“更多”菜单内，其他插件只能往里加菜单项，不能在入口旁放置任意控件。
- 右侧栏的键名预留了 `sidebar.right.tab.guide.list`；以后为 guide 入口新增 list slot 时必须使用这个名称，已保存的 Pin 状态才能沿用。
- 扩展接管某个 kind 且使用不同的 guide 入口 id 时，原有 Pin 状态无法对应到新入口。
- 插件默认加载后，录有左侧导航、会话头部标签条或右侧栏起始页的 Web golden 都会出现“更多”按钮。
