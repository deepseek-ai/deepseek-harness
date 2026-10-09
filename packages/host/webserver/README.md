---
description: "The web GUI host's HTTP server: named-route and upgrade registration, an optional TLS listener, index transforms, and the single fallback seat that serves the Web shell's SPA dist."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-webserver

English | [中文](README.zh.md)

## Summary

Browsers reach the web GUI over HTTP through `dsh-host-webserver`: a `node:http` server — `node:https` once `tls` names a certificate and key — where other plugins register named routes, upgrade routes, index startup inputs, and one fallback handler. It knows no harness concepts and serves no files — the `/api` bridge, plugin bundles, the HMR event stream, and the SPA dist belong to the plugins that register them. Route matching is fixed: exact over the whole table, then longest prefix, then the fallback handler. It serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge.

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

Compose the webserver as the HTTP transport of a browser-facing host, then let the feature plugins claim their routes. Activation listens immediately; registration order carries no request-facing semantics because named routes compose to be disjoint. Add `tls` to carry those same routes over HTTPS instead of plain HTTP.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3000
```

`host` takes one concrete IPv4 or IPv6 literal of a local interface — for example a container's own Pod address from `hostname -i`. A loopback literal (any address in 127/8, `::1`, or a mapped form of either) keeps the server on this machine; any other literal serves the network that address belongs to, over plain HTTP unless `tls` is set. An unspecified address — including the IPv4-mapped forms Linux reads as IPv4 any — is rejected at load instead of opening the port on every interface at once. `port` 0 requests an OS-assigned port; `ctx.webServer.port` reads the listening port afterwards, and the exported `isLoopbackHost(host)` and `isWildcardHost(host)` classify an address by its parsed value, so a mapped or zoned spelling classifies as the address it names. A dotted-quad IPv6 tail names the address's own low 32 bits, exactly as `listen` reads it, so `::0.0.0.1` is loopback `::1` while `::127.0.0.1` is the non-loopback `::7f00:1`; `normalizeBindAddress(host)` returns that address text — `127.0.0.1` for a genuinely mapped `::ffff:127.0.0.1`, `::1` for `::0.0.0.1` and for `::1%lo` — ready to be a URL host.

Set `compression: 'gzip'` to wrap eligible socket-backed responses without changing route APIs. The client must accept gzip and the media type must be compressible or `multipart/form-data`; known response lengths below `compressionThresholdBytes` remain uncompressed, while unknown-length streams are eligible immediately. Existing encodings, `Cache-Control: no-transform`, range responses, SSE, ZIP, and the packaged `.gz` Worker image remain unchanged. The shipped Web bundle uses compression level 1 with a 1024-byte threshold; other compositions default to no compression.

### Serving HTTPS

`tls` serves the same routes over TLS on that one address: the carrier opens no second HTTP listener and never redirects. Both files are read once during activation, before the socket binds, so an unreadable, empty, or malformed file, a key that does not match the certificate, or a bind failure rejects initialization — a misconfigured certificate never falls back to HTTP. Paths resolve against the process working directory, the key must be unencrypted PEM, and `certFile` may hold a chain whose leaf certificate comes first. Replacing either file takes a reload, and this carrier neither provisions nor renews certificates.

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3000
    tls:
      certFile: /etc/dsh/tls/cert.pem
      keyFile: /etc/dsh/tls/key.pem
```

`ctx.webServer.protocol` reads `'http:'` or `'https:'` for the bound listener, so a plugin that keys request policy — a session cookie's `Secure` flag, an origin check — on the transport reads one configuration-derived value instead of inspecting sockets or trusting forwarded headers. Clients still verify the certificate you supplied: this carrier ships no trust store, no HTTP-to-HTTPS redirect, and no HSTS header.

### Registering routes

`register(route)` adds a named `exact` or `prefix` HTTP route, `registerUpgrade(route)` adds an upgrade route for an exact pathname, and both return a disposer that removes the registration. A duplicate path within either table throws — route patterns are a composition-level contract, so a collision is a misconfiguration. HTTP matching is exact over the whole table, then longest prefix, then the fallback handler; upgrades match exactly and unmatched connections are closed.

