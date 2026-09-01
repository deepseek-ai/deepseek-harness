---
description: "The web GUI host's HTTP server: named-route and upgrade registration, index transforms, and the single fallback seat that serves the Web shell's SPA dist."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-webserver

English | [中文](README.zh.md)

## Summary

Browsers reach the web GUI over HTTP through `dsh-host-webserver`: a `node:http` server where other plugins register named routes, upgrade routes, index startup inputs, and one fallback handler. It knows no harness concepts and serves no files — the `/api` bridge, plugin bundles, the HMR event stream, and the SPA dist belong to the plugins that register them. Route matching is fixed: exact over the whole table, then longest prefix, then the fallback handler. It serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose the webserver as the HTTP transport of a browser-facing host, then let the feature plugins claim their routes. Activation listens immediately; registration order carries no request-facing semantics because named routes compose to be disjoint.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3000
```

`host` accepts exactly two values: `127.0.0.1` (default posture, loopback only) and `0.0.0.0` (deliberate network exposure — the server carries no TLS, authentication, or origin policy of its own). `port` 0 requests an OS-assigned port; `ctx.webServer.port` reads the listening port afterwards.

Set `compression: 'gzip'` to wrap eligible socket-backed responses without changing route APIs. The client must accept gzip and the media type must be compressible; known response lengths below `compressionThresholdBytes` remain uncompressed, while unknown-length streams are eligible immediately. Existing encodings, `Cache-Control: no-transform`, range responses, SSE, ZIP, and the packaged `.gz` Worker image remain unchanged. The shipped Web bundle uses compression level 1 with a 1024-byte threshold; other compositions default to no compression.

### Registering routes

`register(route)` adds a named `exact` or `prefix` HTTP route, `registerUpgrade(route)` adds an upgrade route for an exact pathname, and both return a disposer that removes the registration. A duplicate path within either table throws — route patterns are a composition-level contract, so a collision is a misconfiguration. HTTP matching is exact over the whole table, then longest prefix, then the fallback handler; upgrades match exactly and unmatched connections are closed.

### The fallback seat

`registerFallback(handler)` claims the one handler for every request no named route matches. A second registration throws; while no fallback is registered the server answers 404. In the shipped Web composition the [SPA dist server](../frontend-static/README.md) owns the seat and calls `renderIndex` on every index response it renders.

Index startup inputs are two layers. `collectIndexInjections()` gathers a fresh injection table — one `webserver/index-inject` emit per call, each subscriber pushing its current rows — and `renderIndex(html)` renders those rows into the index.html body before applying the raw `tapIndex(transform)` transforms in registration order. A `script-preload` row renders an advisory classic-script preload link. Static deployments carry the same rows in their boot payload. `applyIndexTaps(html)` applies only the raw transforms; it is the escape hatch for markup no row expresses.

### Behavior under failure

A listen failure (for example EADDRINUSE) rejects plugin initialization with the bind diagnostic. An HTTP request whose handler throws is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process. An upgrade-handler exception or upgraded-socket transport error logs a warning and destroys its socket.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The package is a plain route registry with no harness vocabulary: `WebServer` extends Cordis `Service` and holds three route tables plus the fallback slot, the raw index-tap list, and the `webserver/index-inject` event the index renderer gathers rows through. Index rendering composes two layers per response: `renderIndex` renders the fresh injection table, including advisory `script-preload` rows, into the body, then applies the raw taps in registration order; `applyIndexTaps` runs the taps alone. The upgrade handler owns the protocol handshake and connection contents; the webserver only delivers the raw socket and request. `host` and `port` getters expose composition-time facts other plugins adapt to (for example the directory-picker chooser).

### Matching and lifecycle

`match(pathname)` consults the exact table first, then walks the prefix table for the longest match, then the fallback. Activation (`[Service.init]`) listens immediately; disposal starts `close()` and `closeAllConnections()`, destroys every tracked upgraded socket, and returns only after the server and those sockets have closed. Node does not include upgraded sockets in `closeAllConnections()`, so the service tracks them explicitly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `WebServer` service: route tables, fallback seat, index rendering, matching, lifecycle |
| — | No runtime invariant companion is published; route registration and disposal mutate one route table through the same service, so a register/dispose probe only re-executes the implementation. Real routing and HMR tests own the behavior. |
| [`src/injections.ts`](src/injections.ts) | Structured `IndexInjection` rows and `renderIndexInjections` row rendering |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the server contract is not enough: the subsystem reference, then the fallback owner and the layering decision behind who registers which route.

- [HTTP server subsystem](../../../docs/subsystems/web-server.md) — routes, matching order, and the config the server accepts.
- [SPA dist server](../frontend-static/README.md) — the shipped owner of the fallback seat.
- [Web config-tree boot and transport layering](../../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) — why feature plugins own every route.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-webserver) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the HTTP carrier bridges browser and API handler and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the server is intentionally minimal. They are current package constraints, not a task backlog.

- **No server-wide TLS, authentication, or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy. Binding a non-loopback address still exposes unprotected routes and static assets to that network.
- **Socket options are fixed** — config selects the bind host and port, while backlog and other socket settings remain internal until a deployment needs them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
