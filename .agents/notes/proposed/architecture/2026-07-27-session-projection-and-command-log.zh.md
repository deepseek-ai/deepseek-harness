# Agent Note: 会话投影与命令生命周期日志记录

Status: proposed

[English](2026-07-27-session-projection-and-command-log.md) | 中文

## 问题

三个在途的 web 功能——todo（#497）、goal（#527）、plan mode（#587）——都要从会话日志推导按会话的状态并呈现到浏览器客户端，而三者各自发明了一套同样的机制：

- **客户端核心类吸收每一个领域。** 三者都往客户端运行时的 `Session` 类里添加私有字段、拉取编排和事件 switch 分支，并经 `ConversationSnapshot` 投出各自的值。仅 plan 一家就加了七个私有字段和三层栅栏（请求版本、事件版本、最新活值缓存）；goal 加了写 revision 栅栏外加一个合并式重取循环；todo 加了一个投影（projection）字段和一条事件 case 分支。再来第四个领域，就要第四次改动核心类。
- **三条基线通道。** todo 搭在历史尾页的 `todos` 字段上——由 **api-proxy 内部**的 `backscanTodos` 计算，业务折叠（fold）逻辑寄居在载体里；plan 加了一个专用的 `session.planMode` 一元 RPC；goal 加了 `goals.get`。同一个问题，三种协议格式（wire format）。
- **命令结果不可恢复。** `/goal`、`/plan` 以及其余所有斜杠命令都只在 `command.execute` RPC 响应里返回结果，以一条转瞬即逝的 composer 通知呈现在发起命令的标签页上。会话日志里什么也留不下：刷新、另开标签页、恢复或 fork 都会丢掉「该命令曾经运行过」的记录。领域*状态*变更是持久的（goal 提交 `goal/change` 元数据，plan 提交 `plan/mode`），但命令调用本身及其结论不是。

底层缺口是架构性的：客户端没有一个 seam 让插件在会话 scope 内观察会话事件并维护自己的派生状态；host 侧也没有统一的方式把日志派生状态的当前值交给客户端——而该状态的历史可能已被分页挤出客户端窗口之外。

## 提案

先立四件基础设施，之后各领域都退化为纯贡献方。

### 全量值事件规则

携带状态的日志事件必须携带变更后的完整状态，绝不携带裸增量。三个领域现状已然合规：`todo/write` 是整表快照，`plan/mode` 是一个完整布尔值，`goal/change` 元数据是完整的 `GoalSnapshot`（或一个全量值清除墓碑）。该规则让每个领域的状态转移始终足够廉价（框架逐事件驱动它），让值在协议层自描述，并让任何消费方都可以把最近推送的值当作最终值——靠 seq 比较获得乱序免疫，且自愈：漏掉的更新会被下一次更新纠正。

### host 侧投影注册表（`dsh-session-projection`，新包）

一个轻量的 Service Definition 包：merge-extensible 的 host 状态与客户端视图类型表、注册表服务，以及针对持久状态和客户端值的 zod 校验。能力 seam 的角色如下：领域 host 插件提供投影单元，载体消费这些单元，两侧互不相识。

领域注册的是一个**状态驱动计算单元（state-driven computation unit）**——纯折叠、若干声明及可选客户端视图——绝不是一个不透明的 getter。驱动它是框架的职责（订阅、水位线（watermark）、缓存，以及后续的检查点机制），领域只负责计算。投影服务于所有业务领域（会话标题、plan、goal、权限、todos）；命令只是其中一条触发路径，在本约定中没有任何特殊地位。

```ts ignore-check
export interface SessionProjectionStateMap {} // host fold states
export interface SessionProjectionMap {}      // client-visible whole values

export interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S> {
  key: K
  stateSchema: ZodType<S>
  persist?: boolean // host-only units opt in; client-visible units always persist
  /** State for the empty log. */
  init(): S
  /** Pure transition: previous state + one event → next state. The framework drives it; domains hold no subscriptions. */
  apply(state: S, event: SessionEvent): S
  /** Client view; omitted for host-only units. */
  wire?: K extends keyof SessionProjectionMap ? {
    viewSchema: ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
  } : never
  /** State must be plain JSON (persisted-cache precondition); bump to invalidate persisted rows. */
  stateVersion: number
}

declare module 'cordis' {
  interface Context { sessionProjections: SessionProjectionRegistry }
}
```

