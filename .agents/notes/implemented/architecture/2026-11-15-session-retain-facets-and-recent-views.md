# Agent Note: Session retain facets and recently viewed Sessions

Status: implemented

English | [中文](2026-11-15-session-retain-facets-and-recent-views.zh.md)

## Problem

When the Web Client main view switched away from a Session, it released that Session's `mainView` reference. Once the reference count reached zero, the Client disposed the Session's binding, event window, and Conversation assembly state, so returning to it pulled history again.

Keeping a Session alive is inexpensive: the event window only appends, the stream shares the one Gateway WebSocket, and Host-side subscriptions are passive. The cost lies in derived computation. [`BoundConversation`](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) subscribed to the event window when constructed; afterwards every event, including every `assistant/live-chunk`, passed through Definition `match`/`update` folding and rAF-batched publication whether or not the Session was rendered. A retained background Session that keeps running would keep paying that cost.

The retain interface could only express retaining or releasing the whole Session; it could not express receiving data without derived computation.

## Decision

This decision extends [Client Session references](2026-09-15-client-session-references.md) without superseding it: references and source counts are unchanged; `SessionRetainOptions` carries `connection` and facets, and a reference without the connection is ready once its binding exists. It replaces the draft-attachment ownership of [draft attachments across Session switches](../bug-fix/2026-11-13-draft-attachments-across-session-switches.md) with the `draft` reference.

### Connection and facets

A Session reference always keeps the Session object and its scope, which hold local state such as the composer draft and pending submission echoes. Two options decide what it keeps beyond that:

```ts ignore-check
export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  /** Keeps the Session's own event connection and the event window it keeps current; defaults to `true`. */
  readonly connection?: boolean
  /** Owner-declared facets this reference keeps computing over the Session's data; an absent key is not computed. */
  readonly facets?: Readonly<Partial<Record<SessionRetainFacet, true>>>
  readonly signal?: AbortSignal | undefined
}

export interface SessionRetainInfo {
  // existing members unchanged
  /** Positive counts of references retaining each facet; absent while no reference retains any facet. */
  readonly retainedFacets?: Readonly<Partial<Record<SessionRetainFacet, number>>>
  /** Positive count of references keeping the event connection; absent while none does. */
  readonly connectionCount?: number
}
```

| Rule | Behavior |
|---|---|
| Connection | The connection is the Session's own follow stream plus the event window it keeps current, not the page transport. It opens when the first reference that keeps it is retained; when the last such reference is released while the scope remains, `Session.disconnect()` closes it, empties the window, and returns the Session to its cold state while keeping pending submission echoes; the next reference that keeps it connects as a first open |
| Facets | The owning package adds a facet to `SessionRetainFacetMap` through declaration merging; the Controller assigns no meaning to any facet. An absent key is not computed; a facet computes over the data the connection keeps, so without it there is nothing to compute |
| Buffered older pages | When the last facet is released while the connection remains, `Session.bufferOlder()` keeps only the last Turn-aligned page visible and hands the older entries to its `SessionEventStream`. The Session pages back exactly as before; the stream answers page reads from those buffered records, cut by the request's Turn window, without a request, and reads Host pages after they run out. A replaced window drops the buffer, and it leaves with the stream on resync, disconnect, or disposal. [`buffered-pages.ts`](../../../../packages/api/session-controller/src/client/sessions/buffered-pages.ts) owns the page cut |
| Counting | [`shiftFacetCounts`](../../../../packages/api/session-controller/src/client/sessions/facets.ts) keeps one count per facet beside `connectionCount` and the per-source `retainedBy` counts in the generation's `SessionRetainInfo`; `retainInfo(id)` publishes every change, and owners derive their facet from that snapshot and the current binding, so `SessionBinding` is unchanged |
| Immutability | A reference's options are fixed at creation; changing them retains a new reference before releasing the old one |
| `using()` | Signature unchanged; borrowed references keep the connection by default and request no facet |
| `retainAgentScope` | Keeps neither the connection nor a facet |

### The `conversation` facet

`ui-conversation` declares `conversation`: Conversation assembly of the event window and materialization of its views.

- `BoundConversation` remains one per binding, and its `snapshot`, `openTurn`, and `target(t)` sources keep stable identities. `UiConversation.binding()` registers the binding's disposal on the Session scope before the binding starts following, and a failed initial fold disposes the binding so the next resolution starts afresh.
- While the facet is retained, the binding folds the whole current window once, publishes it synchronously, and follows window changes; a fold that fails leaves the binding unfolded, so the next window change folds the whole window again.
- When the facet is released, the binding unsubscribes, cancels a pending rAF, drops its fold, and publishes the empty result once; registry changes while released are not applied until it is retained again. A feed dispatch already in progress checks whether the binding still follows, so a release during that dispatch stops folding immediately.
- Two computations follow the `conversation` facet: `BoundConversation` and the [ui-chat](../../../../packages/client/ui-chat/src/client/apply.ts) quota listener, which neither publishes nor replays notices for failures received while the facet is not retained.

### The `draft` reference

The [input hub](../../../../packages/client/ui-conversation/src/client/input/hub.ts) holds a Session with `{ source: 'draft', connection: false }` while its composer draft has attachments and the Session is not removed. The scope, and with it the same composer shell and its browser-owned attachments, therefore survives every view releasing the Session; returning reconnects and refolds while the composer keeps its attachments, uploads, and failed-upload retries. Removing the last attachment, sending it, or removing the Session releases the hold, and scope teardown then releases every draft attachment. A page unload still marks the Sessions whose draft holds attachments, and the next page reports them as discarded.

