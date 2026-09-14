---
description: "Endpoint-named mock for Typert Remote traffic: a table of unary answers and stream scripts, live stream control, a log, and the Connection carrier face, for test authors booting a real browser client without a Host."
kind: "package-library"
---

# @deepseek-ai/dsh-remote-mock

English | [中文](README.zh.md)

## Summary

`dsh-remote-mock` lets tests configure Host responses through `mock.remote.<namespace>.<method>` using native Vitest mock methods. The same functions answer direct calls and real Connection traffic; reusable tables supply default responses, and explicitly declared streams support test-driven frames and cancellation. Missing responses fail the call and are reported again by `assertNoUnmatched()` at teardown. The package runs without a business Host in Node or a browser page, imports no DOM, React, or Node modules, and is consumed from `devDependencies` only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use it when a spec boots real client plugins that talk to `ctx.remote` and wants to script the Host side by endpoint name: whole-client specs bind `mock.rpc` to their Connection instance, while unit specs may call `mock.remote`, `dispatch`, or `open` directly. Endpoints are the Gateway's wire names (`session/page`, `settings/describe`); `args` is the caller's positional argument list with a trailing `AbortSignal` removed; a value is whatever the test registers and is answered unchanged. The only declaration is whether an endpoint is unary (`unary`) or a stream (`stream`).

<a id="remote-proxy"></a>
### Use the Remote proxy

`mock.remote` exposes every namespace and method without a method list or a domain-specific helper. Each accessed endpoint uses a cached native Vitest mock; `@vitest/spy.fn` is the implementation behind `vi.fn` and also works in a browser page without the Vitest runner. The same mock answers direct calls and Connection traffic, so return overrides and call assertions observe the functions the client actually invokes:

```text
const mock = RemoteMock.create().load(remoteDefaultResponses)
mock.remote.settings.describe.mockResolvedValue(ok({
  writable: true, hasDocument: false, namespaces: [],
}))
mock.remote.settings.mutate.mockResolvedValueOnce(ok(updatedNamespace))
// After the client writes:
expect(mock.remote.settings.mutate).toHaveBeenCalledWith('locale', operations, revision)
```

Use `mockResolvedValue` for a persistent response, `mockResolvedValueOnce` or `mockReturnValueOnce` for queued responses, and `mockImplementation` for argument-dependent behavior. Native queued responses run in registration order, then the mock's current implementation answers. Its initial implementation reads the registered default. `mockClear()` preserves responses and queues; `mockReset()` clears overrides and restores that initial implementation, which reads the latest default. Missing defaults still fail after queued responses are exhausted, including direct calls, which can throw synchronously.

Only explicit `stream()` or table stream declarations select stream methods; everything else uses unary mocks. Accessing a method does not fabricate a successful business result. Declare stream mode before retaining a method reference: each endpoint/mode owns its own mock. Namespace and method `then` probes and symbol reads are inert.

`MockedRemote` uses Vitest's deep mock transformation over the entire generated `TypertRemoteNamespaceMap`. A non-empty map preserves its namespace and method names, parameters, results, and native spy types. An empty map makes only this test proxy `any`, allowing arbitrary namespaces and methods; it does not augment or weaken production Remote declarations. No copied method signatures, optional generated-module suppressions, or compiler-wide flags are needed. Before handing off Remote/mock changes, run `pnpm run typecheck` to generate and check the real Client types; missing, stale, or partial declarations require rebuilding first. Unbuilt test success or `any` inference is not strict type evidence.

### Register default responses

`load(table)` installs reusable `unary` values or handlers, `stream` scripts, and scriptless `streams` declarations. `unary(endpoint, value)` and `unary(endpoint, fn)` register individual defaults; handlers receive the caller's positional arguments and use existing request types. Each endpoint holds only its latest default, including an explicit `undefined`; updating defaults does not discard native overrides. `ok(value)` builds `{ ok: true, value }`; failures use `{ ok: false, error: { code, message, details } }`. Keep stateful handlers, promises, and native queues local to each test:

```text
const initial = { writable: true, hasDocument: false, namespaces: [] }
const mock = RemoteMock.create().load({
  unary: { 'settings/describe': ok(initial) },
})
mock.remote.settings.describe.mockResolvedValueOnce(ok({ ...initial, hasDocument: true }))
```

### Drive streams

A stream script is a function of the open `args` and a `StreamHandle` (`push`, `end`, `fail(error)`, `signal`); the stream stays open after the script returns until the handle ends or fails it. `frames(items)` builds a script that yields the items and ends; `openStream(initial)` one that yields them and stays open. `mock.streams` controls streams the client currently holds open, filtered by the args they were opened with; `opened(endpoint, count)` resolves once the endpoint has been opened that many times, and `drained(endpoint)` once the consumer of every matching stream has pulled everything pushed so far, an open stream's consumer waiting for more and a settled stream's queue empty (pulled from the queue; that equals processed only for a consumer that handles items inside its read loop):

