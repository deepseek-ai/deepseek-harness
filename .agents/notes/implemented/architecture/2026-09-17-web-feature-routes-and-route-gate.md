# Agent Note: Feature routes follow the document base, and a gate keeps them there

Status: implemented

English | [中文](2026-09-17-web-feature-routes-and-route-gate.zh.md)

## Problem

[Web app-owned routes are document-relative](2026-09-14-web-document-relative-app-routes.md) makes the shell, its plugin bundles, and its streams reach one listener under any mount. Routes owned by feature packages still addressed the origin root: `/open-in-app/...`, the deliverables `present.*` and `changes.*` routes, the session-log export download, the upload worker's `/api/session/uploadFileBinary` post, and the `/api/file` route behind local markdown image paths. Under a prefix-stripping proxy each of those requests missed. Nothing stopped a new browser-face reference from binding the bundle to one mount again.

## Decision

Every feature producer keeps its absolute registration key and derives the browser form beside it: `OPEN_IN_APP_*_PATH`/`*_ROUTE`, `PRESENT_*_PATH`/`*_ROUTE`, `CHANGED_FILES_PATH` and `CHANGES_*_PATH`/`*_ROUTE`, `SESSION_LOG_EXPORT_PATH`/`_ROUTE`, `FILE_UPLOAD_PATH`/`_ROUTE`. Browser code addresses only the `*_ROUTE` form, and a Fetch-shaped carrier a page installs (`FileUploadFetch`, `RpcFetch`) receives that relative route and resolves it against its own base.

Two consumers need an absolute URL and resolve against `document.baseURI`: the upload worker, whose own base is a `blob:` URL, and the markdown image vocabulary, which emits only absolute `http(s)`, `blob`, or `data` destinations.

`verify-client-route-resolution` runs in `hygiene` and CI static checks over every browser source the client compiler face compiles. It governs request targets — the first argument of a request constructor, a `fetch`-shaped call, or a dynamic import; an assigned resource property; or a JSX `src`/`href` attribute — and rejects a root-absolute, protocol-relative, or absolute app route (`api`, `plugins`, `open-in-app` prefixes), and a relative app route resolved against a `location` read. A shared `*_PATH`/`*_ENDPOINT` key used as a request target must be stripped. The same pass checks the Host producers of browser references: a `url`, `src`, or `href` field stamped with a root-absolute app route is rejected, while route keys and response-table keys stay absolute and out of scope.

## Alternatives considered

**Banning every `location` read in browser code.** Rejected: identity comparisons, the preview's own query read, and the worker tunnel's host-relative mapping are all legitimate. The gate governs request targets, which is where a mount-bound route appears.

**Rewriting feature responses in the proxy.** Rejected: it duplicates the mount in deployment configuration for each route the proxy does not know about, and the document already resolves relative references.

## Consequences

The gate reads inline literal fragments only, so a composed reference (`comboReference(...)`, `artifact.url.slice(1)`) is not traced; `packages/client/modules/tests/node-half.client.spec.ts` owns the regression signal for composed graph rows, batch descriptors, and the source-map trailer. Preview pages do not expose their worker's file API at the document URL, so markdown local-file image URLs cannot reach that Host. [Session prose local media display](../feature/2026-09-07-session-prose-local-media-display.md) owns the image vocabulary.

## Testing

The gate's own spec pins a negative control per rule: interpolated targets (`${origin}/api/file`), protocol-relative and absolute forms, an unstripped shared key, a relative route resolved against a `location` read, and root-absolute producer fields. Each feature package's specs assert the relative route its browser half sends; `markdown-images.e2e.ts` keeps the local-image path covered end to end. The discovery spec pins which client projects contribute browser sources: a DOM project the Host aggregate also compiles contributes its plain `src/` unless it has a `src/client` half.