- `SessionProjectionStateMap` 描述 host 折叠状态；`SessionProjectionMap` 继续作为协议块和 React 钩子经 `import type` 共享的唯一客户端 DTO 表。单元省略 `wire` 即保持 host-only。客户端值如何*渲染*是 slot 体系的事，永远不归投影层管。状态/视图拆分见[已实现的状态与客户端视图记录](../../archived/architecture/2026-08-19-session-projection-state-and-client-views.md)。
- **host 是投影唯一的计算地点。** 框架主动驱动（eager drive）每个已注册的单元：每个已提交的会话事件都经过 `apply`；对某事件不感兴趣的单元返回同一个状态引用，而引用未变（`Object.is`）就不产生任何下游工作。客户端从不折叠领域事件——它们收到的是成品值（基线块 + 下文的推送帧）。这消除了双重实现陷阱（plan 的双事件折叠只在 host 写一遍），也消除了一切客户端侧领域代码。
- **状态永远靠计算得出，绝不入日志。** 日志只存事件；单元的状态住在框架的按会话水位线缓存里（每单元一份 `{state, observedSeq}`），并在后续阶段进入 domain-KV 存储 seam 上的**持久投影缓存（persisted projection cache）**：形如 `(sessionId, key, ver, seq, val)` 的行（`ver` = 单元的 `stateVersion`，`seq` = 水位线，`val` = 状态 JSON）。一行永远不会是错的，至多是陈旧的——其 `seq` 精确说明陈旧到哪。冷读与活读共用同一套读取配方：取缓存状态（或 `init()`），只对超出其水位线的事件做正向 `apply`，再对结果做 `view`。冷列表（跨全部 workspace 列出每个会话的标题）变成一次索引读，至多外加一小段尾部回放；session-persistence seam 在同一后续阶段为这段尾部补一个按 seq 起读的原语。写入策略：节流（次数/间隔，可配置）外加两个强制点——`turn/end` 与 detach（由活转冷的时刻）。两次写入之间崩溃的代价是尾部回放更长一些，绝不会是值出错。
- 领域的输入事件集由领域自己选择：todos 只折叠 `todo/write`；plan 折叠 `plan/mode` 外加它自己的 `/plan` `command/run` 记录（见 plan 一节）；goal 折叠 `goal/change` 元数据；会话标题折叠其标题事件（顺带下线专设的 `session/title` 帧与客户端的标题快照表——这是该 seam 收编的第四个手工投影）。
- 注册是 effect（disposer 随 fiber 走）：插件卸载后其 key 从后续响应中消失，客户端将其读作能力缺失——HMR（热模块替换）语义随之自动成立。key 重复直接 throw。领域插件在 `ctx.inject(['sessionProjections'], …)` 下注册，因此不带注册表的 headless 组装完全不受影响。
- 该包拥有 `./invariant`（每个被服务的 key 都有一条存活的注册）。

### 已交付的消费方：subagent 身份单元

注册表的两处既有读法已经服务于本 RFC 协议计划之外的一个已交付消费方：[subagent 列表经投影单元读取身份](../../archived/architecture/2026-08-06-subagent-list-identity-projection.md)注册了 `subagent` 单元——从 `subagent/descriptor` 按 last-wins 折叠出的持久化 mode/label 身份——`SubagentRuntime.listChildren` 对 live child 经 `snapshot()` 读取（水位缓存，零日志读），对 cold child 则用一次持久化整读的结果调用 `restore({}, events, 0)` 读取。注册表约定不变：没有失败通道、没有新读法——单元永不抛错，值缺席本身就是信号，缺席如何呈现是该消费方自己的决定。

### 协议层：历史尾页上的 projections 块

```ts ignore-check
// session.history response, tail page only (beforeSeq absent):
{ events, hasMore,
  projections?: { asOfSeq: number, values: Partial<SessionProjectionMap> } }
```

