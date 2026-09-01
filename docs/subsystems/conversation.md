# Conversation assembly

English | [中文](conversation.zh.md)

Conversation is the target-neutral assembly layer between a Client `SessionEventLikeEntry` window and browser views. [`ui-conversation`](../../packages/client/ui-conversation/README.md) owns the event and view registries, one identity-stable binding per `SessionBinding`, Turn/Step locations, incremental Context assembly, target sources, the shared shell, and input orchestration. Target packages such as [`ui-chat`](../../packages/client/ui-chat/README.md) and [`ui-trajectory`](../../packages/client/ui-trajectory/README.md) own their Definitions, final snapshots, and rendering.

This page defines the data model and the extension path for a business-owned Conversation node. The [Web Client architecture](web-client.md) places the subsystem between Client models and Slots; the [Conversation Node assembly decision](../../.agents/notes/implemented/architecture/2026-08-09-client-conversation-node-assembly.md) owns its rationale.

## Data model and ownership

The Session Controller owns the contiguous loaded logical-event window. Each `SessionEventLikeEntry` is either `{ type: 'event', event: SessionEvent }` or `{ type: 'chunks', event: ChunkRowEvent }`; both inner events expose `type`, `seq`, `time`, and `data`. `ui-conversation` passes these entries to the assembler without opening a second history stream, converting records, or expanding packed members. One `ConversationNodeAssembler` per Session applies every registered Definition and publishes an independent source for each registered view target.

| Concept | Owner and purpose |
|---|---|
| Event Definition | A business package matches one standard event or packed Assistant run at a time, correlates it by stable `(kind, id)`, folds deterministic State, and optionally materializes one target node. |
| Context | The engine-owned ordered Matches and current State for one `(kind, id)`. A packed run occupies one update Match; update-only evidence may remain pending until pagination supplies its unique scalar start. |
| Location | The engine-owned Session, Turn, or Step coordinates derived from durable boundary events. Definitions may publish typed data onto one Turn or Step. |
| View Definition | A target package creates one incremental builder per Session and owns the final snapshot type for that target. |
| View | A Slot entry such as Chat or Trajectory reads only its target snapshot and renders target-owned nodes. |

Chat and Trajectory may recognize the same durable event family, but each keeps its own Definition State and final node payload. Shared target-neutral machinery is limited to identity routing, ordered replay, Location data, predecessor dependencies, and publication cadence.

## Target activation

Each Session keeps a monotonic set of active targets. Creating or reading a target source does not activate it. The shell explicitly activates its persisted or newly selected View, while another consumer activates a target through its first source subscription. First activation creates that target's builder and calls `replace()` once from the current target-indexed Contexts. Later flushes call `apply()` for every active target, and unsubscription does not remove one.

The shell owns View selection and resolves the registered preferred View or Chat fallback before rendering when a binding is created or selected as current, and after View-roster changes. The assembler receives only the resolved target id and does not select Chat or another default target. A third-party View participates through the same selection and activation operations.

## Replayable event families

Choose one stable business id before writing the Definition. Every event that contributes to the same Node must carry that id or derive it independently from its own payload; the client must never assign an update to “the latest unfinished” Context.

For a review job, the event contract could be:

| Event | Role | Required durable facts |
|---|---|---|
| `review/start` | unique start | `reviewId`, Turn/Step coordinates, title |
| `review/progress` | update | the same `reviewId`, coordinates, replayable progress |
| `review/end` | update | the same `reviewId`, coordinates, final summary |

Use the producer-owned branded id type across the process boundary. Put the `SessionEventMap` merge and payload types on the producer's type-only export, then import that export for side effects from the client package. Each `(kind, id)` may have at most one start event. A single-event business can use the event's stable identity, such as `event.seq`, as its Definition-local id.

Incremental events are supported. Prefer whole-value checkpoints when the producer can emit them cheaply, because they remain useful when the start is outside the loaded window. Each delta must carry the stable id and produce deterministic State when replayed in ascending log `seq`; it must not depend on live-only memory. If the current history window contains only updates, the assembler keeps a pending Context and builds no State until an older page supplies the start. If the product must render before the start is loaded, a terminal or checkpoint event must carry enough whole fallback state for the Definition to build that result directly; do not recover it by scanning unrelated events.

