# Agent Note: Client Conversation business-node assembly and keyed Chat snapshots

Status: implemented

English | [中文](2026-08-09-client-conversation-node-assembly.zh.md)

## Problem

Client Session owned transport windows, connection state, and pending interactions while also interpreting Assistant, Tool, message, command, compaction, retry, and turn-tail events in a centralized transcript fold. Adding one business node required changes to Session switches, history replay, indexes, caches, and React grouping; business identity, state evolution, and final presentation had no independent owner.

Without target-neutral assembly, running Assistant and Tool values sit outside the finalized flow and enter the log-ordered node list only after settlement. Their React parent then changes and remounts them even when the business ID and `key` remain stable. Separate update paths for full history loads, older prepends, live appends, and token streaming also make reference stability and local recomputation depend on specialized caches spread across the client.

Business events also use different correlation models. Tool has call IDs, Assistant correlates by turn and step, Compaction has its own lifecycle and checkpoint, and an Inbox splice represents one instantaneous state in a sequence. Keeping all these distinctions in one fold would make every business change pass through a global lookup and invalidate unrelated caches.

## Decision

Client Runtime provides a target-neutral Conversation Node assembly engine. Business plugins register Event Definitions, and view plugins register per-Session View Builders. `ui-conversation` registers the first built-in Definitions and the `chat` builder; Session only submits the current contiguous `SessionEventLikeEntry` window to the engine and publishes its snapshot instead of interpreting individual conversation businesses. The entry's outer discriminator distinguishes standard and packed records, while both carry an aligned inner `SessionEventLike` for Definition dispatch.

This Note retains the derivation, business-by-business validation, responsibilities, algorithms, and trade-offs that remain relevant after implementation.

Chat registers an Inbox Definition only for `next-step`, because message classification is its sole consumer; `next-turn` splices remain durable Session inputs but create no Chat Context. Chat and Trajectory each keep target-owned next-step state. Every insertion stores only message IDs in an immutable splice node. A successful claim materializes the pending chain once, replaces the previous claimed set with that batch, and lets later Contexts share the set until another claim. The AgentLoop appends every message admitted from that claim before it can claim another batch; a rejected claim appends no `user/message`, so later classification needs only the current batch. Historical Contexts therefore retain linear ID state instead of cumulative array and Set snapshots.

### Responsibility layers

| Layer | Durable responsibility | Explicitly does not own |
|---|---|---|
| Session | Maintain the contiguous logical-event window, distinguish replace, prepend, and scalar append, and schedule snapshot notifications | Interpret Tool, Assistant, Compaction, or other business events |
| Event Registry | Retain the unique-`kind` Definitions and sole fallback under Cordis lifecycles | Store one Session's Context or State |
| Assembler | Match standard events or packed runs and maintain Contexts, Locations, dependencies, and the publication dirty set | Interpret business State fields or Chat ordering |
| Node Definition | Define one business object's identity, State transitions, Location data, and target Node | Create Contexts, mutate another business's State, or scan all Contexts |
| View Builder | Incrementally organize final target Nodes into that view's snapshot | Reinterpret `SessionEventLike` inputs |
| React renderer | Render renderer-owned data by the final Node's `kind` and read business data from the current Node's Location | Pair business Events, scan global Nodes, or decide business lifecycle state |

Registry contributions are Cordis effects. Removing a Definition causes a low-frequency registry rebuild for existing Sessions; ordinary business Events do not change the Registry or rebuild every business type.

### Overall `ConversationNodeDefinition` contract

Each [`ConversationNodeDefinition`](../../../../packages/client/ui-conversation/src/client/contract/conversation.ts) independently owns one business object's conversion from `SessionEventLike` inputs to State and final view Nodes. A Definition's `kind` is its unique Registry name and the namespace for its business IDs.

One input may be claimed by several ordinary Definitions. For example, an Assistant event or packed run updates both the Assistant Node and Turn Tail, while a Retry Event updates Retry, Assistant, and Turn Tail. The Assembler asks the fallback only when every ordinary Definition returns `null`.

A Definition holds no mutable business data across Sessions. Each Session's Assembler isolates that Session's Contexts, State, dependencies, and View Builders.

#### `kind`, business ID, and Context key

The `id` returned by `match()` only needs to be stable within its Definition. A Tool ID can be a call ID, an Assistant ID can be `turn:step`, and an Inbox ID can be the splice Event seq.

The Assembler uses `conversationContextKey(kind, id)` to make a collision-free key. Definitions that return the same `id` still do not share a Context. The final view Node must retain this engine-owned key and cannot use `seq` or render position as identity.

Each `(kind, id)` has at most one start Match. A second start fails immediately; a Definition must return a new ID to represent a new lifecycle.

#### `match(event)`

`match(event)` reads only the current `SessionEventLike` and returns `{ id, role: 'start' | 'update' }` or `null`. It cannot access a Context, history, a Reader, a Location, or the view envelope. A Client-only `assistant/live-chunk` event can only be an update; the Assembler rejects every transient start, and `start()` receives a `ConversationStartMatch` containing a durable `SessionEvent`.

This restriction makes one scalar event or packed run's routing cost depend only on the number of registered Definitions. The Assembler never scans a Definition's historical Contexts to decide which one owns an update.

