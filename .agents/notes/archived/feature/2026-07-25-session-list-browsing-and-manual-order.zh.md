# Agent Note: Session 列表浏览与 Workspace 手动排序

Status: implemented
Archived: 2026-09-04

[English](2026-07-25-session-list-browsing-and-manual-order.md) | 中文

## 问题

[Workspace UI 完整产品流](2026-07-25-workspace-ui-product-flow.zh.md)交付了分组 session 列表的首个形态，并把 Rename、拖拽排序等操作明确划出当期范围。设计稿（figma 239-10458 及关联画面）随后补齐了这些交互：列表要能切换成不分组的平铺视图、session 行悬停要出详情卡与操作菜单、workspace 要能改名、组内 session 要能手动排序。

两条既有机制挡在前面。其一，host 在每条 `session/event` 上把活跃 session 持久化地提到 workspace 账本最前（活动置顶），任何手动排序都会被下一次活动打乱——两种排序权威不可调和。其二，浏览区域被劈在两个包里：ui-sidebar 拥有列表、搜索和组头行，而 ui-workspace 只借一个 picker slot 放弹层；每加一个 workspace 域的对话框都要跨包接线，归属越来越拧。

## 决策

### 平铺行与浏览态

group-by 菜单提供 WorkSpace / In one list 两种模式。WorkSpace 模式按 `WorkspaceView.sessionIds` 的手动序在各组内展示同级 session 行；In one list 把所有 session 合并后严格按 `updatedAt` 新→旧排序。两种模式都不把 `parentId` 投影成列表层级，fork 谱系只保留为 session 数据；完整 fork 行为由 [Web session fork 操作](2026-07-27-web-session-fork-actions.zh.md)定义。模式选择持久化在浏览器（`dsh.workspace.view`），刷新后仍保持。[Workspace 侧边栏顺序与折叠](2026-08-11-workspace-sidebar-order-and-folding.zh.md)随后加入浏览器本地的最近更新视图，而未改变 Host 记账的手动顺序权威。

### 行交互

- session 行悬停 500ms 出详情卡（完整标题、相对时间、状态行；在 wire 增加 status 字段前，状态行只有 running/idle 两态）。卡片与行菜单互斥：菜单开启或拖拽进行中不出卡。
- session 行 … 菜单：Rename / Fork session / Delete session，其中 Rename 与 Fork 已接线，Delete 仍为纯视觉；workspace 组头 … 菜单的 Rename / Delete workspace 均已接线。菜单鼠标移出即关。
- 支撑件：`Menu` 新增 label 条目、danger 行、`closeOnPointerLeave`；新增 `HoverCard`（portal 定位、开启延时、disabled 守卫）。

### workspace.rename

`workspace.rename({ workspaceId, title })`：title trim 后非空；同名 no-op 与重名查重都在 Host 的 Workspace 操作串行链内求值（与按路径收编和删除共链，并发的 Workspace 操作不能穿插出重名或乱序假成功），冲突返回 `workspace-name-conflict`。按路径收编可以派生出已有 title，因为拥有身份的是 canonical path，而不是 title（见[身份决策](../bug-fix/2026-07-31-same-basename-workspace-adoption.zh.md)）。落盘经 `setTitle` 的 mutate 通道，`domain/changed` 监听自动广播 `host/workspace-changed` 帧。UI 为标准 Modal，client 侧另做重名预检。

### 手动排序：insertSessionBefore 取代活动置顶

`session/event` → `touchSession` 活动置顶链整体删除；workspace 账本顺序现完全由手动排序决定——新 session attach 时前插，显式重排走 `workspace.insertSessionBefore({ workspaceId, sessionId, beforeSessionId? })`（DOM insertBefore 语义：给定锚点时插在锚点前，省略则追加到末尾）。实体只对不在账的 session/锚抛类型化的 `WorkspaceMoveInvalidError`，handler 仅把它映射为业务码 `workspace-move-invalid`，存储故障保持 internal。

