---
description: "Experimental Chrome DevTools inspection for Host and browser Client Cordis runtimes, including Console evaluation, Sources, Network capture, Elements trees, and a CDP-independent query API."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-inspector

English | [中文](README.zh.md)

## Summary

Inspect one running dsh Host and its browser Clients in Chrome DevTools: Host and Client Console contexts, Host Sources and debugging, captured Host fetches, and a shared Cordis tree, with all CDP state in a Worker.

The optional [Developer Tools bundle](../inspector-profile/README.md) enables both NodeJS Inspector and Session Log, including Host fetch capture. Web startup does not require or accept `--inspect`.

## Table of Contents

- [Use this package](#use-this-package)
- [Runtime layout](#runtime-layout)
- [Configuration](#configuration)
- [Observation API](#observation-api)
- [Cordis tree inspection](#cordis-tree-inspection)
- [Host fetch capture](#host-fetch-capture)
- [Security](#security)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

For trusted local development, `pnpm run demo:inspector` explicitly mounts the source overlay through the normal Web profile. The Host prints a debugging URL; Chrome is required to inspect that target. Fetch capture includes secrets, and the local debugging endpoint permits arbitrary code execution.

The bundle sets `experimental-inspector` to `disabled: false` with `captureFetch: true`. The Host's optional `--inspect` argument hook only opens an external Chrome window; it does not control whether the Inspector runs.

When this component is enabled, **Ctrl/Cmd+Shift+.** toggles **NodeJS Inspector** in the full-width bottom panel without requiring a selected Session. Drag its top edge to resize it, taking space from the content above; the selected height is retained across collapse and navigation. The focused divider also accepts Up/Down, Home and End. Its iframe loads on the first open and remains mounted while collapsed and across Session or main-panel navigation; unloading the component resets it. The X button and shortcut restore the opening control's focus when that control remains connected. The iframe automatically connects to this Host and opens Console; the manual Connection panel is omitted. Each embedded frontend shows Host and only its embedding page's Client in Console, Sources and the Cordis tree. The printed `devtools://` URL shows all Clients.

The Host serves the mirrored DevTools frontend at the application-relative `inspector/devtools/devtools_app.html` path, using the existing Web login. The `inspector/devtools` prefix redirects to that entry; GET and HEAD serve files, missing resources return 404, and other methods return 405. Its `cdp` WebSocket route authenticates the same browser session and forwards only to this Inspector's Worker page target. The bottom panel supplies its claimed `clientSourceId` to the entry and automatic WebSocket endpoint; the selection follows that logical Client across reconnects. An absent selector includes all Clients, an unavailable selected Client leaves Host visible, and empty or repeated selectors reject the upgrade with 400. Explicit `ws` or `wss` query parameters override the automatic endpoint, including its selection.

The build compiles the official `chrome-devtools-frontend@1.0.1638082` TypeScript sources with the root workspace's pinned [Vite dependency](../../../package.json). This npm snapshot is an ancestor of the Chromium 150 release branch, not an exact copy of its later stable release. The [source configuration](scripts/devtools/source.ts) and package manifest fix the version. Normal npm installation supplies the source and toolchain; building needs no appspot access, browser download, browser launch, or PAK extraction. Neither workspace installation nor published-package installation runs a DevTools download hook.

The [distribution build](scripts/build-devtools.ts) emits ESM entries, shared chunks, explicit Workers, injected scripts, and runtime assets into `lib/devtools`. It preserves original module-relative resource URLs, including deployment prefixes. CSS text modules, image variables, and minimal English locale constants replace GN-generated inputs without modifying npm sources. The frontend uses English UIStrings directly from upstream modules, with no translation files or dictionary generator. Other language preferences resolve to English. All upstream panels, including Lighthouse, remain included. Memory retains its parser Worker; Performance records Host CPU. Published packages contain the built assets, integrity manifest, and Chromium license, not the build-time npm source or Vite dependencies.

The frontend uses browser runtime adapters and excludes Node-only transports at build time, without an import map. Its same-origin connection bootstrap precedes the application entry. The bottom panel adds `disableLocaleInfoBar=true`; the bootstrap sets DevTools' own `disable-locale-info-bar` preference without changing its language. Updating the frontend requires changing the npm pin and source configuration together, then rerunning the panel and Worker checks; incompatible source edits fail the build.

<a id="runtime-layout"></a>
## Runtime layout

The Worker never accesses live Cordis objects: the shared Host/Client collector projects them into validated snapshots before transport. Cordis owns plugin composition, `ctx.inspector` registration, bootstrap injection, and disposal. A late-loading Client fetches its bootstrap through an authenticated Host route. Bootstrap transport and source-setup failures warn and retain connection-reset recovery for both injected and fetched startup; invalid bootstrap data or service-registration failures reject startup. Source replacement joins old service-consumer cleanup before claiming another source, and unloading an active plugin cancels its pending bootstrap refresh.

The Host plugin starts the Worker and connects a dedicated `MessagePort`. The Client uses injected or fetched browser-source parameters to open an authenticated WebSocket directly to the Worker; it receives no DevTools URL. Chrome DevTools connects to the Worker's CDP WebSocket. A private `node:inspector.Session` per DevTools connection attaches from the Worker to the Host main thread, so Host debugging remains available while Host JavaScript is paused.

The source tree follows those execution environments: `client/` and `host/` provide mirrored adapter entry paths, `worker/` contains only Worker-thread orchestration and Chrome protocol state, and `shared/` contains environment-independent Cordis and network models, normalized realm backend interfaces, and the internal bridge protocol. Worker-side Client and Host adapters are mirrored under `worker/realms/`; a Client adapter in that directory still executes in the Worker.

Host and Client producers send internal observation records rather than CDP messages. Records contain a source generation, sequence, source-clock timestamp, topic, and JSON payload. The Worker validates every process or network frame, owns source state and retention, and translates recognized topics to standard CDP domains.

Client sources declare typed Runtime, Console, and read-only Sources capabilities. `Runtime.enable` publishes only the default Host execution context and one synthetic context for every connected Client included in that DevTools connection; Node's internal and additional VM contexts are not listed. Selecting a Client context routes evaluation, property access, function calls, promise awaiting, and object release to that browser realm. Client Console arguments use the same session-local object table, while `Debugger.enable` publishes the built `lib/client.js` catalog and `Debugger.getScriptSource` reads bounded content chunks. Source-map URLs come from the loaded script's `sourceMappingURL` trailer, including combo URLs and deployment prefixes. Client-script breakpoints, step, and call frames remain unsupported; target-wide pause and resume control the Host debugger only.

A Client synchronously closes its source on `pagehide` and reconnects with the same logical identity on `pageshow` after a cached-page restore. Switching a live page to the background does not disconnect it. Closed generations cannot publish delayed execution contexts or script catalogs.

Both plugin faces run the same browser-safe Cordis collector. It converts reachable Context and Fiber objects into a versioned `CordisTreeSnapshot`; the Worker stores that CDP-independent representation and projects each Host or Client source into the Elements panel.

<a id="configuration"></a>
## Configuration

The Host plugin injects `webServer` and `connection` and accepts these fields:

| Field | Default | Meaning |
|---|---:|---|
| `host` | `127.0.0.1` | Worker endpoint bind address; only loopback is accepted |
| `port` | `9230` | First Worker endpoint port; occupied ports advance upward, while `0` requests an OS-assigned port |
| `clientOrigins` | `[]` | Additional exact browser origins accepted by `/ingest`; loopback origins remain accepted |
| `captureFetch` | `true` | Wrap `globalThis.fetch` and publish every later call |
| `maxRequestBodyBytes` | 8 MiB | Per-request captured request-body prefix |
| `maxResponseBodyBytes` | 32 MiB | Per-request captured response-body prefix |
| `maxBodyChunkBytes` | 48 KiB | Raw bytes carried by one body record before base64 encoding |
| `maxJournalBytes` | 256 MiB | Worker-retained request and response body bytes |
| `maxRetainedRequests` | `2000` | Active and completed requests retained by the Worker |
| `maxSourceFrameBytes` | 128 KiB | Encoded source-frame limit |
| `maxSourceRecordsPerFrame` | `128` | Records in one source batch |
| `maxQueuedRecords` | `2048` | Per-producer records waiting for transport |
| `maxQueuedBytes` | 16 MiB | Per-producer queued encoded bytes |
| `startupTimeoutMs` | 10 seconds | Worker readiness deadline |
| `stopTimeoutMs` | 5 seconds | Graceful Worker shutdown deadline before termination |
| `clientReconnectBaseMs` | 250 ms | First Client reconnect backoff cap |
| `clientReconnectMaxMs` | 5 seconds | Maximum Client reconnect backoff cap |
| `clientRuntimeTimeoutMs` | 30 seconds | Deadline for one Worker-to-Client Runtime or Sources command |
| `queryTimeoutMs` | 10 seconds | Deadline for one non-CDP semantic query |
| `maxClientRuntimeObjects` | `10000` | Live Client object handles retained per DevTools connection |
| `maxClientRuntimeProperties` | `2000` | Property descriptors returned by one Client object inspection |
| `maxClientSourceBytes` | 8 MiB | Maximum encoded bytes read from one Client script or source map |
| `maxCordisNodes` | `2048` | Context and Fiber nodes admitted from one realm snapshot before truncation |
| `maxDisconnectedCordisTrees` | `8` | Last disconnected realm trees retained as non-live snapshots |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-inspector) is the exhaustive source for accepted fields and their declarations.

The Host logs a `devtools://` URL after the Worker listens. The same Worker serves `/json`, `/json/list`, `/json/version`, the target WebSocket under `/devtools/page/<id>`, and the Client source at `/ingest`.

<a id="observation-api"></a>
## Observation API

Both plugin faces provide the same service:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { InspectorJsonValue } from '@deepseek-ai/dsh-experimental-inspector'

declare const ctx: Context
declare const topic: string
declare const jsonPayload: InspectorJsonValue

ctx.inspector.publish(topic, jsonPayload)
await ctx.inspector.cordis.getTree()
```

Publishing validates lossless JSON and schedules delivery without waiting for the Worker. Each source has a bounded queue. Overflow is reported as a sequence gap and never delays the observed application operation. `cordis.getTree()` reads the Worker's latest detached semantic snapshot without creating a CDP session or enabling Runtime, Debugger, or Sources.

<a id="cordis-tree-inspection"></a>
## Cordis tree inspection

The Elements document has fixed `<host>` and `<clients>` containers. `<host>` contains the Host root Context; `<clients>` contains one `<client>` per Client source, and each `<client>` contains that realm's root Context. The Cordis root Fiber is omitted. After removing Cordis service-call `shadow` wrappers, every other Fiber is a child of `fiber.parent`, owns exactly one Context child for `fiber.ctx`, and carries only `uid="<Cordis Fiber.uid>"`; Context elements have no attributes. Context-only `extend()`, `isolate()`, and `intercept()` layers remain direct Context descendants.

Host and Client publish the same nested `CordisTreeSnapshot` type. Context and Fiber nodes carry opaque object handles for realm-local object lookup; Fiber nodes additionally carry Cordis `uid`. The Worker composes those realm snapshots into one `{ host, clients }` inspection tree. It assigns `BackendNodeId` values per source generation; each DevTools connection assigns its own `NodeId` values; `DOM.resolveNode` asks the owning Host or Client Runtime for a connection-local `RemoteObjectId`. `DOM.requestNode` maps that object id back to the same Elements node. `ctx.inspector.cordis.getTree()` and `DSHInspector.getCordisTree` read the detached consumer-neutral tree without routing handles or CDP ids.

Node delivery is depth-limited per DevTools connection: `DOM.getDocument` serves three document levels when the caller omits `depth`, withheld levels advertise `childNodeCount`, and expansion fetches them through `DOM.requestChildNodes` (`depth: -1` for a whole subtree). Repeated expansion requests deliver only missing child lists, preserving existing frontend node objects and deeper loaded descendants. NodeIds leaving through `DOM.performSearch`, `DOM.requestNode`, or `DOM.pushNodesByBackendIdsToFrontend` first push the not-yet-sent ancestor levels as `DOM.setChildNodes` events.

Sources publish complete snapshots, while the Worker compares stable backend node identities before notifying DevTools. Unchanged snapshots emit no DOM event. Changes to a known node's undelivered child list send only `DOM.childNodeCountUpdated`; expanding it fetches the complete current child list. Delivered child lists receive node-level insertion and removal events, inserted-node payloads withhold their subtree, and sibling reordering replaces only that parent's children. Attribute changes target delivered nodes only. Re-fetching a document replaces its delivered depth; `DOM.describeNode` does not attach nodes to the frontend tree. Existing `NodeId` values and unaffected Elements expansion remain stable.

When a Client disconnects, its Console execution context and live object ids are destroyed immediately, removing it from Console's context selector. With disconnected-tree retention enabled, Elements keeps the last tree and adds the boolean `disconnected` attribute to its `<client>` element. Reconnection keeps the logical source id, creates a new synthetic CDP context id for the new transport generation, and removes the attribute when its complete snapshot replaces the stale tree. Attribute changes arrive incrementally without refreshing DevTools. The Client retains its logical id in `sessionStorage` and claims it through Web Locks for the page lifetime, so refresh reuses the id while a duplicated live tab receives a new one. The Worker retains at most `maxDisconnectedCordisTrees` such snapshots; zero removes them immediately.

<a id="host-fetch-capture"></a>
## Host fetch capture

Fetch capture is on by default and records the complete URL, all request and response headers, request body, response body, status, timing, errors, and cancellation. It does not redact credentials, cookies, query values, or payloads. Body capture reads clones; the caller receives the original Response as soon as the original fetch resolves.

The configured body limits bound retention rather than select fields: capture keeps the prefix and marks the result truncated. `Network.getRequestPostData` and `Network.getResponseBody` read the Worker's retained bytes. `Network.streamResourceContent` returns the buffered prefix and adds later response bytes to `Network.dataReceived` for that DevTools connection, which drives live Response and EventStream views. Direct Undici Client/Dispatcher calls and fetch references retained before plugin activation are outside this observer.

After response headers arrive, a caller-side abort can stop the observer's clone; captured bytes remain available through `Network.getResponseBody`, capture metadata records the error and truncation, and CDP emits `Network.loadingFinished` because fetch returned a Response. A fetch rejection before response headers emits `Network.loadingFailed`, with `canceled: true` for an abort.

<a id="security"></a>
## Security

Client selection limits one DevTools connection's realm sessions, DOM projection and diagnostic queries; it does not stop collection or change the shared observation API. It is a display filter, not authorization: a trusted debugging user can open an unfiltered connection, and Host evaluation retains its existing authority.

The CDP target grants arbitrary code execution in both Host and connected Client realms through `Runtime.evaluate`; Host Debugger operations provide additional control. Full fetch capture includes secrets. The Worker therefore accepts only a `127.0.0.1` bind address. Client ingest additionally requires a random WebSocket subprotocol token injected by the Host and rejects non-loopback origins unless explicitly configured. The CDP socket itself has no token; loopback binding is its only access control.

<a id="model-experience"></a>
## Model Experience

None, as this developer-only inspector observes runtime activity without changing model requests.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Memory and Performance inspect the Host** — Memory captures the Host heap; Performance records Host CPU samples. Client Runtime contexts do not expose browser heap snapshots or rendering traces.
- **The same-origin relay runs on the Host main thread** — pausing Host JavaScript also pauses this relay. Use the printed direct Worker DevTools endpoint for breakpoint debugging and resume control.
- **Client active debugging is unsupported** — Console events, Runtime evaluation, RemoteObject access, and read-only `lib/client.js` Sources work. Client-script debugger requests return explicit unsupported errors; target-wide pause and resume control the Host only.
- **Client Sources expose the Inspector bundle only** — other page scripts are not cataloged by this package.
- **Client evaluation uses page JavaScript** — page Content Security Policy can block dynamic evaluation, and the synthetic context does not provide DevTools command-line helpers or native REPL declaration semantics.
- **Client identity arbitration requires Web Locks** — browsers without that API retain reconnect and refresh identity through `sessionStorage`, but cannot distinguish two simultaneously live tabs copied from the same storage state.
- **Fetch interception covers `globalThis.fetch`** — direct Undici APIs and fetch references retained before activation are not observed.
- **Body cloning has cost** — full capture tees request and response streams up to the configured limits and can increase memory and I/O pressure. The retained-body limit does not include buffering inside the stream tee, including an oversized source chunk or data queued for a slower application reader.
- **No automatic Worker restart** — an unexpected Worker exit fails the current Inspector instance; lifecycle recovery belongs to a later change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
