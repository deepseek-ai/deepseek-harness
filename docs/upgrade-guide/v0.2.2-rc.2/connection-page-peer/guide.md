---
kind: upgrade-guide
description: WebServer routes require authentication by default, and default Token login moves to a Provider plugin.
---

# Token Provider and route admission migration

English | [中文](guide.zh.md)

## Change

Default Token verification and HTTP login exchanges move to `@deepseek-ai/dsh-host-authentication-token`. Connection removes BrowserAuth, `authorizeIndex`, `authenticatedUrl`, `requestRejection`, `ConnectionRequestRejection`, `peer(id)`, `createPeer.socketOwned`, `ConnectionAdmission`, and `admitConnection`. Token owns `/api/remote.mux` Socket claims through the post-admission `webserver/upgrade` waterfall. Cookie formats and `/connect` remain; valid v2 Cookies now also authenticate pages, without a page/API `purpose` field.

WebServer registrations now accept `auth: 'anonymous' | 'required' | 'deny'` or a synchronous selector, defaulting to `required`. Previously public handlers, resources, fallbacks, and upgrades need explicit anonymous declarations. HTTP and upgrade handlers receive the admitted Peer as an optional trailing argument; resources keep their Peer argument. Connection source checks also apply to anonymous routes when its listener is active.

## Migration

1. Mount Token beside Connection and Credentials. Manually move `cookieMaxAgeDays` from `connection.config` to `authentication-token.config`. The old location has no effect and is neither migrated nor rejected; leaving Token's value unset uses 30 days.
2. Audit `webServer.register`, `registerFallback`, and `registerUpgrade` calls. Direct administrative handlers also require an owner Peer. Keep authenticated access for protected routes; declare `auth: 'anonymous'` for credential-free assets and login endpoints, and `auth: 'deny'` for blocked routes. Convert a bare fallback handler to `{ handler, auth }` when changing its policy. Check `trustedHosts` for every intended authority, including public assets.
3. Remove page adapters' `purpose` and repeated authentication calls. Consume the Peer passed to `(req, res, peer?)`, `(req, socket, head, peer?)`, or `resource(request, peer?)`. Render protected pages for that Peer. Trusted in-process `readResource(request, peer)` still uses its explicit Peer without source or Cookie checks, but respects `deny`.
4. Keep `printUrl`, `openBrowser`, and `publicUrl` on WebApp. After readiness, WebApp emits `webserver/entry-url(baseUrl, entries)`; listeners append `{ label, url, open }`. WebApp prints entries in order and opens the first eligible one outside SSH. No entries means no output or opening. Token contributes its signed URL without depending on WebApp. Custom HTTP carriers retain `webserver/request` before routing.
5. Providers inject `connection` and `connection.authentication`, retain their `createPeer({ principal, interactions })` results, and call `ctx.connection.authentication.register(provider)`. Keep `browserPeer` for trusted in-process use. Use `admit` instead of `requestRejection`. Without an authorization decision, `required` returns 503 and `anonymous` allows access.
6. Emit all `webserver/*` events with the WebServer as thisArg, including `index-inject` and `entry-url`. Ordinary listeners follow `webServer` isolation; `global: true` opts out. Run upgrade middleware after admission, before protocol handling; await `next()`. Token claims its API Peers only on `/api/remote.mux`.
7. Verify root Token login, existing Cookies, v2 page access, HTTP/WS, `/connect`, anonymous assets, and source-rejection 403. Duplicate mux Sockets still return 409; closing the owning Socket revokes credentials before Peer disposal. Only root Token queries exchange credentials. Token load failure grants no protected access.
8. Update custom Desktop shell/Host pairs together: per-process credentials travel over private IPC before ready; main processes use `authenticationCookie` and the ordinary Host URL. Keep credentials out of the renderer. Desktop may also mount Token.
