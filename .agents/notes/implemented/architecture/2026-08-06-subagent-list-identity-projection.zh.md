# Agent Note: subagent 列表经投影单元读取身份

Status: implemented

[English](2026-08-06-subagent-list-identity-projection.md) | 中文

## 问题

重写前的 `SubagentRuntime.listChildren` 对每个 `header.origin === 'subagent'` 的直接 child，每次列表都执行 `listEvents` 加 `readEvent` 两次整日志物化，且每次物化都伴随整日志 structuredClone，只为从描述符事件里折出 mode 与 label 两个字段。描述符在日志中的位置不固定——fork 前缀任意长，zstd 压缩帧没有 seq 索引——因此定位没有捷径；这条路径没有任何缓存，代价随 transcript（文本记录）长度 × child 数量 × 列表频率放大。它还把 session-query 拉成列表的硬依赖：没有 query backend 的部署，`list_agents` 以 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` 整体拒绝，尽管枚举所需只是 header 事实。

同一根因还有第二个症状：host 侧的 `hasSubagentDescriptor()` 在每次 Agent（智能体）绑定 RPC 的属主判定上扫描目标会话的 own suffix，即便 `SessionHeader.origin` 已经回答了同一个问题的绝大部分。

根因在于 [durable-subagent-catalog 决策](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.zh.md)把描述符事件（`subagent/descriptor`）定为目录的唯一持久权威，却没有为描述符读取配任何缓存层，并把逐 child 双读明确接受为「无索引的正确性基线」。[web subagent conversations](../feature/2026-07-27-web-subagent-conversations.zh.md)（#1569）已把「是不是 subagent」放进了 header（`SessionHeader.origin`），身份判定不再读日志；mode 与 label 仍然要扫。

## 决策

mode 与 label 由 `subagent` projection unit（纯身份两臂）折叠，unit 是折叠规则的唯一权威。枚举使用共享 Session query corpus，取值则走三级「算完即止」阶梯：live child 同步读注册表的既有水位缓存（零日志读）；unseeded cold child 可以使用可选 `sessionProjectionCache` checkpoint，因为其精确 inherited cut 已知为零；每个 seeded child 与每次 cache miss 都执行一次含正文的 Session observation，再经注册的 `subagent` unit 折叠。无索引、不自建缓存、列表侧无回写。

消除逐 child 扫描的出路有三类：把 mode/label 提升进 header（写路承担）；为投影建持久派生（checkpoint 阶梯，或随查询索引重建落值、读端对账）；读时现算（live 走水位缓存，cold 一次整读）。本记录取第三条。「值随查询索引落库」已整体退役：查询基础设施被迫认识领域词汇，而唯一消费方读时现算即可满足——live child 的零读由 session-projection 既有水位缓存白拿，cold child 的一次整读被「算完即止」显式接受。前两条与退役理由详见考虑过的替代方案一节。

要点：

- **subagent 列表使用 Session query corpus 完成枚举与含正文 observation**：mode/label 仍经 `ctx.sessionProjections` 获取，列表不拥有 descriptor parser 或领域索引。
- **取值三级「算完即止」阶梯**：live child 读 `sessionProjections.snapshot(session, ['subagent'])`（注册表既有水位缓存，零日志读）；unseeded cold child 可读 `sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0), ['subagent'])`；seeded child 或 cache miss 执行一次携带 `inheritedEventCount` 的 Session observation，再经注册的 `subagent` unit 折叠。再没有就没有——不自建缓存、列表侧无回写、无索引。
- **`subagent` projection unit 是折叠规则唯一权威**：live 与 cold 快照都运行同一份已注册 unit，不存在第二份描述符解释逻辑。
- **描述符（v2）保持不变**。Session、persistence、projection cache 与 query 在 logical header 之外单独携带精确 inherited cut；listing 无法证明 cut 为零时，存量数据经一次含正文 observation 获得精确值——无 unknown 降级态，也无持久格式迁移。

与既有记录的关系：

- 本记录取代 [durable-subagent-catalog](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.zh.md) 中列表读路径的两项设计：经 `sessionQuery.traceSession` 枚举，与逐 child 读取描述符事件（`listEvents` 加精确 `readEvent` 双读、就地诊断分类）。diagnostic 行语义保留，分类改由列表按投影值缺席与 activity 派生；描述符事件仍是 mode/label 的唯一持久权威与折叠输入，恢复鉴权与激活约定不动。属部分取代，两记录保持交叉链接。
- [session-projection RFC](../../proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md) 是 registry 约定的权威，其后由 [state-and-client-views 记录](2026-08-19-session-projection-state-and-client-views.zh.md)拆分为 host 状态与客户端视图；本记录新增客户端可见的 `subagent` 身份 unit，并经 live 与 cold 快照消费它。折叠规则只在 registry 注册一份；任何消费面都经这一份已注册 unit 计算，不存在第二份折叠逻辑。

### `subagent` projection unit

挂在现有 `subagentTiming` 旁（[projection.ts](../../../../packages/subagent/subagent/src/projection.ts)、[projection-types.ts](../../../../packages/subagent/subagent/src/projection-types.ts)），key 为 `subagent`。两个 unit 都提供客户端 wire view；身份 unit 在 host 状态中保留可选的包装值，并把缺席映射为客户端哨兵：

```ts ignore-check
export type SubagentIdentityProjection =
  | { mode: 'one-shot'; label?: string; seq: SessionSeq }
  | { mode: 'continuable'; label: string; seq: SessionSeq }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    subagent: { identity?: SubagentIdentityProjection }
  }
  interface SessionProjectionMap {
    subagentTiming: SubagentTimingProjection
    subagent: SubagentIdentityProjection | null
  }
}
```

- 投影是纯身份，**projection 体系不做失败通道**：unit 永不抛错；载荷损坏、版本不认识与整日志没有描述符一样。host checkpoint 状态使用可序列化的包装 `{ identity?: SubagentIdentityProjection }`，缺席为 `{}`；客户端 view 则是非可选的 `SubagentIdentityProjection | null` 条目。`null` 完好通过 JSON，因此推送 reset 会替换旧身份，而不会被 stringify 丢掉。判定纪律：消费面把 null 与客户端 key 缺席一律视为无值。「算出来没有」如何呈现是消费方自己的事（见下文 `listChildren` 四态映射）。
- label 强度由描述符 schema 决定：continuable 的 label 解析强制必有，one-shot 的本就可选；mode/label 判别与下文 child 行的强约定完全一致（行不携带 `seq`——它是投影内部的 own-suffix 证明）。
- 身份携带品牌化 `seq`：折出该身份的 `subagent/descriptor` 事件 seq，两臂必有、null 哨兵无。live Session 通过 `isOwnSeq()` 检查它；cold 含正文 observation 则与 `inheritedEventCount` 比较。仅 header 的 seeded candidate 会跳过 cache，因为 header 有意不暴露整数 cut；unseeded candidate 知道 cut 为零。unit 把包装状态中校验后的身份映射为客户端 wire view，并与其他 unit 一律检查点化（`persist` 选项已删除）；`stateVersion` 为 2，在增加 `seq` 时升版。更早的 checkpoint 行按 registry 约定版本失配失效、落权威重折。
- 折叠规则：`subagent/descriptor` last-wins，与 `subagentTiming` 同一条 descriptor-reset 纪律——fork 前缀里的祖先描述符被自身描述符覆盖。损坏或版本不认识的载荷同样 last-wins：重置为 null 哨兵而非保留先前身份，健康祖先的 fork 不会继承自身描述符立不住的身份。

### 枚举：query corpus 与 live preference

`listChildren`（[list-children.ts](../../../../packages/subagent/subagent/src/list-children.ts)）通过 `sessionQuery.listSessions()` 取得 canonical live-preferred corpus，再把每个 listed id 与可能存在的 `ctx.sessions.get(id)` 配对；同 id 存在 live Session 时使用 live header。枚举所需全部是 header 事实：

- 过滤：`header.origin === 'subagent' && header.parentSession === parentSessionId`。
- `hasChildren`：同一份合并材料向下看一层——存在 `origin === 'subagent'` 且 `parentSession` 为该 child 的直接后代。
- `activity`：live 记录为 `running`，仅存在于持久化的为 `inactive`。
- 排序：`createdAt` 升序、再按 child id 升序（与旧约定一致）。
- `sessionQuery` 服务缺席时以 `SUBAGENT_CONTROL_QUERY_UNAVAILABLE` 失败；共享 query corpus 负责决定部署能枚举 live-only 还是持久化 Session。
- query corpus 失败使整次枚举失败；per-child 隔离只适用于逐 child cold observation。

### 取值：三级「算完即止」阶梯

对每个枚举出的 child，mode/label 取值走三级阶梯——算完即止，不自建缓存、无回写（第三级与 apiproxy `session.history` 的冷读同款）：

| 级 | 读法 | 成本 |
| --- | --- | --- |
| 1：live child | `ctx.sessionProjections.snapshot(session, ['subagent'])` | 零日志读——注册表既有水位缓存，同步取值 |
| 2：unseeded cold child，cache 命中 | 可选 `sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0), ['subagent'])`；精确 cut 为零时，每个合法 seq 都归 child 自有 | 零日志读 |
| 3：seeded child 或 cold 兜底 | 一次含正文 `sessionQuery.observeSession(id)` 加已注册的 `subagent` projection，使用 `inheritedEventCount` 做 own-suffix 检查 | 每次列表一次整读现算 |

- 错误约定：`sessionProjections`、Session store 与 `sessionQuery` 都是 listing 所需的 runtime service。三者分别以 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`、`SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE` 与 `SUBAGENT_CONTROL_QUERY_UNAVAILABLE` 显式失败；缺失分类或 corpus 能力不会伪装成空结果。
- cache 是纯可选加速层：服务缺席判空跳过——无错误码、不进配置校验（与 `sessionProjections` 的必需注入相对）。seeded header 会跳过该级，因为不读取正文就无法提供 cache identity 所需的精确 cut。对 unseeded child，第二级任何抛错（包括中毒 unit 行引爆 `viewCheckpoint`）都会静默落第三级——缓存是派生数据，其故障不产生 `corrupt` 判决，终审归权威重折；checkpoint 早于 descriptor、key 缺席或 null 哨兵也都会落底。
- per-child 隔离：单 child 的 cold 整读失败只使该行成为 `unavailable` diagnostic，下次列表自然重试，不影响 sibling（见四态映射）。
- 冷路径的生命周期见证：observation 必须仍指向枚举时的那个生命周期。见证字段为 version、id、createdAt、cwd、parentSession、isSeeded、delegationDepth、origin 与 agentPreset；同 id 删除后重新发布的 Session 对旧 parent 的目录降级为 `corrupt` 行，不外漏新 owner 的 child。
- 冷读并发以常数 4 有界——它约束的是本地介质的一次只读扫描而非部署行为；出现联网 persistence backend 时提升为验证过的 `Config` 字段。
- 冷读成本如实记录：每个 seeded child 与每次 unseeded cache miss 都会在每次列表时支付一次完整 query observation，成本与其 transcript 大小成正比；定案「算完即止」，不自建缓存。observation 可以复用 query／persistence preparation 层，但列表不依赖该优化。live child 全程零日志读。
- 取消：每次 persistence 读前后检查调用方 signal，abort 之后才结算的读拒绝归一化为稳定错误码 `CANCELLED`。

