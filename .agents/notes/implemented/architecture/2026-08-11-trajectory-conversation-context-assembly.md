# Agent Note: Trajectory assembly from registered Conversation Contexts

Status: implemented

English | [中文](2026-08-11-trajectory-conversation-context-assembly.zh.md)

## Problem

Trajectory maintained an independent Session History source and folded the complete loaded Event window into Assistant, Tool, message, Request-header, and Compaction state. Chat already assembled the same Event families through registered Conversation Definitions. The two paths duplicated business correlation and pagination behavior, and a Trajectory structural update copied or rescanned work proportional to the raw Event count even when one business object changed.

Reusing Chat's final Nodes would not solve the ownership problem. Trajectory needs request lifecycles, running Assistant state, prompt inheritance, Tool schemas, timing records, and a stage-oriented read model that Chat does not consume. Sharing final Node payloads would couple both views to the union of their requirements.

The migration also had to preserve durable steering classification. A `user/message` does not say whether it opened a Turn or was claimed from the `next-step` inbox, and an older page can supply the missing inbox predecessor or Location after the message has already materialized.

## Decision

Trajectory registers target-owned Conversation Definitions and a `trajectory` View Builder against the shared [`ConversationNodeAssembler`](2026-08-09-client-conversation-node-assembly.md). Session owns one contiguous Event window and publishes both Chat and Trajectory snapshots through `Session.views`; it does not run a second Trajectory history source or business fold.

Each Definition belongs to one target. Chat and Trajectory may recognize the same durable Event family, but they keep separate State and final Node payloads. They share only the Assembler's exact-ID matching, ordered Matches, Location facts, Reader dependencies, publication scheduling, and replace/prepend/append lifecycle.

Trajectory's target source activates its View Builder on first subscription. Before that subscription, its Definitions maintain current State while the Assembler skips `buildViewNode()` and snapshot assembly. The target remains active after unsubscription, so later visits reuse the incrementally maintained snapshot.

The existing [Trajectory inspection ledger](../feature/2026-07-27-trajectory-inspection-ledger.md) remains the view model. The Trajectory Builder converts materialized target Nodes into its established `eventNodes`, Requests, Tool schemas, running calls, and Location map; layout, table virtualization, selection, Overview, and inspector behavior do not become generic Conversation contracts.

### Business Definitions

| Business | Context identity | State assembly | Trajectory contribution |
|---|---|---|---|
| `next-step` inbox | splice Event seq | Apply the splice to the nearest preceding inbox Context | State only; no visible Node |
| User, steering, or injected message | message Event seq | Read the preceding inbox State and classify the durable message | Input or context Node |
| Assistant and ordinary Request | `turn:step` | Fold `step/start`, chunks, final message, retry, and `step/end` | Final Assistant, partial Assistant, and Request |
| Root Tool call | root call ID | Fold root call/result and nested Code Dispatch events into one call tree | Final or running Tool tree |
| Compaction | compaction ID | Fold start, summary, end, and replacement checkpoint | Compaction Request |
| Request header | header Event seq | Read the preceding header and retain effective prompt plus the actual change | Prompt and Tool-schema source |
| Session and Turn boundaries | boundary Event seq | Retain closure time and error facts | Interrupted Compaction or failed ordinary Request |

Every correlating Event must expose the same business ID directly. Code Dispatch uses `rootCallId`, Compaction uses its compaction ID, and ordinary Tool and retry events retain their protocol identities even when a specific Definition correlates by `turn:step`. Legacy records that lack the required correlation ID are ignored by that Definition rather than merged into an `undefined` Context or crashing the Session.

Assistant chunks update only their `turn:step` Context. Content-bearing chunks request animation-frame publication; usage and finish chunks update State without forcing their own frame. A final message, retry, or boundary publishes immediately. Completed Assistant State retains assembled blocks, timing, usage, and retry facts rather than copying the raw chunk ledger into the target snapshot.

