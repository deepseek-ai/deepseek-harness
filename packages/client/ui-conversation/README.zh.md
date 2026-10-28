---
description: "Target-neutral 对话装配与浏览器 shell：事件和视图注册表、逐会话 binding、输入状态、slot 与临时 composer takeover。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

`ui-conversation` 拥有与 target 无关的 Conversation 组装和共享浏览器 shell。它消费 Session Controller 的 `SessionEventLikeEntry` feed，通过 `ctx.uiConversation` 暴露不依赖 React 的注册表与逐 Session binding，并通过 `ctx.uiSession` 提供 `useConversation`、`useInput` 和 `inputActions` 标准 props。它还拥有按会话的持久化图片 URL 缓存：`ctx.uiConversation.imageUrl(sessionId, attachment)` 为每个附件解析一个经 Gateway 授权的浏览器 URL，并随 Session binding 释放而撤销，因此所有 Conversation target 共享一次 `session.attachment` 读取。Chat 等具体 target 位于独立包，由各自包注册 Definition、快照 builder、View 和 renderer。

## 目录

- [Conversation 组装](#conversation-assembly)
- [已发送用户文本](#sent-user-text)
- [Shell 与标准 props](#shell-and-standard-props)
- [临时 composer entry](#temporary-composer-entries)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="conversation-assembly"></a>
## Conversation 组装

`UiConversation.events` 是 event Definition 的唯一 registry，`UiConversation.views` 是 target snapshot builder 的唯一 registry。两者都拒绝重复 key、保持注册顺序、返回幂等 disposer，并在 contribution roster 变化时重建现有 binding。`UiConversation.binding(bindingOrSessionId)` 为当前 Session Controller binding 返回 identity 稳定的 Conversation binding，不会另开事件源。 View Definition 可以声明 `toolCallFocus`，将工具调用 id 转换为自身的焦点标识。仅当此目标拥有可见的 View 条目时，Conversation 才提供 Inspect 回调；Chat 直接使用回调，不选择目标。

`ConversationBinding.openTurn` 是对象标识稳定的只读来源：最新轮次的开始事件已加载且尚未结束时提供其编号，否则为 `undefined`。观察到的轮次变化同步发布，即使没有活动视图也是如此。固定停止输入同时读取这个来源、会话运行状态和待处理交互状态。卸载会话绑定会解除其事件源订阅。

适配器把每个 `SessionEventLikeEntry` 直接交给 assembler。外层 `type` 区分持久事件与 Client-only transient event，内部 `event` 则统一公开 `type`、`seq`、`time` 与 `data`；Definition 接收这个内部 `SessionEventLike`。replacement window 可以包含两种 entry，历史 prepend 携带持久 entry，实时 append 则可以携带任一种。持久与瞬态事件使用同一组 match/start/update 接口。当前最早的 start 初始化 State；后续所有 Match，包括同一身份的其他 start，都用于更新。不消费 Assistant delta 的 Definition 对 `assistant/live-chunk` 返回 `null`。replace window 或 revision 断档从完整已加载窗口重建；连续 revision 的 append、prepend 与 Assistant settlement 使用增量组装。settlement 只删除具名 attempt 的 transient match，应用可选持久 entry，并从剩余最早的 start 重算受影响的 Context，刷新前序索引及 dependent，不替换无关 target node。没有剩余 start 的 Context 不保留 State，但其 key 和已发布节点仍保留，供后续证据复用，直到完整窗口重建；所属 Definition 可以隐藏这些节点。assembler 拥有 Context 匹配、Turn/Step location、target node 物化、target activity 和稳定 target source。`ConversationSnapshot` 只包含与 target 无关的 View 与 active-target 事实；Session lifecycle 状态仍属于 `SessionSnapshot`。

多个 Definition 可以为同一输入和生命周期角色共享只读 Match 与 Location。各 Definition 仍持有独立的 Context、State 和有序 Match 列表；Match 对象不会跨 assembler 实例复用。

注册入口接受原有可调用的 `match`，或只读的事件类型到处理函数表。Registry 在注册关系变化时复制表条目并预计算有序候选 Set。函数形式的 Definition 保持原有可调用 API，接收全部事件；表中的处理函数只接收已声明类型。修改表需要注销后重新注册。只有 `entries()` 与 `fallbackEntry()` 的旧 assembler 适配器保留原有分发路径。

所有接受的 Match 按顺序更新 State。两次 flush 之间，同一 Context 的重复更新合批发布。kind 和 id 相同时，Context 保持原有 key；传给 Definition 的 Context 快照仍为独立对象。fallback 只处理其目标上没有普通 Definition 匹配的输入。Definition 可以从 `match()` 返回 `exclusive: true`，在其目标上认领一个事件：该目标的其他 Definition 收不到这个事件，该目标的 fallback 也不运行（[语义](../../../docs/subsystems/conversation.zh.md#definition-and-typed-chat-payload)）。

Location 查询按 Turn 和 Step 编号索引 Step，因此非边界 append 不扫描 Turn 的 Step 数组。每个输入的数值坐标与解析出的 Location 共用一条私有索引记录；已发布的 Location 值保持不可变。边界更新、完整替换和向前补页使这些索引与当前时间线保持一致。

shell 选择解析出 target 或 target source 收到首个 subscriber 时，该 target 进入 active 状态。assembler 从当前 Context 对它执行一次 replace，并使它参与后续增量 flush；创建 source 不会激活 target，取消订阅也不会停用 target。

`UiConversation.groups` 为每个已注册目标注册一个可选的业务 Group Definition。它在节点物化后消费投影后的节点变化、变化轮次及已索引的目标位置，覆盖首次激活，并拥有全部分段规则与组数据。按索引读取 Turn 时保留相邻 Node 造成的分隔，使业务更新可以限制在受影响轮次和组内。assembler 先校验并安装根引用和按键索引的组快照，再发布 Node、Group 和 Location 数据来源。未分组目标保持原有路径。[分组](../../../docs/subsystems/conversation.zh.md#group-definitions)定义输入有效期、类型化注册、原子更新及渲染器职责。

Group 注册时缺少 View 目标会报错。已注册的 View Definition 被移除后，其分组计算暂停并清空已发布结果，但保留 Group Definition；重新注册该 View 后，沿现有替换流程从当前已加载时间线重建。切换 View 页签不会移除 View Definition。

target package 通过 declaration merge 扩展 snapshot 与 Location data map，再调用 `ctx.uiConversation.events.register(...)` 和 `ctx.uiConversation.views.register(...)`。target 通过 `ctx.uiConversation.binding(binding).target(targetId)` 读取其 Session-owned source。注册属于 Cordis effect，返回的 disposer 从同一个 registry 移除 contribution。共享的请求检查服务于每个 target：`ctx.uiConversation.inspectSystemPrompt(previous, event)` 将系统消息与位置替换解释为不可变的已加载 surface 状态。它按 surface 顺序选择最后一个非空的存活系统节点，为连续重写只保留存活的替换位置；遇到未建立索引的更早端点后，提示词保持不可用，直到向前补页回放提供其顺序。target 自有的 Definition 独立保留历史卡片。`ctx.uiConversation.inspectRequestPrompt(previous, header, system)` 根据该有效提示词分类请求变更；普通消息与流式分片无需处理系统状态。

<a id="sent-user-text"></a>
## 已发送用户文本

`UiConversation.userText` 注册同步 `match(text, from, context)` 规则。每次调用提供一个业务或 Text 候选；计算器选择起点最早的候选，仅在同起点时使用 `order` 和稳定 ID。每个调用者拥有自己的查询缓存。`Context.read(key)` 只使变化 Facts 的读取者失效，未来候选和无匹配结果在已记录的搜索范围内复用。输入和输出使用 readonly 类型，不在运行时冻结。详见 [UserText 类型](src/client/contract/user-text.ts)与[设计决策](../../../.agents/notes/implemented/architecture/2026-10-10-user-text-json-nodes.zh.md)。

业务扩展本包 `/client` 入口的 `UserTextDataMap` 和 `UserTextFacts`，通过 `ctx.uiConversation.userText` 注册匹配器，并向 `conversation.user.text.node` 贡献 renderer。Session 作用域的 `conversation.user.text` Factory 拥有这个行内 keyed Slot。空白规则也通过同一调度器返回普通 Text 候选，trim 在同起点的边缘空白冲突中胜过 collapse。节点注册自行提供动作，`interactive` 和 CSS `ellipsis` 仍为 React Props。缺少 renderer 时显示原文片段，匹配失败时保留完整原文并报告规则错误。

Queue 预览启用空白折叠和文档边缘 trim，保留 emoji，并使用 CSS 省略而不截断输入。编辑和复制保留原文；原生附件使用独立的展示路径。

[Message quotes](../../session/message-quotes/README.zh.md) 通过相同的 UserText 扩展点注册引用匹配与渲染。 每个用户文本容器和草稿编辑器各自拥有独立的悬停卡片分组，其中的 quote 原文弹层会立即互相替换。

现有语义 `DraftSnapshot` 在 references 旁保留 quote 文本及 clipboard 坐标范围。存储接受较早的字符串和仅含 reference 的草稿；Session 切换和 Workspace 转移通过现有编辑器 runtime 保留原子 quote，发送失败时它们留在编辑器中。`inputActions.insertQuote(text)` 仅在输入框处于 plain 模式时插入非空选区。提交产出普通 Markdown 文本；待发送回显、队列行、steering 行和持久消息使用同一文本匹配器。

`UiConversation.interactions` 拥有插件对文本选择和右键手势的注册。每个注册项提供同步处理函数，其 ID 选择对应的 keyed Slot 组件；插件通过 Slot injection 机制渲染。处理函数调用 `open()` 展示，需要替代浏览器默认行为时单独调用 `preventDefault()`。Chat 提供 DOM 选区和区域内布局；机制不从 DOM 位置推断原始来源数据或 Markdown 偏移。

<a id="shell-and-standard-props"></a>
## Shell 与标准 props

共享图片插槽属性将展示选择与持久化引用分开：`thumbnail` 请求完整缩放的附件列表缩略图，`compact` 请求裁剪的图片方块。每张图片可通过可选的 `label` 提供无障碍展示名称；加载和缓存标识仍使用原始附件引用。`MessageImagesContentInput` 为 root 作用域的 `conversation.images.content` Factory 增加可选的完整 `MessageImageLabels`。消息、工具及 Factory 输入显式携带视图提供的授权 `loadImage` 回调；读取和 URL 缓存仍由资源所有者负责。[ui-attachment](../ui-attachment/README.zh.md) 提供该 Factory，负责渲染与灯箱。

在粗指针设备上，composer 的草稿字号至少为 16px，以避免获得焦点时浏览器自动放大；更大的字号偏好仍然生效。

控件组的尺寸、内容、可见性或字体加载状态变化后，composer 测量展开状态下的控件组。若无法排在同一行，控制栏为模型位设置 `--dsh-composer-model-text-display: none` 和 `--dsh-composer-model-icon-display: block`；两者默认值分别为 `block` 和 `none`。模型位按内容宽度（最多 360px）参与测量，而不是按行宽比例，因此长模型名在测量中保持可见。若连图标也放不下，仍允许换行。

上下文占用率入口遵循[统计控件圆角规则](../../../docs/ui-radius.zh.md#radius-scale)。

composer 在挂载、切换 Session 和解除锁定时使用共享的[文字输入框聚焦策略](../ui-primitives/README.zh.md#use-this-package)。识别出的手机和平板需要点击输入框；桌面设备保留自动聚焦。在这些移动设备上，提交清空正在聚焦的草稿后，焦点移到不接受文字输入的 composer 卡片，收起键盘并保留键盘导航位置。被拒绝的提交、保留的新草稿文字，以及已经聚焦的其他控件均保留原有焦点。移动端键盘平移页面时，[Lexical 补丁](../../../patches/lexical@0.49.0.patch)让光标滚动计算与 DOM 几何使用同一坐标系。

上下文占用按钮在输入卡片下方、会话统计右侧显示圆环和百分比。点击按钮可在视口内的面板查看 token 构成，没有统计项时面板也不会越界；上下文用量和容量尚不可用时，按钮保持隐藏。

关闭代码工作工具时，外壳仅隐藏 Trajectory；其他插件贡献的 View 仍然可用。可用 View 少于两个时隐藏 View 标签栏。在 Trajectory 激活时关闭代码工作工具会返回 Chat；已保存的 View 偏好和 Session 记录保持不变。开启后，Trajectory 恢复可用。View 所有者接收可用列表，使导航操作跟随相同的可见性。

root 作用域的 `conversation.session.header.views.actions` list 有注册项时，标签行中的 View 标签之后显示带提示框的**更多会话视图**按钮。它打开的菜单以该 list 的注册项为菜单行。每个注册项接收 `entries`（按注册顺序的头部之外的 View，含 `id`、`label`、`pinned` 与 `active`；不含 Chat）、在本 Session 选择 View 的 `onOpen(id)`、`onPinnedChange(id, pinned)`，以及关闭菜单的 `onDismiss()`。头部在内存中保存所有 Session 共用的已收起 View id 列表；标签栏不显示已收起的 View，并将已注册的 Chat 放在首位，确保它始终留在更多菜单外。插件重新加载时 Pin 选择重置，不读取旧 localStorage 值。标签栏是否显示按可用 View 计算，不按已固定的 View 计算，因此其他 View 全部收起时，标签栏和“更多”仍然显示。收起当前激活的 View 会立即隐藏其标签，但不会切走其内容。更多菜单仅包含头部之外的 View，通过 `active` 标识当前 View。头部读取当前行可用宽度，为更多按钮与内边距预留 48px，每个标签估算 120px，其余 View 按注册顺序进入更多。单个 ResizeObserver 观察标签行，使窗口缩放和侧栏展开能够更新分组；当前选中项变化不改变顺序。标签行移除时断开观察。如果环境没有 ResizeObserver，仍按初始宽度计算，但不继续观察。当前 View 收起时，更多按钮高亮。每个标签按字符宽度估算文本宽度；只有估算结果超过 88px 单元格时，才通过提示框提供全名。至少保留一个优先展示的外部标签。未注册 View 的 id 保留在内存 Pin 列表中，直到插件重新加载。

输入框注册「文件」命令动作，负责其标题、可用性和原生文件选择器回调。菜单可用性与实际调用都读取已挂载输入框当前的附件接收策略。输入框卸载或锁定后该动作不可用，插件 dispose（资源释放）时移除注册。回调绑定留在输入模块内部。

输入框通过会话作用域的 `useAccess` 钩子读取所在 Session 的访问答案：访问快照不含 `session/prompt` 时隐藏发送，不含 `session/cancel` 时隐藏停止，附件接收跟随 `fileUploads/upload`。没有 Session 的输入框尚无答案，保留普通控件。发送与停止都只对按钮生效——键盘提交或 Esc-Esc 序列仍会到达 Host，由 Host 拒绝并上报失败。这些界面判断不替代 Host 授权。

`SessionInputShell` 通过私有 [DraftEditorRuntime](src/client/input/editor/runtime.ts) 为每个 Session 持有一个 Lexical editor，同时保留提交、附件选择和恢复决策。[DraftEditor](src/client/input/editor/DraftEditor.tsx) 呈现借用的 editor；InputBar 保留钩子与 refs，并通过 [view-binding](src/client/input/editor/view-binding.ts) 安装 DOM 行为。编辑器类型位于 [draft-editor.ts](src/client/contract/draft-editor.ts)，共享输入和提交类型位于 [input.ts](src/client/contract/input.ts)。编辑器后台更新会保留草稿选区，不修改文档选区或从其他控件夺回焦点；显式聚焦 Composer 时恢复其选区。这一拆分不支持同一 Session 同时挂载多个可编辑 root；[两阶段隔离提案](../../../.agents/notes/proposed/architecture/2026-09-14-composer-model-and-draft-editor.zh.md) 定义剩余工作。

草稿中的普通文字及文件、目录、Session 引用胶囊在切换 Session 和刷新后保留。公开输入方法接受文本；内部恢复和工作区携带保留结构化引用。输入模型在首次对外读取前导入保存内容；React 只挂载同一编辑器并绑定现有 Conversation store 写入回调。原存储 key 兼容旧字符串，新写入保存不含运行时节点 ID 的语义快照。等待 skill 目录不会阻塞编辑：斜杠名称保持普通文字，直到匹配的目录项到达。目录到达只重匹配当前文字，不改变胶囊、选区或 Undo 历史。浏览器持有的附件 File 对象不由这一机制持久化。[草稿初始化决策](../../../.agents/notes/implemented/architecture/2026-09-30-structured-draft-initialization.zh.md)规定所有权与恢复流程。

已认领的命令是草稿开头的一个原子 chip，认领与该 chip 同生共灭。删除参数和分隔空格不影响认领。光标到达 chip 边缘时，第一次 Backspace 或 Delete 选中整个 chip，再按一次才删除它并释放认领，参数保留为普通文字；按其他键、点击或移动光标会取消选中。在 chip 前插入文字或换行会把它还原为字面 token 并释放认领，撤销会连同认领一起恢复被删除的 chip。持久化的草稿记录 chip 的 token，刷新后命令目录解析出认领即重建 chip；在此之前先编辑了草稿则保留字面 token，Enter 仍会把它作为命令提交。所有命令和语言使用相同规则，包括 `/goal`、`/目标`、`/plan` 和 `/计划`。输入法组合输入期间，命令提示和普通占位文字持续隐藏，直到编辑器提交最终文字且对应输入为空时才重新显示。

工作区选择使用 `uiWorkspace.openWorkspace` 准备目标并提交导航。草稿内容（包括结构化引用）和附件仅在该请求仍为当前请求、且没有在途提交时，通过它的同步准备回调搬移；后续导航、所有者释放或在途提交都会把原草稿留在它的 Session 中。

本包占据 root 作用域 `main` 中的 `conversation` key。其 `main.conversation` 外壳将常驻的 `conversation.header` 放在可选 Session 的 `conversation.content` Component Factory 外。未选中 Session 时，头部仍承载根作用域导航；标题、操作和 View 标签保留在严格 Session 子组件中。Factory 拥有共享正文与 Composer，通过其标准 Hook 读取当前 Session，并公开 strict-Session `views` 与 root-scoped `widthControls` 两个局部位置。默认 adapter 渲染现有 `conversation.session` entry，主 occurrence 选择宽度拖拽条；嵌入式 occurrence 可以替换 `views`、省略拖拽条，且不渲染主 Header。共享正文与 Composer 注册 queue dock 和 Todo dock。Todo dock 在 composer 上方使用共享面板 elevation；其中的行分别以共享 idle、ongoing 与 done 标记表示待处理、进行中与已完成。`ctx.uiSession.provide()` 从同一个 Session binding 物化 Conversation 与 input source，并将 `inputActions` 作为稳定标准 prop 提供。

blank Session 保留 header 的 leading 与 corner 控件，包括右侧栏展开入口，同时隐藏标题、actions、utilities 和 View tabs。选择 Workspace 会创建这些控件所需的 Session，无需先发送消息。没有选中 Session 时，strict header 不挂载；常驻 header 在 macOS 桌面保留 40px 的窗口顶条，由它自己作为拖拽行持有，在 Web、Windows 或 Linux 上不预留空白高度。侧栏各入口仍遵循自身的数据与执行环境要求。 已开始的 Session 在可用 View 少于两个时使用单行标题栏，仅在渲染标签行时保留其高度。标题与 actions 放不下时，标题区域会裁剪它们，并在 utilities 之前渐隐其末端；utilities 始终完整可见且可点击；标题与 actions slot 中的浮层通过 portal 渲染，不受该裁剪影响。

View 选择规则固定：有效且已注册的持久化选择优先，其次是已注册的 `chat`，否则不渲染 View；绝不选择第一个已注册 View。Shell phase 只组合 Session lifecycle 与 active-target set，不读取任何 target-specific 快照。

Session 首次绑定或缓存的 Session 成为 current 时，shell 会在渲染前读取持久化 View 偏好，激活已注册的偏好 View 或 Chat fallback，并在后续 tab 或 focus 选择写入 store 前先激活对应 target。blank Session 仍不渲染 `conversation.view` slot；未选中的 target 不会激活。

主 occurrence 的活跃 transcript 只在未被内容覆盖的两侧沟槽中提供正文宽度拖拽条；嵌入式 occurrence 省略这些拖拽条。View 如果绘制进沟槽，只将具体的可见元素提到拖拽条上方；透明的全宽包装层保持在下方，不会占用空白沟槽。该规则要求此元素与 Conversation body 之间不能引入中间堆叠上下文；浏览器场景固定了交付 Chromium 的行为。Chat 将该规则用于表格元素，其限定在阅读列内的工具卡片无需提高层级。指针位于拖拽条上时，滚轮仍会滚动 transcript，Ctrl+滚轮则保留为浏览器缩放手势。粘滞 composer 刻意拥有完整的底部区带，该区域不是宽度调整目标；已捕获的拖拽会将指示线提高到松开为止（[拖动手柄样式](src/client/skeleton/ConversationRoot.module.css)）。

宽度拖拽条的指示线只在已捕获指针的拖拽期间跟随指针，普通悬停不改变其位置。

常驻 composer 在无 Session 与有 Session 之间保持挂载。输入空白字符会隐藏占位提示；没有附件的纯空白草稿无法发送。无 Session 时，同一个编辑器表面保持 inert，Workspace picker 连接 blank Session。该表面是 shell 所有的 Lexical 编辑器：引用 chip 是携带 owner 序列化身份的原子 decorator 节点（提交时经 owner codec 展开），已认领的 slash command 是携带认领的行首原子 chip，文件夹文本引用以图标前缀携带文件夹图形，草稿文字和引用语义字段由逐 Session Conversation store 持久化。QueueDock 从 Session 的 `inbox` 投影读取 `next-turn`，包含从冷状态恢复的消息，仅排除仍由本地 transcript 提交承接的 requestId。其他排队行保留正常展示和操作。Queue 操作通过 scoped `ctx.conversation` service 寻址准确的 queue occurrence；queue 预览使用 [UserText Factory](#sent-user-text)（wire 会话形式折叠为其标签），并按原始附件顺序展示本地或持久化的图片和文件。图片使用缩略图，文件使用紧凑的名称与大小卡片。编辑态在 ui-primitives 的 `InlineEditor` 中展示字面发送文本，因此重新编辑不会丢失换行。持久化缩略图通过会话图片 URL 缓存解析。繁忙时 Enter 行为保存在 Host-backed `ui-conversation` settings namespace。 composer 键盘映射经斜杠流水线裁决触发菜单的按键——Tab 确认高亮补全项（可下钻项则下钻），Escape 与 Shift+Tab 离开菜单且不选定——其余按键交给编辑器自身。 接管键盘的浮层通过 `SessionInput.focus()` 把键盘还回来，该路径走 Lexical 自己的 focus，因此光标回到草稿原来的位置而不是开头。

窄屏浏览器设置中，繁忙时 Enter 偏好的标签与控件间距缩小；Windows 和 macOS 桌面窗口保留标准间距。

普通 Enter 使用已配置的投递模式，严格的 Ctrl+Enter 或 Cmd+Enter 使用互补模式，Shift+Enter 插入换行。带 Alt、AltGraph、同时带 Ctrl 与 Cmd，或 Shift 与 Ctrl/Cmd 的 Enter 保持草稿和指令菜单不变，并将 DOM 事件留给应用快捷键。Conversation 插件注册发送、换行、互补投递、命令菜单和引用菜单的固定条目，并在卸载前保留这些键位。

点击可编辑输入框内的留白时，已聚焦的输入框保留当前光标或选区，未聚焦的输入框恢复上次的光标或选区。文本选择、滚动条、控件和内嵌浮层保持各自的指针交互行为。

每次输入框提交都携带原始发生时间、操作来源、投递意图以及会话模型和运行状态快照，贯穿异步命令裁决。快照还记录会话是否仍为空白，以及会话记录的 Agent preset id。普通消息通知在引用序列化前发出一次，纯附件提交也遵循这一规则；已处理或认领的命令不发出通知。快照读取与通知消费异常不能阻断发送。在桌面端，该通知报告 `send_button_click`，携带 `is_new_session`（会话为空白时为 true）和表示 preset 类别的 `agent_preset`：`cordis` 记为 `creator`；`ptc`、`minimal` 与 `standard` 沿用各自的 id；其他 preset 记为 `other`。会话未记录 preset 时省略 `agent_preset`。不发送自定义 preset 的 id。

默认发送等待 Host 接收：Enter 把草稿文字、引用胶囊和附件一起记入本次 attempt，composer 进入 `sending`，编辑器和附件栏只读，Send 显示发送中，直到 Host 接收该提示词（以回执或带有该请求 id 的 Inbox 行为准，先到者生效）。之后才在回显渲染之前、在同一事务里清空草稿、其附件、occurrence 表和撤销历史；被拒绝或失败时 composer 回到 `plain`，草稿和附件保持不变，因此同一时刻只有一条消息在途。只读输入阶段结束时，如果焦点停在页面 body 上，桌面端将焦点恢复到编辑器，移动端则将焦点移到输入卡片，避免重新弹出键盘。用户在此期间聚焦的其他控件会保留焦点。`sendSession` 在序列化之前用投递模式注册 Session 提交回显（`session.beginSubmission`），保留图片与文件的选择顺序；Host 接收提示词后，Session 才在 `pendingSubmissions` 中公开它，并按注册时的模式与运行状态推导位置，因此空闲发送进入 transcript（文本记录），繁忙时 Queue 进入 QueueDock，繁忙时 Steer 进入 pending-steering 区域。随后让出一帧，文件和已上传的图片引用已暂存凭证；没有上传的图片（例如 continuable 子代理草稿里的图片）经浏览器原生 `FileReader` data-URL 路径编码。命令提交也用同一凭证表示通用文件，因此发送 `/goal` 或 `/plan` 时不会再次读取这些浏览器文件。提示词复用提交 `requestId`；Session 按同一 `rpcId` 关联展示接管，并仅退休回显一次。命令提交保持冻结的 `submitting` 阶段。回显以 observed 退休时，durable 图片缓存立即公开每个预览 URL，读取 admitted 附件后用规范化 URL 替换预览，并在各 URL 停止使用后撤销，同时释放文件卡；已被接收但回显未被观察到就退休的提示词会释放其附件，Session scope 销毁时会释放尚未被 Host 接收的消息的附件。选中的通用文件以及普通 Session 草稿里的图片在加入时就进入同一个先进先出的后台上传队列，发送会等到每一项都取得凭证；`maxConcurrentFileUploads` 默认允许两个 Worker transport 同时运行，Conversation 服务在切换 Session 时继续持有排队和运行中的传输操作及字节进度，移除草稿会跳过排队中的传输或中止正在运行的传输。浏览器 shell 暴露 `__DSH_HOST_PATHS__` 时（桌面应用），拖入或粘贴的文件夹以及拖入、选择或粘贴的带真实路径的非图片文件会成为 `@路径` chip；图片仍然上传。拖放和粘贴通过浏览器 entry API 识别目录；该 API 不可用或没有返回 entry 时，粘贴项沿用普通文件处理。文件选择器不能选择目录。引用需要启用 `ui-reference` 插件，原路径也必须仍可由模型的文件工具读取。工作区内的路径使用相对形式，其他路径保留绝对形式。整批文件先校验再插入，保留来源顺序和已选中的文字，引用之间有空白分隔，含空格的路径使用闭合引号。没有该桥的浏览器会拒绝拖入或粘贴的文件夹，桌面端无法获取文件夹路径时单独报错。continuable 子代理允许粘贴和拖入 PNG、JPEG、WebP、GIF 图片，沿用相同的投影限制并以内联方式发送，因为 Host 只为普通 Session 暂存上传；包含通用文件、不支持的图片格式或目录的批次会在进入草稿前整批拒绝。它们的发送同样注册本地回显；continuation 请求携带回显的 `requestId`，Host 把它记录为子会话消息的 `rpcId`。

排队提交的本地回显在禁用的编辑、删除、插话按钮旁显示“发送中…”；折叠后的队列在标题栏保留发送状态。匹配的 Host 队列行替换回显后，各操作按原有的纯文本内容和运行状态要求启用。仅收到提示词确认不会启用队列操作。被拒绝或失败的提交不会公开回显，草稿留在 composer 中并显示错误提示。Agent 接纳阶段的拒绝（`session/prompt-rejected`）显示它自带的文字；若 `presented` 表明拒绝它的插件会在自己的界面里说明，composer 不再提示。

Send 和 Stop 按钮禁用时不显示提示气泡，轮次结束后由 Stop 切换成禁用 Send 的按钮也遵循此规则。普通 composer 运行时，如果草稿为空或输入不可用，主指针操作保持为 Stop。可提交的文字或附件会把同一位置切换为 Send；清空或成功提交草稿后恢复 Stop。消息等待 Host 接收期间，该位置显示发送进度，旁边另有独立的 Stop。繁忙态 Enter 设置为普通 Session 与可继续 child 选择 Queue 或 Steer 投递，运行中的 Send 按钮按 plain Enter 解析出的同一模式投递；当它在普通消息草稿上可用（没有待上传文件）时，其标签以该模式命名（排队发送或插话发送），因此该设置同时约束 Enter 与按钮，而 Cmd/Ctrl+Enter 仍使用另一模式；空闲会话、空草稿与 `/` 命令行保留普通的 Send 标签。它们的 QueueDock 行共享 Edit、Remove 与 Steer，空草稿也共享 steer-all 组合键。One-shot child 继续只读。Plan Mode 与 active goal 不改变附件入口。可继续 child 保留独立的 Send 与 Stop 操作，允许粘贴或拖入图片，但不提供「文件」菜单项；parent 离线时，Send 与 composer 手势锁定，但在线 inbox 的 QueueDock 控制仍可使用（[决策](../../../.agents/notes/archived/bug-fix/2026-08-20-running-draft-primary-send.md)、[inbox 控制](../../subagent/subagent/README.zh.md)）。

文件标签和可编辑的 skill 引用共用覆盖整个引用的悬停背景，并跟随输入框的行高与文字基线。首次点击立即由已注册的引用来源负责打开预览，包括双击序列的第一次点击。后续点击保留原生文本选择行为；已有非折叠选区时，指针点击不打开预览。预览不改变草稿、剪贴板文本或提交内容。

当会话被其他写句柄占用时，发送失败的 toast 提示用户退出其他正在运行的 DSH 后重试。

在获得焦点的 Chat 或 Composer 中连续独立按下两次 Esc，可停止当前运行轮次并保留排队消息。间隔由 shortcuts 插件的 `stopSequenceMs` 配置决定，默认 500 ms。菜单、审批、模态层、终端、内嵌网页、输入法、重复按键，以及输入区域、Session 或轮次变化会清空序列。快捷键与 Stop 按钮调用同一作用域取消操作。插件将 Stop 注册为 `input` 展示分组中的固定操作。该注册使普通 Esc 不能分配给可编辑快捷键，并为 Stop 按钮的悬停和键盘聚焦提示提供 `Esc Esc` 序列。

<a id="temporary-composer-entries"></a>
## 临时 composer entry

`conversation.composer` 是通用 chain，其完整 owner currency 为：

```ts type-equiv
/** Owner values used to elect a composer takeover. */
interface ComposerChainProps {
  /** Current Session identity used by temporary business-owned entries. */
  sessionId: SessionId | undefined
  /** Current Session lifecycle state, absent without a selected Session. */
  session: SessionSnapshot | undefined
  /** Effective business-owned interaction awaiting the user in this Session. */
  pendingInteraction: SessionPendingInteraction | undefined
}
```

业务包仅可在一个 Remote waterfall request pending 期间安装 entry：

```tsx
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChainSelect, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface Request {
  readonly sessionId: SessionId
}

type RequestComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: Request }

const select: ChainSelect<ComposerChainProps, Request> = owner =>
  owner.sessionId === request.sessionId ? request : null

const dispose = ctx.slots.register(
  { name: 'conversation.composer', select },
  RequestComposer,
)

try {
  return await request.result
} finally {
  dispose()
}
```

selector 必须是 owner currency 的纯函数。非 null 返回值作为 `matched` 传给组件；`PropsRuntime<'conversation.composer'>` 提供标准 Session 与 global props。Chain 顺序仍按 `priority` 升序，再按注册顺序；首个返回非 null 的 selector 获选。Shell 会在 takeover 下保持默认 composer 挂载。Request 状态、listener、response encoding 和任何 request-specific child slot 都属于业务 package，不进入 `SessionSnapshot`，也不由 core 包声明。

`InputActions.captureInsertion()` 捕获草稿选区与版本；`insertText(text, span)` 仅在版本未变且编辑器允许编辑时，插入一次可撤销的纯文本编辑。异步消费者在插入被拒绝后负责保留结果，等待用户操作。

`conversation.input.activity` 在模型选择器与发送按钮之间承载一个控件。其 `onActiveChange` 回调将控件展开至整条工具栏并隐藏普通辅助控件和上下文用量按钮，同时保留编辑器与提交按钮。关闭活动后恢复这些控件，上下文详情保持关闭。首页输入框下方没有内容时，该区域保持收起。占用者在卸载时释放展开状态，并拥有活动专属反馈。

<a id="model-experience"></a>
## 模型体验

无，因为本包渲染浏览器状态，并通过 Session Controller API 发送用户确认提交的输入，而不构造模型请求。

#### KV Cache 影响

无；Conversation 组装和浏览器输入状态不会改变提供方侧的 prompt cache。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **只有已注册 target 可以渲染**——除已注册的 `chat` 偏好外，shell 刻意不提供隐式 fallback target。
- **Factory occurrence 继承渲染位置的 Session**——`conversation.content` 不接受独立寻址的 Session；该能力需要单独的 Session provider。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
