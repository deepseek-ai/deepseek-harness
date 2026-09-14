# Agent Note: Session refactor FAQ

Status: proposed

English | [中文](2026-09-10-session-refactor-faq.zh.md)

## Problem

`LogicalSession`, service, storage, projection, and query can look like a rename or unnecessary layers. Contributors need short answers that distinguish temporary naming, long-term responsibility, and current stack state.

## Proposal

### Why `LogicalSession`?

First, `Session` is already used by the existing concrete class. The new name avoids a collision between the abstraction and the compatibility implementation during migration. Repository code migrates to `LogicalSession`, while external developers may keep using deprecated `Session`. After compatibility removal, maintainers can debate renaming `LogicalSession` back to `Session`; that decision is not a prerequisite for the current stages.

Second, `Logical` names the separation between a session's identity, events, surface, and append and the physical work of storing, listing, or publishing it. The logical session is what a consumer reads and appends; storage/query can process a durable session record without a live logical session.

### Is concrete `Session` forbidden immediately?

No. New code is discouraged from depending on it during transition. Stage 1 deliberately preserves the public class, `Session.create`, and `Session.fromRestore` for existing external callers. Repository production code uses `LogicalSession`, and focused compatibility tests protect the deprecated entries until a later removal decision has external migration evidence and a release boundary.

### How do `SessionService` and `SessionStorage` differ?

`SessionService` is the logical session entry point and live identity authority. `SessionStorage` is the physical persistence protocol for readers/writers, formats, migration, leases, and I/O. Application features ask the service for logical sessions; they do not ask storage for business objects.

### Where does projection fit?

`SessionProjectionPort` observes canonical events and produces read models such as titles, summaries, statistics, list metadata, and search documents. Projection is rebuildable, does not own Session writes, and cannot become the durable source of truth. The service owns registration, flush, and lifecycle so live and cold paths share semantics.

### Why no `SessionSearch` or `SessionStats`?

`SessionQuery` already covers exact reads, filters, traces, full-text retrieval, list metadata, and statistics reads. Search indexes and statistics aggregations are projections/providers behind query, so two more public services are unnecessary.

### Must ordinary users migrate?

Stages 1–3 do not change the disk format or startup flow, so users do not migrate manually. The format catalog migrates supported old formats on first open. The system rebuilds derived data such as query indexes.

### What is complete?

Stage 1 establishes the public logical session interface. Stage 2 centralizes service ownership. Stage 3 builds on Stage 2 to separate storage readers and writers. Drafts for the first three stages exist, but Stages 4–5 and in-memory provider extraction are not complete.

### How can I contribute?

Follow the reading order in [developer transition rules](2026-09-10-session-developer-transition.md): overview, target protocols, current subsystem docs, then implementation stages. Choose one explicit consumer, migrate its type and entry point, add contract coverage, and avoid combining that work with lifecycle or durable-format changes.

## Alternatives considered

**Rename `LogicalSession` to `Session` now.** Rejected because the legacy concrete class remains in use during transition. A rename would create a semantic collision and enlarge the diff.

**Name the interface `SessionRuntime`.** Rejected because the package naming table in [Adding a package](../../../../docs/cookbook/adding-a-package.md) reserves `Runtime` for a component that runs live work and owns dispatch, cancellation, or operation lifecycle. The interface holds one session's identity and log and runs nothing, so that name read as an execution environment.

**Put the FAQ inside the protocol document.** Rejected because quick naming and status explanations would obscure protocol obligations. The FAQ only routes readers to normative owners.

## Acceptance criteria

- A new contributor can explain the different responsibilities of logical session, service, storage, projection, and query.
- The FAQ explains that naming is transitional and leaves a final rename to `Session` for after migration.
- Each answer links to or follows one normative owner instead of copying full protocols.

## Risks

The FAQ can become stale as the stack advances. Every stage that updates overview status must review this page. Current branch types, tests, and subsystem docs remain authoritative for implemented behavior.
