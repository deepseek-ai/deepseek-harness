# Agent Note: Bounded DeepSeek Session-log upload

Status: implemented

English | [中文](2026-09-24-bounded-session-log-upload.zh.md)
## Problem

Without a watermark of the current Session format generation, a request carries the whole canonical log: the first request after upload becomes enabled, the first request after a format migration, and the first request of a fork all do. A long log can exceed the V8 string limit of 2^29 − 24 UTF-16 code units on 64-bit hosts. The adapter's merged `JSON.stringify` then throws `RangeError`, the adapter reports `TRANSPORT`, the default retry policy repeats the same serialization, and no request reaches the 2xx that would advance the watermark, so every model request in that Session fails. Below the limit, one request can still carry hundreds of MiB: on Node v24.17.0 and macOS arm64, a 269 MiB first upload of a 96,341-event Session waited 34 s for its 2xx.

## Decision

`session-log-deepseek.Config.maxBytes`, 8 MiB by default, bounds the complete serialized `dsh_session_log` field in UTF-8 bytes. Each request carries the longest contiguous run after the watermark whose field, including the header and numeric envelope fields, fits the limit. Acceptance advances the watermark to that run's `throughSeq`, and later requests continue from there. When the first pending event alone exceeds the limit, the request omits the field, the plugin logs a warning, and the watermark stays before that event until `maxBytes` admits it. An event whose JSON text exceeds the runtime's string limit counts as exceeding every limit, so it blocks upload without failing the request, and the plugin serializes it once per request.

The DeepSeek adapter treats a merged request body that fails to serialize as an extension failure rather than a transport failure. It sends the base body without any extension field, skips the joint acceptance transaction, and reports the omitted field names through the provider plugin's logger, so contributors resend unaccepted state on a later request. A base body that cannot serialize still fails the request.

This supersedes complete-suffix delivery and fail-closed serialization in the [request-extension decision](2026-08-21-deepseek-llm-api-request-extensions.md). That note still owns field ownership, cancellation, acceptance, and the remaining fail-closed failures.

## Alternatives considered

**Serialize the whole pending run first and bound it only on overflow.** Measuring bytes requires serializing every candidate event either way. In a synthetic benchmark, a 14 KiB step took 14.3 µs whole versus 13.8 µs per event, while a 135 MiB backlog took 182 ms to serialize before any fallback versus 10 ms to fill 8 MiB. The whole-run attempt also still overflows the string limit for the logs that motivated this change.

**Send an oversized first event alone.** Exceeding the configured limit reintroduces the provider body-size rejections that still fail the model request. Omission keeps every request bounded, and the warning names the blocked event.

**Omit only the field that fails to serialize.** Acceptance is one joint transaction across fields, so per-field omission would split the registry's acceptance contract. Dropping every extension field on this path only leaves the small `dsh_plugin_packages` inventory out of one request.

## Consequences

A backlog drains at up to 8 MiB per accepted request by default. At the end-to-end rate measured for the 269 MiB upload, about 8 MiB/s, an 8 MiB field adds about 1 s to each request while a backlog drains, and a 0.86 GB backlog drains in about 100 requests. In the same 96,341-event Session, the median per-step append is 11 KiB and the largest event is 414 KiB, so ordinary steps stay far below the limit and only an unusual event or a small configured limit reaches the oversized-event path. While a backlog drains, the endpoint receives a `throughSeq` behind the Session's current tip. Preparation failures, acceptance failures, and provider rejections still fail the model request.

Plugin tests cover the exact byte boundary, UTF-8 counting, backlog draining across accepted requests, the oversized-event warning with its unchanged watermark, an event past the string limit, and the 8 MiB default through plugin configuration. Adapter tests cover the base-body fallback through the provider plugin's logger and through an adapter without a reporter.
