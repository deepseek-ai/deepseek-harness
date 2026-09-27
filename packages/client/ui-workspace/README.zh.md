---
description: "dsh Web 客户端的共享 Workspace 浏览器与选择器插件：分组或扁平的会话行、管理操作、由 slot 组合的 Session 行 action 与目录选择。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

本包让用户浏览分组或扁平的 Session 列表、为新 Session 选择 Workspace，并通过添加、重命名、重排序、搜索、fork、归档和删除 Workspace 来管理 Workspace 与 Session；Session 行菜单及其悬停按钮是可由客户端插件扩展的 slot 列表。待处理交互显示为警告点，subagent 来源的 Session 则保持隐藏。处于空闲状态且未归档、其 Session 有活动定时任务的 Session 行会显示时钟标记，其悬浮卡片会列出这些任务。规范化后仍有差异的文件夹路径会保留为独立 Workspace。添加 Workspace 需要组合目录选择器；没有目录选择器时，添加操作不可用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用侧边栏浏览 Workspace 及其 Session、重排它们并新建会话；在 Session Intent 主视觉区用选择器为新会话选择 Workspace。打开的 Workspace 默认显示五条空闲的非空白 Session。正在运行的 Session（包括有子会话正在运行的父会话）始终按原顺序显示，不占用这五条配额；当前选中的空白**新会话**在首条提示词落地前也作为额外行。每次点击**展开其余**最多再显示五条空闲 Session；全部显示后，**收起**恢复初始行数，但仍显示正在运行的 Session。关闭再打开 Workspace 也会恢复该折叠投影。

未保存标题的历史会话显示本地化名称「未命名 / Untitled」，不使用目录名兜底。当前空会话仍显示「新会话」，其他空会话仍隐藏。重命名草稿使用已保存标题，无标题时留空；无标题行不提供标题复制。

### 重排序与视图选项

分组和平铺视图都先显示置顶 Session，再显示普通 Session。**最近更新**在各分区内严格按最近一次用户提示词或 steering（中途引导）时间降序排列，置顶时间不影响它。**手动排序**使用同一条完整 Session 序列中的相对位置，包括隐藏的归档项。返回最近更新会丢弃手动布局，再次进入手动排序时冻结当时的时间顺序。浏览器默认采用最近更新，并在重新加载后记住所选模式。

置顶把 Session 移到完整保存序列的首位，但不切换所选模式。它在手动模式下排在置顶区最前，在最近更新模式下则不一定。取消置顶不改变保存的位置。拖拽置顶行或普通行都修改同一条完整序列并选择手动模式，隐藏的归档成员始终保留。缺失的置顶成员按置顶数组顺序补到头部。新增的普通 fork 在完整序列中插在来源之前，不继承置顶成员关系；可见置顶行仍排在普通行之前。其他缺失成员按最近更新时间追加，缺失归档项放在最后。补齐仅在内存中完成，直到一次 Session 顺序写入保存完整结果。单纯切换归档筛选既不改变保存的位置，也不改变成员关系。

当前选中的空白**新会话**保留临时首位且无法拖拽；首条提示词落地后，它成为可拖拽的普通行，在手动排序中保留该位置，在最近更新中按当前时间戳排列。折叠分组的拖拽使用目标 Session 身份，并保持来源行可见。真实 Workspace、Ungrouped 与单列表的 Session 显示顺序都保留在浏览器本地；Workspace 分组的拖拽顺序仍由 Host 持久化。[会话置顶与归档决定](../../../.agents/notes/implemented/feature/2026-09-18-session-pin-and-sidebar-archive.zh.md)记录排序与恢复规则。

### 工作区层级

