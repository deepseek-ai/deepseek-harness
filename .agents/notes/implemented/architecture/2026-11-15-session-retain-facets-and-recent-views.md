# Agent Note: Session retain facets and recently viewed Sessions

Status: implemented

English | [中文](2026-11-15-session-retain-facets-and-recent-views.zh.md)

## Problem

When the Web Client main view switched away from a Session, it released that Session's `mainView` reference. Once the reference count reached zero, the Client disposed the Session's binding, event window, and Conversation assembly state, so returning to it pulled history again.

Keeping a Session alive is inexpensive: the event window only appends, the stream shares the one Gateway WebSocket, and Host-side subscriptions are passive. The cost lies in derived computation. [`BoundConversation`](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) subscribed to the event window when constructed; afterwards every event, including every `assistant/live-chunk`, passed through Definition `match`/`update` folding and rAF-batched publication whether or not the Session was rendered. A retained background Session that keeps running would keep paying that cost.

The retain interface could only express retaining or releasing the whole Session; it could not express receiving data without derived computation.

## Decision

This decision extends [Client Session references](2026-09-15-client-session-references.md) without superseding it: references, source counts, and `ready` semantics are unchanged, and `SessionRetainOptions` carries facets.

### Session retain and facets

A Session retain always keeps the binding, scope, history connection, and event window alive. The connection is mandatory and is not a facet.

A facet is a part retained beyond that baseline, and each facet is counted independently. A reference declares the facets it retains through its options when it is created:

```ts ignore-check
// session-controller/client: declares no facets
export interface SessionRetainFacetMap {}
export type SessionRetainFacet = Extract<keyof SessionRetainFacetMap, string>

export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  /** Parts kept alive beyond the Session's history stream; an absent key is not retained. */
  readonly facets?: Readonly<Partial<Record<SessionRetainFacet, boolean>>>
  readonly signal?: AbortSignal | undefined
}

export interface SessionBinding {
  // existing members unchanged
  /** Whether any live reference retains `facet`; identity-stable per binding and facet. */
  facet(facet: SessionRetainFacet): ObservableSnapshot<boolean>
}
```

| Rule | Behavior |
|---|---|
| Declaration | The owning package adds a facet to `SessionRetainFacetMap` through declaration merging; the Controller assigns no meaning to any facet |
| Omission | An absent key is not retained; facets have no default |
| Immutability | A reference's facet set is fixed at creation; changing the set retains a new reference before releasing the old one |
| Counting | [`RetainedFacets`](../../../../packages/api/session-controller/src/client/sessions/facets.ts) keeps one count per facet for each generation; a change between zero and nonzero notifies `binding.facet(name)` observers synchronously, before `retainInfo` and list observers hear the same change; retiring the generation ends every facet |
| Dependencies | The Controller does not validate dependencies between facets; callers are responsible |
| `using()` | Signature unchanged; a borrowed reference serves one operation, and callers omit `facets` |
| `retainAgentScope` | Retains no facets |

### The `conversation` facet

`ui-conversation` declares `conversation`: Conversation assembly of the event window and materialization of its views.

- `BoundConversation` remains one per binding, and its `snapshot`, `openTurn`, and `target(t)` sources keep stable identities. `UiConversation.binding()` registers the binding's disposal on the Session scope before the binding starts following, and a failed initial fold disposes the binding so the next resolution starts afresh.
- When the facet **starts** being retained, the binding first subscribes to the event window, then resumes in one step: the first fold, or a registry change made while not following, rebuilds the current window once; otherwise contiguous changes received meanwhile apply through the incremental assembler and a revision gap rebuilds the whole window. Any pending rAF is then cancelled and the binding publishes once synchronously, also after that fold fails; a failed fold leaves the binding stale, so the next window change rebuilds the whole window instead of extending a partial fold. A view activated while not following is built from the last folded state and catches up on resume.
- When the facet **stops** being retained, the binding unsubscribes from the event window and cancels a pending rAF. The last published snapshot remains readable but no longer updates. While old DOM is still mounted during a switch, its components read that snapshot. A feed dispatch already in progress checks whether the binding still follows, so a release during that dispatch stops folding immediately.
- Calling `uiConversation.binding()` while the facet is not retained returns the unretained binding, which reads the last or empty snapshot without throwing.
- Two computations follow the `conversation` facet: `BoundConversation` and the [ui-chat](../../../../packages/client/ui-chat/src/client/apply.ts) quota listener, which neither publishes nor replays notices for failures received while the facet is not retained. Other state on `binding.ctx` that events do not drive (input shell, command popups, historical image URLs, agent preset seat) keeps its existing lifetime.

### Reference sources and facets

| Source | Owning package | `facets` |
|---|---|---|
| `mainView` | declared by ui-session, retained by ui-workspace | `{ conversation: true }` |
| `sidebarView` | ui-sidebar-right | `{ conversation: true }` |
| `sidebarChat` | ui-subagent | `{ conversation: true }` |
| `recentViews` | ui-workspace | omitted |
| `using()` callers and `gateway` | their own packages | omitted |
| Test fixture default | test-support/client-runtime | `{ source: 'testFixture', facets: { conversation: true } }` |