Historical runs of consecutive same-block `assistant/chunk` deltas arrive as `chunkrow/text-chunks`, `chunkrow/reasoning-chunks`, or `chunkrow/tool-call-chunks`. Their top-level `seq` and `time` identify the first logical member, and their `data` retains each fragment and timestamp gap. These Client-only events can only be updates; `start()` receives a standard `SessionEvent`. A Definition that consumes Assistant deltas handles the relevant packed tags in the same `match()` and `update()` methods, while other Definitions return `null` without expanding the run.

## Definition and typed Chat payload

The example keeps the producer declarations and client contribution in one block so the complete relationship is visible. In a package family, keep the branded id and `SessionEventMap` declaration with the event producer, and keep the Definition, Chat data merge, and renderer in the client plugin.

```ts ignore-check
import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  ConversationLocation, ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'

type ReviewId = Branded<'ReviewId'>

interface ReviewStartData {
  readonly reviewId: ReviewId
  readonly turn: number
  readonly step: number
  readonly title: string
}

interface ReviewProgressData {
  readonly reviewId: ReviewId
  readonly turn: number
  readonly step: number
  readonly completed: number
}

interface ReviewEndData {
  readonly reviewId: ReviewId
  readonly turn: number
  readonly step: number
  readonly summary: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one durable review job.
     * @mode emit
     * @param data - stable identity, location, and initial display state.
     */
    'review/start': ReviewStartData
    /**
     * Records replayable progress for one review job.
     * @mode emit
     * @param data - stable identity, location, and latest progress.
     */
    'review/progress': ReviewProgressData
    /**
     * Closes one review job with its final summary.
     * @mode emit
     * @param data - stable identity, location, and final display state.
     */
    'review/end': ReviewEndData
  }
}

interface ReviewChatData {
  readonly title: string
  readonly completed: number
  readonly status: 'running' | 'completed'
  readonly summary?: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'review-job': ReviewChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'review-job': ReviewChatData
  }
}

interface ReviewState extends ReviewChatData {
  readonly turn: number
  readonly step: number
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function viewData(state: ReviewState): ReviewChatData {
  return {
    title: state.title,
    completed: state.completed,
    status: state.status,
    ...state.summary === undefined ? {} : { summary: state.summary },
  }
}

const reviewDefinition: ConversationNodeDefinition<ReviewState> = {
  kind: 'review-job',
  target: 'chat',
  match: (event) => {
    if (event.type === 'review/start') {
      return { id: String(event.data.reviewId), role: 'start' }
    }
    if (event.type === 'review/progress' || event.type === 'review/end') {
      return { id: String(event.data.reviewId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'review/start') throw new Error('review-job requires review/start')
    return {
      turn: match.event.data.turn,
      step: match.event.data.step,
      title: match.event.data.title,
      completed: 0,
      status: 'running',
    }
  },
  update: (context, match) => {
    if (match.event.type === 'review/progress') {
      return { ...context.state, completed: match.event.data.completed }
    }
    if (match.event.type === 'review/end') {
      return { ...context.state, completed: 100, status: 'completed', summary: match.event.data.summary }
    }
    return context.state
  },
  publication: match => match.event.type === 'review/progress'
    ? 'animation-frame'
    : 'immediate',
  buildLocationData: (context, scope) => {
    if (scope !== 'step' || context.state === undefined) return null
    return {
      kind: 'step',
      turn: context.state.turn,
      step: context.state.step,
      key: 'review-job',
      value: viewData(context.state),
    }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'review-job',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: viewData(context.state),
    }
  },
}

function ReviewNodeView({ node }: ChatNodeViewProps<'review-job'>) {
  const text = node.data.summary ?? `${node.data.title}: ${node.data.completed}%`
  return createElement('p', null, text)
}

export const inject = ['uiConversation', 'slots']

export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(reviewDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'review-job',
  }, ReviewNodeView))
}
```

`match(event)` is an identity extractor, not a fold: it receives only the current `SessionEventLike` and returns the Definition-local id and lifecycle role. After a match, the assembler locates the Context by `(kind, id)` and calls `start` once for a standard event or `update` for a standard or packed event. Both functions return the State that the engine adopts; returning a new immutable value is preferred, but a function that mutates and returns the same object has the same adoption semantics.

