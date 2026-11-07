---
description: "dsh Web 客户端的 subagent 对话目录、续接路由 UI 与 '@' 引用 source。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent

[English](README.md) | 中文

## 概述

从父会话页头浏览本地子代理对话与外部任务。本地对话展示活跃状态、token 用量和耗时；可继续子代理接受后续提示词并支持 Stop。外部任务显示为不可打开的叶子项，不展示执行状态。历史一次性对话以只读记录打开。普通侧边栏省略子代理对话；独立的 `@` 来源插入运行中子代理的标签，不授予继续执行权限。

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

会话页头的普通面包屑使用会话标题。subagent 面包屑优先使用创建时的原始描述（`entry.label`），其次使用智能体名称（`entry.name`），最后回退到 Session id。普通与 subagent 面包屑标题均使用 14px 文字和 20px 行高。当会话的直接目录有子项或读取失败时，后代数量触发器渲染在页头操作区中预设标签之后，不带任何面包屑分隔符。目录缺席或为空时隐藏数量触发器，除非根 Session 已开启且可用的 Team 任务板有共享任务或任务记录错误。仅开启 Team 模式不会显示空入口。触发器打开该直接目录，以总数作为无障碍名称、运行数作为无障碍描述，并在用户显式打开时发现下一层目录。选择任意深度，即可用该子会话的确切 `{parentSessionId, childSessionId, mode}` 地址打开其对话；也可以使用非当前本地行的行尾箭头在右侧 Sidebar 打开同一地址，并在空间允许时优先使用独立分栏。

本包注册 `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>` 资源与 builtin Sidebar tab 类型。资源直接根据地址保留 child 的 `SessionReference`，不刷新 parent 目录，并在 tab 记录关闭时释放 reference。tab 通过 `sidebar.chat.conversation` 渲染共享 `conversation.content` Factory，把局部 View 固定为 Chat，并省略主 Conversation 的 Header 与宽度控制。

每个打开的目录菜单宽度均为 360px，外层内边距为 6px，并受布局视口可用宽度约束。仅当 Team 模式已开启、存在至少一个未删除的共享任务且 footer 扩展可用时，根菜单才显示不可折叠的“子智能体”和“共享任务”标题。“子智能体”标题使用 Users 图标，仅统计直接条目，依次显示已完成、进行中、未运行和外部任务数量；省略零值，分隔符与输入区任务列表一致。外部任务不计入运行中或已完成数量。空的“子智能体”区域仅在同时展示共享任务时显示“暂无子智能体”。Team 模式关闭或没有共享任务时，菜单仅显示 subagent 列表，不显示区域标题、共享任务模块、空状态文案或分隔线；真实的任务记录错误仍以独立警告显示。共享任务上方保留 4px 外边距，不显示分隔线。两个区域标题均保留 7px 图标与文字间距，并在统计数量前额外留出 4px。仅菜单本身滚动，各区域不单独滚动。在兼容 WebKit 的浏览器中，原生 5px 滚动条位于右侧 6px 内边距内，轨道两端内缩，并保留稳定的滚动条空间，使内容在需要滚动时保持原有宽度。其他浏览器保留标准原生滚动条。

根会话目录通过 `conversation.session.header.actions.subagent.footer` 提供共享任务扩展。子会话与祖先面包屑目录只显示导航，不显示区域标题。

宽布局下，根会话数量触发器在没有运行中 child 时，于 14px 图标位内显示 14px Users 图标，否则显示共享 ongoing loader，不带下拉箭头。标题行变窄时，静态预设文字在宽度不超过 540px 时隐藏，数量文字在不超过 460px 时隐藏。紧凑触发器始终显示 Users 图标，包括 child 运行期间；运行指示器仍在菜单内显示。它与更多及侧边栏控件一致：28×28px 操作区域，无内边距，15px 图标位内显示 15px 图标，使用次级前景色以及 ghost 悬停和按下背景。页头操作在紧凑布局中间距为 8px，宽布局中为 10px。纯图标工具提示提供完整数量。调整宽度不会丢失触发器焦点。subagent 切换器保留描述优先的文本与原有图标。

### 浏览目录

