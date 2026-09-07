# Agent Note: Web 输入状态机、composer slot 与 slash 流水线（ui-conversation input / ui-input-trigger）

Status: implemented
Archived: 2026-09-04

[English](2026-07-25-web-input-machine-and-slash-pipeline.md) | 中文

> 范围：输入状态机（claim 看护 + 提交事务）、hub/facade 与发送编排、跨插件输入改写的三个 scoped bail 事件、`/` 与 `@` 触发检测与菜单流水线（ui-input-trigger）、composer 周边 slot 体系。依赖[会话作用域 note](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)的 sctx / provide / session-maybe 与 blank 实体模型；命令知识（三型、目录、popup）零涉——那是[命令业务面 note](2026-07-25-web-command-surfaces-and-assembly.zh.md)的领地。原决策的编辑面一半——textarea + occurrence 表、自管 undo log、粘贴匹配流水线与 backdrop 装饰——已由 [Lexical composer note](2026-08-20-web-composer-lexical-editor.zh.md) 取代；本 note 仍拥有状态机的提交平面、bail 事件约定、触发流水线与 composer slot。

## 问题

两个各自为政的 composer：hero（EmptyState，受控链直写会话）与会话内 InputBar（普通受控 textarea），行为、draft 所有权、发送路径全不一致。要让 `/` 命令、skill 引用、`@` 引用三类触发进入输入面，必须回答：

- 三类触发如何分层，谁对「命令」有知识、谁零知识；
- 输入框如何表达「命令态」——从 draft 文本推导还是显式状态？退格、回车、空格、整行粘贴各是什么语义；
- 提交是异步事务（RPC 往返）——晚到结果回灌、会话切换、React concurrent 重放如何防御；
- 引用 chip 在纯 textarea 上如何表示，undo/剪贴板/粘贴匹配/模型序列化各归谁；
- 跨插件的输入改写（菜单回填、引用插入、token 消费）如何做到依赖倒置；
- 无会话 → blank 会话时哪些 React 外壳必须复用，哪些严格会话输入体允许替换。

硬约束：组件一律经 slots 挂载；呈现产物不进会话日志；键盘路径全程 IME 安全。

## 决策

### 输入状态机（现为 `SubmitMachine`）

纯状态机，事件进/效果出，注入时钟。四相 phase（plain / adjudicating / claimed / submitting）。命令态**永不从 draft 推导**，由 pick 路径在离散时刻显式建立；claim 由 `draft.startsWith(token)` 看护、退格破坏自动 release；claim 形状 `{token, hint?}`（hint 供 ghost text）。

机器的编辑面一半——occurrence 表、自管 undo log、粘贴匹配 attempt 流水线与 `set-invalid`——已并入 Lexical 文档树及其 history（文档身份、位置映射与三投影归 [Lexical composer note](2026-08-20-web-composer-lexical-editor.zh.md) 所有）。留在这里的是语义不变的提交平面：

- `draft-changed {draft}`——编辑器文档的剪贴板投影，供 claim 看护。
- `claim {claim}` / `release` 与在编辑器层应用的 span-CAS 改写事件——bail 事件的机器侧；span CAS = draftRev 相等。
- `enter {draft}` / `adjudicated` / `adjudication-failed` / `submit-settled {draft}` / `send-committed`——提交事务平面：SubmitAttempt（seq + AbortSignal）防回灌，成功 commit 清除草稿前缀，失败带漂移守卫 rollback（回车时快照仅当 live draft 仍等于它才回填；用户已再输入则只发 notice）。

效果面（shell 执行）：`adjudicate`（调 InputTriggerController.adjudicate）、`begin-submit`（claim.submit 事务）、`default-sink`（普通消息，hub 编排）、`commit-draft`（前缀删除并保留后缀）、`notice`。

### 跨插件输入改写：三个 scoped bail 事件

约定声明在 ui-input-trigger（依赖最底层），生产者经 `sctx.bail(sctx, ...)` 派发，唯一消费侧是 hub 建 shell 时挂在 sctx 上的三个 listener；返回 `true` ⟺ 机器过 phase + CAS 守卫并实际改写（发出事件 ≠ 修改成功，Space 是否 `preventDefault` 以返回值为准）：

- `slash/input-begin-command` `{claim, span}`——菜单 pick / Space 裁决出的命令 claim 回填（InputTriggerController 派发）。
- `slash/input-insert-reference` `{reference, span}`——引用 chip 插入（InputTriggerController 派发）。
- `slash/input-consume-token` `{guard: span | bare-token}`——业务成功后消费命令 token（下游命令面派发）。