Start, result, resource, checkpoint, and business-owned terminal Events must carry or directly imply the same ID. If one Event cannot yield that ID, its producer extends the Event protocol; the Client does not guess from the "nearest unfinished object."

The `role` describes the State lifecycle, not visibility. A start may produce a terminal Node immediately, while an update may enter a pending Context before its start has loaded.

#### `ConversationMatch`

After a successful match, the Assembler combines the standard or packed event, `role`, and engine-computed `location` into a read-only `ConversationMatch`. A packed run remains one Match and retains its fragment and timestamp-gap arrays.

A Context's `matches` always remain in ascending first-`seq` order, not network arrival or pagination ingestion order. The Session journal has already rejected overlapping logical ranges. If a tail page supplies a result before an older page supplies its call, the final Match order still places the call before the result.

Location can change when prepend fills a boundary or append closes one. The Assembler replaces the affected Matches' read-only Locations and replays the Context; business code does not retain an old Location copy as authority.

#### `ConversationNodeContext`

| Field | Owner | Semantics visible to the Definition |
|---|---|---|
| `key` | Assembler | Stable final identity derived from `kind + id` |
| `kind` / `id` | Definition + Assembler | Current business namespace and business ID |
| `matches` | Assembler | Complete scalar and packed business evidence loaded in the current window and sorted by first `seq` |
| `start` | Assembler | Unique scalar start Match, or `undefined` before it loads |
| `state` | Returned by Definition, held by Assembler | Most recent `start`/`update` return value, or `undefined` before initialization |
| `current` | Assembler | Most recently materialized Node or `null` for each target |

Read-only Context fields do not require deeply immutable business State. A Definition may return a new object or mutate the old object in place and return the same reference.

The Assembler adopts only the returned value. Returning `undefined` from `start()` or `update()` is a contract error and fails immediately; mutating an object without returning it is likewise invalid.

A Definition may inspect all `matches` to help construct State or a fallback Node, but it cannot add or remove Matches, replace Context fields, or mutate another Context.

#### `start(context, match, reader)`

`start()` is the sole State initialization entry point. The Assembler invokes it when the unique start first appears and adopts its returned State.

When an older page changes Match order, the Reader's predecessor answer, or Location facts, the Assembler recomputes from `start()` instead of applying a reverse-direction patch to old State.

The Context may already contain updates after the start when `start()` runs. After `start()` returns initial State, the Assembler still invokes `update()` for every post-start Match in ascending log order, so ingestion direction cannot change the final fold.

The `reader` is available only in `start()`. Initialization can read the nearest active Context of a specified `kind` strictly before the current start seq, but business code receives no general interface for scanning internal engine Maps.

Each new `start()` invocation replaces the Reader dependencies recorded by the prior invocation, so a Definition that changes its query branch retains no stale edges.

#### `reader.previous(kind)`

`reader.previous(kind)` finds the nearest Context whose `candidate.startSeq < current.startSeq` and whose State is initialized. It never returns a Context at the same seq, a future Context, or a pending Context without State.

The result contains the predecessor's key, kind, ID, start seq, read-only State, and Matches. The consumer interprets that State itself; the provider only maintains its State correctly and need not register a specialized query method.

Each Reader query records a `{ key, revision, windowGap }` dependency. A matched predecessor's revision change replays the consumer; a miss while older history remains records a window gap for a later prepend.

When the window already reaches the Session beginning, a miss is a definitive `undefined`. When `hasMore` is true, the Definition sees the same `undefined`, but the Assembler remembers that the result is provisional.

Dependencies point strictly from earlier starts to later starts, so transitive replay cannot form a temporal cycle. Both the Inbox instantaneous-state chain and Message reads of Inbox use this constraint.

#### `update(context, match)`

`update()` handles a post-start durable or transient Match that `match()` has already routed exactly to the current `(kind, id)`. It does not decide which Context owns the input. An Assistant Definition folds each `assistant/live-chunk` update directly and expands an embedded `assistant/message` or `assistant/attempt` stream during history replay.

The Assembler invokes `update()` in ascending `seq` order. A live tail update can apply incrementally; any non-tail insertion, newly loaded start, or invalidated dependency causes a complete replay from `start()`.

When no business data changes, `update()` returns the existing State. When data changes, it may return an immutable replacement or mutate the existing object and return that object.

The Assembler does not use State reference equality to decide publication or propagation. Every accepted update increments the Context revision, marks it dirty, and causes direct or transitive Reader consumers to be reevaluated.

#### `publication(match)`

`publication()` controls when the latest State materializes as a view Node; it does not delay the synchronous execution of `match()`, `start()`, or `update()`.

| Return value | Behavior |
|---|---|
| `immediate` | Request a notification and flush in the current microtask |
| `animation-frame` | Coalesce high-frequency updates into materialization after three browser animation frames |
| `none` | Do not schedule a flush for this Match; retain its State and dirty marker |

Omitting `publication()` means `immediate`. Assistant token deltas and packed runs use `animation-frame`, invisible Inbox Contexts use `none`, and finals, dependency replays, and Location boundaries publish the latest result through an immediate path.

Every live delta during the three-frame interval still executes `update()`, while one historical packed run executes one batch `update()`. Location-data publication, `buildViewNode()`, View Builder work, and React snapshot notification are coalesced; no fragments are lost. An immediate publication cancels a pending frame interval and flushes the latest State without delay.

