# Agent Note: Recover DeepSeek image requests from Files resolution failures

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-deepseek-files-inline-fallback.zh.md)

## Problem

The direct DeepSeek vision route uses provider file ids so repeated requests do not resend image bytes. An unavailable, unsupported, or stalled Files endpoint can prevent chat before the model request begins even though the same endpoint still accepts inline image data. A fallback that retains the 128MiB Files budget would exceed the inline request-body limit, while a fallback that independently transforms images could send different pixels from the failed file-id attempt.

## Decision

Files remains the preferred transport. Each request-image file resolution has the configurable `filesApiTimeoutMs` deadline, one minute by default. The stream idle deadline defaults to five minutes, so the Files deadline normally leaves time for inline fallback. A deployment may configure the stream idle deadline to expire first. Successful resolutions refresh the outer idle watchdog. Caller cancellation and the outer stream deadline remain terminal outcomes.

A file resolution failure discards the transient file parts assembled for that chat attempt and rebuilds the complete image request with base64 data URLs. Every retained image uses the already prepared deterministic `RequestImageAttachment`; the fallback performs no additional decode, resize, or encode, and a chat request never mixes file ids with inline images. Upload mappings committed before a later image fails remain available to later requests. The next request tries Files again, so recovery requires no process-wide outage state.

Inline fallback has a separate base64-expanded high watermark, `maxInlineRequestImageBytes`, of 20MiB by default. `inlineImageOffloadByteQuantum` defaults to 10MiB, so crossing the high watermark advances the deterministic oldest-image prefix to the next 10MiB removal boundary. The existing 600-image bound and count quantum still apply. File mode retains its 128MiB high watermark and 64MiB removal quantum.

Provider chat errors keep their existing classifications. A stale file id is invalidated, re-uploaded, and retried once. If that replacement resolution fails, the permitted retry uses the inline representation. A generic chat failure does not switch transports because it does not establish that Files resolution failed.

## Alternatives considered

**Send inline images first.** Rejected because successful Files uploads allow deterministic request bytes to be reused across turns without repeating base64 in every request.

**Mix resolved file ids with inline images after one upload fails.** Rejected because the request would still depend on the failing Files service and would have two independent image budgets.

**Apply the 128MiB Files bound to inline fallback.** Rejected because base64 expands the payload and can exceed the chat request-body limit. The 20MiB budget leaves space for JSON, text history, and tools.

**Remember an outage and bypass Files on later requests.** Rejected because a process-local circuit state introduces recovery timing and shared failure state. Retrying Files on the next request detects service recovery without another timer.

## Verification

Serializer tests cover file and data-URL representations over the same request versions, all supported media types, tool-result placement, and 20-to-10 base64 offload. Adapter tests cover immediate resolution failure, failure after a partial set of file ids, deadline-triggered fallback, stale-id replacement failure, all-inline request bodies, caller cancellation without fallback, and generic chat failure without a transport switch. Configuration tests cover both inline bounds and independent Files and stream idle deadlines.

## Consequences

A Files outage no longer prevents an image chat that fits the inline budget. Fallback repeats image bytes and may omit more history than file mode because its limit is lower. A request can leave successful uploads behind when a later image fails, but their indexed mappings are reusable and do not change the chat body sent by the fallback. Explicit file-management operations continue to expose their own failures.