不事件化的调用（注册表登记 → 显式调用 → await）：Input 自身的 draft/submit、Enter 异步裁决、reference serializer。`@mode bail` 已入 JSDoc parser 与 cordis catalog 门禁（scripts/jsdoc.ts）。

### slash 流水线（ui-input-trigger：root `InputTriggerService` + 每会话 `InputTriggerController`）

对「命令」零知识的触发/菜单/pick 流水线：

- 服务只有 source 注册表（`InputTriggerSource{trigger: '/'|'@', name, order?, candidates, onPick, matchSpace?, matchEnter?}`；(trigger,name) 唯一；可选 `order` 对 roster 排序——越小越靠前、默认 0、同值保持注册序——排序后的 roster 同时是组序与轮询序）与 `sessionOf(sctx)`。实现 match 钩子即参与空格/回车裁决的声明；流水线按 roster 序轮询，首个非 undefined 应答胜出，无人认领落 default sink。matchSpace 同步（空格在击键中触发，只许热缓存）；matchEnter 异步（可 await 源自身预热，预热失败即 reject）。
- controller 持有唯一权威 hit（含 span；菜单关闭后为 Space 保留）、每会话 menu store、候选 fetch generation、键盘仲裁（combobox 模式：焦点始终在编辑器表面；↑↓/Enter/Escape 会被拦截；Tab 会选定高亮补全项，候选项可下钻时走 drill 动作，否则走普通 pick，无高亮时保留原生焦点遍历；所有仲裁都经过 IME composition 守卫，唯一例外是 Shift+Enter 无条件先行），以及 pick 编排（outcome → 自派 bail 事件）。`toggleSource(name, syntheticHit)` 是 chrome launcher 路径：它基于调用方的编辑器 selection，只 seed 对应的已注册 source，并发布 `launcher = name` 直至关闭；普通的键入式 tracking 会清除 launcher 并恢复完整的 trigger roster。两条路径渲染同一个 MenuView，并执行同一条 `onPick` 链。`dismiss()` 动词支撑 MenuView 注入的 `onDismiss`（指针落在菜单与所在 composer 卡片之外即关闭菜单；MenuView 还经 `slash.menu` locale 命名空间本地化组标题，并经 ui-primitives 的 `useAnchoredMaxHeight` 把高度收敛到 composer 上方的视口空间）；每个会话作用域出生时对 source roster 做一次 `warm(projection)`，projection 在该 scope 内只有稳定的 sessionId，无 published/能力跃迁；scope disposer 拆除 controller。
- 触发检测词边界（`user@host`、URL `/` 永不触发）、守卫分档（plain：`/` 到处 + `@` 行内 / claimed：`/` 抑制、`@` 活 / frozen：全无）为冻结纯核。

### hub / facade：常驻外壳与严格会话输入体

- hub（trigger/decoration 注册表 + 发送编排）对 slash/command 服务是可选 `ctx.get()` 依赖：无 ui-input-trigger/命令面时输入正常收发，优雅降级。
- 每个实体会话只有一个 `SessionInputShell`（facade），随会话作用域创建和拆除；无会话时不造 input machine。`ConversationRoot` 自身是 `session-maybe` 常驻外壳，持有 HeroShell、Workspace picker、composer stack 与 chain fallback 外框。它始终拥有同一个 scrollport 与 composer seat；会话出现后，彼此独立的严格会话 header 和 body outlet 只填入这些固定区域。
- composer bar 是一个无条件渲染的 `session-maybe` slot entry：无会话时同一个 InputBar 以惰性态渲染（machine face 缺席、`disabled` owner prop），`connectWorkspace` 返回 blank 会话后同一实例转为 live——编辑器表面 DOM 在无会话 → blank 切换及其后每次 phase 翻转中都不重建；`ConversationRoot`、Hero 与布局骨架全程保持。memoized InputBar 在 renderer 绑定各 child slot 的标准 props 后自行渲染 overlay、left、right 与 dock；`ConversationRoot` 只传标量数据和回调，因此无关 shell render 不会制造新的 ReactNode owner prop 或使 bar 失效。
- ConversationRoot 的 Hero 判据是 `sessionId === undefined || (composerPhase === 'blank' && (openState === 'open' || summaryBlank === true))`：summary 已证实为空的会话在任何 open state 下都保持 Hero，未经证实的会话则在 loading 期间进入 settling。首次 submit 同步进入 engaging，失败也保留 composer 与错误上下文，不退回 blank Hero；sidebar 的 blank 位只在提示词成功受理后翻 false。
- 发送统一在 hub defaultSink：乐观清稿后只走 `session.prompt` 且固定 `mode:'queue'`（Web UI 无 steer 入口；host 线缆上的 `mode:'steer'` 不经此 machine）；失败且 live draft 仍为空才回填，用户已经继续输入则不覆盖。不存在 Draft materialize 或 attach 事务。
- blank Hero 改选 Workspace 时，外壳调用 `connectWorkspace`；目标会话不同时把非空 draft 从当前 shell 搬到目标 shell，再 open 新 id，旧 blank 会话留存但不再 current。
- Notifier 双位约定：`dirty`（快照新鲜度，`ensureFresh` 拉取可清）与 `notifyPending`（通知欠账，只有 flush 清）各自独立——拉取不得吞推送，对象层推订阅者（watchTransaction）依赖这一保证。