#### `buildLocationData(context, scope)`

`buildLocationData()` lets a Definition publish a read-only value derived from its State onto an engine-owned Step or Turn without exposing another business's mutable State. The Assembler passes the preceding publication back to its owner, which returns that exact value when its business data is unchanged. The Assembler always materializes `step` before `turn`, so Turn-level aggregation can read Step data updated in the same flush; it calls `buildViewNode()` only after all Location data is ready.

A Definition receives the `step` and `turn` scopes separately and may return one value or `null` in either phase. A value must identify the exact turn/step coordinates and use the Definition's `kind` as its key. The Assembler owns replacement and removal and rejects another Context that claims the same Location key.

`ConversationStepDataMap` and `ConversationTurnDataMap` use declaration merging to constrain keys and values. A Location exposes only a stable `data.get(key)` reader; consumers cannot obtain the provider Context or mutate its State.

#### `buildViewNode(context, target)`

`buildViewNode()` reads the latest Context during publication and directly produces the final business Node for the named target. The Assembler adds no generic activity, tail-candidate, or layout business layer afterward.

`null` means this Context has not yet materialized for the target. On the ordinary incremental path, a Context that has returned a non-null Node cannot later return `null`; temporary absence retains the same-key Node and uses the target's visibility representation.

The Assembler verifies `node.key === context.key` and `node.target === target`. Business code may change `anchorSeq`, data, Location, or visibility, but cannot change identity within one lifecycle.

`current` lets a Definition distinguish "never materialized" from "already materialized and now hidden." Assistant retry suppression uses it to avoid illegal Node withdrawal.

A Definition owns at most one view target; state-only Definitions omit both `target` and `buildViewNode()`. Chat and Trajectory register separate business Definitions even when they recognize the same durable Event family, while the shared Assembler supplies the same matching, replay, Location, and publication mechanics to both targets.

#### No generic `end()`

The engine exposes no fixed `end()` lifecycle. A single-Event business completes in `start()`, a multi-Event business records completion in its own update, and a long-lived instantaneous-state business creates a new Context for every Event.

Step and Turn closure are external Location facts and do not mutate business State. A boundary change replays and builds affected Contexts; each business combines its own completion State with whether its Location is closed to produce normal, running, or interrupted presentation.

IDs are never reused. Completed Contexts remain in the current window, providing stable render identity and possible predecessor evidence for later Readers.

### Location is a first-class engine fact

[`ConversationLocationIndex`](../../../../packages/client/ui-conversation/src/client/conversation/location-index.ts) maps standard events and packed runs to Locations from `turn/start`, `step/start`, explicit turn and step payloads, `step/end`, and `turn/end`. All members of a row share its turn, step, block index, and delta kind, so the row needs one Location entry at its first `seq`.

Location has four shapes: `session`, `turn`, `step`, and `unresolved`. Turns and Steps each carry `open`, `closed`, or `unknown` status plus any loaded start and end Events.

Each Turn and Step also carries a reference-stable Location data store. A Definition update replaces only its owned key; the same store identity can acquire new values through append or prepend, allowing Contexts, View Builders, and React renderers to share resolved hierarchy-level business facts without copying or scanning the global Node array.

`unresolved` means the current history window lacks sufficient preceding boundaries; it does not mean session-level. When older prepend supplies those boundaries, the index corrects Match Locations and replays only Contexts that own those seqs.

An appended standard Event only inherits current coordinates, while an appended boundary recalculates only its owning Turn. Prepend rebuilds Location facts from the contiguous `SessionEventLikeEntry` window, but reference-stability logic retains unchanged Turn and Step objects.

The Assembler also passes a reference-stable timeline to each View Builder. Businesses do not separately maintain turn order, step lists, last-step values, or boundary Maps.

## Three input-window paths

"Backward history scanning" describes the UI loading pages from the newest tail toward the Session beginning; it does not mean a Definition executes `update()` in reverse. The Session journal validates each record's logical range before publication. Regardless of page-loading direction, the Assembler orders every accepted standard event or packed run by its first `seq`.

| Scenario | Input range | Context and State handling | View Builder |
|---|---|---|---|
| Initial history tail or resync | Current complete contiguous logical window | Clear and rebuild all Contexts in ascending first-`seq` order | `replace()` |
| Load one older-history page | Only range-validated fresh standard events or packed runs before the window | Retain existing Context identity, then add Matches, Locations, dependencies, and local replays | `apply(upserts)` |
| Live append | One contiguous tail Event | Match Definitions and update only the exact IDs; boundaries affect only their owning Turn | `apply(upserts)` |

### Initial history tail and logical backward scanning

1. `Session.open()` loads the latest tail page and passes its contiguous `SessionEventLike` entries to `replaceWindow(entries, hasMore)`.
2. `replaceWindow` clears old Contexts, start-seq indexes, seq reverse indexes, Reader dependencies, and the input Map.
3. It sorts every entry by its first logical `seq` and stores the resulting current window.
4. LocationIndex rebuilds Turn and Step facts for that window.
5. The Assembler visits standard events and packed runs in ascending order and invokes every ordinary Definition's `match(event)`.
6. Each result gets or creates its `(kind, id)` Context and enters that Context's ordered Match array.
7. A start runs `start()`; a tail update on initialized State runs `update()` directly.
8. If the page contains only a result or resource and omits its start, the ID still creates a Context and collects Matches, while State remains `undefined`.
9. After matching all inputs, the Assembler rechecks Reader dependencies so earlier instantaneous states in the same window stabilize before later consumers read them.
10. Every Context becomes dirty, and the next flush fully rebuilds Location data in Step→Turn order before invoking `buildViewNode()` for every target.
11. Some businesses return `null` without a start; Compaction, Command, Tool result, and Turn Error can construct fallback Nodes from sufficient update evidence.
12. Each View Builder receives the complete Node set and timeline and establishes the initial snapshot through `replace()`.

