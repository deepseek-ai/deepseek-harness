# Agent Note: DeepSeek LLM API request extensions for session logs and plugin packages

Status: implemented

English | [中文](2026-08-21-deepseek-llm-api-request-extensions.zh.md)

## Problem

The canonical Session log contains request boundaries, raw response chunks, assembled messages, tool activity, plugin events, and failure facts that the model message list does not preserve. The OTel session-telemetry path projects and batches that log independently of model requests, uses deployment-selected sharing modes, and intentionally drops most assistant chunks. DeepSeek's official API therefore cannot reconstruct the complete harness trajectory from its ordinary request messages or the telemetry feed.

Provider-side diagnosis also needs the exact active plugin package versions that produced a request. The existing browser-facing plugin inventory reports configured Loader rows and lifecycle phases but owns neither package-manifest resolution nor the requesting agent's standing preset composition.

Both values belong only on the official DeepSeek adapter path. Adding them to `GenerateOptions` or the provider-neutral LLM seam would expose DeepSeek wire concepts to pi-ai and every future adapter.

## Decision

`@deepseek-ai/dsh-deepseek-llm-api-extensions` registers `ctx.deepseekLlmApiExtensions`, an additive registry of top-level fields for `deepseek-official` request bodies. A contributor claims one declaration-merged field with `register()`. The adapter invokes `prepare()` after serializing the exact wire messages, passes the request cancellation signal, rejects preparation or base-field collision before HTTP, merges the detached fields, and calls the captured `accept()` transaction after HTTP 2xx. The registry stops awaiting preparation after cancellation even if a contributor ignores the signal. Acceptance failures remain request failures under `REQUEST_EXTENSION`; transport and non-2xx failures never accept a contribution. A composition without the registry retains the reusable base adapter. Shipped compositions mount the registry and both contributors: package metadata is enabled by default, while Session-log upload is disabled by default and requires `session-log-deepseek.enabled: true`. Keyless `deepseek-official` replay invokes preparation with a synthetic empty base body and the same acceptance transaction before its first recorded chunk, preserving post-2xx extension side effects rather than field bytes.

The provider-neutral `llm` package and `llm-pi-ai` contain no extension type, service lookup, field merge, or acceptance call.

## Incremental session-log field

`@deepseek-ai/dsh-session-log-deepseek` owns `dsh_session_log` as an explicit opt-in. When enabled, each request carrying a live Session id sends the contiguous canonical event suffix after the greatest durable `session-log-deepseek/delivery-accepted` watermark for that same Session identity. The field includes the immutable Session header and complete event envelopes. A 2xx appends a new watermark for the transmitted `throughSeq`; that event enters the following request's suffix. Forked logs retain parent watermark ids, so a child starts from sequence zero under its own identity. Concurrent acceptances may arrive out of order, and the maximum watermark remains authoritative. A process-local fold scans each Session event once and incrementally consumes later appends; a new Session object or HMR generation rebuilds the fold from durable history.

The failure direction is at least once. A transport or provider rejection records no watermark. A crash after remote acceptance but before the watermark persists causes replay after resume, never a skipped sequence. Existing session checkpoints persist the event; the upload plugin owns no second store.

The `events` array contains complete canonical `SessionEvent` objects directly. The sender copies every present event member without projection or redaction; the field is self-contained and requires no reconstruction against `messages`.

## Plugin package field

`@deepseek-ai/dsh-plugin-package-inventory-deepseek` owns the default-on `dsh_plugin_packages` field from the `llm` package family. It reads active non-group entries from the host Loader tree and, for a live requesting Agent, its standing preset tree. Node package resolution locates the owning manifest without requiring a `./package.json` export. Ordinary entries resolve from their owning tree, while a standing preset root mirrors its Loader's intentional harness-base override and nested includes retain their own bases. An anonymous nearest manifest marks a loose module; a named manifest must carry a version. Exact name/version pairs are deduplicated with deterministic ordering; simultaneously active versions remain separate.

Disabled, pending, failed, unloading, disposed, structural, loose non-package, ordinary dependency, programmatic child-fiber, and in-memory dynamic-plugin entries are outside this package inventory. This definition reports package-backed composition facts the runtime can prove instead of inventing provenance for arbitrary callbacks.

## Deferred inventory caching

The implementation deliberately recalculates the active package set for every request while caching manifest identities for the process lifetime. A synthetic host-only benchmark on Node v24.16.0, macOS arm64 used unique active relative plugin packages, 20 warm-up requests, then 500 measured requests for 25 and 100 entries and 250 for 500 entries. “First request” includes uncached manifest reads; “cached-provider median” returns a prebuilt field through the same registry, so it retains `structuredClone()` and freeze costs but excludes adapter JSON serialization and network time.

| Active entries | First request | Current warm median | Current warm p95 | Cached-provider median |
|---:|---:|---:|---:|---:|
| 25 | 1.23 ms | 0.05 ms | 0.07 ms | 0.02 ms |
| 100 | 2.23 ms | 0.14 ms | 0.24 ms | 0.04 ms |
| 500 | 10.22 ms | 0.60 ms | 0.79 ms | 0.18 ms |

These measurements keep the cache deferred: even 500 entries stay below one millisecond at steady state, and the estimated saving is about 0.42 ms before unavoidable JSON serialization. A real profile showing material `prepare()` latency is the trigger to add the cache rather than a fixed entry-count threshold.