### 纯文本引用：text outcome 与 lexicon 装饰

skill/@subagent 引用不走占位符 + occurrence 身份链——纯文本引用决策：pick 直接把 `/name ` `@name ` 原文插进 draft，chip 视觉纯派生：

- PickOutcome 增 `{text}` arm；新 scoped bail 事件 `slash/input-insert-text` `{text, span}`（与另三个同约定：draftRev CAS、返回 true ⟺ 实际改写）；facade.insertText 走 setDraft 拼接，机器零改动。
- source 可选 `lexicon?(session)` 钩子：同步热快照名录，`undefined` = 数据未热——零装饰、永不触发 fetch（渲染路径保持同步无副作用）；配对的可选 `subscribeLexicon?(session, listener)` 钩子是名录在 warm 之后仍会变化（目录 settle、子代生灭）时的失效通道。controller 把各名录聚合进自己的 `lexicon` 快照 store（每次 source 通知重拉）；scope 出生后才注册的 source 由服务广播给活 controller，补 warm 并并入名录。
- `decorations.scanTextRefs`：词边界扫描 draft（行首/空白后的 `/name`、`@name`，`x/name` 永不命中；`/name` token 还必须止于空白或 draft 末尾——与宿主 skill gesture 同样以空白为界，因此 `/nfs-hg/xxx` 是路径、`/plan。` 是普通文本；ui-primitives 中已发送文本的投影 `projectUserText` 采用同一形状）对照名录，命中即成为 Lexical 树中的 `TextRefNode` 实体（claim 装饰对行首 token 席位有优先权——见 [Lexical composer note](2026-08-20-web-composer-lexical-editor.zh.md)）；编辑破坏匹配形状时实体还原为普通文本。
- 发送即原文（不再 `<skill>` 序列化）；气泡侧 `projectUserText` 只在同一步骤记录了该名字的 `skill-invocation` 注入时才装饰纯文本 `/name` token——ui-chat 的 `SkillNameProjector` 把该步骤注入的 skill 名挂到直接消息节点上，与 recall 投影挂会话标签的方式相同——因此 `/123` 或随手敲的 `/词` 保持普通文本；指令输入气泡（ui-goal）以同样方式指明其已执行的指令，把 token 渲染为 `command` chip；`@name` token 仍按形状装饰。
- 装饰响应性：shell 订阅 controller 的 lexicon store，每次名录变化重扫全文档，scope 出生预热后才 settle 的名录会直接点亮已有 draft token，无需菜单交互或无关重渲染。

### 每会话供数贡献与键盘私面

- ui-conversation（hub 兼贡献者）经 `sessions.provide` 供 `'input'` hook（机器状态 + queue overlay）+ `inputActions` prop（`setDraft`/`submit`，稳定 void 回调）。
- 公私分界：公共 provide 只放 React 语汇成员；键盘/DOM 命令面（`ComposerKeyboard`：shell 所有的 editor，arbitrate/space/paste/dismissPopup/caretSpan——同步返回值、disposer 语义）是 InputBar 独占，走 InputBar entry 自己的 inject 包内私递，不出插件边界。

### slot 体系

`conversation` 本身是 session-maybe；其会话内容与 composer 输入 slot 严格限定为会话，Hero Workspace picker 保持 root。root 注册把 header outlet 渲染在常驻 scrollport 上方，把 body outlet 渲染在其内部、常驻 composer seat 之前。子 slot 均由 ui-conversation 的 conversation 注册声明：