This path starts from the newest page only at the pagination layer. State within the page always computes forward, so the same window does not produce different business results under a different scan direction.

A Context without a start is not an error. It is a pending aggregation container waiting for an older page; that Definition's `buildViewNode()` decides whether the evidence already makes it visible.

If an update with the same ID is genuinely earlier than the start in log order, rather than merely loaded first, replay fails with a protocol error after the start arrives. Arrival order may be reversed; business log order may not.

### Prepending a newly loaded older page

1. `Session.loadOlder()` requests the immediately preceding page using the current `baseSeq` and first verifies continuity between the page tail and current window.
2. Session prepends the accepted standard or packed entries to its own window and passes only that page to `assembler.prepend(entries, hasMore)`.
3. The journal has already removed complete duplicate ranges and rejected partial overlaps; the Assembler sorts the fresh page by first `seq`.
4. Existing Contexts, State, current Nodes, and View Builder instances remain intact.
5. LocationIndex rebuilds facts over the extended complete input and reports seqs whose Location identity actually changed.
6. Contexts owning those seqs update their Match Locations and replay from start; unrelated Contexts do not join Location replay.
7. Fresh standard events and packed runs enter existing or new Contexts through the same Definition matcher and stable ID.
8. If the new page supplies a pending Context's start, that Context initializes from the start and then applies every already-collected update in ascending order.
9. If the page establishes a nearer Reader predecessor, changes a predecessor revision, or removes a window gap, the consumer recomputes from `start()`.
10. Reader dependencies propagate replay toward later start seqs; no Event is applied in reverse within the propagation batch.
11. An empty page that changes `hasMore` from true to false also rechecks dependencies and resolves a provisional `undefined` to definitive absence.
12. The flush republishes Step/Turn Location data and target Nodes only for dirty Contexts, then passes non-null results to View Builder `apply()` as `upserts`.

Prepend retains existing Context keys and current Node identity. A page may add historical keys at the front of Chat `order` or correct an existing Node's anchor, Location, visibility, or data, but it does not recreate unrelated business Contexts.

On a structural change, the Chat Builder recomputes visible `order` and the secondary Location index from its keyed store. That is view-index work; it neither reruns every business Definition nor replaces unchanged Node values.

Reader gap repair is the largest algorithmic difference between prepend and ordinary append. A page can both add visible historical Nodes and change later Inbox instantaneous states and the Message classifications that depend on them.

### Forward live append

1. Session accepts only a standard live Event immediately after the current logical tail seq; it deduplicates overlap and runs tail-page repair before accepting a gap.
2. A non-boundary Event enters the current Turn and Step coordinates incrementally; a boundary Event updates Location facts for its owning Turn.
3. The Assembler invokes `match()` once on every ordinary Definition for this Event and scans no Definition's Context set.
4. Each successful result directly locates one Context through `(kind, id)`.
5. A new ID creates a Context; a normal tail update for an existing ID invokes `update()` once.
6. A start or any evidence inserted before the tail uses complete `replayContext()` and retains the same forward-order semantics.
7. After a Context revision changes, only recorded Reader dependents replay.
8. Location close updates affected Matches within its owning Turn and replays those Contexts, allowing unfinished Assistant, Tool, or Retry values to acquire interrupted or cancelled presentation.
9. The Assembler takes the highest publication urgency among all matching Definitions: `immediate` outranks `animation-frame`, which outranks `none`.
10. Session routes immediate work to the microtask notifier and animation-frame work to the RAF notifier.
11. The flush updates Step/Turn Location data for dirty Contexts, then invokes `buildViewNode()` and passes this transaction's upserts and latest timeline to each View Builder.
12. The new React snapshot reuses stable Context keys; the same Tool running→settled or Assistant streaming→final value never moves across parents.

Append's business-matching cost is the Definition count plus the Contexts actually updated, independent of historical Context count. Reader consumers and Location closure add replay proportional to real dependencies or the owning Turn.

A structural Chat `order` change can still reorder the current visible keys. A data-only update replaces one keyed-store Node and touches its Location index. The guarantee is that unrelated businesses do not refold and unchanged Node identity is retained, not that every view-index operation has constant complexity.

### Consistency across replace, prepend, and append

All three paths preserve the same invariants: Context Matches are seq-ordered, State folds forward from one unique start, Reader sees only strictly preceding active Contexts, Location data publishes in Step→Turn order, and Node key depends only on kind and ID.

`replaceWindow` is the low-frequency complete replacement for initial open, resync, gap repair, and registry changes; it does not implement ordinary load older. Both `prepend` and `append` retain existing Builder and Context identity.

Page size, record packing, the number of history loads, and RAF coalescing affect only when evidence arrives or publishes. They do not change final Context State and Nodes for equal logical evidence.

