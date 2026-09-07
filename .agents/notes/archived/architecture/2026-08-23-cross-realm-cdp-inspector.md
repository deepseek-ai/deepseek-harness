# Agent Note: Cross-realm CDP inspector

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-23-cross-realm-cdp-inspector.zh.md)

## Problem

Host diagnostics, browser Client observations, and JavaScript debugging originate in different JavaScript realms. A debugger transport implemented on the Host main thread cannot deliver `Debugger.resume` while that thread is paused, and a design that lets each producer emit CDP directly duplicates protocol state and couples application instrumentation to Chrome's presentation protocol.

## Decision

`@deepseek-ai/dsh-experimental-inspector` is one private Client/Host Cordis plugin package. Its Host face starts a Node Worker; its Client face connects directly to that Worker. Cordis owns composition, service publication, bootstrap injection, and disposal only. The source protocol, Worker state, CDP server, V8 bridge, and domain adapters do not inspect Cordis runtime data.

The Worker is the sole CDP endpoint and the sole owner of CDP state. Host and Client producers send validated observations under a versioned internal protocol; Client Runtime, Console, Sources, and semantic queries use separate typed frame families on the same authenticated carrier. A realm registry gives every DevTools connection the same Runtime, Console, Sources, and Debugger capability slots, while explicit unsupported members preserve different Host and Client support levels.

## Realm ownership

The Host main thread owns application objects and `globalThis.fetch`. It sends observations over a dedicated `MessagePort` and never constructs CDP messages.

The Client page owns browser observations, evaluated values, and Client object handles. It exchanges JSON frames directly with the Worker over an authenticated ingest WebSocket, so a paused Host does not stop Client delivery or Runtime execution.

The Inspector Worker owns HTTP discovery, both WebSocket routes, source generations, retention, realm sessions, CDP sessions, and domain adapters. Each DevTools connection opens one backend session for the Host and every connected Client realm. V8 object ids remain inside the Node Runtime backend. Client object handles remain inside the typed Client protocol. One connection-local object table maps either backend handle to CDP object ids and projects the same RemoteObject, property, exception, Console, and paused-frame types.

Chrome DevTools consumes one page-type target. Runtime methods route by execution context or object id. Debugger source methods route by script id; Host scripts retain native debugging, while Client scripts expose read-only content and reject active debugging. `Profiler` and `HeapProfiler` remain Host-only. `Network` and the minimal page-target scaffold run inside the Worker.

## Source protocol

Both MessagePort and WebSocket carriers use the same JSON value set and discriminated frames. A source identifies one logical producer and one connection generation, declares capabilities and topics, sends an initial replacement, then appends sequence-numbered batches. The Worker rejects malformed, oversized, stale-generation, and undeclared-topic frames before reading domain fields.

Delivery is ordered and best-effort. Producers never wait for an acknowledgement on an application path. A bounded producer queue reports dropped prefixes through sequence gaps; the Host MessagePort carrier permits one append batch in flight and sends the next after the Worker acknowledges consumption. The Worker requests a new snapshot after an unexplained gap. Domain stores retain bounded state and explicitly close unfinished operations when a source disconnects.

Runtime frames use closed command and result unions instead of method strings with untyped parameter records. Every request carries a source id, source generation, DevTools Runtime session id, request id, and command. Every result repeats those identities and the command discriminant. Console lifecycle/events, chunked source reads, and non-CDP semantic queries have separate correlated frame families. RemoteObject values, previews, property descriptors, call arguments, exceptions, Console events, debugger frames, scripts, and errors have dedicated exact decoders.

## Client Runtime, Console, and Sources

`Runtime.enable` publishes the Host's real execution context and one negative-id synthetic execution context for each connected Client source that declares the Runtime capability. An omitted context continues to mean Host. Client source replacement destroys the old context and creates a new context with a new generation and unique id.

The Client Runtime subset covers `Runtime.evaluate`, `Runtime.getProperties`, `Runtime.callFunctionOn`, `Runtime.awaitPromise`, `Runtime.releaseObject`, `Runtime.releaseObjectGroup`, and `Runtime.globalLexicalScopeNames`. The Client executes commands in its page realm and retains live objects in a table isolated by DevTools Runtime session. It returns opaque handles and JSON-safe metadata; the Worker validates the result and assigns a connection-local CDP object id. An object argument may be used only by the same Client source generation and DevTools session. Closing the source, disabling Runtime, closing DevTools, releasing an object, or releasing an object group removes the corresponding handles.

JavaScript exceptions are successful Runtime responses carrying `exceptionDetails`; transport failures use a separate error union. A Worker deadline sends request-scoped cancellation to the Client. Handles allocated for a response remain provisional until the Worker acknowledges that response, so cancellation and late responses cannot leave unreachable objects. Finite command deadlines, object counts, property counts, source bytes, and frame bytes bound retained or returned state.

The Client Console observer preserves the original page call and asynchronously emits one event per enabled DevTools session. Each session serializes arguments into its own `console` object group, so disconnect, Runtime disable, or `Runtime.discardConsoleEntries` can release one connection without invalidating another. Context and Fiber arguments use the same semantic reference and DOM reverse mapping as evaluation results.

