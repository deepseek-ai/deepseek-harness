# Agent Note: Logical session and storage rebuild

Status: proposed

English | [中文](2026-09-06-logical-session-storage-rebuild.zh.md)

## Problem

Session consumers depend on a concrete event-log class, the live-session registry, the projection registry, and persistence handles. These dependencies mix logical session behavior with publication, storage, and physical-format concerns. A new session or storage implementation would therefore require changes across consumers, the Agent loop, persistence, query, telemetry, and frontend code.

The refactor needs one stable access path before it can replace implementations safely. The first stage must separate consumers from the concrete `Session` class without changing object identity, event values, publication order, persistence bytes, or model output.

## Proposal

Use two application protocols and one private provider protocol. `LogicalSession` represents one logical session: an identified event session that is independent of how its events are stored or published. `SessionService` creates, opens, publishes, finds, forks, and flushes logical sessions, and it owns projection-port registration. `SessionStorage` is the physical provider interface behind the service; it owns durable session data, revisions, format migration, crash repair, batching, and the cross-process writer lease.

Build the change as stacked stages. Each stage either preserves observable behavior or names one explicit behavior change. A compatibility name remains only while a later stage still has a real consumer and a stated removal condition.

[Developer transition](2026-09-10-session-developer-transition.md) provides operation pseudocode and a contribution path. [Capability protocols](2026-09-10-session-capability-protocols.md) explains storage, projection, and query with an overall diagram. [Historical data compatibility](2026-09-10-session-data-compatibility.md) covers user migration. The [FAQ](2026-09-10-session-refactor-faq.md) explains naming and progress.

## Stage 1: one public logical session interface

Stage 1 is the entry point for the refactor. After its four implementation substages, every production consumer holds a `LogicalSession`. The concrete `Session` class and its static constructors remain as deprecated source-compatibility entries for external developers, while the existing in-memory implementation remains the session object consumers hold. The stage changes internal dependency direction without changing runtime behavior.

### Public model

`LogicalSession` exposes the logical-session operations that production consumers already use. It owns session identity, immutable creation metadata, fork lineage, event positions, validated append, immutable event reads, the ordered surface, and the derived request and message views.

```text
abstract class LogicalSession {
  abstract readonly header: SessionHeader
  abstract readonly inheritedEventCount: SessionLogOffset
  abstract readonly firstLiveSeq: SessionLogOffset
  abstract get seq(): SessionLogOffset
  abstract get surface(): SessionSurface
  get id(): SessionId

  abstract append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
  ): SessionEvent<T>

  abstract eventAt(seq: SessionSeq): SessionEvent | undefined
  abstract snapshotEvents(from?: SessionLogOffset, toExclusive?: SessionLogOffset): readonly SessionEvent[]
  ownEvents(): readonly SessionEvent[]
  isOwnSeq(seq: SessionSeq): boolean
  abstract requestHeader(): EpochHeader | undefined
  abstract requestContext(): RequestContext | undefined
  abstract deriveMessages(): Message[]
  deriveEventMessage(event: SessionEvent): Message | null
}
```

The abstract members allow another implementation to choose a different log representation. The concrete members depend only on those abstract members, so implementations share identity, ownership, and derived-view semantics.

Live sessions still come from `ctx.sessions`. Code that validates, queries, or inspects a log without publishing it uses `createLogicalSession` or `restoreLogicalSession`. These functions return detached sessions and do not register them or emit live-session events.

### Stage 1 substages

The plan is the review entry. The implementation substages divide interface definition, construction, consumer migration, and compatibility verification so each review has one claim.

| Stage | Result |
| --- | --- |
| 1.1 | Defines the ownership model, invariants, full Stage 1 design, and later-stage direction. |
| 1.2 | Adds `LogicalSession` and a switchable static gate that records concrete-class bindings and reports new ones as warnings until it is switched to reject them. |
| 1.3 | Adds detached construction functions and migrates production static-constructor callers. |
| 1.4 | Changes stores, events, agents, projections, and all production consumers to `LogicalSession`. |
| 1.5 | Migrates tests, retains the deprecated `Session` compatibility entries, and closes Stage 1. |