## How built-in businesses use Definitions

### Matching, ID, and State

| Business / `kind` | Stable ID | Start Match | Update Matches | State and cross-Context reads |
|---|---|---|---|---|
| Next-step Inbox / `inbox-next-step` | Splice Event seq | Each `agent/inbox/spliced` targeting next-step | None | Append message IDs to persistent splice state; materialize once per claim and expose the shared current claimed batch to Message |
| Message / `input-message` | Message ID | Append-surface `user/message` | None | Use source for a context message, or read the nearest next-step Inbox to distinguish user from steering |
| Request Prompt / `request-prompt` | Header Event seq | Each `request/header` | None | Read the preceding Request Prompt through Reader, retain the full prompt state, and classify system/tool changes |
| Assistant / `assistant-step` | `turn:step` | `step/start` | Live `assistant/live-chunk`, durable `assistant/message` or `assistant/attempt`, and same-step Retry | Aggregate blocks, usage, first-token time, settlement evidence, and retry-hidden state, then publish same-key Step data |
| Tool / `tool-call` | Root call ID | Root `tool/call` | Root result and Code Dispatch start/result | Aggregate the root, children, and parent Map; Dispatch Events route exactly through `rootCallId` |
| Command / `command` | Command ID | `command/run` | `command/done` and compact lifecycle/checkpoint Events carrying a source command ID | Aggregate command outcome and manual-compaction evidence |
| Automatic Compaction / `compaction` | Compaction ID | `compaction/start` without a source command ID | Summary, end, and replacement checkpoint | Aggregate summary/checkpoint; sufficient checkpoint evidence supports fallback without a start |
| Retry / `model-retry` | Retry ID | Attempt 1 `llm/retry` | Later `llm/retry` and `llm/retry-started` | Aggregate one RetryId's attempts and scheduled/started state |
| Turn Error / `turn-error` | Turn number | `turn/start` | Error `turn/end` | Aggregate the terminal failure; the turn's Retry history renders through Retry and never hides this row |
| Turn Tail / `turn-tail` | Turn number | `turn/start` | Assistant, Retry, `step/end`, and `turn/end` | Retain turn end, read each Step's Assistant data, and publish Turn data; use complete Matches to choose the visual tail anchor |
| Deliverables / `deliverables` | Turn number | `turn/start` | Tool calls/results in that Turn | Aggregate successful mutation paths and publish Turn data without producing a view Node |
| Unknown fallback / `unknown-surface` | Event seq | Append-surface Event unclaimed by any ordinary Definition | None | Retain raw type/data for the JSON fallback |

### Chat Node and history/live behavior

| Business | `publication()` | Chat output | History and runtime behavior |
|---|---|---|---|
| Inbox | `none` | No Node | Recompute next-step ID state along the Reader chain when prepend supplies earlier splices; next-turn creates no Chat Context |
| Message | Immediate by default | `user`, `steering`, or `context` | Window-gap repair can reclassify the same message key |
| Request Prompt | Immediate by default | One non-empty `system-prompt` for the initial request, each explicit series, or a real system change | A step's first header anchors before its request messages; prepend can hide a conservatively rendered resume after its preceding header proves the system unchanged |
| Assistant | RAF for scalar chunks and packed runs, immediate for final, none for pure usage/finish | Same-key `assistant-step` with running/settled/interrupted status | Scalar and packed reducers are equivalent; Matches support fallback without `step/start`; Location close produces interruption presentation |
| Tool | Immediate by default | One recursive `tool-call` root containing all `subCalls` | A result-only history window supports fallback; running→settled retains its key |
| Command | Immediate by default | Ordinary `command` or integrated `manual-compaction` | Checkpoint arrival may change the anchor without changing the Context key |
| Compaction | Immediate by default | `compaction` marker | A checkpoint may render before start; an older start triggers forward replay |
| Retry | Immediate by default | One `model-retry` Node containing all attempts | Multiple retries update one key; Location close presents the last scheduled attempt as cancelled |
| Turn Error | Immediate by default | `turn-error` on terminal failure | Error end supports fallback without start; the turn's settled Retry chain renders beside it |
| Turn Tail | Immediate only for `turn/end`; otherwise none | Independent `turn-tail` footer | Compute closing/metrics from Step Assistant data and use same-turn Matches to choose the anchor |
| Deliverables | Immediate by default | No Node | Tool settlement incrementally updates Turn data; the Turn Tail extension slot reads produced files |
| Fallback | Immediate by default | `unknown` JSON row | Covers only append-surface Events; an ordinary business that claimed but has not rendered an Event does not duplicate it |

Inbox demonstrates that every Event can be a start-only instantaneous-state Context; not every business requires a start/update pair. Reader links each next-step state to the prior same-kind Context instead of inventing a lifecycle ID for the entire Inbox. The state itself shares immutable pending splice nodes and one current claimed-batch Set, while unconsumed next-turn input remains outside Conversation because no Chat or Trajectory classification reads it.