### 权威模型

- session log 是唯一权威；本方案不新增领域索引、自有 checkpoint 或进程 memo。第二级读取的 `sessionProjectionCache` checkpoint 是既有组合项的派生数据，列表只读。取值现算现弃；seeded candidate 用含正文 observation 按精确 cut 分类，unseeded cached identity 无需 seq 门，因为每个合法 seq 都归自身所有。
- Session 与 persistence 写路完全不感知列表与投影消费：没有事件监听回写，没有写时折叠。
- 枚举与取值不构成第二个鉴权来源，也不让尚未发布的 child 可见——两个来源只见已发布的 live 记录与已落盘的持久化记录，与 durable-subagent-catalog 记录对派生读面立下的规则一致。

### `listChildren` 行形状与消费面

`SubagentListEntry` **数据结构与重写前完全一致**——child 与 diagnostic 两臂、`kind` 判别、reason 三值、child 臂的 mode/label 强约定全部保留；变化只在诊断的信息来源：投影体系没有失败通道，diagnostic 由列表按投影值缺席与 activity 派生，列表本身零事件解析。「没有就等待硬读取」保证阶梯对健康数据必然算得出 mode/label。

```ts ignore-check
export type SubagentListEntry =
  | ({
    readonly kind: 'child'
    readonly id: SessionId
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
  } & (
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string }
  ))
  | {
    readonly kind: 'diagnostic'
    readonly id: SessionId
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }
```