api-proxy 的历史处理器切出尾页后同步遍历注册表——全程没有一个 `await`，因此所有 key 的值与 `asOfSeq` 构成同一个一致切面。`asOfSeq` 是**最后一个事件的 seq**（`session.seq - 1`；空日志为 `-1`，与 `session/subscribed.lastSeq` 同一套词汇），因此携带基线之后首个变更的推送帧在比较时恒严格更大。api-proxy 不持有任何领域知识（与 `viewFor` 面向 `ctx.tools` 是同一种载体/贡献方关系）。

不新增 RPC 方法。时机上的重合是精确的：客户端每一个需要新基线的时刻（打开、重连重同步、缺口修补）本来就要拉尾页，而唯一永远不需要基线的路径（loadOlder）恰好是唯一传 `beforeSeq` 的路径。因此客户端**完全没有**独立的「重取基线」决策。窗口内容从不充当信号：「窗口里没有该领域的事件」这个问题在窗口内从构造上就无法回答，只有基线能回答它。

随此块下线的旧通道：`session.planMode` 与 `setPlanMode`（读写两侧——plan 选择改走标准命令通道，见 plan 一节）、`goals.get`（读侧；六个变更 RPC 保留，但其响应不再喂状态——mux 事件反正会到）、`todos` 搭载字段，以及 api-proxy 里的 `backscanTodos`（移入 todo 领域的单元，落在 `tool-todo`）。

### 推送帧与客户端值仓（领域零客户端代码）

既然 host 是唯一计算地点，成品值经一个新的 mux 帧送达客户端：

```ts ignore-check
// MuxFrame union + schema branch:
{ type: 'session/projection', sessionId, key: string, value: unknown, seq: number }
```

只要某单元的状态引用发生变化（上文的 `Object.is` 闸门），框架就发出该帧；`seq` 是发出时该单元的水位线。这是实时推送状态，绝不入日志——与 tool-view 的 `view` slot 同一姿态：回放时在 host 重新计算。

客户端对象层为每个会话维护一个**通用值仓（value store）**：`key → { value, seq }`，由尾页的 projections 块播种、由该帧更新，唯一规则是 **seq 高者胜**。重放的基线无法把更新的帧往回滚；丢失一个帧的代价只是陈旧——到下一个帧或基线为止——绝不会出错。没有 `fromEvent`，没有按领域的 cell 注册，没有客户端侧领域折叠——领域交付投影支持只需**零客户端代码**（`SessionProjectionMap` merge 经 `/types` 出口同时服务两侧）。专设的 `session/title` 帧与 manager 的标题快照表都收编进这对通用机制。所有按领域自造的栅栏（#587 的三层、#527 的写 revision）都消融进这一条 seq 规则。

### plan 走标准命令通道（完整示例）

plan mode 完整演示了这套模式——触发路径、运行面、回放面，三者干净分离：

- **触发路径**：web 的 plan 开关像任何其他命令一样经 `command.execute` 发送 `/plan` / `/plan off`；专设的 `setPlanMode`/`planMode` RPC 下线。用户的*请求*被持久记录为该命令的 `command/run { name: 'plan', args: 'off' | '' }`——结构化字段，无需解析行文本。
- **运行面**（不变）：plan-mode 服务在内存里保持待定意图，并在下一个轮次边界落下 `plan/mode`。冷启动时服务从回放面重建其意图队列（「运行态为空即以回放态为准」）。
- **回放面**：plan 的投影单元折叠**两**种事件——它自己的 `command/run` 记录设置 `wanted`；`plan/mode` 设置 `active` 并清除 `wanted`；`view` 推导出 `{ active, pending: wanted !== null && wanted !== active }`。待定态由此成为纯回放量：host 重启能恢复它，其他标签页折叠同样的事件（跨标签页待定态随之自动获得），冷读回答 `{ active: false, pending: true }` 也是准确的（「一个未兑现的选择正等待恢复」）。

领域的输入事件集由领域自己选择——本示例落实的正是这条一般规则。「用户请求过 X」是出现在投影里（plan 折叠自己的命令记录），还是只出现在 flow 里（命令节点反正会渲染），属于各领域自己的语义，永远不是框架的关切。

### React：`useProjection`，第五个框架钩子席位