### Steering from predecessor Contexts

Trajectory reconstructs steering from durable inbox history, using the same identity rule as the [Chat steering decision](../feature/2026-08-04-web-context-source-and-steer-marks.md) without sharing Chat's final Node.

Each `agent/inbox/spliced` Event targeting `next-step` starts an invisible Context identified by its Event seq. Its `start()` reads the nearest earlier inbox Context, appends the splice to persistent pending-ID state, and materializes that state only when a claim replaces the current claimed batch. The AgentLoop appends every admitted message from one claim before it can claim another batch; a rejected claim appends no `user/message`. A later user-origin `user/message` reads the nearest earlier inbox Context: an ID in the current claim produces a Steering Node, while every other user-origin message produces an ordinary User Node.

A Reader miss while older history remains records a window-gap dependency. When prepend supplies the missing predecessor, the Assembler replays the affected inbox chain and message Contexts in forward Event order. Historical page direction therefore cannot permanently misclassify a message.

The message Event's Location places steering in the owning Step. If the loaded history window lacks enough boundary Events to resolve that Location, layout uses the following Assistant step as the positional fallback. A running Request marker follows leading steering input in the same Step, so the marker denotes the model Request caused by that input rather than appearing before it.

### Window paths and complexity

Let `E` be the loaded raw Event count, `P` one newly prepended page, `D` the number of Trajectory Definitions, `C` the number of materialized Trajectory Context contributions, and `Mᵣ` the total Matches held by Contexts invalidated by a prepend. `D` is a small registered set; streaming chunks aggregate into one Assistant Context, so `C` is normally much smaller than `E`.

| Path | Context work | Target snapshot work | Result |
|---|---|---|---|
| Initial tail or reconnect replace | Match the loaded window in `O(E × D)` and build State in forward Event order | Inactive: none; active: build and order `C` contributions | A full Context replace remains proportional to the loaded window |
| Older-page prepend | Match only fresh Events and replay only Contexts whose Match, Location, or Reader answer changed, in `O(P × D + Mᵣ)` | Inactive: none; active: rebuild the stage snapshot from `C` contributions | Business folding does not restart over all `E` Events |
| Live append | Match in `O(D)`, locate the keyed Context in `O(1)`, and update only that State | Inactive: none; active: replace a same-anchor contribution in `O(1)` before snapshot assembly | Business correlation is independent of loaded Event history |

First activation builds the current `C` target Contexts without rematching Events and calls `replace()` once. Once active, the Builder stores contributions by Context key and keeps a key-to-position index. A content update with the same anchor replaces one contribution in place; a new contribution or anchor change rebuilds and sorts contribution order. Snapshot assembly then walks `C` contributions, indexes Request headers and Tool schemas with Maps, and handles Compaction boundaries and Turn errors with linear cursors or indexes.

Final Event and Request ordering keeps a publication's current upper bound at `O(C log C)`. The migration removes repeated reverse lookups and the old raw-history refold, but it does not claim end-to-end `O(1)` publication. Chat retains its existing keyed snapshot behavior and complexity; adding the Trajectory target does not make Chat scan Trajectory Contexts or Nodes.

### Independent presentation hot paths

The Context migration and the following presentation optimizations solve different costs. These reductions preserve the existing view model and are theoretical from call counts and asymptotic behavior; this decision does not claim benchmark measurements.

