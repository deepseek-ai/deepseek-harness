# Agent Note: One Remote failure vocabulary for ctx.remote

Status: implemented

English | [中文](2026-08-28-ctx-remote-failure-vocabulary.zh.md)

## Problem

Every Remote owner package maintained its own failure surface: an `XxxErrorDetailsMap` interface, an `XxxError` union derived from it, and an exit mapping function that translated domain error classes (`UnknownPresetError`, `PresetMountError`, `SessionTitleInvalidError`, and their peers) into a wire failure value. `@deepseek-ai/dsh-typert-protocol` carried two failure classes at once — `TypertRemoteFailure` for a failure an owner reported and `TypertLookupFailure` for one a lookup resolver produced — while `@deepseek-ai/dsh-client-connection` kept a second typed view, `RpcErrorDetailsMap`, that hardcoded domain codes such as `agent-preset-not-found` and `session-not-found` into the carrier.

One code therefore existed in three places: the owner's table, the carrier's typed view, and whatever union or cast a consumer wrote to narrow it (`result.error as SessionError`). Adding a domain code meant editing all three, and relaying another domain's code meant copying that code into your own table — `SessionErrorDetailsMap` had absorbed five foreign codes this way, across `agent-preset-*`, `subagent-*`, and `workspace-not-found`.

Failure information was flattened in two places as well. All 17 of the Gateway's own assembly failures (an unmounted method, an ambiguous endpoint, a lookup provider mismatch, a result that fails its codec) reached the wire as `code: 'internal'`, so a client could not separate an assembly fault from a business refusal; owners defensively pre-folded unrelated exceptions into their own domain codes, so a genuine Host bug arrived at the caller as a plausible-looking domain failure.

Fixed Host facts bypassed `ctx.remote` too: the Host home came from `(ctx.get('connection') as ConnectionHandle).generation.getSnapshot()?.host.home`, so every page that needed one fixed fact injected the carrier and understood its generation store.

## Decision

`@deepseek-ai/dsh-typert-protocol` exports one failure class, `RemoteError<Code>`: a real `Error` carrying readonly `code` and `details`, the structural marker `isDSHRemoteError`, and standard `ErrorOptions` (`cause` holds in-process only). The correspondence between codes and details lives in one merge-extensible `RemoteErrorDetailsMap`; `RemoteFailure` is the code-distributed union of instances, and `RemoteResult<T>` keeps its shape.

```text
export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
  readonly isDSHRemoteError: true = true
  constructor(readonly code: Code, message: string,
    readonly details: RemoteErrorDetailsMap[Code], options?: ErrorOptions)
}
export type RemoteFailure = { [C in RemoteErrorCode]: RemoteError<C> }[RemoteErrorCode]
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }
```

A failure point throws directly: `throw new RemoteError(code, message, details)`. A domain builds no error-class family and writes no exit mapping function; only the "classify any provider exception" case keeps one `catch`, and inside it `throw new RemoteError(code, messageOf(error), details, { cause: error })`. An existing exception class that an in-process flow still consumes (`ApiSessionCwdConflict` and its peers) stays as a non-exported private class and converts to a `RemoteError` in one line at the exit.

A code is a `<domain>/<reason>` string: `session/not-found`, `gateway/cancelled`, `workspace/invalid-path`, `agent-preset/locked`. The prefix follows the wire-namespace style, so the code itself says who owns it, and relaying another domain's code no longer needs an awkward unprefixed name.

## Code ownership

A code has exactly one declaration site, and the site follows from both who produces it and who can see the declaration — declaration merging only applies where the augmenting file enters the current program, so the home must be a package every producer already sees:

- **Carrier codes**: `gateway/bad-request`, `gateway/cancelled`, and `gateway/internal` are declared by the protocol and reachable everywhere.
- **Gateway assembly codes**: the 17 `gateway/*` codes are declared in `packages/api/gateway/src/remote-error-codes.ts` with the uniform `TypertGatewayFaultDetails { endpoint, field? }` details; that module is face-neutral and each face imports it, so both programs see the same entries.
- **Produced by several packages**: when two or more packages throw the same code, the declaration lands in the lowest layer both already depend on. `session/not-found` lands in `@deepseek-ai/dsh-session` (session-controller and workspace-controller both depend on it), and `workspace/not-found` lands in `@deepseek-ai/dsh-workspace` (no dependency edge exists between the two API packages, so the capability package is their only shared layer).
- **Single producer**: a code only one package throws lands in that producer. `subagent/not-found` and `agent-preset/conflict` therefore live in session-controller — it is their only thrower in the repository, and neither the subagent nor the agent-presets table declares them.

What two domains share is validation logic, not a code. `session/invalid-time-zone` and `subagent/invalid-time-zone` are two codes each declared and thrown by its own domain, and both endpoints canonicalize through `canonicalClientTimeZone()` from `@deepseek-ai/dsh-util-time`; no client branches on this code, so splitting it costs nothing while merging it would recreate the reachability problem.

## Discrimination by code

Discrimination always reads `code` and never uses `instanceof`. Client and Host are separately bundled programs, and a worker transport bundles the page half once more, so several copies of the same class exist and prototype identity across copies does not hold. The mechanism layer reads the structural marker plus a string `code` through the protocol's `remoteErrorOf(value)`, and the Gateway client face additionally exports `isRemoteFailure(error)` for a consumer's catch site; both read those fields, never the class — the test does not even require `instanceof Error`, because an Error thrown in another realm fails that too.

Business code usually needs neither function: the `ok: false` branch of `RemoteResult` is already a typed `RemoteFailure`, so `if (result.error.code === 'session/not-found')` narrows `details` to that code's shape with no cast. A site that must propagate the failure writes `throw result.error` — it is a real `Error`, with a working stack and `message`.