既有四个席位都装不下这份状态（store 纪律禁止业务对象；inject 禁止钩子；`ConversationSnapshot` 正在被清退）。`useProjection` 成为一个框架席位，在 ui-renderer（唯一的钩子铸造点）铸造，经与 `useSession` 相同的标准套件通道（`provideInfo` → SessionProvider → props）送达：

```ts ignore-check
type UseProjection = {
  <K extends keyof SessionProjectionMap>(key: K): SessionProjectionMap[K] | undefined
  <K extends keyof SessionProjectionMap, S>(
    key: K, selector: (v: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean): S
}
```

`undefined` 统一表示能力缺失（host 插件未挂载，或尚无任何基线/帧携带过该 key）。值仓只暴露按 key 的裸 `{subscribe, getSnapshot}` 面；其余交给带逐 key 缓存的 `bindSnapshotSelector`——引用稳定性成立，因为一个 key 的值引用只在帧或基线落地时才变化。写路径不变：变更回调留在 inject 共享面（回调出自 inject，活状态出自 `useProjection`）。

「钩子不得穿过 inject」的唯一既有违例——`DetailsInjected.useSelection`——随本变更一并收编：选中态是住在聊天 store 里的查看状态，因此 details 注册声明共享 store 句柄，组件改读 `props.useStore(s => s.selection)`；`useSelection` 退出 inject 约定。

### 日志中的命令生命周期

两个仅日志（非 surface、模型不可见）事件，镜像 `tool/call`/`tool/result` 的配对：

```ts ignore-check
'command/run':  { commandId: string; name: string; args?: string; source: CommandSource }
'command/done': { commandId: string; kind: 'success' | 'error'; text?: string }
```

host 侧命令执行器（`packages/interaction/commands`）在调用处理器前追加 `command/run`，在结算时追加 `command/done`——在接收 agent（智能体）的会话上直接独立追加，与[合成轮次移除](../../implemented/simplification/2026-07-28-remove-synthetic-log-only-turns.zh.md)之后所有插件自有 log-only 事件同一形状：没有轮次包裹它们（轮次只描述模型循环执行），持久化在常规检查点排空它们，run/done 配对由 commands 包自己的 invariant 伴生插件把守。载荷是结构化的——`name` 以及默认携带的 `args` 来自解析器自己的切分（`parseCommand` 的 name 与 rawInput），因此消费方（折叠自己命令记录的投影单元、富命令卡片）永远无需重新解析行文本。当载荷由权威领域事件持有时，命令定义会设置 `recordInput: false`；此时 `command/run` 省略 `args`，而不是重复该载荷。`text` 是处理器的原样结果——与 `tool/result.content` 同一性质的事实数据，不是呈现（版式如何编排仍由客户端在渲染时计算，满足「呈现永不入日志」这条红线）。想让模型知道结果的领域保持既有行为（plan 的旁白、goal 的注入）——那是领域自己的决定，保持不变。

由于已提交事件会在 mux 流上广播，刷新后仍在、多标签页同步、fork/恢复后可还原这三件事随之全部自动获得。`command.execute` RPC 退化为准入判定——`{ matched, commandId? }`：该行是否匹配命中，以及命中时新铸的配对 id，发起命令的客户端据此把自己的请求与生命周期事件产出的 flow 节点关联起来。一次性通知通道（`runDetached` → `noticeFor`）就此下线。

客户端 flow 构建器新增一个通用命令节点（run/done 按 `commandId` 配对；跨窗口截断时与工具配对同样软降级）。渲染走一个新的 keyed slot `'conversation.chat.commandview'`，key = 命令名，**兜底 = 通用命令卡片**（零注册即可用——从前的通知文本现在持久地渲染在 flow 里）。领域要升级展示，只需注册一个行组件，取材于 `command/run` 的结构化字段与自己的投影值（`useProjection`）——与 toolview 解散之后的工具行同一形状。

## 交付计划

基础设施先行；三个在途 PR（Pull Request）原样不动，待基座落地后重新对接（它们的迁移映射即指南）：