### Reference sources and facets

| Source | Owning package | Options |
|---|---|---|
| `mainView` | declared by ui-session, retained by ui-workspace | `{ conversation: true }` |
| `sidebarView` | ui-sidebar-right | `{ conversation: true }` |
| `sidebarChat` | ui-subagent | `{ conversation: true }` |
| `sidechat` | client-ui-sidechat (experimental) | `{ conversation: true }` |
| `recentViews` | ui-workspace | omitted: connection only |
| `draft` | ui-conversation | `{ connection: false }` |
| `using()` callers | their own packages | omitted |
| `gateway` | session-controller | internal entry without connection |
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
| Limit | The ui-workspace `recentViewLimit` configuration, 10 by default, counted Sessions besides the main-view Session; a volatile Host `Config` field the browser receives through [synced plugin configuration](2026-11-15-client-config-sync.md), so a change applies without a reload and Sessions already evicted do not return |
| Eviction | Beyond the limit, the least recently left unpinned Session is evicted first, then the least recently left pinned one; the list is checked again whenever the Session list, Workspace list, or Session UI status changes |
| Disposal | Plugin disposal unsubscribes from both lists and the status, clears the order, and releases every reference |

## Alternatives considered

**Decide following by subscriber count.** `BoundConversation` would fold only while subscribed and catch up synchronously on cold reads. React renders before it subscribes, so following would depend on read-time catch-up to avoid a stale first frame, and whether computation runs would follow incidental subscription timing rather than the owner's intent.

**Split reference sources into render and hold classes.** This expresses only one switch; an independently counted part such as a draft would need another classification.

**Owner-declared facet defaults at runtime.** This requires a Controller runtime registry plus recounting across load order and HMR, while the rule that an omitted facet is not retained suffices.

**Expose a facet observable on `SessionBinding`.** A new required `SessionBinding` member breaks every hand-built binding, including third-party test fakes, while facet counts are local reference counts that `retainInfo` already publishes beside the per-source counts.

**Retention levels instead of facets.** A fixed `state`, `cache`, `live` enumeration cannot grow with later owner needs, while a default-on `connection` plus owner facets expresses the same three states.

**Keep the last fold after the facet is released.** A stale result with no owner adds a hidden state; the window stays, and folding only its last page on return is cheap.

**Root-level draft-attachment ownership.** Recording owners in the Conversation service and re-adopting them in a new composer duplicates Session lifetime tracking with a catalog watch; holding the scope keeps the composer itself.

**Keep background Session DOM.** React 18 has no `<Activity>`; K hidden subtrees pay layout, memory, and subscription costs and conflict with the single-Session `session-maybe` binding.

**Keep folding while unretained and only defer publication.** The `match`/`update` cost of stream chunks remains.

**Compute a bespoke difference between the folded inputs and the window.** One attempt can start, stream, and settle entirely while unretained, which makes such difference logic error-prone; returning folds the last page from scratch instead.

## Consequences

- A recent view switches back without a history request and folds only its last page; paging back through pages already loaded makes no request.
- A recent view keeps its whole loaded window in memory; it keeps no Conversation fold.
- A Session evicted from the recent views with draft attachments keeps its composer but not its window, so returning to it requests history again.
- The attention-protected recent views have no upper bound: an unread completion stays protected until the user reads it, so each Session that finishes unread while the user is elsewhere keeps its generation, loaded event window, and history follow stream until it is read, marked read, removed, or archived.
- A rendering owner that omits `conversation: true` sees an unretained stale or empty snapshot without an error.
- `SessionRetainOptions` and `SessionRetainInfo` gain optional fields only; a third-party Client plugin that renders a Session it retains under its own source must add `facets: { conversation: true }`, and a plugin that only needs local state may pass `connection: false`, which the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.3/session-retain-conversation-facet/guide.md) describes.

## Testing

- [reference-ownership.client.spec.ts](../../../../packages/api/session-controller/tests/reference-ownership.client.spec.ts) covers per-facet and connection counting, holding a Session without connecting it, disconnecting after the last connected reference, buffering older pages after the last facet, and counts ending with the generation and root disposal; [session.client.spec.ts](../../../../packages/api/session-controller/tests/session.client.spec.ts) covers buffered-page paging, Turn jumps, Host paging after buffered pages, buffering again after live growth, and disconnect then reconnect.
- [conversation-registry.client.spec.ts](../../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts) covers dropping the fold on release, one synchronous fold on retention, equality with continuous following, activation and registry changes while not following, a release during an in-progress dispatch, a cancelled rAF publication, a failed fold, and a failed initial fold leaving no subscription; [draft-attachment-retention.client.spec.ts](../../../../packages/client/ui-conversation/tests/draft-attachment-retention.client.spec.ts) covers the `draft` reference, its release, removed Sessions, and unload marks.
- [quota-notice.client.spec.tsx](../../../../packages/client/ui-chat/tests/quota-notice.client.spec.tsx) covers quota notices publishing only while the facet is retained.
- [recent-views.client.spec.ts](../../../../packages/client/ui-workspace/tests/recent-views.client.spec.ts) and [workspaces-service.client.spec.ts](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) cover the attention and pin rules, synchronous re-entrancy during retention, the main-view Session staying out of the count, eviction without automatic return, configuration, list-driven reconciliation, and returning to a recent view through the same generation without reopening history.
