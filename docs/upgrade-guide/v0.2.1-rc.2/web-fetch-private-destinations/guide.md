---
kind: upgrade-guide
description: "The HTTP fetch provider no longer rejects non-public destinations, and HttpFetchProvider no longer accepts an address resolver."
---
# `web_fetch` reaches private destinations

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-web-fetch-http` used to resolve each hostname, reject any loopback, private, link-local, or reserved answer with `WEB_BLOCKED_URL`, and pin the connection to the validated addresses. It now sends every request through the installed proxy policy and the system resolver, so `web_fetch` reaches loopback, private-network, and cloud metadata hosts. Fetches behind TUN-mode proxies with fake-IP DNS work without configuration.

The package no longer exports `HttpFetchResolver`, and the `HttpFetchProvider` constructor takes only `HttpFetchLimits`.

Deployments that relied on the provider to keep the model away from private services are affected, as is code that passed a resolver to `HttpFetchProvider`.

## Migration

1. If the model must not reach private destinations, confine the process's network access, add a `tools/pre-execute` policy that rejects those `web_fetch` URLs, or remove `@deepseek-ai/dsh-tool-web`'s fetch tool from the composition.
2. Replace `new HttpFetchProvider(limits, resolveAddresses)` with `new HttpFetchProvider(limits)`. To direct a test request to a local server, put the server's address in the URL instead of overriding resolution.
3. Confirm the migration with `pnpm run typecheck`; no reference to `HttpFetchResolver` remains.
