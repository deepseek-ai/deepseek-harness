# Agent Note: Session opening cache identity and read ordering

Status: implemented

English | [中文](2026-09-20-session-open-read-coordination.zh.md)

## Problem

Opening a historical Session can make `session.follow`, composer catalog prewarming, and RPCs with Agent parameters access the same cold log concurrently. `skills/list` requests a complete observation itself; `commands/list`, `goals/get`, `fileReferences/list`, and `sessionReferenceResolver/candidates` can initiate resume through the Agent lookup during parameter resolution. Auxiliary requests that do not wait for the history opening snapshot compete with the main conversation for reading, parsing, and projection computation instead of reusing completed results.

Reuse of completed observations has a separate problem: Cordis can return different proxy objects for accesses to the same service. Comparing the object references returned by `ctx.get('sessionPersistence')` can mistake one underlying service for different instances. Removing instance identity checks entirely is also unsafe because persistence revisions are comparable only within the corresponding service instance and Session identity.

Subagent navigation combines two needs: displaying a conversation at a known address, and discovering its parent or descendant catalogs. Refreshing parent projections before navigating through an existing parent-child address adds prerequisite work and can reject an address that the Host could validate and open when the Client catalog cache is absent.

## Decision

### Identify the cache producer with a service-owned Symbol

`SessionPersistence.identity` is a `Symbol('sessionPersistence')` created once per service instance. Proxy access preserves that value, while a replacement service instance receives a different value. The prepared observation cache looks up the Session id and compares both `persistence.identity` and `stat().revision`; the same instance and revision can reuse a completed preparation.

This identity exists only within the process and does not enter Session headers, events, or persisted files. Existing cache capacity, leases, live precedence, and revision invalidation remain unchanged. This fix does not merge Promises for unfinished cold reads; stable identity prevents false invalidation after completion, not duplicate concurrent work across all callers.

### Auxiliary RPCs wait for the current conversation's initial open to succeed

The Client uses the existing `sessions.using()` at the actual RPC call site, rather than only delaying prewarm hooks. Menu candidates, explicit reference queries, and later catalog refreshes therefore use the same waiting entry point. Each operation first checks that its target already has a Client binding, so background prewarming does not reopen a closed Session.

| Client consumer | RPC after waiting | Temporary reference source |
| --- | --- | --- |
| Skill catalog | `skills/list` | `skillCatalog` |
| Command catalog | `commands/list` | `commandCatalog` |
| Goal activation state | `goals/get` | `goalActivation` |
| `@` file and Session candidates | `fileReferences/list`, `sessionReferenceResolver/candidates` | Shared `referenceCandidates` |

`sessions.using()` waits for `reference.ready`, then for the operation's returned Promise, and finally releases its reference. `ready` means that the initial `Session.open()` attempt has settled, not that it succeeded; these consumers also require `openState === 'open'` and send no auxiliary RPC after a failed open. The Goal reader additionally checks that its captured binding has not been replaced and logs rejected reads without clearing existing display state.

Skills retain the shared catalog request's own cancellation signal; `@` queries use the current candidate request's signal for the history wait and both RPCs. Unquoted `@` queries still fetch files and Sessions concurrently after waiting, while quoted paths still query files only. Commands and Goals gain no new cancellation protocol. These references retain Client data and follow streams, grant no new Host Agent authority, and do not prohibit normal Agent resume after the opening snapshot.

### Conversations use follow; catalog branches retain explicit reads

The main conversation's opening `follow` snapshot already carries that Session's complete projection baseline. Later changes to shared projection values notify subscribers, so switching Sessions or opening a menu does not require another read of the same baseline.

- Main-view navigation does not separately refresh the selected Session's projections; restoring a saved subagent address does not prewarm its parent.
- The Sidebar retains the target child directly from its complete parent-child address, without making a parent-catalog read a prerequisite for opening the conversation.
- The header dropdown's `changeOpen` only changes presentation state and does not refresh `rootSessionId`. Child expansion and failed-read retries retain explicit refreshes under the UI callback name `refreshProjection`; the underlying `sessions.refreshProjections` API is not renamed.
- Team navigation uses the existing Lead and roster member ids to open `{ parentSessionId, childSessionId, mode: 'continuable' }` directly. It neither refreshes the parent catalog nor requires the target to be present in the Client catalog; member-role and main-view ownership checks, plus the UI restrictions on provisioning and failed members, remain unchanged.

A known address does not waive authorization checks. When opening child history, the Host still checks the target's own header parent and origin, plus the mode and descriptor ownership in its own `subagent` projection. Later continuation remains subject to the existing direct-parent authorization rules.

## Implementation scope

