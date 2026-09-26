# Agent Note: Web app-owned routes are document-relative

Status: implemented

English | [中文](2026-09-14-web-document-relative-app-routes.zh.md)

## Problem

Every browser reference to a shell-owned route was origin-root absolute: `/api/...` RPC, `/plugins/??...` plugin bundles, the Remote stream mux, the HMR event stream, and the launch entry's token-cleanup redirect to `/`. One listener served behind a prefix-stripping proxy (a mount such as `https://host/tools/dsh/` that forwards `/tools/dsh/...` as `/...`) therefore saw those requests at the origin root, where no route answers them: the shell, its plugin bundles, and its streams all missed. A single bundle has to serve both the origin root and any mount without a second build.

The mount cannot be recovered from the transport. A configured base URL makes it deployment input, forwarded-prefix inference makes a request header authoritative for routing, and response rewriting in the proxy reimplements the same fact in fragments. The one place that already knows the mount is the served document itself.

## Decision

The served HTTP shell owns its document base. Its index carries exactly one `<base href="./">`, spliced in after the opening head tag once the index taps have run, so it precedes the boot manifest, every plugin-resource row, and any markup a tap inserted. The base freezes the entry directory: `/mount/` and `/mount/index.html` are the supported entries, and a document URL that later moves (an in-page `pushState`) does not move the base. Nothing infers a prefix, so deep direct loads and reloads are not entry points; a bare mount still needs the proxy's own normalization to its slash form.

Browser references to those routes are relative to that document — `api/x`, `plugins/x` — while server route keys stay absolute pathnames: the RPC channel key `/api`, the `webServer` registration paths, and the response tables keyed by the combo route `/plugins/??...&rev=...`. A shared constant that names a key (`*_PATH`, `*_ENDPOINT`) is stripped at the boundary (`KEY.slice(1)`) before browser code uses it, and the browser form lives beside it as `*_ROUTE`.

The Host composes browser references in one place per producer. Module graph rows and batch descriptors carry the document-relative combo reference; the source-map trailer carries the combo query alone, because a script's source-map reference resolves against that script's own directory (`.../plugins/`) rather than the document. The response table stays keyed by the absolute route, which is also what a request reaches after the proxy strips its prefix.

The launch entry follows the same rule. `authenticatedUrl` adds the process token to the caller's URL and keeps its authority and mount, and the token exchange redirects to `./`, which removes the query token while preserving the request URL's directory. The Host/Origin fence and the cookie rules are unchanged.

Consumers that need an absolute URL resolve against `document.baseURI`: the Gateway when it constructs its WebSocket URL and selects `ws:` or `wss:`, and the Inspector when it locates its own bundle from the boot graph.

Desktop is the other document owner. Its window loads `dsh-app://app/`, an origin that serves the same dist at that root and forwards every app-owned path to the shell-owned Host, so its document directory already is the root and no base row is injected for it; it names that Host origin for the Gateway through the transport's `streamBaseUrl` instead. Its resources live at that root, which is also why the served HTTP shell's `./` does not apply to it.

## Alternatives considered

**A configured base URL as the routing base (`publicUrl`).** Rejected: the document already knows its own URL, so this adds a second, drift-prone source for a fact the page can read, and it would have to be plumbed to every consumer instead of one shell decision. The advertised public URL remains an operator-facing print/open input, not a routing input.

**Inferring the mount from a forwarded-prefix header.** Rejected: it makes a request header authoritative for routing, so any client that sets it could move app-owned routes, and the proxy contract becomes server-visible configuration.

**A shared `Connection.resolveUrl` or routes base.** The HTTP carrier's document base and the worker tunnel's Host-root mapping differ. Resolving every target in Connection would prepend a static preview path to worker-local routes or lose a served mount. Each carrier resolves its own targets; UI resource consumers use the document base.

**An absolute `/` redirect with the proxy rewriting `Location`.** Rejected: the browser already knows the request's directory, and a configured redirect target cannot be right for both the loopback entry and a proxy mount.

## Consequences

One bundle serves the origin root and any mount, and the served document is the single source of the mount. The costs are explicit: the supported entries are only the dist root and the configured index path, a bare mount depends on the proxy's slash normalization, and a reload of a deep in-page path re-enters at that path rather than the frozen one.

Routes owned by feature packages (open-in-app, deliverables, session-log export, uploads, markdown media) follow the same rule through their own `*_ROUTE` constants; the static gate that keeps browser sources on this rule is recorded with those changes.

## Testing

The frontend-static real-composition test serves the index through the Loader and asserts one `<base href="./">` that precedes an injected plugin-resource row and tap markup. The client-modules node-half suite asserts that graph rows, batch descriptors, and the source-map trailer are document-relative while the response table still serves them by route, and the client test roster plus the assembled-boot fixture carry the same relative form. `browser-auth.host.spec.ts` covers the `./` redirect and the authority- and mount-preserving `authenticatedUrl`; `frontend-static.spec.ts` and `apps/cli/tests/web-auth.e2e.ts` run the exchange through a real Loader composition and the built CLI.

`apps/web/tests/public-mount.e2e.ts` is the browser proof: a real Chromium reaches one listener through the prefix-stripping proxy, the mounted WebSocket streams both ways, a `pushState` to a deeper path leaves `document.baseURI` at the mount, and a document-relative `fetch('api/session/create')` still succeeds beneath it.
