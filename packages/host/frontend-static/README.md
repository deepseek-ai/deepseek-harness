---
description: "SPA dist server for the Web shell: claims the webserver fallback seat and serves the built frontend with traversal rejection and SPA index fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-frontend-static

English | [中文](README.zh.md)

## Summary

Serve the built Web shell from its configured distribution directory. Root and configured-index entries require an authenticated Peer and render its startup data; other assets need no credentials but still pass active Connection source checks. Missing or non-file paths return 404, traversal returns 403, and admitted requests with unsupported methods return 405. Only one instance can own unmatched requests; a second activation fails, and unloading it leaves unmatched requests at 404.

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

Compose this plugin in a browser-facing host that serves the built Web shell: it claims the webserver's fallback seat and answers every request no named route matches. It needs one config value — where the built frontend's `index.html` lives.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-host-frontend-static'
  config:
    distIndex: /absolute/path/to/dist/index.html
```

`distIndex` is an assembly fact of the composing application: [`dsh-web-app`](../../bundle/web-app/README.md) resolves it through the frontend package's exports and mounts this plugin; a deployment never hardcodes it.

### What the server enforces

Requests are served from the dist root (the directory containing `distIndex`). The root and configured index render `index.html` with 200; other existing files use their MIME type, or `application/octet-stream` for unknown extensions. Paths outside the root return 403; missing or non-file targets return empty 404 responses. After admission, non-GET/HEAD requests return 405. The fallback resource renders each index through `webServer.renderIndex` with the Peer WebServer admitted, or the explicit Peer supplied to trusted `webServer.readResource(request, peer)`. The boot manifest and that Peer's access snapshot reach both index entry paths.

The served HTML carries one document base, `<base href="./">`, ahead of every injected resource row, so it freezes the entry directory the page was loaded from: the shell's own app-directory-relative references and the Host's plugin-resource rows both resolve under the mount that served the page. The same index therefore serves the origin root and whatever mount a prefix-stripping proxy owns; this plugin renders it only for the dist root and the configured index path.

The fallback's synchronous `auth` selector requires `required` for root and configured-index requests and declares other files `anonymous`. WebServer centralizes admission through Connection before file serving; anonymous assets skip credential verification, not Connection's source policy. The resource receives the admitted Peer directly and captures it for index rendering without another authentication call. Token middleware handles the root Cookie exchange before routing. After reading index bytes, rendering checks that both request and Peer remain live.

Browsers revalidate every served file except the index. Such a response carries `cache-control: no-cache` and a weak ETag built from a SHA-1 of the file's bytes, so a file whose content changes gets a new ETag even when its name stays the same; a request whose `If-None-Match` equals the current ETag receives an empty 304. The rendered index carries no cache headers.

### Observable failures

Traversal returns 403 rather than an error page. An absent or non-file target inside the dist root returns an empty 404, so a stale link or a mistyped pathname is an explicit failure rather than a silent SPA fallback. Claiming the seat twice throws, and while the seat is unclaimed the webserver answers 404 — which is what a browser sees if this plugin's fiber is disposed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The function plugin wraps `serveStatic`, which maps a Fetch `Request` to a `Response`. Its fallback declares route auth and consumes the Peer WebServer supplies; in-process reads use the caller's explicit Peer. The renderer runs index transforms and inserts the document base before resource references. The plugin scope owns the fallback registration and releases its single-owner seat on disposal.

### The traversal fence

`serveStatic` normalizes the requested pathname and joins it to the dist root, then requires the target to be the root itself or stay under it. The check uses `sep` rather than `/` because `resolve()` emits backslash paths on Windows, where a `/` suffix would reject every legitimate subpath as traversal.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `serveStatic` and `apply`: fallback resource, traversal rejection, index authorization and rendering, revalidation, MIME table |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the serving contract is not enough: the seat owner's contract, then the composition that resolves the dist and the subsystem reference.

- [Webserver](../webserver/README.md) — the fallback seat this plugin claims and the index taps it runs.
- [dsh-web-app bundle](../../bundle/web-app/README.md) — the application that resolves `distIndex` and mounts this plugin.
- [HTTP server subsystem](../../../docs/subsystems/web-server.md) — how the fallback seat fits the route tables.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-frontend-static) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the SPA dist server answers browser asset requests and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when a served asset class is not yet covered. They are current package constraints, not a task backlog.

- **The starter MIME table is minimal** — it covers the Vite-emitted asset set plus the shipped PWA manifest; other extensions fall back to `application/octet-stream` until an asset class ships.
- **Pathname routing is explicit** — the current client enters through the root or configured index path and has no History API pathname routes. Adding one requires an explicit server rule and real-composition coverage rather than a broad fallback for every miss.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