`buildLocationData(context, scope)` optionally publishes Definition-owned data onto an engine-owned Turn or Step. Use declaration merging to give each key a precise value type. Another Node in the same Location can consume that value through its constrained slot hook, such as `useTurnData(key)`, without receiving the Session or scanning `snapshot.chat.nodes`.

`target` and `buildViewNode(context)` declare one target-owned rendering contribution and must appear together. Preserve `context.key` as the React-facing identity, choose `anchorSeq` from durable ordering evidence, and return only renderer-ready data. Once a target Node has been published, keep returning the same key; use `visibility: 'hidden'` when it must temporarily leave the visible flow rather than withdrawing it with `null`.

## Predecessor reads

Some Definitions need the latest earlier State of another business kind. `start` receives a `ConversationContextReader`; call `reader.previous<State>(kind)` there instead of accepting a Context collection or scanning events. The reader returns the nearest started Context before the current start `seq` as read-only data.

The assembler records that dependency. If an older prepend later supplies a nearer predecessor, closes a previously unknown window gap, or revises the predecessor State, it reruns the dependent Context from `start` and replays its updates in ascending `seq`. The queried Definition remains responsible for writing useful State; the reader exposes no business-specific query methods and grants no mutation authority over another Context.

## Window update paths

History may be requested from the tail backward one page at a time. The Session journal validates non-overlapping logical sequence ranges first; the Assembler then orders accepted inputs by their first `seq` before State replay.

| Path | Engine work | Definition-visible behavior |
|---|---|---|
| Replace on open, resync, or gap repair | Rebuild the loaded window, match every standard event or packed run once per Definition, then replay each started Context | `start`, followed by its updates in ascending logical `seq`; pending update-only Contexts remain without State |
| Prepend one older page | Match only fresh older inputs, merge them into Contexts by `(kind, id)`, preserve existing keyed nodes, and replay only affected Contexts and dependencies | A newly found scalar start activates its collected scalar and packed updates; a changed Location or predecessor may rerun the Context |
| Append one live event | Call each Definition's `match` once, look up the matched Context by key, and update only that Context | One scalar `update` and one requested publication for a matching post-start event; no existing Context scan |

With `D` registered Definitions, one incoming scalar event or packed run performs `D` current-input matches and constant-time Context-key lookup after a match. Definition code must preserve that property: do not traverse the complete event window, every Context, `context.matches`, or the rendered Node collection on the normal append path. Use State for accumulated facts, Location data for same-Turn/Step sharing, and `reader.previous()` for indexed predecessor dependencies.

`publication` controls when changed State is materialized. Use `immediate` for structural or terminal changes, `animation-frame` for high-frequency visible deltas, and `none` when the State change feeds only a later publication. The engine applies every scalar update in log order and every packed run in one batch update; cadence only coalesces view publication.

## Verification obligations

Add focused tests that establish these outcomes:

1. A complete window passed through replace produces the expected final State, Location data, Node payload, and `anchorSeq`.
2. An update-only tail stays pending; prepending the unique start produces the same result as a complete replace.
3. Initial history followed by live append produces the same result as replaying the combined window.
4. Prepending an older page adds earlier rows without replacing existing keyed Node values whose data did not change.
5. Repeated visible deltas preserve `context.key` and publish at most once per animation frame when requested.
6. The keyed renderer consumes `node.data` and constrained Location hooks only; it does not scan the Session event window, Contexts, or Chat Nodes.
7. Scalar and packed Assistant history produce the same final State, timing boundaries, and target snapshot, while one packed run remains one Match through replace, prepend, Location replay, and registry rebuild.
8. Creating a target source performs no builder work; explicit selection or the first subscription performs one complete replacement, later updates reach every active target, and repeated activation performs no replacement.

Use [`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts`](../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts) for streaming and interruption, [`inbox.ts`](../../packages/client/ui-chat/src/client/conversation-nodes/inbox.ts) plus [`message.ts`](../../packages/client/ui-chat/src/client/conversation-nodes/message.ts) for predecessor queries, and [`packages/client/ui-deliverables`](../../packages/client/ui-deliverables) for a Definition that publishes Turn data without creating its own Node.