Request Prompt demonstrates shared pure interpretation without shared target State: Chat and Trajectory call `inspectRequestPrompt()` from their own Definitions. The function canonicalizes the full header and classifies model-visible system/tool differences; each target then chooses its own output. Chat materializes a non-empty initial system field, a real system change, and each `series` snapshot that explicitly begins a message series or follows a surface replacement. An unchanged `resume` remains in Trajectory and reconstruction state but does not repeat the visible Chat row once its predecessor is loaded. Ordinary append-only later Turns do not write another unchanged header. The first header in a Step follows the provider envelope rather than the header Event position: step one uses the owning Turn start and later steps use their Step start, placing the system field before the request's user-role messages; a later header in the same Step stays at its own Event after the surface rewrite that began the new series. When the preceding header is outside a partial window, a non-`initial` header stays at its own Event and renders conservatively. Prepending an identical predecessor hides an unchanged resume without withdrawing its stable Node key; a real change remains visible. Every header is a full snapshot, so a first loaded `resume`, `change`, or `series` header can render its system field without fabricating a comparison to unloaded history ([resume presentation decision](../bug-fix/2026-09-03-resume-headers-do-not-repeat-system-prompts.md)).

Retry, Assistant, and Turn Tail demonstrate independent claims on one Event. Each Definition updates only its own State and produces its own atomic Chat Node.

Assistant, Turn Tail, and Deliverables demonstrate layered Location data composition. Assistant writes `assistant-step` data for each Step; Turn Tail derives `turn-tail` data from those Step values; Deliverables independently maintains `deliverables` data for the same Turn. Consumers read only declaration-merged keys, do not scan another business's Nodes, and cannot obtain the provider's Context State.

Tool and Command demonstrate multi-Event aggregation: the producer supplies a shared ID, and the Context builds a tree or integrates Compaction internally instead of pushing pairing into the Chat Builder.

Compaction and historical Tool results demonstrate business fallback without a start. The engine does not impose "no start means no rendering"; each Definition decides whether current Matches are sufficient.

Retry demonstrates the State and Location split. Scheduled and started belong to Retry State, while Step and Turn closure belong to engine Location; `buildViewNode()` combines them into cancelled presentation.

Unknown fallback demonstrates Registry ownership: it handles only append-surface Events unclaimed by every ordinary matcher, and does not create a duplicate Node merely because a claimed Context temporarily returns `null`.

## View Builder and React identity

[`ConversationViewRegistry`](../../../../packages/client/ui-conversation/src/client/conversation/view-registry.ts) stores an independent builder factory for each target and shares no Session's ordering or caches.

A shell selection or a target source's first subscriber adds that target to the Session's monotonic active-target set. The Assembler indexes each Context under its sole target but creates no builder, Node, or snapshot for an inactive target. First activation flushes pending target-neutral work, creates the builder, and calls `replace({ nodes, timeline })` once from that target's current Contexts.

The shell synchronously resolves the persisted selection when a Session binding becomes available, when a cached binding becomes current, or when the View roster changes, then explicitly activates that registered View or the Chat fallback. Tab and focus actions activate their resolved target before updating selection state. A blank Session does not render the View slot, and `ConversationSnapshot.activeTargets` derives only from materialized active snapshots without querying inactive target Contexts for activity.

Ordinary prepend and append flushes call `apply({ upserts, timeline })` only for active targets. Complete window replacement and Registry rebuild call `replace()` only for active targets. Unsubscription does not remove a target, so returning to an opened View does not rebuild it.

[`ChatSnapshotBuilder`](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts) maintains `order`, a keyed `nodes` store with identity-stable Node and Turn-process sources, the turn/step `locations` index, `timeline`, and the `legacy` slice used by StatsLine and mirrored into top-level public compatibility fields.

Only a new key or a change to `anchorSeq`, visibility, or Location identity makes a Chat update structural. An ordinary content change does not rebuild `order`; the keyed Node store replaces that key's value and publishes only its source. The Turn-process projector recalculates cross-Node presentation only for a Turn whose structure, specification, or status changed, then publishes only that Turn's process sources.

For a structural change, the Builder computes visible order from current store values and reuses unchanged index arrays by reference. Prepend may add earlier history keys, append may add a key at the tail or its business anchor, and ordering never renames existing keys.

[`ChatView`](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) only traverses `order` and resolves the two stable sources for each key. Each [`ChatNodeSeat`](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) remains in the same parent list under its Context key, subscribes only to its Node and Turn-process sources, and dispatches the `'conversation.chat.node'` keyed slot by `node.kind`.

[`ChatNodeDataMap`](../../../../packages/client/ui-chat/src/client/contract/chat-nodes.ts) is a declaration-merged renderer payload registry. Each business module registers its own Definition and keyed renderer; `registerConversationNodes()` and `registerChatNodeRenderers()` only assemble those independent contributions and do not interpret business through a closed union or central switch. Built-ins live in `ui-chat`, and this type and registration boundary allows a business to move into an independent package without changing the Chat dispatcher.

The Chat entry in `conversation.view` registers `ChatNodeTurnDataInjected` once when it declares the `conversation.chat.node` child slot. `ChatNodeSeat` passes the Node's stable Turn data store as `hookContext`; the Slot renderer binds `useTurnData(businessKey)` directly to that store. Every keyed Chat renderer therefore reads strongly typed, read-only data from its own Node's Turn, and the Assistant renderer has no special injection authority.