The deferred design uses one monotonic inventory epoch. A global `internal/status` listener advances it whenever a Loader entry's root fiber crosses the `FiberState.ACTIVE` boundary, covering dependency activation, disablement, unload, and HMR without a time-based stale window. The contributor caches the Host snapshot by epoch, caches each standing preset `EntryTree` in a `WeakMap`, and caches the combined Host-plus-preset result by tree and epoch. Already-sorted snapshots merge and deduplicate exact `(name, version)` pairs in linear time. A calculation whose epoch changes before settlement retries instead of publishing a stale snapshot; disposed preset trees remain collectible through the `WeakMap`.

The process-lifetime manifest-identity cache remains separate because in-process package-version replacement is not supported.

## Verification

Registry tests pin duplicate ownership, effect-scoped disposal, detached field values, concurrent and abortable preparation, receiver-preserving acceptance, one acceptance settlement, and failure aggregation. Session tests pin the default-off policy, explicit full-first/suffix-later delivery, direct complete event envelopes independent of base-body messages, incremental watermark folding, persisted restart recovery, fork identity fencing, out-of-order acceptance, and late invariant loading. Package-inventory tests pin default-on and explicit-off policies, host and standing-preset discovery, conflicting Loader resolution bases, manifest resolution, lifecycle filtering, and exact name/version ordering. The direct adapter mock proves pre-HTTP preparation failure, cancellation, non-2xx non-acceptance, 2xx acceptance before a later stream failure, and field collision. Keyless replay pins post-2xx extension acceptance, and the TypeScript JSON-RPC plus Python packaged-runtime snapshots project the acceptance event through both SDKs. Real Loader composition pins default package metadata plus opt-in Session upload, one real-API request mounts both shipped extensions and proves the official endpoint accepts them, and pi-ai tests retain their unchanged wire requests.

## Alternatives considered

**Add generic metadata to `GenerateOptions` or `ctx.llm`.** Rejected because the values and acceptance timing are DeepSeek wire semantics; a provider-neutral request would make every adapter understand or ignore foreign fields.

**Hard-wire the two producers into `llm-deepseek`.** Rejected because the adapter would import Session, Loader, preset, package-manifest, and cursor logic. The registry keeps transport responsible only for field merge and HTTP acceptance.

### Why not request-relative message references?

A recursive tagged representation could replace exact event-string ranges with paths and UTF-8 byte offsets into the containing request's `messages`. Measurement used Node v24.16.0 on macOS arm64 and the three largest available local Zstandard Session artifacts, whose compressed artifact sizes were 2,437,052, 572,602, and 118,811 bytes. Late-enable replay used each final completed request boundary; steady replay covered 411 completed boundaries. The byte counts cover complete minified DeepSeek requests.

| Replay | Raw JSON | Referenced JSON | Saving | Synchronous encoder time |
|---|---:|---:|---:|---:|
| Late enable | 29,668,725 B | 27,645,825 B | 6.82% | 500.1 s total |
| Steady state | 389,295,815 B | 387,180,848 B | 0.54% | 285.0 s total |

The three late-enable calls took 470.5, 29.4, and 0.158 seconds. Only 701 of 115,071 events (0.61%) selected references. A hypothetical level-6 whole-request gzip comparison reduced raw request bytes by 89.38% for late enable and 73.42% for steady state; message references added 21.68% and 0.59% respectively after gzip.

The receiver would also need to traverse the tagged tree, resolve paths into the exact request messages, validate UTF-8 ranges, and reconstruct every referenced event. Even treating that receiver cost as zero, the steady-state byte saving, synchronous sender cost, and dependence on another request field do not justify a versioned wire format.

### Why not omit assistant chunks or overlapping event data?

About 98% of the measured v1 real-session events were `assistant/chunk`. Omitting them after reference encoding reduced the complete identity JSON by another 84.79% for late enable and 6.49% for steady state, but prevented lossless reconstruction and left message provenance dangling. V2 embeds compact streams in attempt settlements; `dsh_session_log` still sends every current canonical event whole and does not omit those embedded records. Fuzzy or normalized substitutions have the same reconstruction defect.

**Keep the upload cursor only in memory.** Rejected because a normal process restart would resend the entire Session. A canonical acceptance event makes restart recovery best-effort durable without another storage backend; the remaining crash window produces allowed duplicates.

**Inventory every live Cordis fiber.** Rejected because programmatic and in-memory fibers have no authoritative npm package provenance. Loader-backed host and preset entries provide exact resolvable package identity.

**Cache one process-global list or expire it on a TTL.** Rejected because one immutable list is incorrect for Loader lifecycle and per-Session presets, while a TTL permits stale metadata between expiry boundaries. The deferred epoch design invalidates on the authoritative active-state transition instead.

**Replace the complete field with a content hash or server-side inventory reference.** Rejected because it changes standalone request reconstruction and requires endpoint state plus a later wire version. That is a wire-byte protocol change, not a computation-cache optimization.

## Consequences

Official DeepSeek requests carry active package versions to their resolved `baseURL`, including configured gateways. An explicit Session-log opt-in also carries the complete newly unaccepted Session suffix. The fields are model-hidden and add no prompt tokens or KV-cache changes, but can substantially increase HTTP body size. Manifest resolution, field collision, acceptance logging, or provider schema rejection fails the model request rather than silently dropping metadata.

The `delivery-accepted` event becomes part of the canonical log and is itself delivered on a later request. Crash recovery can duplicate a suffix but does not infer acceptance from assistant output or create a second local cursor store. Direct calls without a live Session omit the session field; host package inventory remains available.

The [DeepSeek request-identity decision](../feature/2026-08-11-deepseek-request-user-id-header.md) continues to own user/session headers, which remain outside the body. The [session-telemetry decision](../feature/2026-07-23-session-telemetry-otel-revival.md) remains current until a separate change removes that seam and backend; this request path does not alter OTel capture or sharing modes.
