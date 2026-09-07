# Agent Note: TypeScript Program-backed semantic gates

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-14-typescript-program-backed-semantic-gates.zh.md)

## Problem

Repository gates sometimes need facts that TypeScript syntax does not carry by itself: whether a receiver is a Cordis `Context`, which concrete event names reach a forwarding helper, and whether declaration merging changed an event signature.

The existing gates use TypeScript's single-file syntax model and maintain these facts through naming conventions, handwritten tables, and JSDoc.

The repository needs one semantic source of truth without introducing runtime package cycles, broad fallback heuristics, or machine-readable annotations that restate information already available to TypeScript.

## Decision

Repository gates can combine project-wide type information through `ts.Program` and use `TypeChecker` to extract **strongly typed** facts, reducing their reliance on naming conventions, handwritten tables, and JSDoc metadata.

The repository applies this model to two gates.

### One project model expands the root solution

[`TypeScriptProject`](../../../../scripts/ts-project.ts) parses the root `tsconfig.json`, recursively expands every project reference, and combines the referenced source roots into one no-emit semantic program. A normal program created from the solution config can redirect referenced projects to built declarations; explicit expansion keeps the package `src` files available for AST traversal and symbol identity.

The wrapper owns config diagnostics, semantic compiler options, repository-relative paths, source lookup, and the shared checker. Individual gates do not glob package sources or construct partial programs independently.

### A. Event relations follow receiver and value types

[`gen-doc-graphs`](../../../../scripts/gen-doc-graphs.ts) classifies calls by assignability to the repository's actual `Context`, `AgentEventDispatch`, and Cordis `EventsService` types. Variable names and property spellings do not determine whether a call is an event operation.

Context and agent-dispatch calls contribute only finite string-literal event sets. Direct `EventsService.dispatch()` calls recover the event slot through array literals, constant aliases, conditional branches, and resolved call sites of non-exported local helpers. Generic forwarding parameters are not concrete producers: attribution stays with the call sites that supply a closed event value.

Semantic queries run only where a branch can consume them: calls are prefiltered by the closed event-API method-name set before receiver classification, and helper call sites are indexed on demand instead of eagerly resolving every call in every package source. The demand-driven index proves locality per helper — a helper that is non-exported, sits in a real ES module, and whose every same-file reference is a direct callee has all of its calls in that file by module scoping, so only that file is indexed. Any unproven premise (an export modifier, a global script file, an aliasing or otherwise unclassifiable reference) falls back to the original full package-source index, which is the unchanged original semantics; the proof affects cost, never results. A lazy single global index was rejected because the helper-parameter path is reached on the current tree, so it would still pay nearly the whole `getResolvedSignature` sweep.

Every declared harness event must have a discovered producer. A missing producer fails generation as dead vocabulary or an unsupported semantic dispatch shape; listener-free extension points remain valid. `internal/dispatch` instrumentation is not treated as a subscription to every event it observes, so the matrix contains direct product listeners rather than manually asserted indirect relationships.

### B. Scoped-event routing generates one typed resolver map

[`gen-scoped-events`](../../../../scripts/gen-scoped-events.ts) scans real `scopeTarget(base, key)` calls to establish the routing-key type for each scoped base. It then finds Cordis `Events` members with `this: Scoped<Base>` and searches every payload parameter plus one public property level for a type identical to that key after removing `null` and `undefined`.

Exactly one match generates a resolver. Multiple matches are ambiguous and fail. Zero matches require `@dshScopeScan unsupported`, which is reserved for events whose routing key intentionally stays outside the payload, such as owner-keyed session events and parent-keyed subagent lifecycle events. The annotation records an unsupported scan; it does not encode an event name, parameter index, property path, or replacement type.

The committed [`scoped-events.generated.ts`](../../../../packages/core/scope/src/scoped-events.generated.ts) is a runtime-only map in the package that owns scoped dispatch and imports no event-owner package. Semantic completeness lives in the generator: its root Program enumerates every scoped `Events` declaration and real `scopeTarget` contract, resolves the unique payload path with the checker, and refuses missing, stale, or ambiguous entries before rendering the `unknown[]` runtime boundary.

The `dsh-scope/invariant` companion consumes this map instead of maintaining a handwritten table. Because Program analysis happens in the repository gate rather than through generated type imports, neither `dsh-scope` nor `dsh-invariants` acquires dependencies on every event owner.

### Semantic gaps fail explicitly

The generators reject missing declarations, config diagnostics, widened or generic event names, inconsistent routing-key types, ambiguous payload matches, unnecessary unsupported annotations, and stale generated output. Recovery through local helper call sites is deliberately narrow: exported or unresolved dataflow requires a new semantic rule rather than a package-specific override.

## Verification

`verify-doc-graphs` freshness-checks semantic producer/listener discovery, and `verify-scoped-events` reruns the Program analysis while freshness-checking the generated resolver map. The root TypeScript build compiles its runtime adapter; workspace constraints and runtime-closure checks keep event-owner aggregation out of deployment dependencies.

## Alternatives considered

- **Keep syntax-only scans with receiver allowlists and manual overrides.** This is simple per exception but makes renames and new helper shapes update a second representation. Completeness can detect a missing producer, but it cannot prove that the override still describes the source.

## Consequences

- Event relation generation follows semantic receiver identity and closed event values instead of local naming conventions.
- Scoped-event membership, subject extraction, and runtime invariant coverage come from event declarations and real dispatch contracts rather than handwritten tables.
- Refactors that change event names, parameter positions, subject properties, or routing-key types fail generation at the owning contract.
- Building a flattened Program costs more startup time and memory than parsing isolated files, and semantic gates depend on a valid root project graph.
- Generated TypeScript remains committed source: changes to event owners or dispatch shapes must regenerate it and the affected documentation.
