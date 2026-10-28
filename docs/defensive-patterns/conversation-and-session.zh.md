# 会话与 Session 规则

[English](conversation-and-session.md) | 中文

关于读取 Session、持有 Session、计算会话节点与渲染它们的规则。数据模型与各类型语义见 [session-projection.zh.md](../subsystems/session-projection.zh.md) 与 [conversation.zh.md](../subsystems/conversation.zh.md)。

## Projection 是唯一的读取与计算路径

Session 数据一律经 Projection 读取与计算。客户端读投影值，而不是拉 Session 日志；属于该会话的计算以注册单元的形式运行并**推送**结果，而不是按需重算。同一个问题若有两个答案——一个拉取、一个推送——两者就会分叉，渲染可能显示出 Session 日志已不再支持的值。

- 判定条件：客户端渲染的每个 Session 派生值都在渲染位置经投影读取取得，每个新增的会话内计算都注册为单元、其结果以已发布值的形式到达客户端。组件自己拉取 Session 数据、或读者按需触发一次计算，都属违规。
- State 与 View：单元折叠 host 侧 State，并在其上声明客户端可见的 View，二者分工写在注册里。`ProjectionDefinition` 的字段与驱动它们的注册表归 [session-projection.zh.md](../subsystems/session-projection.zh.md#ctxsessionprojections--sessionprojectionregistry)。
- 版本：`stateVersion` 从 1 起，只要序列化 state 字段或折叠语义变化就自增，兼容与否都一样。存在兼容改法时优先兼容，但版本仍要自增；同一 key 以不同 `stateVersion` 注册两次会抛错，而不是合并。
- 计算策略：单元默认全量计算。收窄某个单元的计算范围需要对应领域专家确认，绝不能由实现者自行决定。
- 边界：非完全 projection 渲染可用于某些 key 的界面可用性展示，例如在连接中的 Session 应答之前先画缓存块。它绝不参与对外可见结果的判定，那些结果等标准 projection 值。

在渲染位置读取、并以注册代替拉取，两者都合规：

```tsx
// The client reads the published value; it never fetches Session data itself.
function PlanChip({ useProjection }: PlanChipProps) {
  const plan = useProjection('plan')
  return plan === undefined ? null : <Chip label={plan.label} />
}

// The computation is a registered unit; the registry drives it and publishes changes.
const planDefinition: ProjectionDefinition<'plan', typeof emptyPlan> = {
  key: 'plan',
  stateVersion: 1,
  init: () => emptyPlan,
  apply: (state, event) => foldPlan(state, event),
  wire: { viewSchema: planSchema, view: planView },
}
```

自行发请求拉取同一个值，就破坏了唯一读面：

```tsx
function PlanChip() {
  const [plan, setPlan] = useState<Plan>()
  useEffect(() => {
    void fetchSessionPlan(sessionId).then(setPlan)   // a second read path beside Projection
  }, [sessionId])
  return plan === undefined ? null : <Chip label={plan.label} />
}
```

拉取到的副本与推送值互相矛盾，版本检查也无法说明 Session 当前持有的是哪一个。

## 冷读是最后手段

可用的缓存要先于原始日志被读取；只有没有任何投影覆盖该数据时才走冷读。「小会话可以全读」这一例外已移除、不再考虑。当缓存与正式数据不完全对等时，缺失或过期要产出显式结果，而不是静默改走重路径。

- 判定条件：Session 读取先查 projection 缓存，行缺失时为调用方留下显式状态；缓存判断的 `else` 分支直接打开完整日志，即属违规。
- 回退语义：缺失意味着什么由调用方决定，并写进返回值。不存在按缓存大小或 Session 大小开出的例外，也没有对应的批准人。
- 边界：这条限制是前端的。host 侧「禁止 fork 冷读」的绝对化表述不成立，因为 host 可能需要打开前端打不开的日志。

先读已存储的投影行，缺失仍是一个由调用方渲染的状态：

```ts ignore-check
// The listing reads stored projection rows; a miss remains an explicit state.
type ListingView =
  | { kind: 'cached'; snapshot: ProjectionSnapshot }
  | { kind: 'unknown' }

function readListing(header: SessionHeader, keys: readonly ProjectionKey[]): ListingView {
  const cached = ctx.sessionProjectionCache.cachedSnapshot(header, keys)
  return cached === undefined ? { kind: 'unknown' } : { kind: 'cached', snapshot: cached }
}
// Opening the complete log is a separate operation the caller names, never this fallback.
```

缓存判断落回完整日志，就等于把慢路径变成常规路径：

```ts ignore-check
function readListing(header: SessionHeader, session: Session): ListingView {
  const cached = ctx.sessionProjectionCache.cachedSnapshot(header)
  if (cached !== undefined) return { kind: 'cached', snapshot: cached }
  return coldReadCompleteLog(session)   // every miss pays the full-log read
}
```

现在每次缺失都在前台读完整日志，于是慢会话在每次列表读取时都慢，而不只是在那条主动请求它的路径上慢。

## 持有与回收遵循同一条生命周期判据

客户端经显式引用（`SessionReference`）持有 Session，引用计数归零即释放。闲置回收只看那一条生命周期判据——零引用且无在途——绝不按业务状态枚举「哪些 Session 可以回收」，因为那份清单要靠每个新增状态的业务功能自己去维护。隐式持有者不可见，回收便判断不了谁还在使用该 Session。

- 判定条件：判据 = `refCount == 0 && inflight == 0`。代码是否在「获取 → 使用」的时间窗口内通过一份可审计 retain / release 的引用来持有 Session？模块级 Session 对象或全局 current id 都属违规。
- 边界：强制的是统一判据与不做业务状态枚举这两点；释放触发本身靠人工核对，因此仅凭人工核对不构成打回理由。
- 归口：`retain`、`release`、`ready` 与 teardown 顺序归 [Session Controller 的 client references](../../packages/api/session-controller/README.zh.md#client-references)。消息里携带的 source session mention 是另一种类型，归 [session-reference.zh.md](../subsystems/session-reference.zh.md)。

经显式引用持有并在 teardown 释放的视图合规：

```ts ignore-check
class SidebarSessionView implements Disposable {
  private readonly reference: SessionReference

  constructor(readonly id: SessionId, sessions: ISessions) {
    this.reference = sessions.retain(id, { source: 'sidebarView' })
    void this.reference.ready.catch((error: unknown) => { console.error('opening failed:', error) })
  }

  [Symbol.dispose](): void {
    this.reference.release()   // the last reference releases the Session
  }
}
```

模块状态缓存 Session 对象，会把所有持有者对回收器隐藏：

```ts ignore-check
let currentSessionId: SessionId | undefined
const sessionCache = new Map<SessionId, Session>()

export function remember(session: Session): void {
  currentSessionId = session.id
  sessionCache.set(session.id, session)
}

export function reclaimIdle(): void {
  if (state === 'idle' || state === 'closed') reclaim()   // a newly added state is missed
}
```

没有人能数清谁仍在使用该 Session，下一个新增的 Session 状态也会漏出枚举、永远不被回收。

## 节点计算是增量的，流式发布是合批的

新增节点计算要说明其复杂度；高频流式 chunk 绝不立即发布、也不做全量计算。每个 chunk 全量重算并立即发布，等于把整个节点集合压进帧预算，转写区便会堵在流后面。追加速路径的开销——在 `D` 个已注册 Definition 下执行 `D` 次匹配与一次常量级 Context key 查找——以及发布节拍取值（`none`、`animation-frame`、`immediate`）归 [conversation.zh.md](../subsystems/conversation.zh.md#definition-and-typed-chat-payload)。

- 判定条件：单个 chunk 计算了多少——受影响子树的增量，而不是事件窗口——以及结果何时发布——合批策略，而不是每个 chunk 发布一次。
- 边界：本条约束实现；节拍本身不构成打回理由，改动按它声明的节拍与所用的已发布路径评判。
- 高频路径上禁止：`immediate` 发布，以及每个 chunk 做一次全量重算。
- 边界：结构性或终态变化可以 `immediate` 发布，因为节拍是按单次发布选择的。只有高频 delta 路径受合批约束。

只更新一个 Context 并请求合批发布的 chunk 合规：

```ts ignore-check
const assistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'assistant-step',
  target: 'chat',
  match: event => matchAssistant(event),
  start: (_context, match) => initialState(match),
  update: (context, match) => appendChunk(context.state, match.event),   // increment, not the window
  publication: () => 'animation-frame',   // high-frequency deltas coalesce; never immediate
  buildViewNode: context => assistantNode(context),
}
```

每个 chunk 重建整个节点集合并立即发布：

```ts ignore-check
function onChunk(chunk: AssistantLiveChunk): void {
  const nodes = buildNodesFromCompleteWindow(session)   // full recompute per chunk
  target.publish(nodes, { publication: 'immediate' })   // and an immediate publish
}
```

每个 chunk 都要在帧预算内做一次全窗口重建，于是分组与渲染都堵在流后面。

## 节点构建与分组引擎不承载业务规则

业务规则绝不进入分组引擎，业务诉求也绝不改变构建产物的形态。`ProcessState`、分组产物层级，以及 `conversation-nodes/process-groups.ts` 里的分组语义集合都属基础设施：引擎只认枚举化的落位语义（如成组 / 独立 / 回复），由调用方算出该用哪一个。引擎内的业务特判会改变所有使用方共享的产物结构，并把业务条件带上分组计算路径。

- 判定条件：引擎内部是否存在业务条件？新增 `ProcessState` 字段、增删分组产物层级、为某个业务改变分组语义，都属违规；落位判定归算出枚举值的调用方。
- 边界：架构分层、其开销与既有业务预期，就是业务不得重做分组设计的原因。
- 边界：携带新落位含义的新枚举值才是受支持的扩展，无论调用方在哪里算出它。
- 例外与批准人：无默认例外。改动该基础设施须经对应领域专家确认。分组 Definition 类型归 [conversation.zh.md](../subsystems/conversation.zh.md#group-definitions)。

调用方决定业务含义，并把引擎据以落位的枚举值传进去：

```ts ignore-check
// Business judgment stays in the caller.
function placementOf(command: CommandView): NodePlacement {
  return isHandoff(command) ? 'reply' : 'grouped'
}

// The engine consumes the enum as data; it reads no business condition.
function groupEntries(commands: readonly CommandView[]): readonly NodePlacement[] {
  return commands.map(placementOf)
}
```

业务条件写进引擎自己的计算过程：

```ts ignore-check
// The grouping engine asks what a node means, not where it goes.
function placeProcessNode(node: ChatConversationViewNode): GroupPlacement {
  if (node.kind === 'command' && isRagMessage(node)) return 'rag'   // business special case
  return 'grouped'
}
```

产物从此承载某一个业务的含义，所有使用方与分组计算都要跟着该功能走。

## 节点列表与席位组件不承载业务分支

`ChatNodeList`、`ChatNodeSeat` 与 `ChatGroupSeat` 属基础设施。它们不承载业务判断，也不承载业务专用字段；单一业务绝不改变列表遍历或席位选择。新的节点形态把自己的 kind 贡献给 `ChatNodeDataMap`，并经 kind 注册面注册 renderer，于是列表继续按 kind 分发，业务语义留在业务模块内。为某个功能加的分支，会让每个节点的渲染都依赖该功能。

- 判定条件：在列表或席位组件里加业务分支、给其 props 加业务专用字段，或为单一业务改变列表遍历与席位选择。
- 正确出路：业务包把自己的 key merge 进 `ChatNodeDataMap`，并为该节点 kind 注册 renderer；席位渲染该 kind 已注册的组件。注册纪律归 [slots.zh.md](../subsystems/slots.zh.md#extension-rules)。
- 边界：对所有业务生效的渲染增强——排序、虚拟化、可访问性——不属于为业务诉求修改。
- 例外与批准人：无默认例外；任何例外须经对应领域专家确认。

声明自己的 kind 并注册 renderer 的业务包，不改动共享列表：

```tsx
// The business declares its kind and registers its renderer; the shared list is untouched.
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { handoff: HandoffData }
}

const HandoffNodeView = memo(function HandoffNodeView({ node, t }: ChatNodeOwnerProps<'handoff'>) {
  return <HandoffCard data={node.data} t={t} />
})

ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
  { name: 'conversation.chat.node', key: 'handoff', locale: NS }, HandoffNodeView))
```

把业务分支与业务字段写进共享席位：

```tsx
export const ChatNodeSeat = memo(function ChatNodeSeat({ node, handoffFlag }: ChatNodeSeatProps) {
  if (node.kind === 'user' && handoffFlag) return <HandoffSeat node={node} />   // business dispatch
  return <div data-handoff={handoffFlag}>{renderByKind(node)}</div>
})
```

某个功能的条件从此决定每个节点怎么渲染，下一个功能还得再改一次共享席位。

## Markdown 管线不承载业务分支

`AssistantMarkdown` 及其渲染管线属基础设施：Markdown 渲染路径里不得出现业务条件，也不得按业务改写节点映射或样式注入规则。展示需求要么在既有链上注册 renderer，要么在数据里表达；官方默认内容也参与同一个注册面，而不是做成「可选 renderer + 宿主内联 fallback」。承载业务特判的管线，再也无法单独评审或单独优化。

- 判定条件：`AssistantMarkdown` 或其 block 映射里出现业务分支——例如 `if (isXxxBusiness) renderXxx()`——或按某个业务注入样式规则。
- 正确出路：在既有链上注册 renderer，或在数据里带上语义字段、由通用 renderer 读取。Component Factory 的注册归 [ui-renderer README](../../packages/client/ui-renderer/README.zh.md)。
- 包装展示：需要标准渲染的包装组件调用官方入口并保留其 fallback；绝不重复渲染 Slot，也绝不跨包导入官方私有 React 组件。
- 权责边界：宿主只负责位置与调用；插件的状态、清理、控件归插件自己，官方宿主不为某个 contribution 承载业务动作。
- `labels`：可选传入完整 `MarkdownLabels`，**传入即整体使用**、不与默认值做字段级合并；省略则用官方默认。`variant="compact"` 由 Factory 固定。
- 边界：通用 Markdown 能力——语法支持、性能优化——不属于为业务诉求修改。
- 例外与批准人：无默认例外；任何例外须经对应领域专家确认。

注册进既有单席位、并复用已发布 Factory（而不是自己重渲标准内容）的 contribution：

```tsx
// The business contributes its own body into the seat the host already renders.
ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register(
  { name: 'conversation.chat.reasoning.body', scope: 'session', locale: NS },
  TranslatedReasoningBody,
))

// The contribution keeps the standard rendering by calling the published Factory.
function TranslatedReasoningBody({ text, running, renderFactorySlot, t }: ReasoningBodyProps) {
  return (
    <>
      <p>{t('reasoning.translated')}</p>
      {renderFactorySlot('conversation.chat.reasoning.content', { text, running })}
    </>
  )
}
```

业务分支写进共享 Markdown 管线：

```tsx
export const AssistantMarkdown = memo(function AssistantMarkdown({ blocks, ...props }: AssistantMarkdownProps) {
  return <>{blocks.map(block => (
    isHandoffBlock(block)
      ? <HandoffBlock block={block} />   // a business special case in the pipeline
      : renderBlock(block, props)
  ))}</>
})
```

每个业务特判都落进同一条共享管线，Markdown 渲染再也无法脱离它如今承载的这些业务去改动或度量。

## 用户消息模型与渲染不承载业务字段

`UserMessage` 与 UI 侧 `user` kind 渲染属基础设施：消息模型上不得有业务专用字段，用户消息渲染里不得有业务分支。业务差异经消息 payload 传递——自己可 merge 扩展的 source kind 或某个 content 字段——或经注册的 renderer 表达。为某个业务加的字段，所有消息模型使用方都要处理；下一个业务还会往同一个共享 renderer 里再加一条分支。

- 判定条件：`UserMessage` 上出现业务命名字段，或 `user` kind 的渲染里出现业务条件。
- 正确出路：在 payload 里表达。`MessageSourceMap` 可经 declaration merging 扩展，因此生产者声明自己的 source kind，而不是加宽 `UserMessage`；消息模型见 [session.zh.md](../subsystems/session.zh.md)。
- 边界：通用消息能力——附件、引用、编辑态——不属于为业务诉求修改。
- 例外与批准人：无默认例外；任何例外须经对应领域专家确认。

声明自己的 source kind 的生产者，把业务差异留在 payload 里：

```ts ignore-check
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    handoff: { kind: 'handoff'; sessionId: SessionId }
  }
}

const message = createUserMessage({
  role: 'user',
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'handoff', sessionId: source.id },
})
```

共享模型上的业务字段，以及它逼进共享 renderer 的分支：

```ts ignore-check
interface UserMessage extends MessageBase {
  readonly role: 'user'
  readonly handoffKind?: 'handoff' | 'rag'   // one business's field on the shared model
}

// ...and the renderer branches on it.
if (message.handoffKind === 'handoff') return <HandoffBubble message={message} />
```

消息模型的每个使用方都要处理某一个业务的字段，共享 renderer 则随每个后续业务再长一条分支。