对每个枚举出的 child，阶梯取值结果按四态映射成行：

| 阶梯取值结果 | 行 |
| --- | --- |
| 快照含非 null 的 `subagent` 身份 | child 行 |
| 快照在、`subagent` 为 null 哨兵或 key 缺席，且 child **inactive** | diagnostic 行，reason `corrupt`（定局残骸：无、损坏或版本不认识的描述符，不再细分） |
| 快照在、`subagent` 为 null 哨兵或 key 缺席，且 child **running** | 行不出现（创建窗口：描述符尚未追加，与旧实现同窗口 omit） |
| cold 整读失败 | diagnostic 行，reason `unavailable` |

- `unsupported` 不再被产出：类型与 wire 枚举按「数据结构保持现状」留存该成员，本记录留档其为不再产出。
- descriptor-less 定局残骸从旧实现的 omit 归入 `corrupt` diagnostic——库里的坏、死子会话可见，不静默消失，这正是保留 diagnostic 的原始动机。
- 列表只选择 `subagent` wire unit，且该折叠永不抛错：描述符损坏或版本不认识折为 null 哨兵，由四态映射收纳为该 child 的 `corrupt` 行（确定性数据故障，对齐旧实现 `SESSION_QUERY_CORRUPT_SESSION`→`corrupt` 的映射语义）。live 与 cold 同待遇，逐 child 隔离，sibling 与列表本身不受影响。它与「无值 + running → omit」正交：创建窗口是「尚无数据」，折为无值是「数据坏了」——running 的中毒 child 也出 `corrupt` 行而非 omit。