### The fallback seat

`registerFallback(handler)` claims the one handler for every request no named route matches. A second registration throws; while no fallback is registered the server answers 404. In the shipped Web composition the [SPA dist server](../frontend-static/README.md) owns the seat and calls `renderIndex` on every index response it renders.

Index startup inputs are two layers. `collectIndexInjections()` gathers a fresh injection table — one `webserver/index-inject` emit per call, each subscriber pushing its current rows — and `renderIndex(html)` renders those rows into the index.html body before applying the raw `tapIndex(transform)` transforms in registration order. A `script-preload` row renders an advisory classic-script preload link. Static deployments carry the same rows in their boot payload. `applyIndexTaps(html)` applies only the raw transforms; it is the escape hatch for markup no row expresses.

### Behavior under failure

A listen failure (for example EADDRINUSE) rejects plugin initialization with the bind diagnostic, and unusable TLS material rejects it too, naming the config field and the resolved path but never the file's contents. An HTTP request whose handler throws is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process. An upgrade-handler exception or upgraded-socket transport error logs a warning and destroys its socket.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The package is a plain route registry with no harness vocabulary: `WebServer` extends Cordis `Service` and holds three route tables plus the fallback slot, the raw index-tap list, and the `webserver/index-inject` event the index renderer gathers rows through. Index rendering composes two layers per response: `renderIndex` renders the fresh injection table, including advisory `script-preload` rows, into the body, then applies the raw taps in registration order; `applyIndexTaps` runs the taps alone. The upgrade handler owns the protocol handshake and connection contents; the webserver only delivers the raw socket and request. `host`, `port`, and `protocol` getters expose composition-time facts other plugins adapt to (for example the directory-picker chooser), and an explicit `tls: null` normalizes to an unset listener, so `protocol` has a single source.

### Matching and lifecycle

`match(pathname)` consults the exact table first, then walks the prefix table for the longest match, then the fallback. Activation registers one effect that owns the whole acquisition — the TLS reads, the plain or secure server, and the bind — so a disposal that lands mid-initialization waits for the listener and then closes it rather than leaving it unowned. Disposal starts `close()` and `closeAllConnections()`, destroys every tracked upgraded socket and every raw TLS connection, and returns only after the server and those sockets have closed. Node's `closeAllConnections()` includes neither upgraded sockets nor a TLS socket whose handshake has not finished, so the service tracks both explicitly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `WebServer` service: route tables, fallback seat, index rendering, matching, TLS listener, lifecycle |
| [`src/injections.ts`](src/injections.ts) | Structured `IndexInjection` rows and `renderIndexInjections` row rendering |
| [`tests/tls-fixture.ts`](tests/tls-fixture.ts) | Generated TLS material for TLS-listener tests; another suite may materialize the same pair |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the server contract is not enough: the subsystem reference, then the fallback owner and the layering decision behind who registers which route.

- [HTTP server subsystem](../../../docs/subsystems/web-server.md) — routes, matching order, and the config the server accepts.
- [SPA dist server](../frontend-static/README.md) — the shipped owner of the fallback seat.
- [Web config-tree boot and transport layering](../../boot/app-boot/README.md) — why feature plugins own every route.
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

- **No certificate lifecycle** — `tls` serves the PEM files present at activation: the carrier never provisions, renews, or watches them, and it applies Node's default TLS policy. Replacing a certificate takes a reload.
- **No server-wide authentication or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy. Binding a non-loopback address still exposes unprotected routes and static assets to that network.
- **Socket options are fixed** — config selects the bind host and port, while backlog and other socket settings remain internal until a deployment needs them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Two working notes, both non-authoritative:

- TLS test material is generated at test time (`tests/tls-fixture.ts`), never committed: GitHub push protection rejects PEM private keys even in tests, and the certificate is disposable anyway. The helper issues one self-signed localhost certificate per process, covering 127.0.0.1, `::1`, and `localhost`, and writes the key owner-only.
- `selfsigned` stays on the 4.x line: 5.x installs two `@peculiar/asn1-schema` copies under pnpm, and its extension builder then throws for every `generate()` call.

</details>