1. **host 基座**：`dsh-session-projection`（单元约定、主动驱动、水位线缓存）+ api-proxy 的 projections 块 + `session/projection` 推送帧。零领域注册也可合入（此时块与帧直接缺席）。
2. **客户端基座**：通用值仓 + `useProjection` 席位；下线按领域的 cell 机制，并在标题单元注册后一并下线 `session/title` 帧与标题快照表。帧的形状依赖 1（在此之前 fixture（测试前置数据）喂合成帧）。
3. **命令通道**：两个事件、执行器落日志、通用节点 + keyed slot、通知通道下线、`{matched, commandId?}` 准入。与 1 并行。
4. **领域重新对接**（在 1+2 之后）：先 todo（单元进 `tool-todo`，删掉搭载字段），再 plan（双事件单元、RPC 下线、开关改发 `/plan`），最后 goal（`goal/change` 单元，删掉 `goals.get`，把六个 `Session` 方法移入领域插件的 inject）。
5. **持久投影缓存**（后续阶段，待 domain-KV 存储 seam 就绪后）：`(sessionId, key, ver, seq, val)` 行、带 turn/end 与 detach 强制点的节流写入，以及持久化侧供冷尾部回放用的按 seq 起读原语。

## 备选方案

**专设一个 `session.projections` RPC**——不予采纳：基线刷新时刻与尾页拉取精确重合，单独的一元 RPC 只会换来第二次往返、第二个待调和的 seq，以及一个客户端「何时重取」决策——而搭载设计把这个决策整个删掉了。

**不透明的 `get(agent)` 提供方约定**——否决：计算模型藏在领域内部时，框架永远无法为状态做检查点、无法服务冷会话（没有 agent、没有已加载的日志——`get` 无处可跑）、也无法从日志中段续算。注册 `(init, apply, view)` 单元把驱动权交给框架，领域只留纯数学；有 host 侧行为需求的领域，其服务订阅照旧自持，与投影单元互不牵连。

**为 plan 待定意图专设的仅实时叠加钩子（`live?(agent, base)`）**——不予采纳：它存在的唯一理由是用户的 plan *选择*不在日志里。让选择走标准命令通道后，`command/run` 上了账，待定态成为纯回放量，投影继续由纯折叠与可选客户端视图构成。

**把注册 API 命名为 `registerFold`**——已被单元约定取代：注册对象如今确实是一个折叠，但本仓库里 `fold*` 专指纯 `(events) => state` 辅助函数，而该注册表接收的是带 key、带 schema、带版本的单元。投影仍是事件溯源中指称读模型角色的术语，#587 的 Note 标题与 #497 的评论也都已在使用它。

**客户端侧折叠（带 `fromEvent` 的按领域投影 cell）**——否决：一旦 plan 的单元要折叠两种事件，客户端 cell 就必须在浏览器里复刻 host 的状态转移逻辑——同一个折叠写两遍、各自演化。推送成品值（标题帧先例的泛化）保住唯一计算地点，并把客户端简化为一个由 seq 把守的通用值仓；领域零客户端代码。

**对日志尾部的有界反向扫描（absorber 声明）。**不予采纳：现有实现均不支持它，它只服务于「每个事件都携带完整折叠状态」的领域，而持久投影缓存以统一方式覆盖同一冷读需求（缓存行加正向尾部回放——与客户端的基线和追赶、与分页加载是同一套配方）。只有当出现检查点机制服务不了的真实冷读路径时才重议。

**`invalidate` 式 cell（标脏，遇领域事件就重取）**——不予采纳：它的存在只为伺候增量事件。全量值规则让每个领域都是 last-wins；goal 的重取循环、合并逻辑、陈旧读栅栏随之全部消失。

**把注册表挂到 `ctx.apiProxy` 名下**——不予采纳：会话投影并非 web 专属（TUI、ACP（Agent Client Protocol）、headless 都是未来消费方），且领域包不得依赖 apiproxy 包。独立 seam 还顺带删掉了 #587 从 api-proxy 指向 plan 包的 type-only 导入边。

**第二张客户端 DTO 类型表**——不予采纳：`SessionProjectionMap` 仍是协议与 UI 共享的唯一客户端词汇。`SessionProjectionStateMap` 不是另一张客户端视图表；它描述 host 折叠状态，使内部状态可以不同于发往客户端的值。