### Stage progress

| Stage | Status |
| --- | --- |
| 1 | Draft work complete. |
| 2 | Draft work complete. |
| 3 | Based on Stage 2; implementation and remote CI complete; remains draft. |
| 4–5 | Not complete. |
| In-memory provider extraction | Follow-up wraps the current implementation as a replaceable provider. |

### Invariants

Stage 1 preserves the following behavior. Later stages must preserve the same facts unless their proposal names and tests a change.

- `append` remains synchronous. It validates before mutation, assigns contiguous sequence numbers, freezes accepted events, and contains observer failures after commit.
- `session/created` remains a synchronous publication veto. `session/event`, `session/disposed`, and `session/flush` keep their existing ordering and participation semantics.
- The store returns the same session object that it registered and supplied to listeners. No wrapper may replace that identity.
- Session headers, fork lineage, `firstLiveSeq`, derived request state, message history, and serialized event values remain unchanged for the same input log.
- Detached construction never enters the live registry or publishes live events.
- JSONL bytes, format versions, migrations, crash repair, batching, and writer-lease behavior remain unchanged.

### Enforcement and completion

`verify-logical-session-access` reports production bindings of the concrete `Session` class outside its owning package. Its enforcement is switchable: the checked-in default is `warn`, under which the gate prints every finding as a warning, writes one GitHub Actions `::warning` annotation per finding, and exits 0, so branches that still bind the class merge while their consumers migrate; `DSH_LOGICAL_SESSION_ACCESS=enforce` fails the gate on any finding for one run, and changing the checked-in default to `enforce`, once no in-flight branch binds the class, makes the gate reject every remaining binding. The package keeps the public class and static constructors only for external source compatibility. Repository production code has no allowlist and uses `LogicalSession`; compatibility tests keep the old imports and constructors working until a separate removal decision names ecosystem evidence and a release boundary.

Stage 1 is complete when production code uses only the public logical session interface and detached construction functions, the deprecated `Session` entries have focused compatibility tests but no production consumer, the access gate has no migration allowlist, generated API documentation is current, and the snapshot and SDK outputs remain unchanged.

## Destination architecture

Stage 1 establishes the logical access interface. Later stages move construction and publication into `SessionService`, split persistence into reader and writer roles under `SessionStorage`, attach storage and projections behind the logical session, and delete the bridge names.

```text
consumers ──► LogicalSession
                  │
                  ├── logical events and projections
                  ├── fork, flush, and close
                  └── attached storage reader or writer

composition ──► SessionService ──► LogicalSession implementation
                       │
                       └──────────► SessionStorage implementation
```

The dependency direction is deliberate. Application components depend on `LogicalSession` and `SessionService`, not on `SessionStorage`, the bundled in-memory implementation, JSONL, projection registries, migrations, search indexes, or frontend state. `SessionService` selects and coordinates the physical provider; each physical implementation depends inward on the private protocol it implements.

### Ownership rules

| Question | Owner |
| --- | --- |
| Does the operation read or mutate one logical session, its log, header, projections, or lifecycle? | `LogicalSession` |
| Does it construct, publish, enumerate, fork, flush, or dispose live sessions? | `SessionService` |
| Does it own bytes, revisions, physical layout, migration, repair, batching, or a writer lease? | A `SessionStorage` provider used only behind `SessionService`. |
| Does it read exact events, filter across sessions, retrieve full text, trace, or read statistics? | `SessionQuery`, backed by rebuildable projection/providers. |

### Later stages

