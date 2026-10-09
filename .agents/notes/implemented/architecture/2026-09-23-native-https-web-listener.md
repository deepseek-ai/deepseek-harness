# Agent Note: Native HTTPS on the Web listener

Status: implemented

English | [中文](2026-09-23-native-https-web-listener.zh.md)

## Problem

A directly reached Web listener needs to encrypt launch tokens and session cookies without requiring a separate reverse proxy. Advertising an HTTPS URL does not encrypt the listener or establish certificate trust.

## Decision

WebServer owns optional TLS through `tls: { certFile, keyFile }`, exposed by `dsh web` as paired `--tls-cert` and `--tls-key` flags. Certificate and unencrypted private-key PEM files are loaded before binding; unreadable, empty, invalid, or mismatched material fails activation without an HTTP fallback. HTTP remains the default. Both transports share routing, upgrades, and disposal; disposal also owns incomplete TLS handshakes.

`webServer.protocol` is the source for the bind-address URL, the non-loopback plain-HTTP warning, and Connection's `Secure` cookie attribute. Neither forwarded headers nor `publicUrl` control encryption or that attribute. Explicit Host-port grants normalize under the listener's scheme, while Origin comparison uses the Origin's HTTP(S) scheme so HTTPS proxies can retain HTTP upstreams. TLS grants no additional Host authority and does not replace authentication.

The API authority check does not equate a proxy's upstream transport with the browser page's scheme. An HTTPS listener can accept a matching HTTP Origin, but `sec-fetch-site: cross-site` still rejects the request and authentication remains required. Schemeful `SameSite=Strict` cookies prevent cross-scheme browser credential delivery; this is not support for serving a public browser frontend over HTTP with a TLS upstream.

HTTP cookie audiences retain their existing spelling so enabling TLS support does not invalidate unrelated HTTP sessions. HTTPS cookie names and signed audiences include the `https:` scheme, preventing replay of an HTTP credential on any HTTPS port even if the cookie is renamed. Default ports follow URL normalization without a separate port-443 spelling.

Certificate issuance, trust, renewal, and replacement belong to the operator. Files are read once per activation; replacement requires a listener reload or process restart. The certificate must cover the hostname or IP the TLS client dials. The default port remains 3080; `--port` selects another port, subject to operating-system permission.

## Alternatives considered

**Require a TLS-terminating proxy.** This remains supported, but requires another service for a directly reached listener.

**Derive transport or cookie security from `publicUrl` or forwarding headers.** An advertisement does not describe the receiving socket, and request headers cannot establish trusted proxy identity. Native listener state keeps this decision independent of proxy policy.

**Issue, renew, or generate certificates.** This would add certificate lifecycle and trust-distribution responsibilities. An automatically generated certificate would not establish browser trust.

**Fall back to HTTP on certificate errors.** This would expose credentials despite an explicit request for encryption; activation must fail instead.

## Consequences

Direct HTTPS needs no TLS-terminating proxy. An HTTPS proxy in front of an HTTP listener still owns external cookie rewriting. An HTTPS listener emits `Secure` cookies, so public browser-facing deployments must retain HTTPS rather than depend on local-browser exceptions for HTTP. Deployment procedures belong to the [public deployments guide](../../../../docs/user/guide/public-deployments.md).

This partially supersedes the HTTP-only assumptions in [browser launch-token authentication](2026-08-24-browser-token-authentication.md) and [concrete bind addresses](2026-09-19-concrete-web-bind-address.md). Those notes remain active for cookie payloads and lifetimes, and bind admission respectively.

## Testing

The WebServer suite covers verified HTTPS, invalid material, and disposal. Connection covers listener-owned cookie attributes, cross-protocol credential replay, and exact-port grants; Web startup rejects unpaired flags. The built CLI's `public-url.expected.e2e.ts` authenticates over verified TLS with a `Secure` cookie while retaining HTTP and proxy cases; its failure matrix verifies unreadable TLS material exits without opening a listener. Desktop's startup suite covers matching WS/WSS credentials and refusal on a different transport.