**用事件广播收集、替代注册表遍历**——不予采纳：异步监听器给不出那个单一的同步切面，而正是它让 `asOfSeq` 成为横跨所有 key 的一致快照；注册表才是本仓库承接贡献的通行形状（`ctx.tools`、提示词片段、slot）。

**专设 `plan/select` 选择事件（用结构化领域事件替代折叠命令记录）**——不予采纳，改用命令通道：`command/run` 的结构化 `{name, args}` 已经记录了选择，`/plan` 的语法与其折叠逻辑同住一个插件（领域内耦合，非跨领域），还少一种事件类型。处理器必须在任何可能失败的路径之前调用 `set()`，使已入日志的请求与运行面不可能分叉——这是领域内部的顺序约束，文档写在处理器处。

**保留 `setPlanMode` 专用 RPC**——不予采纳：plan 选择就是一条普通的用户命令；命令通道给它持久记录、flow 渲染、多标签页可见性与准入语义，不需要专设协议方法。Web UI 的交互组件（一个开关）在内部拼出命令行即可。

**让变更 RPC 的响应喂 cell 状态**——不予采纳：已提交的 mux 事件即刻到达，携带同一个全量值外加 seq；「响应喂状态」正是当初逼出 #527 写 revision 栅栏的根源。

## 验收标准

- 领域插件把按会话的日志派生状态送达 React，只需写：全量值事件声明、一次 host 侧单元 `register`、自己那份 `SessionProjectionMap` merge、以及 inject 回调——零客户端侧代码，不改客户端 `Session` 类、`ConversationSnapshot`、api-proxy 或任何协议 schema 文件。
- 历史尾页携带 `projections`，其 `asOfSeq` 等于窗口尾部 seq；loadOlder 页永不携带；未装注册表的部署照常返回不带该块的历史，客户端把所有 key 视为缺席。
- 陈旧的基线不能覆盖更新的 `session/projection` 帧，重放的帧也不能让值仓倒退（两条路径都做 seq 高者胜测试）。
- 在一个标签页执行的斜杠命令，刷新后、在第二个标签页上、恢复之后都在 flow 中渲染出持久节点；未注册的命令渲染通用卡片；命令结果的 composer 通知路径彻底移除。
- `useProjection` 经标准 props 套件抵达组件；没有任何钩子穿过 inject 约定（包括 `useSelection`）。
- 会话标题搭乘这对通用机制（基线块 + 投影帧）；专设的 `session/title` 帧与客户端标题快照表彻底移除。

## 风险

- **全量值规则是承重结构**：未来某个领域若只记裸增量，就无法凭其最新事件服务消费方，还会让自己的单元复杂化。缓解：该规则写明在本 Note 与投影包的 README 里；单元约定让完整状态在每次转移处都是显式的。
- **单元的同步纪律**：`init`/`apply`/`view` 一旦 await 就会撕裂一致性切面。注册表在文档中申明这条纪律，invariant 配套在可行范围内断言同步性；其余由评审把关。
- **注册表的实时增删不做推送**：会话中途加载或卸载领域插件会改变键集，但不会触发任何会话事件、也不会推任何帧；开着的客户端持有陈旧的 key 直到下次尾页拉取（重连、缺口修补、打开）。接受为仅开发期（HMR）的陈旧时窗——日后可以在变更流上加一个注册表变更推送，约定不受影响。
- **忙碌会话上的主动驱动开销**：每个已提交事件都要过每个已注册单元的 `apply`。按构造，单元的逐事件开销很低（全量值规则），不匹配的事件返回同一引用，且已注册领域的数量很小；若真出现热点路径，可以加按单元的事件类型预过滤，约定不变。
- **投影载荷膨胀**：每个尾页携带每个已注册的 key。载荷是 UI 量级状态的全量值（一张 todo 清单、一份 goal 快照）；将来若某领域的值很大，可以在请求上加逐 key 的 opt-out 或惰性 key，模型本身不用改。
- **命令日志体量**：每条斜杠命令两个仅日志事件；上限由人敲命令的频率决定，相对分片体量可忽略不计。
- **重新对接的返工**：三个未合入的 PR 要变基到挪动后的地基上。这是基础设施先行的既定代价。