UI 为组内 session 行的 HTML5 拖拽（仅 workspace 分组、非搜索态；fork 子会话及其源会话各自独立排序）。顺序权威完全在 host：drop 只发 RPC，client 零本地重排，视图靠响应体 upsert 与 changed 帧刷新；失败即无事发生。client 的 upsert 拒绝比已装载投影更旧（`updatedAt`）的快照，防迟到的一元响应回滚较新的帧。

### 壳/区域切分

ui-sidebar 缩为列几何壳：品牌行、折叠状态机、New Session、Settings，以及一个 `sidebar.workspaces` 洞；壳与区域的约定只有两个事实 `{ wide, expandSidebar }`。ui-workspace 全权拥有浏览区域（section header、搜索、分组树与平铺、全部 workspace 对话框、拖拽）及其 groupBy store；rail 态的搜索、添加工作区图标也归区域，经 `expandSidebar()` 请求壳展开。picker 拆为核心件 `WorkspacePickFlow`（区域内直接组件组合；在[单一路径 Note](../simplification/2026-07-31-one-route-to-add-a-workspace.zh.md)之前名为 `WorkspaceCreateFlow`）与薄包装层 `WorkspacePicker`（继续填 ui-conversation 的 hero slot）；原 `sidebar.workspace` picker slot 与声明感知延迟注册随之删除。

## 考虑过的替代方案

**保留活动置顶、拖拽仅作临时调整**——手动序在下一次 session 活动即被打乱，形同虚设；两种排序权威并存无法向用户解释。也考虑过「拖过一次即冻结该 workspace 的活动置顶」的折中，状态多一档、语义更难讲，直接删除更干净。

**排序报文用数字下标**——`{ index }` 在拖拽窗口期会漂移：host 前插新 session（如 Intent 材料化）后同一下标指向别的行。锚点式 insertBefore 对前插与过滤投影天然免疫。

**drop 后乐观重排**——client 先行重排需失败回滚，对象层多一块纠缠态；本地、局域网往返毫秒级，等 host 响应的简单方案肉眼无感。顺序权威单一化（完全信 host）后，前端永不发明顺序。

**rename 对话框留在 ui-sidebar（最小改动）**——正是问题本身：workspace 域的对话框散落在借来的坑里，每加一个（Delete 确认框将至）都重演跨包接线。只挪 rename Modal 会在下一个对话框上重演这份接线；整个浏览区域归 ui-workspace，壳只留几何。

**WorkSpace 模式按 fork 谱系嵌套 session**——嵌套会让当前子会话依赖祖先展开态才能可见，也让组内手动序只能移动根节点；`parentId` 是 lineage 数据，不是列表导航结构。所有 session 拍平成同级行后，每行都可独立打开、搜索与排序；In one list 仍因没有 workspace 持久化载体而禁用拖拽。

## 后果

- 手动序是 Host workspace 账本的唯一顺序权威：活动绝不改动 `WorkspaceView.sessionIds`。后续加入的浏览器本地最近更新视图可以把活跃行提到最前，但不会改变该账本；其独立语义见 [Workspace 侧边栏顺序与折叠](2026-08-11-workspace-sidebar-order-and-folding.zh.md)。
- 壳/区域两事实约定把 workspace 域的后续功能（Delete 确认、跨组移动、Ungrouped 收编）全部收进 ui-workspace 单包；ui-sidebar 不再随 session 列表功能演进。
- 平铺模式不支持重排，也没有在指定 workspace 中创建 session 的入口（需切回分组视图），是拍板接受的范围收窄。
- session Delete 的功能接线与扩展 wire 状态枚举，留待后续迭代。

## 测试

包级用例覆盖派生（deriveGroups/deriveFlat）、同级 session 行、两处 apply 注册与透传、host 实体移位语义、rename/insertSessionBefore 的 RPC 实现与 fixture（测试前置数据）桩；`apps/web` keyless 快照回归覆盖装配后的应用，并钉住 fork 后没有 session 展开控件。