数量、负责人及侧边栏操作的工具提示在悬停 500ms 后显示。悬停文字可见的触发器 150ms 后打开目录；指针离开触发器和目录后，经过 120ms 关闭。点击后代数量触发器会打开并固定目录，或关闭已固定的目录。纯图标数量触发器不会因悬停而打开，包括等待悬停打开期间切换到窄布局的情况。点击可切换固定菜单的开关状态；ArrowDown 会打开并固定菜单，并将焦点移至首行。点击外部或按 Escape 可关闭已固定的菜单。点击会将焦点移入面板，此时 ArrowDown/Home 进入首个树行，ArrowUp/End 进入最后一个树行；Escape 在焦点原本位于面板内时将其送回。点击面包屑标题会导航至对应会话。

目录行在智能体名称上方显示创建描述，缺少创建描述时使用可用的 Session title；名称在同级子智能体中唯一。没有名称的历史目录项在相同位置显示 Session id。两者均缺少时，该行仅显示名称或 Session id。导航、行身份与 Sidebar 地址始终使用 Session id。本地行使用紧凑的 4px 垂直内边距；可点击内容使用 6px 水平内边距和 7px 间距，与共享任务行对齐，同时保留树的左侧偏移。当前对话在行尾显示装饰性对勾，该对勾不是操作控件；其他本地行保留侧边栏箭头。主标题使用 13px 文字，次级名称使用 12px。所有行均将描述与名称换行完整展示，包括在触屏上。running 使用共享 ongoing loading，最近一个已结束轮次正常完成的 inactive child 使用共享 success 绿点，其他 inactive child 使用共享 idle 灰点。每行都为状态图标预留相同的 14px 列宽，并将较小的圆点居中，使 title 与 loading 状态对齐。文字可见的页头触发器会垂直居中活动图标与数量，并保留 4px 水平间距。尾随列在上行显示提供方的持久化 token 用量总计，在下行显示活跃轮次耗时。键盘导航：ArrowRight/ArrowLeft 展开和折叠分支；ArrowUp/ArrowDown、Home、End 与 Escape 用于导航或关闭树。没有 label 的 one-shot 行回退到其会话 id。只有确认存在下级的行才显示展开箭头。点击或通过键盘打开菜单时，读取当前目录及其直属子节点的目录；展开分支时对该分支执行相同操作。每次打开操作通过现有投影读取器依次读取直接子节点，复用已完成的读取并合并进行中的请求，不递归发现更深层后代。悬停与渲染不触发读取。已开始的单层读取可能在菜单关闭后完成。缺少目录的行不显示展开箭头或未知标记；共享投影更新确认存在下级后显示箭头，并保持 agent 活动状态图标。读取失败时保留导航操作并提供重试。

### 续接对话

可继续 child 保留普通输入和独立 Stop 操作，不受创建者在线状态影响。提示词经由 `subagents/prompt` 路由，由运行时校验创建地址和在线 Team 根；失败使用普通提示词错误反馈。Stop 经由 `subagents/interruptByUser` 路由。

### `@` 引用 source

`@` source 仍然刻意保持独立且惰性：候选是从 `ctx.sessions.list` 零 RPC 得到的运行中 child；pick 会插入字面文本 `@label `，codec 投影为 `@label`。它不参与命令裁决，也不会把 label 解析成继续执行地址。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[子代理运行时](../../subagent/subagent/README.zh.md)负责 continuation 与中断；[对话参考](../ui-conversation/README.zh.md)说明编辑器行为。

### 目录派生

页头谱系 renderer 通过标准 `useSessions` 钩子，仅从 `projectionsBySession` 读取 `subagentCatalog`。Session 对象层将列表缓存提示、显式读取和 Host 全局 control 流合并到这些共享值；实时帧更新已加载层级，无需每个菜单单独订阅。活动状态优先使用统一 UI status，缺少时使用 Session 摘要；摘要还提供标题与用量。渲染与悬停仅使用本地投影，不会请求缺失目录。尚未读取的空菜单显示“尚未加载子智能体”；仅请求进行中显示加载提示。缺失或显式为空的目录没有展开箭头；后续共享投影包含下级时才显示箭头。读取失败后需要显式重试。需要迁移的行保留打开历史的操作，不显示格式提示，也不展开下级；打开 Session 后，历史与 control 投影提供其目录。外部行始终为叶子，不加载子 Session。

每个页头入口在树下方声明 footer 插槽。可选 UI 通过该插槽加入同一滚动容器；目录负责打开和关闭。CSS 锚点让面板跟随触发器，并按布局视口限制尺寸。浏览器缩放和平移时面板随页面移动，因此可以超出视觉视口。内部滚动、悬停行为、点击固定展开和焦点恢复保持独立。

