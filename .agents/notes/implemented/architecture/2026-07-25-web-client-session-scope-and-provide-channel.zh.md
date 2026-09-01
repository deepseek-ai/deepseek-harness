# Agent Note: Web client Agent-scope 对等模型与供数通道（agents/scope / blank 复用 / provide）

Status: implemented

[English](2026-07-25-web-client-session-scope-and-provide-channel.md) | 中文

> 范围：client Agent scope（actx）与定向事件、client/host 实体化对等模型、空会话 blank 位与复用（`connectWorkspace`）、逐会话供数通道（`sessions.provide`），以及承载这些能力的 host wire 小件（summary `blank` 列、`host/session-added` 帧字段、`host/commands-changed` 帧）。输入状态机与 slash 管线见[输入状态机 note](2026-07-25-web-input-machine-and-slash-pipeline.zh.md)；命令业务面见[命令业务面 note](2026-07-25-web-command-surfaces-and-assembly.zh.md)。

## 问题

web client 只有一张全局会话面：slot 全部从根上下文渲染，插件拿不到「当前是哪个 agent/会话」的语境；draft 的权威副本埋在 Session 对象里，任何要参与输入的插件都无处下手。要支撑命令/输入体系，平台层必须先回答：

- 会话交互态（菜单、popup、草稿、在途请求）归谁持有，双会话如何结构性隔离；
- 「新会话」在 host 实体存在之前是什么——client 是否必须为它凭空创建独立生命周期；
- 会话 scope 组件如何「自己拿会话数据」，而不是层层下传 props；
- 用户放弃的新会话在 host 侧留下什么，由谁回收。

硬约束：host 是唯一真源；一切注册走 `ctx.effect` disposer；scope 机制与 host 的 Agent scope 架构一致；模型可见 ⟺ 已入会话日志。

## 决策

### 对等模型：client 与 host 同一根状态轴

host 侧 `session.create(workspaceId)` 一体产出 Session + Agent + cwd（作为不可拆分的原子整体）；client 侧就是这次出生的镜像——会话行进入 list mirror 的瞬间，client 为它铸 Agent scope（actx + provide + 输入面全套挂上）：

- 会话身份自出生即为 host 真身：sessionId 由 `session.create` 响应 / `host/session-added` 帧带来，client 侧一切寻址（scope tag、slot store 键、RPC 地址）用的都是同一个 id。
- 实体化时点 = 用户选定 Workspace（cwd 确定）的瞬间：client 当场调 `session.create({workspaceId})`，拿到完整实体。
- 「New Session 且未选 workspace」是**纯视图态**（一个导航位置），不对应任何会话/scope 实体；选定之前 composer 整体锁死（无 slash、无纯文本）。
- 「空会话」就是一个日志还空着的普通实体化会话；对 host 上所有 Agent-scope 插件（goal/plan/skill（技能）/…）它与任何会话无异，slash/plan 天然全活。

### Agent scope：actx 是 client 侧 cordis 世界的唯一会话载体

运行时 `agents/scope.ts` 与 host `dsh-scope` 机制层一致（fiber + tag + filter 过滤；不 value-import：host 包携带 scoped-events 的 `Events` merge，进 client program 撞 Context merge）：

- `createScope(ctx, key)`：no-op 插件 fiber + `extend({[kScope]: key, [Context.filter]: …})`——filter 直接住 actx：untagged listener 全局可收，tagged 只收本 scope。
- 派发就是 cordis 原语，thisArg = actx 本身：`actx.bail(actx, event, req)` / `actx.emit(actx, event, payload)`。
- `Session.bindScope(actx)`：resolve 铸 scope 时单次配对（重复绑 throw；dropScope unbind），镜像 host `Agent.loopCtx`——Session 用它自行派发 scoped 事件。actx→Session 反向走 `sessions.sessionOf(actx)` 一跳（镜像 host 插件 `agent.session` 用法）。

与 host dsh-scope 的有意分歧三条：

- filter 住 actx 自身而非独立 carrier：host 包装层护的是「业务 Agent subject 与 scope key 不漂移」（host 事件首参注入 Agent 本体），client 事件 payload 只带 id、无 subject 可护。
- key 用品牌 `SessionId` 值比较而非对象身份：host 里 agent.id === 会话 id（1:1 同轴），agent 身份直接复用 `SessionId` 品牌，client scope 的身份即 wire id。
- client 是 **Agent 身份** scope 而非活对象 scope：cold 会话期 host Agent 对象已 dispose（资源释放）而 client actx 存活（视野内）——身份轴严格对等、对象冷热有意不同步。

id→ctx 换乘只许三类位置（业务提供方永不换乘）：