选择**添加工作区**并选取目录，即可注册工作区并打开 Session。**视图选项 → 分组方式**默认为**按工作区**，将工作区作为同级分组显示。选择**按工作区树**后，每个 Workspace 会位于最近的已注册祖先之下，之后添加的 Workspace 也会自动归入。每个 Workspace 保留自己的 Session 和行操作，子 Workspace 显示在父级自己的 Session 之前。祖先默认展开，已有的折叠偏好除外。保存的折叠状态也会隐藏当前 Session；如果后代 Workspace 包含当前 Session，祖先文件夹图标仍保持高亮。各层级的高亮和点击区域保持整行同宽，仅内容缩进。拖拽 Workspace 仅重排同级项目；落在后代行上时，由最近的兼容祖先接收，因此无需先折叠父级就能将其他工作区拖到其后。选择搜索结果会展开全部祖先。分组方式和展开状态保存在当前浏览器中；切换模式会保留各 Workspace 的展开偏好，单列表视图保持平铺。

层级仅使用已注册的规范路径，不扫描项目，也不解析符号链接别名。嵌套不会改变 Session 的工作目录、日志或 Workspace 归属。删除父 Workspace 后，子 Workspace 仍保持注册，并归入下一个已注册祖先；没有祖先时显示在根层级。

### 搜索

折叠搜索是视图和添加操作旁的一枚区头按钮：激活后输入框会扩展并占据区头。非空白查询会以单一扁平结果列表替代任一浏览模式——不区分大小写的标题和 Workspace 子串匹配项会立即显示，经 250 ms 防抖的 Host 请求则会加入经过排序的当前对话内容匹配项及其摘要片段。每次新查询都会中止前一个请求；内容搜索失败时，元数据匹配项仍会显示，不另给警告。列表最多显示 20 条结果。选择未归档结果会清空并收起搜索、打开 Session，并在当前浏览模式中将其行滚动到可见区域；分组浏览还会按需展开所属 Workspace 和完整 Session 列表。已归档结果提供取消归档操作；尝试打开时会说明限制，不清空查询，也不导航。

### 管理会话

Session 行内的 Rename 操作打开一个以该行显示标题预填的对话框；确认未修改的标题是有意允许的——这正是把当前自动标题钉住、不再被重新生成覆盖的手势。双击标题也会打开 Rename；对于未归档 Session，先发生的点击会打开其对话。Rename 使用临时 `workspaceOperation` reference，并等待首次历史打开。行内 Fork 在源会话最后一个已完成轮次处 fork，通过 Session Controller 递增继承的持久化标题，不 retain 子会话、不打开其历史，也不改变选择。Workspace 行内的 Delete 操作会打开确认框，说明保留边界；成功后该分组被移除，其 Session 则留在 Ungrouped 下。Pin、Rename、Fork、Archive 本身就是 `sidebar.workspaces.session.menu.item` 列表的条目（pin 与 archive 同时也是 `sidebar.workspaces.session.row.action` 的条目），因此客户端插件的 action 由其 `order` 决定落在哪个位置。

对静止的 Session，Archive 不经确认对话框直接提交，并保留 Session 的记账位置。仍有工作在跑的 Session 是唯一会先询问的情形：Host 拒绝普通归档并列出这些工作，侧栏随即打开"停止并归档"对话框，按族列出——进行中的回合、运行中的子代理、后台任务、定时提醒，各带名称——并写明恢复路径；确认后请 Host 按停止按钮同样的方式停止这些工作，归档集合持久化后即完成归档，停止在后台收敛；取消则让 Session 继续运行并保持可见。视图选项以一组显式三选一控制显隐：隐藏已归档（默认项）隐藏已归档 Session，全部对话（显示已归档）将其纳入列表，仅显示已归档则隐藏普通 Session，并丢弃没有归档 Session 的 Workspace；树形分组下，被丢弃 Workspace 的子级挂到最近一个仍显示的祖先下。可见的归档行置灰，并提供无障碍说明，告知取消归档后才能打开；Rename、Fork 与取消归档仍然可用。归档成功后的提示提供"撤销"动作，并在归档行仍被隐藏时附带"筛选已归档会话"动作，后者直接把筛选切到全部对话（显示已归档）；停止并归档显示同样的提示但措辞不同，撤销只恢复 Session，不会让被停止的工作继续。取消归档移除归档标记，但不恢复置顶，也不改变保存的位置。列表为空时显示居中的"图标在上、文字在下"占位；仅显示已归档视图用自己的文案（暂无已归档会话），并附"查看其他会话"文字按钮，点击把筛选切回隐藏已归档。