### Recently viewed Sessions: `recentViews`

ui-workspace [navigation](../../../../packages/client/ui-workspace/src/client/navigation.ts) owns a [`RecentSessionViews`](../../../../packages/client/ui-workspace/src/client/recent-views.ts), which holds one `recentViews` reference for each recent view.

Its state records only what the user did: the order in which Sessions left the main view and the Session the main view shows now. One idempotent `sync()` derives the Sessions to hold from that state and the current Session list, Workspace list, and Session UI status, retains the missing ones, then releases the rest. Navigation calls `show(sessionId)` after retaining the new `mainView` reference and before releasing the previous one; Session list, Workspace list, and status changes call `sync()`. Retaining publishes the Session list synchronously, so a re-entrant `sync()` only marks the state dirty and the running pass repeats until the selection is stable.

| Rule | Behavior |
|---|---|
| Order | Both `mainView` references are held while `show()` syncs, so the previous Session moves to the recent views before its `mainView` reference is released and its reference count never reaches zero; the main-view Session is never a recent view, and reselecting it leaves the selection unchanged |
| Blank | A Session still blank when the main view leaves it does not enter |
| Failure | A failed retention is reported to the console once and the Session leaves the order, so it is released with its `mainView` reference; navigation continues |
| Exit | A removed, archived, or evicted Session leaves the order and returns only when the main view leaves it again |
| Attention | A Session that is running, awaits the user, or has an unread completion, as the unified Session UI status reports, is neither counted nor evicted; once it is read and idle it counts again |
| Limit | The ui-workspace `recentViewLimit` configuration, 10 by default, counted Sessions besides the main-view Session |
| Eviction | Beyond the limit, the least recently left unpinned Session is evicted first, then the least recently left pinned one; the list is checked again whenever the Session list, Workspace list, or Session UI status changes |
| Disposal | Plugin disposal unsubscribes from both lists and the status, clears the order, and releases every reference |

## Alternatives considered

**Decide following by subscriber count.** `BoundConversation` would fold only while subscribed and catch up synchronously on cold reads. React renders before it subscribes, so following would depend on read-time catch-up to avoid a stale first frame, and whether computation runs would follow incidental subscription timing rather than the owner's intent.

**Split reference sources into render and hold classes.** This expresses only one switch; an independently counted part such as a draft would need another classification.

**Owner-declared facet defaults at runtime.** This requires a Controller runtime registry plus recounting across load order and HMR, while the rule that an omitted facet is not retained suffices.

**Make `events` a facet.** A Session without its connection can do nothing, and the only connection-free use, the Gateway, already has its own internal entry.

**Keep background Session DOM.** React 18 has no `<Activity>`; K hidden subtrees pay layout, memory, and subscription costs and conflict with the single-Session `session-maybe` binding.

**Keep folding while unretained and only defer publication.** The `match`/`update` cost of stream chunks remains.

**Compute a bespoke difference between the folded inputs and the window.** One attempt can start, stream, and settle entirely while unretained, which makes such difference logic error-prone; resumption instead reuses the assembler's existing contiguous-change and gap-rebuild paths.

## Consequences

- A background Session switches back without a history request, while it performs no Conversation folding until it is shown again.
- An unretained Session keeps the memory of its last assembly until it is shown again or its binding retires.
- The attention-protected recent views have no upper bound: an unread completion stays protected until the user reads it, so each Session that finishes unread while the user is elsewhere keeps its generation, loaded event window, and history follow stream until it is read, marked read, removed, or archived.
- Returning to a Session that ran in the background pays one catch-up fold, at most equal to the post-open fold of a fresh opening, without a network request.
- A rendering owner that omits `conversation: true` sees an unretained stale or empty snapshot without an error.
- `SessionRetainOptions` and `SessionBinding` are pre-stable public interfaces; every consumer and the test fixture changed together.

## Testing

- [reference-ownership.client.spec.ts](../../../../packages/api/session-controller/tests/reference-ownership.client.spec.ts) covers per-facet counting, notifications only at zero transitions, and facets ending with the generation and root disposal.
- [conversation-registry.client.spec.ts](../../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts) covers zero folding while unretained, one synchronous publication on resume, equality with continuous following, activation and registry changes while not following, a release during an in-progress dispatch, an interrupted rAF publication, a failed resumption, and a failed initial fold leaving no subscription.
- [quota-notice.client.spec.tsx](../../../../packages/client/ui-chat/tests/quota-notice.client.spec.tsx) covers quota notices publishing only while the facet is retained.
- [recent-views.client.spec.ts](../../../../packages/client/ui-workspace/tests/recent-views.client.spec.ts) and [workspaces-service.client.spec.ts](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) cover the attention and pin rules, synchronous re-entrancy during retention, the main-view Session staying out of the count, eviction without automatic return, configuration, list-driven reconciliation, and returning to a recent view through the same generation without reopening history.