- slot inject 工厂：ctx 不进渲染层，slot 框架交给组件的身份就是 sessionId，经服务 map 换回对象/controller。
- root 协调服务自寻址：从投影的 sessionId 经 `sessions.scope(id)` 找回 actx。
- root untagged listener：按 payload 的 sessionId 查自有 store。

### scope 生命周期：挂靠 list mirror，出生即视野、死亡即 prune

Session 实例与 scope 同生命周期，存活资格 = host listed（一个判据，mint 与 prune 共用）：

- 出生 = 会话行进入 client 视野（list 基线拉取 / `create()` 本地回声 / `host/session-added` 帧），lazy 首次 resolve 铸 scope（resolution 纯函数、渲染安全）。
- prune 一次同拆三样：Session 实例、scope fiber（级联挂在 actx 上的一切消费方）、会话键控 slot store。暂存会话（= `list.current`）例外：被移除仍在台上时保留冻结只读视图，stage 移走才拆。
- 重开 = lazy 重建实例 + `open()` 拉 history（host 会话日志是持久真相）。
- 遗留 TODO：approval/question 帧不进 history，跨 prune 不可恢复（manager 级 pendingBuffers 只覆盖「从未实例化」窗口）。

### blank 位：空会话的可见投影、转正与复用

「实体化但无首条提示词」的会话经 summary 派生位 `blank` 治理（派生列而非 header 字段，SessionHeader 保持不可变）：

- host 判据：`session.seq === 0`（零日志事件 = 尚无用户消息）。live 会话 `summarize()` 内存直读；cold 会话恒 `false`——JSONL provider 的 lazy-create 约定保证 never-appended 会话不进入 `persistence.list()`，所以 blank 从不落盘。
- wire 承载两处：`SessionSummary.blank` 必填列；`host/session-added` 帧必填 `blank` 字段（创建时恒 true，供别的 tab 按同一空会话状态入镜像）。
- client 镜像只降不升（单调），三来源翻转，全部复用既有 wire 信号：
  - 发送方本地：首次 `prompt()` 的**成功响应**翻 false（受理即证明用户消息已入 host 日志——此点翻转是确证而非乐观；`onEngaged` 同步更新列表镜像，当前 `New Session` 行原地转为普通标题，不新增列表行）。首条提示词被拒则会话保持 blank：与 host 权威对齐、继续显示为 `New Session`、在仍为该工作区成员时保持 connectWorkspace 复用资格。
  - 其他端：`host/session-status (running:true)` 帧翻转——blank 会话从不 running，首次 running 必然已非 blank；
  - 重连对齐：`session.list` 的 summary.blank 是权威，错过帧的端下次拉取自然对齐；陈旧的 blank:true 不能把已转正的会话重新标回 blank。
- 列表纪律：store 保留全部行；Workspace browser 的分组、平铺、搜索和计数共用同一可见投影——所有非 blank 会话都显示，blank 会话只显示 `session.id === sessions.current` 的一条，并强制标题为 `New Session`。切换 Workspace 后，旧 blank 实体仍在镜像中但从列表隐藏，目标 Workspace 的 current blank 显示；因此用户可见面全局至多一条 blank 行。
- 残留账零 GC：刷新后 blank 会话带位回来，下次同 workspace 且仍为成员时复用，普通单端路径使每个 workspace 至多保留一个；host 重启后 blank 无盘痕自然蒸发；多 tab 竞态多出的空壳只会成为非 current 隐藏行，后续复用消化，不做协调。

### connectWorkspace：New Session 的唯一入口

`workspaces.connectWorkspace(workspaceId): Promise<SessionId>`（归属 WorkspaceRuntime——它同时持有 workspace 规范 path 与 sessions 引用）：