| Hot path | Retained behavior | Expected reduction |
|---|---|---|
| Markdown summaries | Layout retains source Markdown; each stable Table record memoizes its displayed summary by content, while Detail parses only the selected record | A one-record append reparses the changed visible record instead of every Markdown record |
| Search text | `TrajectorySearchIndex` linearly checks stable Record IDs and source signatures, but normalizes Markdown only for changed records and commits updates in three-second batches | Signature comparison remains `O(C)`; expensive normalization follows the changed-record count, and continuous frame updates collapse into one batch per interval |
| Timeline tooltip | Timing text is computed after the delayed tooltip opens | A render with no open tooltip performs no per-span label formatting |
| Following Assistant lookup | One reverse pass records the next Assistant for every input position | The former repeated forward lookup falls from worst-case `O(C²)` to `O(C)` |
| Group duration | Fixed decimal grouping replaces `toLocaleString('en-US')` for the invariant English numeric shape | Complexity remains linear in Groups, but the Intl formatter leaves the repeated render path |

Display memoization and search indexing stay separate. Search must include off-screen records and may lag live changes by the throttle interval; Table rendering must update the visible changed record immediately and must not inherit the index's commit cadence.

## Alternatives considered

**Keep the independent Session History fold and optimize it locally.** Rejected: caches could reduce selected hot paths, but Trajectory would still own a second Event window, pagination repair, request inspection fold, and business-correlation implementation beside Chat.

**Reuse Chat Definitions and branch on a `target` argument in `buildViewNode()`.** Rejected: Trajectory needs different State and intermediate records, not only another React renderer. One Definition would carry both views' payloads and conditionals and would invalidate unrelated target data when either view changed.

**Create a Trajectory-specific Assembler.** Rejected: exact-ID routing, update-before-start collection, prepend replay, Location repair, Reader dependencies, and publication cadence are not Trajectory-specific. A second engine would recreate the lifecycle duplication this change removes.

**Add generic Surface, rewind, fanout, or settled lifecycle concepts.** Rejected: the current durable Event stream does not require a generic Surface branch, and Session or Turn boundaries are target business inputs rather than a reason to fan out one Event over every historical Context. Completion remains business State interpreted with Location closure.

**Replace the Trajectory stages with generic Conversation Nodes.** Rejected: stages organize requests, timing, schemas, and table layout for one view. Making them engine contracts would constrain a future plain Session-log view and return view-specific composition to Client Runtime.

**Share one Markdown cache between display and search.** Rejected: display is immediate and viewport-bound, while search covers the complete loaded record set and intentionally batches updates. A shared cache would couple correctness and scheduling across unrelated consumers.

## Verification

Runtime tests pin target registration, first-subscription activation, exact-ID append, update-before-start replay, prepend identity, Reader window-gap repair, Location replay, and isolation between Chat and Trajectory snapshots.

Trajectory Definition and Builder tests pin Assistant streaming and interruption, nested Tool calls and parallel interruption, Compaction and prompt inheritance, Steering classification and Step placement, Request marker order, stable contribution replacement, and prepend expansion. Table, layout, Timeline, and search tests pin deferred Markdown work, throttled index updates, tooltip-time formatting, and stable search results across append and prepend.

## Consequences

Trajectory business assembly now scales with the changed page or keyed Context instead of restarting from the complete raw Event window. Target-owned Definitions can evolve independently from Chat while retaining one Session window and one set of lifecycle rules. Steering becomes a first-class Trajectory record at its actual Step position without adding steering-specific state to Session.

After first activation, the retained stage-oriented Builder still performs work proportional to materialized Trajectory contributions and may sort on publication. Before activation, the target retains Context State and one target index but no Builder, materialized Node, or snapshot. The search index still performs a light linear signature pass when its input layout changes.

Definition authors must provide stable protocol identities. Old Events without a required ID can disappear from the affected Trajectory business view, which is preferable to joining unrelated records or failing history load; producers that require faithful display must log the identity.

The [Conversation assembly decision](2026-08-09-client-conversation-node-assembly.md) remains the authority for the generic Context, Reader, Location, and publication contracts. The [Trajectory ledger decision](../feature/2026-07-27-trajectory-inspection-ledger.md) remains the authority for table hierarchy, virtualization, inspector, and interaction behavior. This Note owns how Trajectory adapts those two decisions and why the adaptation does not share final Nodes with Chat.