显式激活菜单、展开分支或重试失败读取时，`prepareCatalog` 读取当前目录及其直接子节点。点击祖先标题会导航到该 Session。Session 对象层合并重复读取，并在重连后刷新之前请求过的投影。

面包屑地址从 Provider 所绑定的 Session 地址、已加载的 parent 目录或已列出的 subagent 谱系推导，也包括从未选中过的祖先。

### 耗时、完成状态与 token

每个可见目录层在包含运行中 child 时独立推进时钟；折叠该层或关闭菜单会释放时钟。token 用量总计为四个互不重叠的 `tokenUsage` 桶之和。`subagentTiming` 投影会累加已结束轮次的耗时，并提供 `latestTurnCompleted`，用于成功圆点与已完成数量；新轮次开始时会清除该完成状态，直到自身的 `turn/end` 到达。耗时仅在运行中 child 存在未结束轮次时每秒递增一次，并在 child 变为 inactive 后冻结；被中断的未结束轮次以其同一切面的 `active.through` 为上界，绝不使用更新的会话元数据。

### 编辑器选举

one-shot 和模式未知的 child 选用只读编辑器。可继续 child 经由 `subagents/prompt` 路由提示词。本包绝不接收宿主上下文，也不调用面向模型的工具。

模式未知的目录项仍可见、可点击，没有标签时显示子会话 id。读取子历史并确认受支持模式前，输入区保持只读；读取失败在该子会话中报告。

会话树菜单高亮遵循[标准菜单边缘几何](../../../docs/ui-radius.zh.md#nested-hover)。每个分支展开控件的点击区域覆盖左侧 28px 空间与所在行的完整高度，不与相邻行重叠；仅原位的 12px 图标旋转，点击展开控件不会触发行导航或侧边栏导航。悬停展开控件仅高亮箭头；悬停导航主体或键盘聚焦时仍保留背景高亮。细连接线使用三级边框颜色，与首行图标中心对齐，跨过预留的展开控件空间连接叶子状态图标，末端竖线止于对应图标中心。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖对话界面、宿主 seam 与设计笔记。

- [ui-conversation](../ui-conversation/README.zh.md)——承载页头操作与编辑器链的聊天界面。
- [ui-input-trigger](../ui-input-trigger/README.zh.md)——承载 `@` source 的建议机制。
- [subagent](../../subagent/subagent/README.zh.md)——可继续 child 背后的宿主能力 seam。
- [历史Web subagent 对话](../../../.agents/notes/archived/feature/2026-07-27-web-subagent-conversations.md)——目录与编辑器规范。
- [当前轮次中断](../../subagent/subagent/README.zh.md)——独立 Stop 的语义。

-----

<a id="model-experience"></a>
## 模型体验

### 用户提示词中的 subagent label 文本

#### 模型看到的内容

只有 `@` 引用 source 会影响模型输入：pick 的候选以字面文本 `@label` 进入普通用户消息，没有专用内容块或宿主侧解析。浏览目录、导航 child 与查看持久化 transcript（文本记录）都不会添加提示词 section；已接收的继续交互内容会经宿主 subagent 适配器成为普通 FIFO 用户消息。

#### Token 影响

有条件且仅追加：字面 `@label` 或用户后续消息只会向对应的新用户消息增加 token。目录与 transcript 操作增加零模型 token。

#### KV Cache 影响

仅追加。本包绝不改写更早的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义目录能显示什么、`@` 引用意味着什么；它们是当前包约束。

- **非完成的 inactive 结果仍合并显示**：目录能区分最近一次正常完成与其他 inactive 状态，但不区分失败、取消、拒绝、token 耗尽或尚无已结束轮次的 child；UI 不公开 Activation 身份，停止能力仅限编辑器上针对运行中可继续 child 的当前轮次 Stop。
- **祖先菜单的未缓存分支需要键盘激活**：悬停不读取，点击祖先标题会导航。聚焦标题后按 ArrowDown，可在不离开当前 Session 的情况下准备这一层。
- **单层发现会在中断后停止**：意外的读取拒绝会停止后续兄弟节点，并记录到控制台。重连可能在直接子节点读取前中断发现；需再次显式打开菜单来准备这一层。
- **`@` 引用仍是显示标题文本**：重复或改名后的 label 会有歧义，因此它们刻意不获得继续执行语义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