- 复用臂：list mirror 中找 `blank && cwd == workspace.path && sessionIds.includes(id)`——host 自己的成员规则，绝不只按 cwd。没有账户槽位的 cwd 匹配（CLI（命令行界面）/TUI 在 host cwd 创建的会话，或已删除/重建的注册）会打开一个任何分组表面都无法显示在该工作区下的会话，因此落到新建臂（见[成员复用修复](../bug-fix/2026-08-05-workspace-blank-session-reuse-membership.zh.md)）；命中直接返回该 id，不新建。
- 新建臂：未命中则 `session.create({workspaceId})`，返回新 id。
- 未知 workspaceId fail loud（不静默创建到别处）。
- 解析保证（两臂同约定）：promise resolve 时返回的 id 已在 list store 且 `sessions.binding(id)` 同步可解析——`SessionRuntime.create` 在 RPC 成功后同步投影列表再 resolve，使 draft 搬运方可以在 open 之前往新 scope 的 machine 写文本，不等 notifier flush。
- 调用方拿 id 自行 `sessions.open`；首条提示词发送就是普通 `session.prompt`——会话本来就在，失败即普通提示词失败，draft 文本还在 machine 里，重试即再次发送。
- 全局 New Session 按钮默认取 `recentWorkspaceId`：先比较各 Workspace 内 Session 的最新 `updatedAt`，无 Session 时回退 Workspace `createdAt`，同值保持 Host 顺序；只有完全没有 Workspace 时才 `sessions.clear()` 进入无会话视图。Workspace 分组内的创建动作仍显式命中该 Workspace。
- 运行时启动时订阅首次完整基线：若已有恢复成功的 current 会话则保持不动，否则自动 `connectWorkspace(recentWorkspaceId)` 并 open 返回的 blank 会话。该策略只结算一次；之后用户主动 clear 不会再次被自动选择覆盖，连接失败则等下一次基线投影重试。
- blank Hero 中改选 Workspace 也走 `connectWorkspace`；若目标 id 与当前 id 不同，先把当前 input machine 的非空 draft 搬到目标 scope，再 `sessions.open(nextId)`。旧 blank 实体不删除，只因不再 current 而从列表隐藏。

### 逐会话供数：`sessions.provide` 标准件通道

会话 slot 组件「自己拿会话数据」的唯一供数路径。插件以静态描述符 `sessions.provide({hooks, props, resolve})` 声明固定键表（重名 key 注册时 throw），`resolve(binding)` 在确定会话下物化值并随 scope 拆；ui-renderer `standardKit` 统一循环把 hooks 格绑成 `use<Name>` 选择器钩子（`observableHook`→uSES，防 tearing）、props 格原样透传。

slot scope 是闭集 `root | session-maybe | session`：

- `root` 只拿全局标准件，不接收会话身份或供数。
- `session-maybe` 以**收养（adoption）身份语义**跟随 current 会话（唯一行为——不存在「永久保持实例」模式）：空态出生的化身在**第一个**会话到来时保持 React 实例（空壳收养它——不重挂，DOM 存活）；此后行为与严格会话 entry 完全一致——切到不同会话重挂，跌回无会话也重挂为崭新的空态化身（之后再次收养）。因此组件本地的逐会话状态**由构造保证**随切换清零；需要活过切换的状态必须住会话绑定的源（machine、store、hooks）。无会话时 `sessionId`、`useSession`/`useInput` 的选择结果及 `inputActions` 均可缺省。根部无 key 的 `SessionMaybeProvider` 通过订阅运行时的原子 `currentProvide` 投影驱动这条更新——选择移动和提供方名册变化经同一 source 发布，current id 不变时的名册变化也会重发已挂载 bundle，而不是把 entry 困在过期的钩子/prop 形状上——`SessionMaybeProvideInfo` 靠静态键表在无会话时仍保留完整钩子/prop 形状；逐 entry 的收养记账（化身计数 key）住在 renderer 的 `SessionMaybeEntry`。
- `session` 保证 `sessionId`、所有钩子 source 与 props 均存在；每个严格 entry 的错误边界以 `sessionId` 为 key，切换会话会重建该 entry 及其会话 store。

`conversation` 是 `session-maybe` 的常驻外壳：`ConversationRoot`、HeroShell、Workspace picker、root 持有的 scrollport 与 composer stack，以及 overlay chain 的 fallback 外框，在无会话 → blank 会话的切换中保持 React 实例。两个严格 session entry 只填入固定区域，不改变该树的父级：`conversation.session.header` 在 scrollport 上方承载 breadcrumb／tab／action，`conversation.session` 在其内部承载 view ring 与 draft mirror；二者共享同一个 session scope chat store。composer bar（`conversation.composer.bar`）本身即为 `session-maybe`：无 session 时，其 machine faces 和消息动作保持惰性，整张虚线卡片可经指针打开现有 Workspace picker，只读 textarea 也可通过 Enter 或 Space 打开。session 出现后同一实例（含 textarea）转为 live；其余输入 slot 保持严格 `session`，在此之前不派发任何内容。blank → engaging/active 的 InputBar 不因 phase 翻转而重建。

- 运行时内建第一条：`'session'` 钩子——`useSession` 本身走同一机制，无特判。
- Concurrent 纪律：渲染平面只从 hooks 格读（uSES 一致性保证）；props 格回调只在事件 handler 空间用；描述符解析 render-safe（幂等缓存、废弃渲染残留由 prune 收尸）。
- 第三方组件值零依赖，类型一行 type-only import（declaration merging 进 `SessionStandardProps` / `SessionMaybeStandardProps`）。

