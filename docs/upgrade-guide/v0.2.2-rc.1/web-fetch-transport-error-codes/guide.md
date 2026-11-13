---
kind: upgrade-guide
description: "Local HTTP fetch transport failures raise classified WEB_FETCH_* codes instead of WEB_PROVIDER_ERROR."
---

# Local HTTP fetch transport failures use classified codes

English | [中文](guide.zh.md)

## Change

The local HTTP fetch provider (`dsh-web-fetch-http`) previously raised `WEB_PROVIDER_ERROR` with the text `web fetch failed: TypeError: fetch failed` for every network failure before or during the response. It now raises one of `WEB_FETCH_DNS_FAILED`, `WEB_FETCH_CONNECTION_REFUSED`, `WEB_FETCH_CONNECTION_TIMEOUT`, `WEB_FETCH_CERTIFICATE_INVALID`, `WEB_FETCH_CONNECTION_INTERRUPTED`, `WEB_FETCH_NETWORK_UNREACHABLE`, or `WEB_FETCH_NETWORK_ERROR` for an unrecognized failure. The message names the failure class, the system error code, and the underlying error. The same code appears in the `error.code` of new `web_fetch` tool results. Callers of `ctx.web.fetch()` and readers of tool-result error codes that match `WEB_PROVIDER_ERROR` for network failures are affected. Other providers, and other `dsh-web-fetch-http` failures, are unchanged.

## Migration

1. Where code routes local fetch network failures on `WEB_PROVIDER_ERROR`, match the seven codes above instead.
2. Do not parse the message text; it is diagnostic and may change.
3. Confirm by fetching an unresolvable host, such as `http://example.invalid/`, and checking that the error code is `WEB_FETCH_DNS_FAILED`.