会话更新时间使用 tertiary 文本色，包括已归档行。标题宽于所在行时，静止状态以省略号裁切。把指针停在行上，标题会滚动到远端——例如 fork 递增后的标题——并在揭示时不显示省略号；指针离开后标题回到开头。

快捷键速查提供新建会话、搜索会话、添加工作区、重命名会话、分叉会话和归档会话。桌面默认使用平台的主修饰键，搜索为 Mod+K；Windows 和 macOS Web 使用[快捷键服务的平台默认值](../shortcuts/README.zh.md)；Linux Web 在用户配置前不绑定这些命令。按钮提示和会话行菜单显示当前有效绑定。点击菜单项操作该行，按快捷键操作主会话。Windows 和 macOS Desktop 的绑定也可从终端输入区域和模态对话框中执行；其他环境遵循命令的区域和模态限制。搜索和重命名的打开请求归本包管理，输入草稿保留在浏览器中。目录选择或工作区接纳尚未结束时，目录选择器拒绝重复打开。分叉捕获源会话，并使用会话行相同的 Host 操作选择最近已完成轮次，不读取更早的 Client 历史。没有会话或会话为空时不可用；没有已完成轮次的源会话由 Host 拒绝。快捷键分叉被拒绝时保留当前选择、显示本地化提示，并允许重试；非预期失败还会保留诊断日志。

### 待处理交互

Session 行渲染运行时的实时 `pendingInteraction` 分类：审批显示**等待审批**，计划审阅显示**计划待审**，普通问题显示**等待回答**。交互待处理期间，该行使用共享 warning 橙点，并以**待批准**、**计划待审**或**待回答**替换尾部更新时间；悬停详情仍保留完整状态和相对时间。待处理交互的优先级高于共享 ongoing loading；已完成但未查看的 Session 使用 done，idle 在行内不显示点，在悬停详情中使用共享 idle 灰点。 行首 seat 仅在该行的主状态为 idle 时渲染——没有待处理交互、没有自身或后代活动、也没有未查看的完成提醒——因此该处的占用方不会与行自身的状态点同时出现。归档行该格整体留空：既不显示状态点也不挂 seat，其活动状态只出现在悬浮卡片上。

### 活动 Schedule 标识

当成组的与平铺的 Session 行所对应的 Session 存在活动定时任务时，该行显示时钟标记。它是行首 `sidebar.session.row.leading` seat 的占用方，因此仅在该行主状态为 idle 时渲染，绝不与行自身的状态点同时出现；归档行该格同样留空，搜索结果没有该 seat，也不显示标记。它不是按钮，没有 Tab stop，点击其所在区域不会打开整行。标记自身的读取及其「活动」条件的确切含义由 [ui-schedule](../ui-schedule/README.zh.md) 负责。

-----

`ctx.uiWorkspace.openSession(target)` 会同步替换其拥有的 `mainView` reference，并让主区域返回 Conversation，而不等待 `reference.ready`，因此历史加载会显示在已经选中的 Session 视图内。目标可以是已知 Session id，也可以是持久的直接父子 subagent 地址；显式地址不要求预先加载 parent catalog。`openWorkspace(id, beforeOpen?)` 仅在请求未被后续导航替代时打开结果；新会话使用 `openWorkspace`。`forkSession(id)` 创建子会话，不导航，也不替代尚未完成的导航。可选的同步准备回调在目标被 retain 后执行，并且仅对仍有效的 Workspace 请求执行，因此过期请求不会搬移 composer 草稿。后续导航或 owner 释放会阻止晚到的 UI 提交，但不取消底层 Session 创建。启动恢复会 retain 主 reference，不改变已选面板，也不取消后续导航。归档主 Session 会释放其 reference 并清除主选择。选择失败时保留当前全局面板。Session 行读取 `usePanelInfo`，在全局面板活跃时不显示 Session 选中样式；仅把焦点移到搜索框或目录选择器不会离开该面板。

