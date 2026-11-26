---
description: "dsh Web 客户端会话面板中的 subagent 对话目录、面包屑同级切换器、续接路由 UI 与 '@' 引用 source。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent

[English](README.md) | 中文

## 概述

在会话面板的「子智能体」分栏中浏览本地子代理对话与外部任务，并从子会话的面包屑切换同级子代理。本地对话展示活跃状态、token 用量和耗时；可继续子代理接受后续提示词并支持 Stop。外部任务显示为不可打开的叶子项，不展示执行状态。历史一次性对话以只读记录打开。普通侧边栏省略子代理对话；独立的 `@` 来源插入运行中子代理的标签，不授予继续执行权限。

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

会话页头的普通面包屑使用会话标题。subagent 面包屑优先使用创建时的原始描述（`entry.label`），其次使用智能体名称（`entry.name`），最后回退到 Session id。普通与 subagent 面包屑标题均使用 14px 文字和 20px 行高。每个 subagent 面包屑标题都是覆盖其父会话直接目录的切换器，并把该标题对应的 Session 标为当前项；根 Session 没有切换器。[会话面板](../ui-session-panel/README.zh.md#contribute-a-section)分栏 `subagents`（order 200，标题为“子智能体”）在根会话和子会话中都列出当前 Session 的直接目录，前提是目录有子项或读取失败。显示分栏不读取任何内容；展开分支时准备该分支。目录缺席或为空时，分栏连同标题一起隐藏，除非存在可用的 footer 扩展，且 Session 已开启的 `agentTeam` 投影含有未删除的共享任务或任务记录错误。仅开启 Team 模式不会显示空分栏。选择任意深度的本地 child，即可用该子会话的确切 `{parentSessionId, childSessionId, mode}` 地址打开其对话；也可以使用非当前本地行的行尾箭头在右侧 Sidebar 打开同一地址，并在空间允许时优先使用独立分栏。两种操作都会关闭面板浮层或该行所在的切换器菜单。

本包注册 `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>` 资源与 builtin Sidebar tab 类型。资源直接根据地址保留 child 的 `SessionReference`，不刷新 parent 目录，并在 tab 记录关闭时释放 reference。tab 通过 `sidebar.chat.conversation` 渲染共享 `conversation.content` Factory，把局部 View 固定为 Chat，并省略主 Conversation 的 Header 与宽度控制。在空白 child 的 Hero 中选择工作区时，与主 Conversation 一样，把该工作区的空白 Session 打开为主 Session，并把草稿移过去。

从会话列表拖拽根 Session 行时，如果屏幕上正显示另一个 Session，会显示放置目标。右侧侧边栏打开时，每个分栏各由一个放置目标覆盖，分栏之间的分割线和聊天区域保持可见；在某个分栏上放下时，会在该分栏中打开该 Session。侧边栏收起时，一个放置目标覆盖侧边栏打开时所占的区域，且始终位于该行被拖出的导航栏或窄窗口抽屉的右侧；侧边栏放不下时，该放置目标覆盖该栏右侧的整个区域。每个放置目标只绘制其卡片，卡片四边各内缩 8px，因此侧边栏的左边框和分栏之间的分割线保持可见；有多个分栏时，只有指针下方的放置目标显示其卡片。放置目标显示在抽屉遮罩之上。在此放下后，会在屏幕上那个 Session 的 Sidebar 中把被拖拽的 Session 打开为 `dsh-resource://subagentchat/session/<id>`（不带查询参数的地址）；如果已有 tab 显示该 Session，则改为显示该 tab。其 Conversation 与主 Conversation 一样接受后续提示词，该 tab 随屏幕上那个 Session 的浏览器本地 Sidebar 布局保存。tab 标题为该 Session 的显示标题。

分栏的标题控件（`conversation.session.panel.section.actions`，键为 `subagents`）显示直接成员进度：依次为已完成、进行中、未运行和外部任务数量；省略零值，分隔符与输入区任务列表一致。外部任务不计入运行中或已完成数量。分栏把运行中的子智能体排在最前，最近开始的在前，然后是其余的，最近更新的在前。它只显示五行，然后是会话面板的收起控件「显示其余 {count} 个」，点击后显示其余的行并变为「收起」；只有能收起两行及以上时列表才收起，这个选择在 Session 内保持，隐藏后再次显示面板也不变；展开某个分支后，该分支自己的行全部显示。会话没有子智能体且目录读取未失败时，分栏连同标题一起隐藏。直接子智能体运行中且面板未显示时，面板开关上的蓝点（`conversation.session.panel.indicator`）会提示这一状态，并向辅助技术说明数量；外部任务不计入。会话面板负责分栏滚动，目录树不单独滚动。面包屑切换器菜单宽度为 360px，外层内边距为 6px，并受布局视口可用宽度约束，仅菜单本身滚动。在兼容 WebKit 的浏览器中，其原生 5px 滚动条位于右侧 6px 内边距内，轨道两端内缩，并保留稳定的滚动条空间，使内容在需要滚动时保持原有宽度。其他浏览器保留标准原生滚动条。

面包屑切换器菜单只显示导航。

切换器标题最宽 244px，超出时以省略号截断，后接上下双向箭头图标。当前 Session 的标题使用主前景色、字重 500；祖先标题使用三级前景色、常规字重。

### 浏览目录

侧边栏操作的工具提示在悬停 500ms 后显示。非触摸指针悬停切换器 150ms 后打开其菜单；指针离开切换器和菜单后，经过 120ms 关闭。点击当前 Session 的标题会打开并固定菜单，并将焦点移入菜单，已固定的菜单不因指针离开而关闭；点击祖先标题则导航至该祖先。在切换器上按 ArrowDown 会打开菜单，并将焦点移至首行；菜单已打开时，焦点移入菜单，行加载完成后移至首行。点击外部或按 Escape 可关闭菜单；焦点原本位于菜单内时，Escape 将焦点送回切换器。

目录行显示创建描述（缺少时使用可用的 Session title）和智能体名称，名称在同级子智能体中唯一：切换器菜单中名称位于标题下方；会话面板中每行只占 28px 一行，悬停 500ms 后的悬停卡片显示标题、作为负责人的名称、活动状态与模式，以及 token 总计和精确耗时。没有名称的历史目录项在相同位置显示 Session id。两者均缺少时，该行仅显示名称或 Session id。导航、行身份与 Sidebar 地址始终使用 Session id。本地行使用紧凑的 4px 垂直内边距。在会话面板中，它们遵循面板的列：状态图标中心距行起始 14px，标题从 30px 开始，侧边栏箭头中心距行末端 14px。在切换器菜单中，可点击内容使用 6px 水平内边距和 7px 间距，同时保留树的左侧偏移。当前对话在行尾显示装饰性对勾，该对勾不是操作控件；其他本地行保留侧边栏箭头：点击区域 24px，在面板和切换器菜单中都是悬停时箭头变深、没有底色。主标题使用 13px 文字，次级名称使用 12px。切换器菜单中的行将描述与名称换行完整展示，包括在触屏上；面板中的标题以省略号截断，行的无障碍名称仍包含名称、模式、活动状态与度量。running 使用共享 ongoing loading，最近一个已结束轮次正常完成的 inactive child 使用共享 success 绿点，其他 inactive child 使用共享 idle 灰点。每行都为状态图标预留相同的列宽（面板中 16px，切换器菜单中 14px），并将较小的圆点居中，使 title 与 loading 状态对齐。切换器菜单中，尾随列在上行显示提供方的持久化 token 用量总计，在下行显示活跃轮次耗时；面板中的行只以 12px 文字显示简短耗时。在目录树中，Enter 或 Space 打开获得焦点的行，ArrowRight/ArrowLeft 展开和折叠分支，ArrowUp/ArrowDown、Home 与 End 在行间移动。没有 label 的 one-shot 行回退到其会话 id。只有确认存在下级的行才显示展开箭头。准备一层时，通过现有投影读取器依次读取其目录及直接子节点的目录，复用已完成的读取并合并进行中的请求，不递归发现更深层后代。已开始的单层读取可能在面板隐藏或菜单关闭后完成。缺少目录的行不显示展开箭头或未知标记；共享投影更新确认存在下级后显示箭头，并保持 agent 活动状态图标。读取失败时保留导航操作并提供重试。

### 续接对话

即使创建者离线，仍可在可续接的子会话中输入消息。子会话运行且草稿为空时，输入栏和主会话一样在主按钮上显示 Stop。提示词经由 `subagents/prompt` 路由，由运行时校验创建地址和在线 Team 根；失败使用普通提示词错误反馈。Stop 经由 `subagents/interruptByUser` 路由。

### `@` 引用 source

`@` source 仍然刻意保持独立且惰性：候选是从 `ctx.sessions.list` 零 RPC 得到的运行中 child；pick 会插入字面文本 `@label `，codec 投影为 `@label`。它不参与命令裁决，也不会把 label 解析成继续执行地址。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[子代理运行时](../../subagent/subagent/README.zh.md)负责 continuation 与中断；[对话参考](../ui-conversation/README.zh.md)说明编辑器行为。

### 目录派生

「子智能体」分栏、其进度控件与面包屑切换器通过标准 `useSessions` 钩子，仅从 `projectionsBySession` 读取 `subagentCatalog`。Session 对象层将列表缓存提示、显式读取和 Host 全局 control 流合并到这些共享值；实时帧更新已加载层级，无需逐树订阅。活动状态优先使用统一 UI status，缺少时使用 Session 摘要；摘要还提供标题与用量。显示分栏、渲染与悬停仅使用本地投影，不会请求缺失目录。尚未读取的空切换器菜单显示“尚未加载子智能体”；仅请求进行中显示加载提示。缺失或显式为空的目录没有展开箭头；后续共享投影包含下级时才显示箭头。读取失败后需要显式重试。需要迁移的行保留打开历史的操作，不显示格式提示，也不展开下级；打开 Session 后，历史与 control 投影提供其目录。外部行始终为叶子，不加载子 Session。

会话面板负责分栏的显示、滚动和关闭。切换器菜单是挂载到 body 的 `MenuSurface`；CSS 锚点让菜单跟随其标题，并按布局视口限制尺寸。浏览器缩放和平移时菜单随页面移动，因此可以超出视觉视口。内部滚动、悬停行为、点击固定展开和焦点恢复保持独立。

在切换器标题上固定打开的点击或按 ArrowDown、展开分支以及重试失败读取时，`prepareCatalog` 读取当前目录及其直接子节点；准备被拒绝时记录到控制台。点击祖先标题会导航到该 Session。Session 对象层合并重复读取，并在重连后刷新之前请求过的投影。

面包屑地址从 Provider 所绑定的 Session 地址、已加载的 parent 目录或已列出的 subagent 谱系推导，也包括从未选中过的祖先。

### 耗时、完成状态与 token

每个可见目录层在包含运行中 child 时独立推进时钟；折叠该层、隐藏面板或关闭切换器菜单会释放时钟。token 用量总计为四个互不重叠的 `tokenUsage` 桶之和。`subagentTiming` 投影会累加已结束轮次的耗时，并提供 `lastTurnCompleted`，用于成功圆点与已完成数量；新轮次开始时会清除该完成状态，直到自身的 `turn/end` 到达。耗时仅在运行中 child 存在未结束轮次时每秒递增一次，并在 child 变为 inactive 后冻结；被中断的未结束轮次以其同一切面的 `active.through` 为上界，绝不使用更新的会话元数据。

### 编辑器选举

one-shot 和模式未知的 child 选用只读编辑器。可继续 child 经由 `subagents/prompt` 路由提示词。本包绝不接收宿主上下文，也不调用面向模型的工具。

模式未知的目录项仍可见、可点击，没有标签时显示子会话 id。读取子历史并确认受支持模式前，输入区保持只读；读取失败在该子会话中报告。

目录行高亮使用[嵌套几何规则](../../../docs/ui-radius.zh.md#nested-hover)中的标准菜单项圆角。每个分支展开控件的点击区域覆盖左侧 28px 空间与所在行的完整高度，不与相邻行重叠；仅原位的 12px 图标旋转，点击展开控件不会触发行导航或侧边栏导航。悬停展开控件仅高亮箭头；悬停导航主体或键盘聚焦时仍保留背景高亮。细连接线使用三级边框颜色，与首行图标中心对齐，跨过预留的展开控件空间连接叶子状态图标，末端竖线止于对应图标中心。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖对话界面、宿主 seam 与设计笔记。

- [ui-conversation](../ui-conversation/README.zh.md)——承载面包屑谱系与编辑器链的聊天界面。
- [ui-session-panel](../ui-session-panel/README.zh.md)——承载「子智能体」分栏的会话面板。
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
- **会话面板分栏没有层级激活**：显示分栏不读取任何内容，因此 Session 列表未缓存其目录的直接子智能体在分栏中没有展开箭头，直到其目录到达，例如打开它自己的对话后，或在兄弟会话的面包屑切换器中准备这一层后。
- **`@` 引用仍是显示标题文本**：重复或改名后的 label 会有歧义，因此它们刻意不获得继续执行语义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