| Stage | Result | Required compatibility boundary |
| --- | --- | --- |
| 2 | `SessionService` owns session construction, publication, lookup, fork coordination, flush, and storage attachment. | Existing event order, seed persistence, and close timing remain unchanged. |
| 3 | `SessionStorageReader` and `SessionStorageWriter` replace the union-shaped persistence handle; JSONL implements the protocol. | Stored bytes, revisions, migration preparation, batching, and leases remain unchanged. |
| 4 | The logical session owns live writer enqueue and projection reads; the backend stops subscribing to live session events. | Writer and listener failures are awaited together with documented precedence. |
| 5 | Internal bridge aliases and derived-view shortcuts are removed; the Agent loop adopts an unpublished forked session exactly once. | Fork identity, publication interleave, cleanup, snapshots, and SDK output remain verified. |

Persistence policy, migration orchestration, telemetry, session loading, and frontend presentation remain consumers. Exact reads, search, and statistics share `SessionQuery`; `SessionProjectionPort` produces titles, summaries, statistics, and search documents.

## Compatibility and non-goals

The stack does not change the released Session JSONL format, wire values, TypeScript or Python SDK output, or model-visible history. It does not add a second storage backend or a second logical session implementation. It creates the dependency direction needed to add either later without changing consumers.

The proposal preserves the shipped [handle-based persistence decision](../../implemented/architecture/2026-08-27-handle-based-session-persistence.md), [JSONL-only persistence decision](../../implemented/simplification/2026-08-30-jsonl-only-session-persistence.md), [writer-lease decision](../../implemented/feature/2026-08-31-cross-process-session-write-lease.md), and [read-only migration preparation](../../implemented/architecture/2026-09-05-read-only-session-migration-preparation.md). The new protocols relocate those responsibilities; they do not weaken them.

## References

- [Sessions subsystem](../../../../docs/subsystems/session.md) defines the shipped session API and event semantics.
- [Session persistence subsystem](../../../../docs/subsystems/persistence.md) defines the shipped durable format and lifecycle.
- [`@deepseek-ai/dsh-session`](../../../../packages/core/session/README.md) owns the session package contract.
- [`@deepseek-ai/dsh-session-persistence`](../../../../packages/session/session-persistence/README.md) owns the current persistence service contract.

## Alternatives considered

**Replace the implementation in the interface stage.** Rejected because a type migration and a lifecycle migration require different evidence. Stage 1 keeps the exact session object and behavior while it changes the dependency direction.

**Expose a broad service or storage facade immediately.** Rejected because the baseline has not yet assigned every lifecycle and persistence responsibility to one owner. Later stages add only members with a production consumer and characterization evidence.

**Remove `Session` immediately after migrating owned callers.** Rejected because it would break external developers without improving the repository's dependency direction. Stage 1 retains deprecated compatibility entries while the access check prevents owned production code from using them; removal requires a later explicit compatibility decision.

**Recover inherited metadata from inventory instead of the opened session.** Rejected because inventory cannot supply the exact inherited-event cut required to restore a session.

## Acceptance criteria

- Stage 1 makes `LogicalSession` the recommended session type, preserves deprecated `Session` source compatibility and session object identity, and leaves observable behavior and serialized output unchanged.
- Each later stage has one ownership result, named compatibility limits, focused characterization tests, and an independently revertible commit boundary.
- All production application components use only `LogicalSession` and `SessionService`; only the service implementation and physical provider packages use `SessionStorage` and its reader or writer roles.
- The bundled in-memory session implementation and JSONL storage can become replaceable implementations without changes to search, statistics, persistence policy, migration orchestration, session loading, or frontend consumers.
- Each stage updates its owning Agent Note, subsystem reference, package documentation, generated catalogs, and required bilingual pair in the same PR.

## Risks

A thin abstraction can preserve type safety while hiding lifecycle gaps. In particular, alternate logical session implementations cannot participate until `SessionService` owns publication and attachment, and a synchronous disposer must not start an unowned asynchronous close.

Storage separation can lose guarantees if an implementation treats a reader as a stale snapshot, drops inherited metadata, changes batching, or releases a writer lease before durability completes. Contract tests must cover freshness, close durability, migration preparation, and cross-process ownership.

Fork adoption can create duplicate registry entries or reorder `session` and `agent` publication. The later fork stage must transfer one unpublished session to the Agent loop, preserve object identity, and close it if setup fails.
