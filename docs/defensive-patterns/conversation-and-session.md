# Conversation and Session rules

English | [中文](conversation-and-session.zh.md)

Rules for reading a Session, holding one, computing conversation nodes, and rendering them. The data model and per-type semantics live in [session-projection.md](../subsystems/session-projection.md) and [conversation.md](../subsystems/conversation.md).

## Projection is the only read and compute path

Session data is read and computed through Projection. A client reads a projection value instead of pulling the Session log, and a computation that belongs to the Session runs as a registered projection unit that publishes its result instead of being recomputed on demand. Two answers to the same question — one pulled, one pushed — drift apart, so a render can show a value the Session log no longer supports.

- Judged condition: every Session-derived value a client renders arrives through a projection read at the render position, and every new in-Session computation is registered as a unit whose result reaches clients as a published value. A component that fetches Session data itself, or a computation a reader triggers on demand, is the violation.
- State and View: a unit folds host-side State and declares the client-visible View over it, and the registration states that division. The `ProjectionDefinition` fields and the registry that drives them belong to [session-projection.md](../subsystems/session-projection.md#ctxsessionprojections--sessionprojectionregistry).
- Version: `stateVersion` starts at 1 and is bumped whenever the serialized state fields or the fold semantics change, compatible or not. Prefer a compatible change where one exists, but still bump; registering one key twice with different `stateVersion` values throws instead of merging.
- Compute strategy: units compute in full by default. Narrowing what a unit computes needs the owning domain expert's confirmation, never the implementer's own decision.
- Boundary: a partial projection view may serve interface availability for individual keys, such as a cached block drawn before the connected Session answers. It never decides an externally visible result, which waits for the standard projection value.

A component that reads at its render position, and a computation that registers instead of being pulled, both comply:

```tsx
// The client reads the published value; it never fetches Session data itself.
function PlanChip({ useProjection }: PlanChipProps) {
  const plan = useProjection('plan')
  return plan === undefined ? null : <Chip label={plan.label} />
}

// The computation is a registered unit; the registry drives it and publishes changes.
const planDefinition: ProjectionDefinition<'plan'> = {
  key: 'plan',
  stateVersion: 1,
  init: () => emptyPlan,
  apply: (state, event) => foldPlan(state, event),
  wire: { viewSchema: planSchema, view: planView },
}
```

A component that pulls the same value over its own request breaks the single read path:

```tsx
function PlanChip() {
  const [plan, setPlan] = useState<Plan>()
  useEffect(() => {
    void fetchSessionPlan(sessionId).then(setPlan)   // a second read path beside Projection
  }, [sessionId])
  return plan === undefined ? null : <Chip label={plan.label} />
}
```

The pulled copy and the pushed value disagree, and no version check can tell which one the Session currently holds.

## Cold reads are the last resort

Read an available cache before the original log, and reach for a cold read only when no projection covers the data. The "small Session may be read in full" exception is removed and is not reconsidered. When cached and official data are not equivalent, a missing or stale row produces an explicit outcome instead of silently switching onto the slow path.

- Judged condition: a Session read consults the projection cache first, and an absent row leaves an explicit state for the caller; a cache test whose `else` branch opens the complete log is the violation.
- Fallback semantics: the caller decides what a miss means and states it in the returned value. There is no cache-size or Session-size exception, and no approver for one.
- Boundary: this restriction is the client's. An absolute "never fork a cold read" on the host is not required, because the host may need to open a log the client cannot.

The stored projection rows are read first, and a miss stays a state the caller renders:

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

A cache test that falls through to the complete log turns the slow path into the ordinary one:

```ts ignore-check
function readListing(header: SessionHeader, session: Session): ListingView {
  const cached = ctx.sessionProjectionCache.cachedSnapshot(header)
  if (cached !== undefined) return { kind: 'cached', snapshot: cached }
  return coldReadCompleteLog(session)   // every miss pays the full-log read
}
```

Every miss now reads the whole log in the foreground, so a slow Session is slow on every listing rather than only on the path that asks for it.

## Retention follows one lifecycle rule

A client holds a Session through an explicit reference (`SessionReference`), and the reference count reaching zero releases it. Idle reclamation follows the one lifecycle rule — no references and nothing in flight — and never enumerates which Sessions may be reclaimed from business state, because that list has to be maintained by every feature that adds one. An implicit holder is invisible, so reclamation cannot tell who still uses the Session.

- Judged condition: the predicate is `refCount == 0 && inflight == 0`. Does the code hold the Session across its acquire → use window through a reference that retain and release can be audited against? A module-level Session object or a global current id is the violation.
- Boundary: the enforced parts are the unified predicate and the absence of business-state enumeration; the release trigger itself is checked by hand, so hand-checking alone is not a rejection reason.
- Ownership: `retain`, `release`, `ready`, and teardown ordering belong to [the Session Controller's client references](../../packages/api/session-controller/README.md#client-references). A source-session mention carried in a message is a different type, owned by [session-reference.md](../subsystems/session-reference.md).

A view that retains through an explicit reference and releases it on teardown complies:

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

Module state that keeps the Session object hides every holder from the reclaimer:

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

Nobody can count who still uses the Session, and the next state added to the Session escapes the enumeration and is never reclaimed.

## Node computation is incremental and streaming publication is batched

A new node computation states its complexity, and high-frequency streaming chunks never publish immediately and never recompute in full. A per-chunk full rebuild published at once puts the whole node collection on the frame budget, and the transcript stalls behind the stream. The append-path cost — with `D` registered Definitions, `D` matches and one constant-time Context-key lookup — and the publication vocabulary (`none`, `animation-frame`, `immediate`) are owned by [conversation.md](../subsystems/conversation.md#definition-and-typed-chat-payload).

- Judged condition: how much one chunk computes — the increment on the affected subtree, not the event window — and when its result is published — a batching policy, not one publication per chunk.
- Boundary: this rule binds the implementation; cadence alone is not a rejection reason, so a change is judged on the cadence it states and the published path it uses.
- Forbidden on the high-frequency path: `immediate` publication, and a full recomputation per chunk.
- Boundary: a structural or terminal change may publish `immediate`, because the cadence is chosen per publication. Only the high-frequency delta path is bound to batching.

A chunk that updates one Context and asks for a coalesced publication complies:

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

Rebuilding the whole node collection for every chunk and publishing it immediately:

```ts ignore-check
function onChunk(chunk: AssistantLiveChunk): void {
  const nodes = buildNodesFromCompleteWindow(session)   // full recompute per chunk
  target.publish(nodes, { publication: 'immediate' })   // and an immediate publish
}
```

Each chunk costs a full-window rebuild inside the frame budget, so grouping and rendering stall behind the stream.

## The node build and grouping engine carries no business rule

Business rules never enter the grouping engine, and a business requirement never reshapes the built payload. `ProcessState`, the group product hierarchy, and the set of group semantics in `conversation-nodes/process-groups.ts` are infrastructure: the engine understands enum placement values such as grouped, standalone, and reply, and the caller computes which one applies. A special case inside the engine changes the produced structure for every consumer and puts a business condition on the group computation path.

- Judged condition: does the engine contain a business condition? A diff that adds a `ProcessState` field, adds or removes a group level, or changes group semantics for one business fails; the placement decision belongs to the caller that computes the enum value.
- Boundary: the layering, its cost, and existing business expectations are the reason a business does not rework the grouping design.
- Boundary: a new enum value carrying a new placement meaning is the supported extension, wherever the caller computes it.
- Exception and approver: none by default. A change to this infrastructure needs the corresponding domain expert's confirmation. [conversation.md](../subsystems/conversation.md#group-definitions) owns the group Definition types.

The caller decides the business meaning and passes the placement enum the engine places by:

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

A business condition inside the engine's own computation:

```ts ignore-check
// The grouping engine asks what a node means, not where it goes.
function placeProcessNode(node: ChatConversationViewNode): GroupPlacement {
  if (node.kind === 'command' && isRagMessage(node)) return 'rag'   // business special case
  return 'grouped'
}
```

The produced structure now carries one business's meaning, so every consumer and the group computation follow that feature.

## The node list and seat components carry no business branch

`ChatNodeList`, `ChatNodeSeat`, and `ChatGroupSeat` are infrastructure. They carry no business condition and no business-specific field, and a single business never changes the list traversal or the seat selection. A new node shape contributes its kind to `ChatNodeDataMap` and its renderer through the kind registration surface, so the list keeps dispatching on kind while business semantics stay in the business module. A branch added for one feature makes every node's rendering depend on that feature.

- Judged condition: a business branch in a list or seat component, a business-only field on its props, or a traversal or seat-selection change that serves one business.
- Correct outlet: the business package merges its own key into `ChatNodeDataMap` and registers a renderer for the node kind; the seat renders the registered component for the node's kind. The registration discipline is owned by [slots.md](../subsystems/slots.md#extension-rules).
- Boundary: a rendering change that applies to every business — ordering, virtualization, accessibility — is not a business modification.
- Exception and approver: none by default; the corresponding domain expert confirms any exception.

A business package that declares its kind and registers its renderer leaves the shared list untouched:

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

A business branch and a business field inside the shared seat:

```tsx
export const ChatNodeSeat = memo(function ChatNodeSeat({ node, handoffFlag }: ChatNodeSeatProps) {
  if (node.kind === 'user' && handoffFlag) return <HandoffSeat node={node} />   // business dispatch
  return <div data-handoff={handoffFlag}>{renderByKind(node)}</div>
})
```

One feature's condition now decides how every node renders, and the shared seat must change again for the next feature.

## The Markdown pipeline carries no business branch

`AssistantMarkdown` and its rendering pipeline are infrastructure: no business condition enters the Markdown render path, and no business rewrites the node mapping or the style injection rules. A presentation need registers a renderer on the existing chain or expresses itself in the data, and the official default content participates in that same registration surface rather than existing as an optional renderer with a host-side inline fallback. A pipeline that hosts business special cases can no longer be reviewed or optimized on its own.

- Judged condition: a business branch inside `AssistantMarkdown` or its block mapping — for example `if (isXxxBusiness) renderXxx()` — or a style injection rule keyed on one business.
- Correct outlet: a renderer registered on the existing chain, or a semantic field in the data that the generic renderer reads. The Component Factory registration is owned by the [ui-renderer README](../../packages/client/ui-renderer/README.md).
- Wrapping: a wrapper that needs the standard rendering calls the official entry and keeps its fallback; it never re-renders the slot and never imports the private React component across packages.
- Responsibility: the host owns position and invocation; the plugin owns its own state, cleanup, and controls, and the official host carries no business action for a contribution.
- `labels`: an optional complete `MarkdownLabels` object is used whole, with no field-level merge against the default; omitting it uses the official default. `variant="compact"` is fixed by the Factory.
- Boundary: generic Markdown capability — syntax support, performance — is not a business modification.
- Exception and approver: none by default; the corresponding domain expert confirms any exception.

A contribution that registers into the existing single seat, and reuses the published Factory instead of re-rendering the standard content:

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

A business branch inside the shared Markdown pipeline:

```tsx
export const AssistantMarkdown = memo(function AssistantMarkdown({ blocks, ...props }: AssistantMarkdownProps) {
  return <>{blocks.map(block => (
    isHandoffBlock(block)
      ? <HandoffBlock block={block} />   // a business special case in the pipeline
      : renderBlock(block, props)
  ))}</>
})
```

Every business special case lands in one shared pipeline, and Markdown rendering can no longer change or be measured without the businesses it now carries.

## The user message model and rendering carry no business field

`UserMessage` and the UI's `user` kind rendering are infrastructure: no business-only field on the message model, and no business branch in the user message renderer. A business difference travels in the message payload — its own merge-extensible source kind or a content field — or through a registered renderer. A field added for one business is handled by every consumer of the model, and the next business adds another branch to the same shared renderer.

- Judged condition: a business-named field on `UserMessage`, or a business condition in the rendering of the `user` kind.
- Correct outlet: expression in the payload. `MessageSourceMap` is declaration-merge extensible, so a producer declares its own source kind instead of widening `UserMessage`; the message model is documented in [session.md](../subsystems/session.md).
- Boundary: a generic message capability — attachments, quotes, edit state — is not a business modification.
- Exception and approver: none by default; the corresponding domain expert confirms any exception.

A producer that declares its own source kind keeps the business difference in the payload:

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

A business field on the shared model, and the branch it forces into the shared renderer:

```ts ignore-check
interface UserMessage extends MessageBase {
  readonly role: 'user'
  readonly handoffKind?: 'handoff' | 'rag'   // one business's field on the shared model
}

// ...and the renderer branches on it.
if (message.handoffKind === 'handoff') return <HandoffBubble message={message} />
```

Every consumer of the message model handles one business's field, and the shared renderer grows a branch for each business that follows.