已知边界偏差（有意接受，随本记录留档）：

- own suffix 出现多个描述符，旧实现判 corrupt，现 last-wins 取末者（提供方约定本就保证恰一）。
- live/persisted header 冲突，旧实现是 per-child corrupt；现枚举 live 优先、不做一致性校验，冲突不再被察觉，以 live 记录成行。
- 损坏存储的源读失败（如坏 surface 被冷读整读拒收），旧实现映射 per-child `corrupt`，现统一成 `unavailable` 行（读侧无从区分成因）。
- 未知 parent，旧实现经 session-query 抛 not-found（「parent session … was not found」）；现自管合并对不存在的 parent 得到空子集，枚举返回空列表，wire 上后续操作落到 child 级 subagent-not-found——语义与文案的静默变化，显式接受。
- rung 2 的更晚事件窗口只适用于 unseeded child：cache 行恰在首个 descriptor 后落盘，日志随后追加第二个 descriptor（或 malformed 载荷置 null 哨兵），且进程在下一次 checkpoint 前崩溃。cold listing 可能持续供出旧身份，直到一次 live 运行或 cache write 替换该行。其前提违反 provider 的「恰追加一次」约定，并且还需错过所有 mandatory checkpoint；健康 child 不受影响。seeded child 没有 body-owned cut 时绝不进入 rung 2。

消费面保持相同的 row 与 diagnostic wire 形状。`list_agents` 使用必需的 query corpus 与 projection registry；live identity 来自 registry snapshot，cold identity 来自 cache 或 query observation。Host ownership 仍使用 `header.origin`，history 使用共享的 live／cold Session query source；没有消费方独立解析 descriptor event。

### 改动落点