- `conversation.session.header`（single）——常驻 scrollport 上方严格会话的 breadcrumb、view tab 与 header action。
- `conversation.session`（single）——常驻 scrollport 内严格会话的 view ring 与 draft mirror。header 和 body 共享同一个会话作用域 chat store；会话 id 切换时各自重建。
- `conversation.composer.bar`（single）——InputBar 本体的 slot：InputBar 是真 slot entry（自有 slot 自注册），composer chain fallback 的内容；不做 chain entry——chain 单选举会在 takeover 时卸载它，破坏编辑器表面的 DOM 存活。
- `conversation.input.overlay`——输入卡内浮层锚点；注册者 inject 按 slot sessionId 解析各自每会话 controller。
- `conversation.input.dock`——输入上方堆叠条（QueueDock 的队列只读列表落此），order 定序。
- `conversation.composer.dock`——composer 上沿统计带。
- `conversation.input.left` / `conversation.input.right`——工具行左右区。
- `conversation.input.plan` / `conversation.input.model`（single）——工具行两具名控制位；bar 只传 `locked`（owner props），空到 owning 插件注册为止，无占位 fallback。plan seat 未激活时保持为空，因为入口归共享 Command source 所有；有效 plan 目标会渲染 warn 状态的 `Plan ×` 状态按钮，其唯一动作是 `/plan off`。
- `conversation.hero.workspace`（root scope）——无会话 / blank Hero 共用的 Workspace picker；pick 经 `connectWorkspace` 复用或创建目标 blank 会话，必要时搬运 draft 后切 current。

### 测试纪律

状态机全部行为由纯 JS 单测覆盖（事件序列进、断言状态与效果，零浏览器 DOM）；交互矩阵逐行投影测试。这一要求正是纯核 + 服务壳分层的成因。

## 曾考虑的替代方案

| 弃案 | 一行理由 |
|---|---|
| ActiveCommand 中间态 / registerMode 模式注册表 / 从 draft 推导命令态 | claim 由 pick 路径显式建立——无表、无推导 |
| bindTarget/bindDraft 对象直连 | 反向耦合 + root 单例跨会话误配；scoped bail 事件保依赖倒置且路由结构性正确 |
| 统一 slash/input-apply 或全事件化 | 三个独立 payload 覆盖跨插件改写；异步链路保持基于注册表的显式调用 |
| contenteditable / 富文本树 | 兼容性差；textarea + U+FFFC + occurrence 表覆盖全部交互约定——后被 [Lexical composer note](2026-08-20-web-composer-lexical-editor.zh.md) 反转：textarea 栈的样式与身份成本被实测后翻案 |
| draft 双持久化 {text, occurrences} | mirror 写剪贴板投影零新概念；chip 跨刷新降级可接受 |
| 原生 textarea undo 栈 | 受控 + 程序化写入下不可靠；粘贴两段 undo 语义只能自管——两侧都随 textarea 一并退役；undo 现归 Lexical history |
| InputBar 收 16 员 wiring 回调包 | 消费矩阵实证 11 员 InputBar 独占、1 员死成员；标准件通道让组件自取，键盘面包内私递 |
| 由 `ConversationRoot` 把 InputBar child slot 渲染为 owner prop | 新 React element 会击穿 bar 的 memo 边界；bar 已收到 `renderSlot`，也拥有这些位置 |
| 空格裁决也认领即执行型命令 | 误触发防线：空格后整行是普通提示词；不可逆副作用只留显式入口 |
| 通用 tokenPattern 装饰机制 | 结构化 occurrence 记录取代模式扫描 |
| 占位 select 常驻工具行 | 具名 slot 在注册前保持为空；占位件与真实现冲突时是两个真源 |
| 始终可见的 Plan 开／关切换 | 入口已归共享 Command source 所有；第二个入口会把状态 seat 变成冗余的 mode chrome |
| 第二套加号菜单组件／controller，或在 Command 上方增加 Add/File 分组 | 这会重复异步候选、键盘高亮、焦点保留与 pick 状态；加号控件只是既有 MenuView 按 source 过滤的 launcher，且此 scope 没有文件能力 |
| 引用一律走 U+FFFC chip（纯文本引用决策所取代的旧线） | 纯文本 + 派生装饰零身份状态；原文即模型投影，undo/剪贴板免特判；chip 链保留给需要不可分原子性的场景 |

## 后果

- 一个常驻 conversation 外壳承接无会话/blank/active：无会话 → blank 保持 ConversationRoot、Hero、root scope Workspace picker、scrollport、composer seat、InputBar 与编辑器表面；只有严格会话 header 和 body outlet 开始承载内容。同一 blank 会话 → engaging/active 也保持 InputBar 与编辑器表面。EmptyState 与受控 intent 链（`sessions.updateIntent`/`updatePendingPrompt`/`workspaces.sendSession`）随最后消费方一并删除。
- 输入面对命令零知识 + 可选依赖：无命令包时纯输入可用；`@` 引用与 skill 引用免费复用同一菜单/pick 流水线。代价是空格/回车裁决是逐 source 轮询协议，其应答语义（同步/异步、undefined 含义）为冻结约定。
- 提交事务化（attempt seq + 漂移守卫）使晚到结果回灌、会话切换、concurrent 重放三类缺陷结构性不可能，由矩阵测试钉住。
- 已知欠账：chip 跨刷新保真未立项；subagent 引用的模型表示待业务立项。