导航和启动恢复通过所选 Session 的 `follow` 获取投影，不会另行刷新该 Session 或其父会话的投影。

新建会话尝试获取列表中第一个符合条件的空白会话；启动恢复尝试已保存的空白会话。若该写锁被占用，导航直接新建 Session，不再尝试其他空白会话。其他获取错误会中止请求：显式新建会话或在 hero 中选择工作区时，失败以短暂提示展示，引用 Host 的错误码和消息（例如 preset 挂载失败），非 Host 拒绝的失败则显示其自身消息；已被后续导航或 owner 销毁取代的请求不弹提示，启动恢复仍只报告到控制台。已释放的空白会话被复用时保留 slash 命令状态。后续导航会取消尚未完成的启动选择。

Workspace 和 Session 的启动基线均就绪后，空安装环境调用 `workspaces.initializeDefault`，创建或复用其空白 Session。选中该 Session 后输入框才可编辑，不会自动提交消息。后续导航或所属上下文销毁会阻止启动流程选中其结果。不符合首次使用条件时仍可选择文件夹，不显示错误。默认工作区创建失败时显示短暂提示，引导用户通过“选择工作区”选择文件夹，直到下次启动才重试。Session 创建失败沿用普通的恢复错误处理。登记成功的工作区在 Session 创建或后续提交失败时仍然保留。

首次使用的目录名与其存储标题都是固定的，都不跟随读者语言：`workspaces.initializeDefault` 不携带任何名称，同一安装环境在切换语言后仍只有一个磁盘路径和一个存储标题。仍保留该自动标题的工作区，在本包展示它的所有位置——侧栏行及其悬浮卡片、搜索结果元信息、hero 选择器菜单、重命名与删除对话框——都通过控制器的 `workspaceDisplayTitle` 显示为本地化的默认名称。重命名对话框以屏幕上的标签作为初值，而判断确认是否需要保存用的是存储标题，因此对这类工作区直接确认未改动的初值即可固定该名称，该行不再跟随语言；重名检查按工作区身份而非标题排除目标自身。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是一条组合：两个目标 slot 都由其他插件声明，因此 `apply` 使用 `slots.inject()` 在各自的声明生命周期内完成注册，并在目标 slot 的声明恢复后重新注册。

浏览器入口还为每个 Session 行声明两个 root 作用域的 `list` 子 slot：`sidebar.session.row.leading` 仅在该行主状态为 idle 时渲染、归档行留空，`sidebar.session.row.hover` 仅在该行的悬浮卡片打开时挂载。两者只接收行的 Session 身份，占用方据此读取自己的数据；Session 作用域的 slot 会强制建立 Session 绑定，从而激活并保留列表中每个 Session。

### 目录流子 slot

每个注册各自声明一个**目录流子 slot**（`single` kind：`conversation.hero.workspace.directoryFlow`／`sidebar.workspaces.directoryFlow`），由组合的选择器包 client half 填入其选取交互——`-native` 后端的无渲染 OS 选择器驱动，`-browse` 组合下则是应用内浏览对话框。平铺显示的**添加工作区…** 操作仅在当前界面的 slot 被占用时渲染；slot 为空意味着该组合没有目录选择能力。本包持有触发与接纳：占用方通过 slot 的属主交互约定（`open`/`busy`/`onPicked`/`onCancel`/`onError`）每次打开上报一个所选路径，owner 通过对象层接纳它，并等待 Workspace 列表投影刷新后才选中已提交的 Workspace。

### Session 行 action

Session 行的 "..." 菜单和行尾悬停按钮是 WorkspaceBrowser 注册项声明的两个 `list` slot：`sidebar.workspaces.session.menu.item` 与 `sidebar.workspaces.session.row.action`。每一个菜单行、每一个悬停按钮都是条目，本包自己的 action 也不例外：`apply` 以客户端插件注册自己 action 的同一方式注册 `pin`（菜单 100、按钮 200）、`rename`（200）、`fork`（300）、`archive`（菜单 400、按钮 100），因此插件 action 落在其 `order` 所指的位置，以另一个 `priority` 复用内置 id 则遮蔽该 action。