- Session formats, migrations, the Host observation's `all | none` policy, and the response fields of `session.projections` are unchanged.
- There is no global cold-read singleflight, and Agent lookups are not universally replaced with read-only lookups.
- `SessionManager.handleConnected()` still refreshes previously requested catalogs in bulk; this decision does not guarantee one cold read on reconnect.
- Tool-side `listDescendants` observes each reachable child catalog. An observation can reuse live state or a valid prepared Session; otherwise it reads the cold log. Expanding a child node in the Client can also cold-read that node. Ordinary main-session opening is not equivalent to every descendant-enumeration scenario.
- `@` Session candidates still enumerate headers and obtain names from live projections or projection caches, falling back to ids on misses. Existing ranking, the default limit of 50, and direct-subagent grouping remain unchanged; discovery does not recursively traverse `subagentCatalog`.

## Alternatives considered

**Remove persistence-instance comparison.** Rejected. A matching Session id and revision cannot establish that two persistence services provide the same data; replacing a service must still invalidate old preparations.

**Unwrap Cordis proxies in callers or cache service objects per Context.** Rejected. The cache needs the producer's identity, not the identity of an object returned by a particular service access. A per-instance Symbol expresses that requirement without propagating proxy implementation details.

**Add shared singleflight for every cold read.** Outside this implementation. It could merge more concurrent calls, but would require separate rules for independent waiter cancellation, leases, and task ownership during service replacement. It also would not replace the ordering requirement that auxiliary RPCs must not resume an Agent ahead of the opening snapshot.

**Delay only warm hooks, or merely await the extra projection request.** Rejected. Explicit menu queries could still bypass warm hooks, and serializing a redundant projection request does not remove its work. The wait belongs at the actual auxiliary RPC entry point; reads already supplied by follow are removed.

**Keep Team's parent-catalog presence check.** Rejected. The Team roster already provides member identity, and the existing Host history entry point can validate an explicit address. Requiring a Client catalog cache hit for navigation mistakes data that has not loaded for a child that does not exist.

## Consequences

An ordinary main Session completes its own history and projection read before auxiliary operations reuse the completed observation or attached state. The Client's direct-child list consumes the main Session's catalog without reading each child's log merely to display its row. Catalog and conversation opening are separate operations, so navigating to a known child no longer adds parent-projection prewarming.

Auxiliary catalogs become available after the conversation's opening snapshot, and operations retain temporary Client references until they finish. This wait covers only the current Client generation's initial open, not readiness after every underlying follow replacement. Reconnect and exceptional retry scenarios still require their own verification.

A missing header root catalog remains a specific coverage gap: if it belongs to an unopened parent and no other source supplies the catalog, opening the dropdown alone does not fetch it, and the current UI may continue to display a loading notice. This implementation adds neither a new parent-catalog loading entry point nor a shared unknown-state interaction protocol.

## Verification and known gaps

During local navigation to a long historical main Session, the user observed repeated `readColdSessionLog` calls converge to one using temporary timers and call stacks, and verified direct teammate navigation. This result describes that operation's cold-read helper invocation count, not every underlying file I/O, every reconnect scenario, or a single unit of end-to-end cost. Private Session content and identities from diagnosis are not test fixtures.

Focused TypeScript builds and bundles were run for affected packages during development; the complete change has no gate, behavior-test, or assembled Web snapshot verification result. Existing tests have only partial callback renames and still contain old fixture names, root-menu-opening refresh expectations, Sidebar parent-refresh prerequisites, and Team rejection of missing catalogs. These are known verification gaps, not passing checks.

## Relationship to existing records

- [Session observations and projection-owned Client state](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.md) retains ownership of read cuts and shared values. This record adds cache-producer identity and opening-snapshot consumption order; the older claim of sharing unfinished cold loads does not match the current reader and is not evidence that this change implements singleflight.
- [Client Session references, reference sources, and UI state](../architecture/2026-09-15-client-session-references.md) retains ownership of `retain`, `ready`, `using`, and explicit-address semantics. This record limits temporary references to four classes of auxiliary reads as independent asynchronous operations, rather than adding references to every UI action.
- [Web subagent catalogs consume shared projections](../simplification/2026-09-08-web-subagent-catalog-projections.md) retains ownership of the generic projection store, explicit catalog reads, and control updates. This implementation applies its rule that opening a conversation uses the follow baseline, without replacing the catalog mechanism.
- [Web subagent catalogs and human continuation](../feature/2026-07-27-web-subagent-conversations.md) retains ownership of presentation and continuation authorization. This record changes only prerequisite navigation reads and root-menu refresh timing, not the child's own Host validation; the older description of interactive loading for missing root catalogs must be reconciled with the coverage gap recorded here.