Slot-level contextual Hooks and entry-owned `inject.hooks` remain independent paths. The latter continues to bind only registration-owned Observables. The former caches definitions by stable slot-inject-face identity and binds its factory and Hook per stable render occurrence. `useTurnData()` subscribes to `turn.data.source(key)`, so another Location-data key or Session snapshot publication does not notify it.

The standard `useSession` remains available to every session-scoped slot renderer, although `ChatNodeSeat` needs neither it nor aggregate `useChat`. `useTurnData()` narrows the common read path rather than acting as a permission sandbox. Whole-window statistics or arbitrary object indexes may still read the Session snapshot explicitly, but they are not modeled as current-Node Turn data.

Assistant streaming to final and Tool running to settled stay in one Seat while updating its data and necessary ordering properties. Settlement therefore does not reset component-local State through a parent move.

When business logic deliberately changes a materialized Node to hidden, it leaves visible order and remounts when visible again. This is explicit business withdrawal of presentation, distinct from the stable-Seat guarantee for running→settled.

The concrete Tool renderer remains governed by the [`ui-tool ownership decision`](2026-08-08-client-tool-presentation-ownership.md). Tool Definition supplies recursive root/subcall data, and `ui-tool` dispatches concrete presentation by the Tool-name keyed slot.

Trajectory registers its own target and business Definitions against the same Assembler and `SessionEventLikeEntry` window as Chat. Its target builder preserves the stage-oriented read model without consuming the Chat Builder's legacy slice or running an independent history fold. Chat and Trajectory keep independent scalar and packed Assistant reducers; target-specific Definitions do not change the shared Context, Reader, or Location contracts.

The target-specific Trajectory Definitions, retained stage model, Steering adaptation, complexity bounds, and presentation hot paths are owned by the [Trajectory Context assembly decision](2026-08-11-trajectory-conversation-context-assembly.md).

## Runtime and render path

```text
SessionEventLike window
  -> ConversationNodeAssembler
       -> Definition.match(event) -> (kind, id, start/update)
       -> Context matches + State + Location
       -> Definition.buildLocationData(step -> turn)
            -> StepLocation.data / TurnLocation.data
       -> Definition.buildViewNode() for each active target
  -> active target View Builder
       -> chat: ChatSnapshotBuilder -> ChatView -> keyed ChatNodeSeat
       -> trajectory: TrajectorySnapshotBuilder -> stages/layout/table
```

## Verification

Runtime tests pin Definition lifecycle registration, exact-ID append, update-before-start collection followed by forward replay after start, prepend identity, Reader window-gap repair, transitive dependencies, Location closure, Step→Turn data phase order, Location data replacement, publication cadence, illegal withdrawal, first-subscription activation, monotonic active targets, and per-target Builders.

Conversation tests cover every built-in Chat Definition, Assistant Step data, Turn Tail and Deliverables Turn data, Chat ordering and structural sharing, selector isolation, Assistant and Tool running-to-settled identity, nested Code Dispatch, steering, Compaction, Retry, interruption, load-older anchoring, and slot dispatch. Trajectory tests cover its independently registered Message, Assistant, Tool, Compaction, Request-header, and boundary Definitions together with the preserved stage-oriented view model.

Slot type/runtime tests pin required parent-provided common inject, the `hookContext` type, Hook isolation across Node contexts, stable factory/Hook identity, and the absence of business-renderer rerenders for unrelated Session publications. Existing entry-owned Observable Hook tests continue to pin the path that does not use a contextual factory.

Assembled Web snapshots, GUI tests, and browser scenarios cover the real plugin graph. Browser evidence compares Assistant streaming→settled, Bash running→settled, and PTC mode root + nested subcalls against master layout.

History-path tests cover complete replace, non-overlapping prepend, complete-range deduplication, partial-overlap rejection, empty-page `hasMore` convergence, and scalar live append. Scalar and packed representations of the same Assistant history produce equal Chat and Trajectory State, timing boundaries, and final Nodes; one packed run remains one Match through replace, prepend, Location replay, and registry rebuild.

## Alternatives considered

**Keep the centralized Session transcript fold and extract only helpers.** Rejected: business identity, history replay, and cache invalidation would still belong to one closed switch; moving functions would not establish independent ownership.

**Let React renderers scan Session Events.** Rejected: every view would duplicate matching and lifecycle State, React would become business authority, and paging and streaming would recompute unrelated component trees.

**Pass global Nodes or Location indexes to every business renderer.** Rejected: business components would scan and infer their current Turn/Step, and their subscription scope would grow with the window. A Definition publishes aggregates onto an engine-owned Location, and a renderer reads only its own Node's Location data.

**Call every Context of a Definition for each new Event.** Rejected: append cost would grow with history, and `update()` would combine matching with conversion. Context-free `match(event)` finds the ID first, after which only one Context updates.

**Let a Definition matcher read Contexts or scan history.** Rejected: matching would depend on ingestion direction, result-first history pages could not determine ownership independently, and live append would regress to searching open objects.

**Define a reverse State fold for backward history scanning.** Rejected: every business would maintain two inverse algorithms, and deletion, non-invertible aggregation, and cross-Context dependencies would be difficult to keep equivalent. Ordered Matches followed by forward replay from start preserve one business meaning.

**Add a separate live-stream matcher and update lifecycle.** Rejected: a second Definition path would duplicate dispatch, replay, publication, and Context types. Client-only `assistant/live-chunk` and durable settlements use the existing `match(event)` and `update(context, match)` lifecycle; only the event discriminator and stream expansion differ.