条目只接收行身份（`sessionId`、`displayTitle`），其余一切自己负责：用自己注入的 hook 读自己关心的 Host 状态（置顶与归档集合，以每次 Workspace 快照只派生一次的 Set 形式），自己决定是否显示（Host 规定归档与置顶互斥，所以 pin 在归档行上不渲染），整套行为放在注册项自己的 `inject` face 里（置顶成功后顺带把会话推到保存顺序最前，归档成功后发提示），浮层也自己带——重命名对话框、停止并归档对话框和行 action 的提示是本包注册在 `shell.overlay` 的条目，由 action 注入的请求驱动。菜单条目渲染一个 `role="menuitem"` 的按钮（本包自己的行用 ui-primitives 的 `MenuItemButton`，它带宿主样式，开启新分组的行加 `separatorBefore`，分隔线随行一起出现和消失），并通过 slot 级 `useMenuOpenState` hook（菜单自身的打开状态，从该行的渲染出现处绑定）关闭菜单；悬停按钮条目渲染一个图标按钮，按钮条会拦住点击、不让它打开该行。browser 不再向行传任何 action 回调，它剩下的动作只有搜索结果里的恢复按钮和标题双击，后者发出的是同一个重命名请求。

#### 打包客户端插件

按照 Client 依赖规则，将 `ui-workspace`、`ui-slots`、`ui-renderer`、`client-locale` 与 `ui-primitives` 声明为浏览器／类型开发依赖。纯类型的 `ui-workspace/client` import 会加载本包的 `SlotMap` 声明；缺少该 import 时，独立编译的插件不会知道这些 slot key。Component 保持模块级稳定身份；用户可见文案由贡献包自己的 locale namespace 持有。

```tsx
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace, LocaleDictOf, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { exportSession } from './export-session.ts'

const NS = 'acme.sessionActions'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'acme.sessionActions': 'export'
  }
}

const en: LocaleDictOf<typeof NS> = { export: 'Export {title}' }
const zh: LocaleDictOf<typeof NS> = { export: '导出 {title}' }

interface ExportRowInjected {
  exportSession: (sessionId: SessionId) => void
}

type ExportRowProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<typeof NS>
  & InjectFace<ExportRowInjected>

function ExportRow({ sessionId, displayTitle, useMenuOpenState, exportSession, t }: ExportRowProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton separatorBefore onSelect={() => { setMenuOpen(false); exportSession(sessionId) }}>
      {t('export', { title: displayTitle })}
    </MenuItemButton>
  )
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'acme-session-actions: dictionaries')

  // Order 500 places the row after the shipped Archive (400); `separatorBefore` opens the plugin group.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'acme.export-session',
    order: 500,
    locale: NS,
    inject: (): ExportRowInjected => ({ exportSession }),
  }, ExportRow))
}
```

即使 owner 通常已经存在，也必须使用 `ctx.slots.inject()`：它等待声明，在声明折叠时移除贡献项，并在声明恢复后重新注册。注册项的 `inject` factory 可以闭包使用插件已声明的 Cordis service；Component 只接收投影后的数据和 callback。悬停按钮以同样方式注册到 `sidebar.workspaces.session.row.action`，渲染一个图标按钮。

#### 动态客户端包

动态加载的 browser half 采用同一套组件协议，能拿到哪些模块取决于它走哪条 lane。Module Loader 包（`factory(require)`，即真实 Loader/Web fixture 那种）把 `@deepseek-ai/dsh-client-ui-primitives` 当作隐式 baseline external：通过 loader 的 `require` 解析 `MenuItemButton`，不要把 primitive 列为运行时依赖或打包另一份副本，仅在源码编译需要其类型时声明开发依赖。`cordis-client-runner` 闭包（生成的 Client Slot catalog 面向的读者）无法 import 任何东西：它用 `React.createElement` 渲染自己的 `role="menuitem"` `<button>`，样式经 `styles.insert` 注入，并通过同一个 `useMenuOpenState` hook 关闭菜单，catalog 里的示例就是这个写法。