The Client discovers this package's `lib/client.js` URL from the assembled web boot graph. `Debugger.enable` reads metadata through a typed source operation, and `Debugger.getScriptSource` reassembles bounded base64 chunks; the source map remains available at the advertised URL. Client-script breakpoint, step, and call-frame operations remain explicitly unsupported because page JavaScript cannot pause its own realm and continue servicing control messages. Target-wide pause and resume continue to control the Host debugger.

## Host debugging

The Worker attaches each DevTools connection to the Host main isolate through its own Node inspector Session. Node Runtime, Console, Sources, and Debugger backends normalize native values and events into the same realm model used by Client backends. The common projector allocates connection-local object ids for evaluation results, Console arguments, paused scopes, and call-frame results. Breakpoint requests are translated back to native backend handles before reaching Node. The default context may receive the display name `Host` while retaining its real id and metadata.

The Worker event loop, DevTools socket, Client ingest socket, and Node inspector Session remain runnable while Host JavaScript is paused. Host observations naturally stop until resume.

## Fetch capture

Fetch capture wraps `globalThis.fetch` and is enabled by default. Every later fetch records its complete URL, headers, request body, response headers, response body, timing, cancellation, and error. No field is redacted by default; using the inspector grants local DevTools access to those secrets.

The wrapper passes a normalized Request to the original fetch, reads request and response clones on independent capture tasks, and returns the original Response as soon as fetch resolves. Capture failure never changes the caller's fetch result. Finite per-body and journal budgets prevent unbounded retention; exceeding a budget preserves the captured prefix and reports truncation.

## Alternatives considered

**Run the CDP server on the Host main thread.** Rejected because a breakpoint freezes the socket responsible for delivering `Debugger.resume`.

**Relay Client observations through the Host web server.** Rejected because the relay also freezes at a Host breakpoint and makes the Client data path depend on Host responsiveness.

**Let producers emit CDP messages.** Rejected because producer code would own Chrome-specific request ids, replay, enable state, and ordering instead of domain observations.

**Share one Node inspector Session across DevTools clients.** Rejected because object ids, object groups, enable state, and debugger operations belong to one protocol session; sharing requires an error-prone virtual-session layer.

**Send live Client objects or CDP object ids over WebSocket.** Rejected because JSON cannot preserve identity or behavior, and a CDP object id belongs to one DevTools session. Client-local handles plus a Worker-owned per-connection mapping preserve both ownership rules.

**Use one untyped Runtime RPC method.** Rejected because method strings and arbitrary parameter objects cannot enforce command/result correlation, object-reference ownership, or exhaustive evolution as Runtime, Sources, and Debugger support grows.

**Split protocol, Host, and Client into separate packages.** Rejected for the experimental phase. One package keeps the capability deployable as one Client/Host plugin while source directories and build entries preserve realm boundaries.

**Use Undici diagnostics channels as the complete fetch source.** Rejected because they observe transport lifecycle but cannot provide complete request and response bodies without consuming application streams. They may later augment transport-level timing.

## Verification

- A real Worker accepts Host MessagePort and Client WebSocket sources and exposes both through one CDP target.
- Malformed, oversized, stale-generation, and sequence-gap frames cannot corrupt another source or the Worker.
- Console evaluates in the Host context and receives Host console events.
- Console lists Host and Client contexts; Client evaluation, properties, function calls, promise awaiting, and release operations preserve RemoteObject identity without sharing objects across realms or DevTools connections.
- Host and Client Console events use the same projector; Client arguments remain isolated by DevTools connection and Cordis arguments resolve to Elements nodes.
- Sources receives Host scripts and the built Client bundle; Client source reads are chunked and active debugging fails explicitly, while a breakpoint can pause the Host, evaluate a call frame, and resume.
- Host paused scopes and call-frame results use the same connection-local RemoteObject table as Runtime evaluation.
- Network replays requests that predate `Network.enable` and streams later requests without loss or duplication.
- Successful, failed, aborted, redirected, textual, binary, streaming, and truncated fetches preserve caller behavior and expose the configured captured data.
- Disposal stops capture, closes admission, disconnects V8 sessions, closes sockets, and waits for Worker exit before completing.

## Consequences

The Worker-owned endpoint keeps DevTools control responsive while Host JavaScript is paused and gives Host and Client observations one CDP state owner. That ownership adds the following security, resource, and compatibility costs.

Full fetch capture intentionally exposes credentials and payloads to any local process that can attach to the CDP endpoint. Loopback binding is mandatory but is not authentication.

Cloning request and response streams adds CPU, memory, and I/O pressure. Finite limits bound retained bytes but cannot make full capture free.

A page-type synthetic target depends on a small set of Chrome DevTools compatibility responses outside Node's native inspector domains. Each no-op must be named and covered because silently accepting every unknown method hides protocol drift.

Client Runtime execution uses page JavaScript evaluation, so page Content Security Policy may reject it and native DevTools command-line or REPL semantics are not promised. Read-only Client Sources do not imply active Client debugging; adding that capability requires an execution agent that remains responsive while the inspected page realm is paused.