**Make Inbox a first-class engine concept or one window-wide Context.** Rejected: Inbox is ordinary business State and does not belong in the generic engine. Per-splice instantaneous State plus a strictly backward Reader supports prepend, append, and Message lookup together.

**Register specialized query methods for cross-business reads.** Rejected: consumers would still depend on provider APIs, and each new relationship would expand a central interface. Reader exposes a named kind's read-only predecessor Context; the provider writes useful State and the consumer interprets it.

**Let a Location-data consumer read the provider's Context State directly.** Rejected: the consumer would depend on another business's mutable internal shape and could not express which Turn/Step owns the value. Declaration-merged data maps expose only the provider-selected read-only value and engine-owned coordinates.

**Cache every Definition's Location data by State identity.** Rejected because a Definition may mutate and return the same State object, and its Location data may also depend on Match Locations or values published by another Definition. Each Definition instead decides whether its business value changed and returns the preceding publication unchanged when it did not.

**Add generic `end()`, prepared, or window-reset lifecycles.** Rejected: businesses have different completion conditions, and a pagination gap is not a business lifecycle. Business Events update State, Location close triggers replay/build, and Reader dependencies own pagination invalidation.

**Reuse one Event Definition across Chat and Trajectory by branching in `buildViewNode(target)`.** Rejected: the views require different business State and intermediate records, so a shared Definition would make each package carry the other's conditions and payloads. Separate target-owned Definitions keep those choices local while sharing the Assembler's ingestion and lifecycle contracts.

**Deactivate a target when its last subscriber leaves.** Rejected: returning to the View would repeatedly rebuild its complete snapshot. Subscription establishes first use; the target then stays incremental for the remaining Session lifetime.

**Add a generic layout model above final business Nodes.** Rejected: activity, tail candidacy, and layout enums would centralize current Chat business semantics in the engine again. Final Nodes carry renderer-required data directly and share only identity, ordering, and Location facts.

**Register the Turn-data Hook only on the Assistant renderer.** Rejected: current-Node Location access is a common capability of the `conversation.chat.node` slot, not one business renderer. The parent Chat entry registers common inject once, and every keyed renderer shares the same strongly typed contract.

**Keep running Assistant or Tool values in an independent tail container.** Rejected: settlement would move them across React parents, and a stable business key could not prevent remount. One keyed order permits data and position changes without changing Seat identity.

## Consequences

A new business node can register its matcher, State transitions, optional Location data, final target Node, and renderer locally without changing Session's business switch. `ChatNodeDataMap` and the Location data maps let a business package merge strongly typed data into the contract; every related Event must still expose a stable ID derivable from that Event alone.

Host business packages declaration-merge their durable Event members into `@deepseek-ai/dsh-session/types`, while Client Definitions type-only import the corresponding business package `/types` subpaths. Augmenting the declaring interface rather than a re-export barrel gives the independent Host and Client TypeScript programs the same Event narrowing without pulling Host runtime into the Client graph.

Initial tail, older prepend, and live append share one set of Context invariants. Missing starts, Reader window gaps, unknown Locations, and packed high-frequency deltas are explicit engine states and require no direction-specific business cache.

Append does not scan historical Contexts; prepend replays only Contexts whose Matches, Locations, or Reader answers actually changed. A structural Chat change may still recompute visible order and indexes, but does not rerun unrelated business folds or replace unchanged Node identity.

Separating State updates from publication cadence folds every live Assistant delta and each historical packed run while materializing at most once per three animation frames. The Assistant view reads the same projection that the preceding Step Location phase installed. Turn Process returns its existing open data and Node for continuing Assistant chunks without deriving or encoding them again, and Turn Tail defers its complete-Match scan until `turn/end`. Step or Turn close and final Events immediately publish the latest State.

An inactive target retains Definition State and a target Context index but no builder, materialized Nodes, or snapshot. The mounted built-in or third-party View activates its own target through normal subscription; previously opened targets continue receiving incremental updates.

Steps and Turns are stable homes for cross-business aggregates. Turn Tail and Deliverables derive their values without renderer scans of global Nodes; slot-level `useTurnData()` narrows common reads to the current Node's Turn, and keyed Location sources isolate unrelated updates.

Inbox Context retention grows with splice count and claimed message count rather than their cumulative prefixes. This removes duplicate state growth but does not deduplicate message content in durable Session events or bound the loaded event window.

The cost is new Runtime contracts for Registry, Assembler, Location data, dependency replay, and per-target Builders, plus parent-owned common inject and per-occurrence `hookContext` in UI Slots. Definitions that consume Assistant deltas also maintain equivalent scalar and packed update branches. Definition authors must understand stable IDs, unique scalar starts, forward replay, Step→Turn publication order, read-only Reader access, and the prohibition on Node withdrawal.

`useTurnData()` does not revoke the standard `useSession` capability from session-scoped renderers, so this boundary relies on API guidance and tests rather than capability isolation. Registry changes remain low-frequency full rebuilds; the Chat Builder still maintains a legacy slice for StatsLine and the top-level public fields, while Trajectory owns target-specific Definitions and a Builder over the shared Session window. Built-in Definitions remain in their respective UI packages, and these compatibility boundaries do not return business interpretation to Session.
