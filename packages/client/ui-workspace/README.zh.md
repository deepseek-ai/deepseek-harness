---
description: "dsh Web 客户端的共享 Workspace 浏览器与选择器插件：分组或扁平的会话行、添加/重命名/重排序、搜索、fork、归档，以及目录流选取子 slot。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace

[English](README.md) | 中文

## 概述

`dsh-client-ui-workspace` 是 dsh Web 客户端的共享 Workspace 浏览器与选择器：用户在侧边栏浏览分组或扁平的 Session 行，在 Session Intent 主视觉区为新会话选择 Workspace，并可用添加、重命名、重排序、搜索、fork 与归档操作管理 Workspace 与 Session；两个界面共用同一套 Workspace 菜单与添加流程。待处理的用户交互以琥珀色警告点呈现，活动 Schedule projection 会在普通行与搜索结果中显示不可交互的闹钟，共享侧边栏投影还会隐藏 subagent 来源的会话。不同的规范化路径仍作为由 id 区分的独立 Workspace；添加文件夹走目录流子 slot，由组合的选择器包 client half 填充。

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

用侧边栏浏览 Workspace 及其 Session、重排它们并新建会话；在 Session Intent 主视觉区用选择器为新会话选择 Workspace。打开的 Workspace 默认显示五条非空白 Session，并在首条提示词落地前把当前选中的空白**新会话**作为一条临时额外行。**展开其余**会显示隐藏条目；关闭再打开 Workspace 会恢复该折叠投影。

### 重排序与视图选项

视图选项把分组方式和每个记账各自的一份浏览器持久化 Session 顺序放在一起：**手动排序**和**最近更新**在两种呈现方式下都可用。进入最近更新时会执行一次完整的时间排序，后续 user prompt 或 steer 会将对应 Session 置顶一次；进入手动排序则保留所有当前位置并停用后续置顶。两种模式下的拖拽都会编辑当前顺序；真实 Workspace 在手动模式下的拖拽还会更新 Host Session 记账，而 Ungrouped 和单列表的顺序始终只保存在浏览器本地。折叠分组的拖拽边界按渲染行确定，并把来源行放在中间隐藏行之前，因此拖拽不会隐藏来源行。无论采用哪种 Session 顺序，Workspace 拖拽顺序都由 Host 持久化。

### 搜索

折叠搜索是视图和添加操作旁的一枚区头按钮：激活后输入框会扩展并占据区头。非空白查询会以单一扁平结果列表替代任一浏览模式——不区分大小写的标题和 Workspace 子串匹配项会立即显示，经 250 ms 防抖的 Host 请求则会加入经过排序的当前对话内容匹配项及其摘要片段。每次新查询都会中止前一个请求；内容搜索失败时，元数据匹配项仍会显示，同时给出警告。列表最多显示 20 条结果，打开所选 Session 时不会清除查询。

### 管理会话

Session 行内的 Rename 操作打开一个以该行显示标题预填的对话框；确认未修改的标题是有意允许的——这正是把当前自动标题钉住、不再被重新生成覆盖的手势。Archive 不经确认对话框直接提交，归档集合回声落地后，该行从所有分组视图中消失。Fork 在源会话最后一个已完成轮次处 fork，在客户端递增继承的持久化标题后再打开子会话。Workspace 行内的 Delete 操作会打开确认框，说明保留边界；成功后该分组被移除，其 Session 则留在 Ungrouped 下。

### 待处理交互

Session 行渲染运行时的实时 `pendingInteraction` 分类：审批显示**等待审批**，计划审阅显示**计划待审**，普通问题显示**等待回答**。每个待处理交互都使用一枚琥珀色警告点，优先级高于运行指示器。

### 活动 Schedule 标识

分组与平铺 Session 行以及搜索结果会在 `SessionSummary.projectionValues.schedule` 为非空数组时显示一枚轮廓闹钟。标识位于标题之后；普通行的更新时间仍位于标识之后，搜索结果则没有更新时间。它不是按钮，没有独立 pointer 行为或 Tab stop，点击所在区域仍会打开整行。本地化 tooltip 与同义读屏标签均为**有活动定时任务**。

