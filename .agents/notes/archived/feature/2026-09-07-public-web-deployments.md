# Agent Note: Advertised public HTTP(S) Web roots

Status: implemented
Archived: 2026-09-30

English | [中文](2026-09-07-public-web-deployments.zh.md)

## Problem

A forwarding gateway can expose the Web GUI beneath a shared HTTP(S) origin and strip its path prefix before forwarding, so one process answers loopback `/` and an external mount at once — a mount the listener cannot know and an origin only the operator knows. A proxied request carries that external authority in `Host`, which the browser-trust fence refuses until the deployment declares it.

## Decision

`--public-url` is an optional advertised HTTP(S) application root — `http(s)://`, an optional forwarding prefix, and no credentials, query, or fragment — reaching the Web bundle's `publicUrl` config through `src/public-url.ts`. It supplies the printed and opened URL, `DSH_WEB_URL`, and the web-surface orientation, and configures no routing, client transport, or cookie scope. The config field and the CLI flag are both advertisement only: the browser-visible authority must be named with repeatable `--trusted-host`, and the fence still validates `Host` and `Origin` per request, so advertisement grants neither identity nor authentication.

The advertised root is the first production input that can carry a mount prefix, so the launch flow adds the launch token without collapsing that mount. Network listening stays explicit and independent — the shipped CLI refuses a wildcard `--host` — and the proxy owns the external leg, whose required operations the [public deployments guide](../../../../docs/user/guide/public-deployments.md) publishes.

## Alternatives considered

**Let the advertised root select routing and cookies.** One root would supply every browser URL and cookie path, but the advertisement would then decide request routing, so one process could no longer serve loopback and a prefixed mount at once.

**Fold the advertised host into trustedHosts.** Rejected: advertisement must not change the fence, and #4181 keeps trust explicit.

**Have the backend emit mount-aware URLs.** A configured `<base>` or prefixed asset paths would require the webserver to know the external mount and duplicate knowledge the proxy already holds.

**Infer the external leg from requests or forwarded headers.** Request-derived authority is spoofable, and accepting stripped and preserved paths alike leaves the deployment ambiguous.

**Infer network exposure from the advertised root or a trusted host.** A display or authority choice cannot authorize opening every interface, so listener selection stays explicit and a wildcard host stays rejected.

## Consequences

The advertised URL carries no credential until the process adds its launch token, and a misconfigured address can still disclose it. An HTTP root carries that tokenized URL and the session cookie without TLS, and an HTTPS root encrypts only the browser-to-proxy leg.

Advertising an authority admits nothing on its own: a browser reaching the deployment under any non-loopback authority stays outside the fence until `--trusted-host` names it.

## Testing

`tests/public-url.spec.ts` covers URL validation and normalization; `tests/startup.spec.ts` covers the flag over a real Loader tree, including that the advertised host leaves the accepted authorities untouched; `tests/web-app.spec.ts` covers the printed URL, handoff, web-surface prompt, `DSH_WEB_URL`, and a `null` field advertising loopback; `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts` boots the built profile with `--public-url` behind the reference prefix-stripping proxy and authenticates through both the advertised mount and loopback, so the bundle patch's `publicUrl` expression is exercised as shipped.