| 区域 | 文件 | 改动 |
| --- | --- | --- |
| subagent | projection.ts、projection-types.ts、index.ts | 新客户端可见 `subagent` unit 与注册 |
| subagent | list-children.ts 及类型 | query-corpus 枚举加 projection 阶梯四态映射；必需 projections／query service 与可选 projection-cache 加速 |
| host/apiproxy | Session controller／query integration | owner 检查使用 `header.origin`；live／cold history 与 listing 消费共享 query 和 projection source |
| tool | tool-subagent-control/list-agents.ts | model-visible schema、描述与渲染保持不变 |
| wire/client | api/subagents.ts、runtime sessions/service.ts、GUI | 类型、行形状与 diagnostic 处理**零改动**；api/subagents.ts 仅 `history` 的 JSDoc 措辞改为双臂 |
| core/session、session-persistence、session-projection(-cache)、session-query(-sqlite) | 含正文 cut 与品牌化 seq 传递 | Logical header 暴露 `isSeeded`；Session、persistence observation、cache identity 与 query record 单独携带精确 `inheritedEventCount` |

## 考虑过的替代方案

**mode/label 进 SessionHeader。** 零读保证最强——列表只看 header 就能成行。但 header 变更会传导到持久化 provider 与兼容性检查；存量 JSONL 只能降级为 unknown 或 backfill。读时现算对存量的答案是「第一次列表一次 `inspect` 现算」，不碰持久格式。

**projection-cache 阶梯（`cachedSnapshot ?? cold fold` 加 fail-soft 写回）。** 机制成立——session-projection-cache 的 checkpoint 阶梯本就为冷读设计。但 checkpoint 写回是一套由列表驱动的派生数据持久化与失效编排（floor/identity/putSoft）；被否的是这套编排作为主机制。定稿的第三级阶梯后来以只读方式机会性复用该缓存作第二级——无写回、无编排、缺席即跳过。

**给 persistence 加有界读原语抢救存量。** 为一次性问题新开 persistence 原语；被读时 `inspect` 整读取代——存量第一次被列表时的整读就是取值本身。

**list 行 mode/label 可选化。** 健康数据必然可算；可选化只是把垃圾数据的处理复杂度外溢给全部消费方——每个消费面都要长出过滤分支和 unknown 展示态。强约定加算不出即 omit 更干净。

**彻底删除 diagnostic 行。** 删除把库损坏的可见性外溢为行静默消失，wire/tool/GUI 反要各自承担约定与快照变更；而保留只需列表侧按投影值缺席与 activity 派生分类，零成本。库里的坏、死子会话必须可见是 diagnostic 存在的原始动机，保留后消费面整体零改动。

**registry 计算失败通道（per-unit 容错加 `failures` 附加字段）。** 为把损坏、版本不认识报告给消费方，由 registry 捕获 unit 异常并在 snapshot 旁附 per-key 失败态。被否：failure 不是值，也不必是通道——unit 永不抛错，缺席本身就是信号，「大不了算出来没有」，如何呈现是消费方要考虑的事。一个独立观察：vendor cordis 的 `emit`（[vendor/cordis/src/events.ts](../../../../vendor/cordis/src/events.ts)）对 listener 抛错零捕获，投影驱动挂在 `session/event` 上时 unit 异常会沿 emit 逃逸——这加重了「unit 永不抛错」纪律的分量，但 emit 容错的修复不属于本记录范围。

**值随 query 索引 preparation 落库。** 投影值在 sqlite backend 的对账重建里折叠落进 session 索引行，读稳态零日志：`projectionsFor` 批量读面、行值随 `(key → stateVersion)` 注册集存储的失效对账与 SCHEMA bump。整体退役：方向反了——查询基础设施被迫认识领域词汇（投影列、注册集对账），而唯一消费方 subagent 列表读时现算即可满足；消费方归零后，这套派生持久化没有存在理由。`SESSION_QUERY_PROJECTIONS_UNAVAILABLE` 随读面一并删除。