### 视图状态

Workspace 基线就绪后，浏览器持久化的展开状态和 Session 顺序记录只保留当前 Workspace id、Ungrouped 和单列表记账。`WorkspaceView.sessionIds` 提供真实 Workspace 的成员关系，而不提供 Session 显示顺序。视图操作接收完整记账顺序，而不是筛选后的行。尚无 Session 摘要的新成员会等待摘要，已保存的位置则在摘要暂时缺失时保留。归档显隐仅在派生行时应用。置顶和拖拽写入完整顺序，普通派生不执行写入。当前选中的空白 Session 仍是一次显式位置写入；Workspace 重连时同样如此，此时保留其他已保存成员，直到基线确定成员关系。侧边栏收成窄栏或搜索替代列表主体时，排序仍保持挂载。最近更新从当前摘要派生，不读取已保存位置；时间相同时按 Session id 稳定排序。

侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。可见普通行的共享 ongoing loading 来自其已加载 parent 目录中正在运行的直接 child，绝不来自摘要谱系。Child 活动状态使用最新 UI status，尚无该状态时使用 Session 摘要。

行动画由 [AnimatedRows](src/client/rows/AnimatedRows.tsx) 负责。它仅在 React 提交改变行成员或顺序时读取更新前后的位置，并使用浏览器原生位移与透明度动画。被移除的行以不可交互的副本在滚动列表外淡出，不会延迟 React 卸载，也不会扩大列表的滚动范围。初始加载、拖拽提交、展开其余会话和视图选项变化直接完成。动画组件不使用布局观察器或轮询，也不会因仅内容更新或滚动而测量位置。

### 悬浮卡片

Workspace 与 Session 悬浮卡片会复制对应行被截断的值：激活 Workspace 卡片会写入其完整目录路径，激活非空白 Session 卡片则会写入其完整显示标题。临时的空白「新会话」卡片保持只读，因为其本地化标签是占位文案，并非会话内容。 Session 卡片在卡片打开期间还会在相对时间与行尾状态行之间渲染 `sidebar.session.row.hover` seat，与行自身状态无关。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖侧边栏宿主、主视觉区界面与选取后端。

- [ui-sidebar](../ui-sidebar/README.zh.md)——承载 `sidebar.workspaces` 子 slot 的侧边栏外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——承载 Session Intent 主视觉区选择器子 slot 的聊天界面。
- [directory-picker-native](../../host/directory-picker-native/README.zh.md)——填充目录流子 slot 的 OS 选择器后端。
- [Workspace Controller](../../api/workspace-controller/README.zh.md)——负责 Workspace、成员关系与 Workspace 分组顺序的 Host 变更和框架无关 Client 投影。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义搜索深度、归档界面与选取载体；它们是当前包约束。

- **没有模糊内容搜索或事件深链接**：内容后端采用字面 token/短语匹配，选择结果会打开 Session，而不是匹配的事件。
- **没有 Session 删除**：会话可以归档但绝不会被删除；已归档的行通过「已归档会话」视图筛选与搜索结果中的取消归档操作原位恢复，删除 Workspace 注册记录不会删除 Session。
- **待处理的用户交互不会聚合到折叠的分组上**：折叠分组内正在等待的行不会点亮分组头指示，只有展开该分组后才可见。
- **原生文件夹选择依赖本地 Host 载体**：在 `-native` 组合下，进程内部署或远程浏览器部署无法打开本地操作系统对话框；可远程的选取是 `-browse` 组合的应用内流程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是一个纯消费方插件，只向两个由宿主声明的 slot 注册展示组件，并注册自身的 locale dictionaries；inject face 由无状态 RPC 包装层和一次 create-and-open 调用组成；本插件不发出 Cordis 事件，也不持有跨插件可变状态。