The client plane does not construct `RemoteError`; the one exception is the Gateway's own client face, which rebuilds an instance from wire data in `invoke()` and folds carrier throws at stream boundaries into the same vocabulary. A test double that needs a failure value takes `RemoteError` from `@deepseek-ai/dsh-client-test-runtime` instead of making a client package import the protocol as a value. Assertions match the code (plus details fields where they matter) with `toMatchObject`: `RemoteError` is an `Error`, its own-key set differs from the former literal, and `toEqual` fails on it.

## Fixed Host facts

`ctx.remote.$host` exposes two fixed facts: `home: string | undefined` and `isLoopback: boolean`. It is a getter on the Client Remote service reading the connection handle captured at service construction — `home` comes from the ready frame in the generation snapshot (`undefined` before ready), `isLoopback` from the carrier. There is no store, no subscription, and no generation counter.

Refresh after a reconnect rides the existing signal: the Client Remote emits `connection/reset` when it connects, and a consumer that must re-read listens for that or for its own domain's remote event rather than turning `$host` into a subscribable object. Consumers therefore no longer inject `connection`: the `@deepseek-ai/dsh-client-connection` consumer allowlist shrinks to hmr, frontend-static, bundle/web-app, session-log-export, webworker-runtime, and the gateway and api-remotes assemblies.

## What the wire carries

The envelope is unchanged: the wire still carries `{ code, message, details }` data, and `RemoteError` is each side's in-process carrier for it. On the Host, `rpcFailure()` collapses to two branches — a structurally identified `RemoteError` is encoded as-is, everything else folds into `gateway/internal` — and carrier-signal cancellation uses the same vocabulary (the `RemoteInvocationCancelled` class is deleted, and its four throw points raise `RemoteError('gateway/cancelled', …)`).

Three wire-visible behaviors follow. The Gateway's 17 assembly codes travel as themselves, so a client can handle "method not mounted" separately from a business refusal. Owners do not pre-fold unrelated exceptions: an unclassified throw reaches the Gateway, which folds it into `gateway/internal` once and keeps the diagnostic chain in `message`. A client unary call aborted by its caller answers `gateway/cancelled`, matching the code the Host would have produced even when the local throw wins the race against the wire round-trip.

The carrier keeps only the open wire shape. `ConnectionRpcFailure` and `ConnectionRpcResult` in `@deepseek-ai/dsh-client-connection` carry no domain-code knowledge, and its `transportError()` produces `gateway/internal`; the only home for the typed view is now the protocol's `RemoteFailure`.

## Alternatives considered

**A `RemoteFault` error-class family per domain.** Giving each domain (or each code) its own `Error` subclass reads as more object-oriented, but it splits one fact — the code — across class identity and a field, and cross-realm discrimination has to fall back to the field anyway. Class identity then becomes pure overhead: every domain maintains a subclass, exports it, and explains it in prose, while consumers still branch on `code`. One class plus one code table trades that weight for a single declaration line.

**`attempt` / `unwrap` / `remoteFailureOf` wrappers at call sites.** A wrapper saves one `if` per call site, but it turns `RemoteResult` from the canonical shape into "first pass it through a library function," and both styles then coexist indefinitely; `unwrap` additionally turns "failure is a normal result" back into an exception flow, against the Remote face's contract of never rejecting. The `remoteErrorOf` that survives serves the mechanism layer and test assertions only — business code holds either a typed `result.error` or a failure it threw itself.

**A `host/updated` event with a subscribed `$host` store.** A subscription would refresh automatically when the Host home changes, but `home` and `isLoopback` are fixed for the lifetime of one connection, so a store, generation, and subscription lifecycle would tax every page that only wants one read. Reconnection already has a signal (`connection/reset`) and business invalidation rides each domain's remote event, so fixed facts stay plain reads.

**Putting local, non-wire failures in the code table.** ui-goal's `no-current-goal` never crosses a process boundary; admitting it would mix entries only one client package cares about into a shared vocabulary and would suggest it has wire semantics. Local failures keep their own local types, and the code table describes the Remote vocabulary alone.

## Consequences

Adding a domain code is one declaration merge plus one throw: no mapping function, error class, and carrier typed view to keep in step. The cost is that the home now requires a judgment — it must be reachable from every producer — and that judgment only surfaces once a second producer appears; `workspace/not-found` moved from workspace-controller to the capability package exactly that way, which also gave `@deepseek-ai/dsh-workspace` a type-only protocol dependency.

Prefixing the code strings changes the wire strings wholesale, so codes embedded in connection fixtures, assertions on both the Host and Client sides, and spec-local declarations all move in one pass. The pre-release stance accepts that single cut; the same rename after a release would need a compatibility window.

The type of `details` follows from the code, so a code-and-details mismatch is rejected at compile time. The other face of that is every throw site having to supply the code's required detail fields: the protocol makes `issues` optional on `gateway/bad-request` precisely so a business validation point with no codec issues still writes `{}`.

`RemoteError` is an `Error`, so it keeps `message` and `cause` through any logger and through `errorChain()`; but `cause` holds only in-process, and the wire carries exactly `code`, `message`, and `details`. Cross-realm discrimination always reads the structural marker, and any new transport (a worker, a bundle split) must carry that marker or an equivalent marker frame across, or failure values degrade into plain `Error`s.

Consumer signatures for Remote methods are uniformly `Promise<RemoteResult<T>>`, matching the generated projection described in [the method-call surface](2026-08-02-typert-remote-method-calls.md); the ledger for the unary endpoints is [the unary endpoint migration](../../archived/architecture/2026-08-10-unary-apiproxy-remote-migration.md).