**subagent 手工 parse 加进程 memo 加创建播种。** 为摘除 session-query 依赖，由 subagent 包自己解析描述符事件、以进程内 memo 避免重复整读、创建时播种初值。被已交付的阶梯取代：live 走 `sessionProjections` 水位缓存、cold 走注册 unit 的折叠，复用 registry 这一份折叠权威，不再出现第二份描述符解释逻辑，也不引入进程态缓存与播种时序。

**session-query 输出面 DeepReadonly（读路径改造实验）。** 公开查询输出深只读化，以在类型层面钉死不可变借用。实证否决：3 处 TS2589（类型实例化过深）加 17 处数组位传染（消费方数组方法与展开处被迫跟改）；深层不可变由 core/session 的运行时深冻结保证，该读路径改造未纳入本记录。

## 验证

`packages/subagent/subagent/tests/list-children.spec.ts` 固定本约定：live identity 通过 `Session.isOwnSeq()` 检查；unseeded cold identity 可在 cut 零时使用 cache；seeded candidate 跳过该 cache rung，转而使用携带 `inheritedEventCount` 的 observation；祖先 identity 无法通过 own-suffix 检查；缺席、null、中毒与不可用的 cache／observation 会按约定落底或产生 diagnostic；lifecycle 篡改按完整见证字段集降级为 `corrupt`。既有无密钥快照保持健康 wire 与 model-visible 面不变，`subagent-diagnostic` 则固定诊断分类。

## 后果

- live child 的列表全程零日志读；cold child 在 cache 未挂载或未命中时每次列表一次 `inspect` 整读，成本与其 transcript 大小成正比、随列表频率重复——定案「算完即止」，不自建缓存、不回写，同 id 短期重复整读可命中准备阶段 LRU 但列表不依赖它。
- subagent 列表要求 Session query corpus 与 projection registry；服务缺失会显式失败，而不是供出不完整 row。可选 projection cache 只改变正文读取次数。
- 身份解释只存在于 registry 注册的一份 unit：列表三级阶梯与 GUI history 冷读使用其 live、cached 或 observed wire 快照，不存在手写旁路折叠；若未来某消费面绕开该 unit 手写折叠，各读面的值将漂移——这是本设计要求维持的纪律，不是机制保证。
- per-child 隔离回归：单 child 冷读失败只损失该行，healthy sibling 不受影响；persistence 列表失败仍使整次枚举失败。
- 诊断与枚举语义留下五处边界偏差（多描述符取末者、header 冲突不再被察觉、损坏源读失败改变分类、未知 parent 由 not-found 改为空列表、unseeded rung 2 更晚事件窗口）。seeded 祖先 identity 已不再构成偏差，因为含正文读取会把它与 `inheritedEventCount` 比较；恢复鉴权始终不受影响。
- pre-#1569 的无 `origin` 存量不再被认作 subagent 属主；其本就不进目录，pre-release 无兼容承诺。

## 相关

- [durable-subagent-catalog 与 list_agents](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.zh.md)——被本记录部分取代：描述符仍是 mode/label 的持久权威与折叠输入，取值改为共享 query corpus 上的 projection 阶梯。
- [session projections 与命令生命周期日志](../../proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)——registry 约定的权威；本记录为其新增 `subagent` 身份 unit，并消费其 live 与 cold wire 快照。
- [session projection 状态与客户端视图](2026-08-19-session-projection-state-and-client-views.zh.md)——state/client 拆分；`subagent` 与 `subagentTiming` 都提供客户端 wire view。
- [session projections 作为必需接缝](2026-08-19-session-projection-mandatory-seam.zh.md)——`sessionProjections` 转为必需注入；列表的错误约定随其变化（registry 缺席是激活期失败，投影错误码删除）。
- [web subagent conversations](../feature/2026-07-27-web-subagent-conversations.zh.md)——`SessionHeader.origin` 的出处（#1569），身份判定去日志化的前半步；其 history 冷读（inspect 前缀加 registry 折叠）是本记录取值阶梯的同款先例。
- [发布前可复用的 Session 准备阶段](2026-08-05-session-preparation.zh.md)——`inspect()` 冷读与 LRU 复用；cold child 整读的成本模型建立其上。