### 队列只读镜像

- 队列语义：running 不锁输入；普通消息经 `session.prompt {mode:'queue'}` 排队，命令永不排队。

### host wire 小件

- summary `blank` 列与 `host/session-added` 帧 `blank` 字段（见上文 blank 位）。
- SSE（Server-Sent Events）帧 `host/commands-changed`（纯失效信号）；client 路由为类型事件 `commands/changed` 与 `connection/reset`（连接代建立后广播，wire 派生缓存一律视旧态为陈旧）。 该 commands 帧及其类型化 client 事件后来被「`commands/change` 经 `ctx.remote.$on` 原样转发」取代（[转发的 Remote 事件](2026-08-10-remote-event-delivery.zh.md)）；`connection/reset` 不变；本条陈述的「失效而非差分」契约依然成立。
- `command.list/execute`、`skills/list` 一律 `sessionId` 单址（会话恒有 Agent，`agentFor` 的恢复语义现成）；命令面叙述见[命令业务面 note](2026-07-25-web-command-surfaces-and-assembly.zh.md)。
- `session.create` 请求形状：workspaceId/cwd 二选一 + 可选调用方预分配 sessionId（同 id 同 cwd 重试幂等，异 cwd 报 `session-conflict`）。

## 考虑过的替代方案

| 弃案 | 一行理由 |
|---|---|
| client-local Intent + materialize（published CAS / pendingPrompt attach 事务 / before-create 链） | client 被迫模拟 host 缺失的前半段生命，养出 published CAS、attach 事务、部分发布一坨状态机 |
| host 预留 ID（draft Map） | host 只认了个号，状态机原封留在 client |
| host draft Session（有 Session 无 Agent） | 每个查 Agent 的 host 面都要为 draft 分叉；core 要新增 `attachAgent` API + header cwd 后写 |
| 无 cwd 先绑 Agent（ungrouped） | header.cwd readonly「created in」不变性被推翻 + launch-dir 副作用产品坑 |
| React Context 层层传会话语境 | 插件在 host/client 两侧应是一个心智模型；scope 机制与 host dsh-scope 同构 |
| `scopeTarget` carrier + 融合派发器（镜像 host `agentEvents`） | host 包装层护的是「业务 Agent subject 与 scope key 不漂移」，client 事件无 subject 可护；filter 住 actx + cordis 原语覆盖全部需求 |
| Session 不持 ctx（对象层 cordis-free） | 只为筛选单测不引 cordis 而生的红线，代价是 contribute 两跳回调 + 可变公有字段；host Agent 本就持 loopCtx |
| Session 实例常驻（resident-instance） | host 会话日志即持久真相；常驻仅为身份便利，与 scope 生命周期错位是复杂度之源 |
| 组件收 wiring 回调包（inject→props 两层下传） | 标准件通道让组件自取；公共 API 收敛为 hooks + 稳定 props |
| Hero 无会话视图与会话 Conversation 整支互换 | 即使外层 layout 不变，Hero、picker 与 composer 子树仍会一起重建，界面产生整块抖动 |
| 让 InputBar 自身变成 `session-maybe` | 输入状态机、键盘命令面与动作都被迫接受缺省值；只替换 disabled 输入体能把可选性留在外壳边界 |
| 专用「转正」帧 | `session-status(running:true)` 语义蕴含转正（blank 会话从不 running），加帧是 wire 多一型换零信息 |

## 后果

- 插件获得与 host 同构的会话上下文：逐会话状态挂 actx、随 scope fiber 一次拆装，泄漏结构性不可能；双会话隔离由 scope filter 结构性保证。
- client 对象层收敛为 wire 镜像：会话身份、生命周期、能力判别全部以 host 实体为准——输入体系（下一层）面对的永远是「有真 Agent 的会话」，slash/skill 等提供方一律以 sessionId 直接寻址。
- 空会话治理零专用机制：状态靠一个派生位，可见性靠统一列表投影（仅 current blank 以 `New Session` 展示），回收靠 lazy persistence 的既有约定（重启蒸发），常规上限靠同 Workspace 复用。
- 代价：id→ctx 换乘纪律、provide 的 Concurrent 纪律都是约定而非类型强制，靠 review 与测试钉住。单一状态轴仍会在 Session 存在前隐藏 machine face；这段时间内，[常驻会话壳](../../../../packages/client/ui-conversation/README.zh.md)会把激活操作转到 Workspace picker。
- 已知欠账：approval/question 跨 prune 恢复（TODO）；模型选择以 live-mutation 形状回归（host `selectModel` 三件套现成，其 client 消费方尚未构建）。