对于 cold Session，该值有意采用尽力而为语义。身份匹配且可用的 projection-cache 行可以在不打开 Session 的情况下预热闹钟；cache 缺失或陈旧可能造成短暂漏显或残留。标识只表示当前列表值包含尚未 dispatch 或 delete 的 Schedule 记录，不表示 Schedule runtime 当前 live 或能够唤醒该 Session。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是一条组合：两个目标 slot 都由其他插件声明，因此 `apply` 使用 `slots.inject()` 在各自的声明生命周期内完成注册，并在目标 slot 的声明恢复后重新注册。

### 目录流子 slot

每个注册各自声明一个**目录流子 slot**（`single` kind：`conversation.hero.workspace.directoryFlow`／`sidebar.workspaces.directoryFlow`），由组合的选择器包 client half 填入其选取交互——`-native` 后端的无渲染 OS 选择器驱动，`-browse` 组合下则是应用内浏览对话框。平铺显示的**添加工作区…** 操作仅在当前界面的 slot 被占用时渲染；slot 为空意味着该组合没有目录选择能力。本包持有触发与接纳：占用方通过 slot 的属主交互约定（`open`/`busy`/`onPicked`/`onCancel`/`onError`）每次打开上报一个所选路径，owner 通过对象层接纳它，并等待 Workspace 列表投影刷新后才选中已提交的 Workspace。

### 视图状态

Workspace 列表基线就绪后，浏览器持久化的展开状态与 Session 顺序记录只保留当前 Workspace id、Ungrouped 与单列表记账。真实 Workspace 从 `WorkspaceView.sessionIds` 初始化，Ungrouped 与跨 Workspace 单列表从最近更新时间顺序初始化。共享侧边栏投影会隐藏持久化 Session 摘要中带有 `origin: 'subagent'` 的行；每个可见普通行都会在经不间断的 subagent 谱系可达的任一后代运行时继承蓝色活动指示器。同一份纯派生还会为分组、平铺与搜索节点读取列表 projection value 中的 Schedule key；本包只使用纯类型依赖 `@deepseek-ai/dsh-schedule/client`，不会导入 Schedule runtime 或 `ui-schedule`。

### 悬浮卡片

Workspace 与 Session 悬浮卡片会复制对应行被截断的值：激活 Workspace 卡片会写入其完整目录路径，激活非空白 Session 卡片则会写入其完整显示标题。临时的空白「新会话」卡片保持只读，因为其本地化标签是占位文案，并非会话内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖侧边栏宿主、主视觉区界面与选取后端。

- [ui-sidebar](../ui-sidebar/README.zh.md)——承载 `sidebar.workspaces` 子 slot 的侧边栏外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——承载 Session Intent 主视觉区选择器子 slot 的聊天界面。
- [directory-picker-native](../../host/directory-picker-native/README.zh.md)——填充目录流子 slot 的 OS 选择器后端。
- [Workspace Controller](../../api/workspace-controller/README.zh.md)——负责 Workspace 与排序的 Host 变更和框架无关 Client 投影。

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
- **没有 Session 删除与取消归档控件**：会话可以归档，但已归档会话没有查看或取消归档入口；删除 Workspace 注册记录不会删除 Session。
- **待处理的用户交互不会聚合到折叠的分组上**：折叠分组内正在等待的行不会点亮分组头指示，只有展开该分组后才可见。
- **原生文件夹选择依赖本地 Host 载体**：在 `-native` 组合下，进程内部署或远程浏览器部署无法打开本地操作系统对话框；可远程的选取是 `-browse` 组合的应用内流程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是纯消费插件，只注册展示组件和 locale dictionary；inject face 是无状态 RPC wrapper 加 create-and-open 调用，不发出事件或持有跨插件可变状态。