```text
mock.stream('session/follow', openStream([snapshotFrame]))
await mock.streams.opened('session/follow', 1)
mock.streams.push('session/follow', eventFrame, ([request]) => (request as { sessionId: string }).sessionId === SID)
mock.streams.fail('session/follow', new Error('gone'))
await mock.streams.drained('session/follow')
```

A failed stream rejects the consumer's next read with the given `Error`. Consumer cancellation (the opening signal or an early iterator `return()`) aborts `StreamHandle.signal`, ends the iteration without throwing, and logs the stream as `cancelled`.

### Connect a client

`mock.rpc` is the `ClientConnectionRpc` face. Pass it as `{ transport: { rpc: mock.rpc } }` to the Connection installer, or let `TestClient` bind it to its instance, so every Remote call reaches `dispatch` and every stream reaches `open` with no envelopes in between. Payloads carry `{ args }` as the whole-client proxies send them (an array) or as the Gateway's own endpoints send them (one object, delivered as one positional arg); a call whose signal aborts rejects with the abort reason. `RemoteMock.create()` registers one stream, `$events`, that answers the Gateway client's opening with `{ type: 'ready', clientId, host: { home } }` (host from `RemoteMockOptions.host`, default `/home/mock`) and stays open, which is what lets the assembled client reach `connected`; a spec overrides or fails it like any other stream.

### Observe and assert

`mock.log.calls(endpoint?)` lists unary calls through `dispatch` or `rpc.call` (`args`, `seq`, a live `state` of `pending` / `answered` / `failed`, and the answer or thrown error as `result`), `streams(endpoint?)` lists scripted opens with their live `state` and `pushed` count, `requests(endpoint?)` lists the first positional arg of calls and opens in order (without an endpoint, excluding the Gateway's own `$`-prefixed endpoints), and `unmatched()` lists requests that found no rule. Native `.mock.calls` additionally includes direct proxy calls; carrier stream mocks receive their final cancellation signal. `assertNoUnmatched()` reports misses at teardown. `modeOf(endpoint)` reports explicit registrations; `endpoints()` also includes accessed proxy methods so assembly can provide their namespaces.

### What can go wrong

- **A request has no rule** — `dispatch` rejects and `open` throws `remote-mock: no rule for <endpoint>; registered: …`, and the log records the miss; register the endpoint.
- **A payload is not `{ args: unknown[] | object }`** — `rpc.call` rejects and `rpc.open` throws a `TypeError`; the whole-client proxies send the array form and the Gateway's own endpoints the object form, so a hand-written call is at fault.
- **A second concurrent read on one stream** — the read rejects; the Gateway reads streams sequentially, so this names a test-side misuse.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

`dispatch` and `open` take the endpoint and positional args; `rpc` exposes the same core through Connection's decoded carrier interface. Each mock owns its native functions and queued overrides; shared tables supply defaults without copying handlers or answer objects. Each scripted stream owns its queue, its single pending read, and its log entry; the first of `end`, `fail`, or consumer cancellation settles it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public face re-exports |
| [`src/remote-mock.ts`](src/remote-mock.ts) | `RemoteMock`: default responses, native mocks, Connection dispatch, controlled streams and missing-response checks; `ok` |
| [`src/remote-proxy.ts`](src/remote-proxy.ts) | Namespace/method lookup and generated-map mock types |
| [`src/streams.ts`](src/streams.ts) | `frames` / `openStream` scripts and `MockStream` (handle + `AsyncIterable`) |
| [`src/log.ts`](src/log.ts) | Log store with the shared `seq` counter |
| — | No runtime invariant companion is published; this test-support library owns no production event stream or mutable process state, and its behavior is exercised by its package tests. |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is browser-side test infrastructure; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **In-process carrier only** — `rpc` serves a Connection instance in the same realm; no HTTP or WebSocket carrier for browser-lane specs is provided.
- **Values cross by reference** — answers and stream items reach the client unserialized, so a non-JSON value that the real wire would reject passes through unchanged.
- **Values are not checked** — a unary answer must be the result the caller reads (`{ ok, value }` or `{ ok: false, error }`); the mock passes it through unchanged and does not check those fields.
- **No payload matching** — rules match on endpoint only; discriminate on business arguments inside a handler.
- **Native stream overrides own their iterable** — an override returning its own iterable bypasses scripted-stream logs, `requests`, `opened`, `drained`, and `push` / `end` / `fail`; the caller also owns cancellation. Native call assertions still work. Use a registered stream script when a scenario needs those controls.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
