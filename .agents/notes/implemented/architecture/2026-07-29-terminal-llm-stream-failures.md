# Agent Note: Terminal LLM stream failures

Status: implemented

English | [中文](2026-07-29-terminal-llm-stream-failures.zh.md)

This note supersedes the thrown-error identity and call-local sidecar mechanism in [bounded LLM request recovery](2026-06-21-bounded-llm-request-recovery.md), which retains structured failure facts, retry policy, and durable attempts. The [compaction reference](../../../../packages/compaction/compaction-basic/README.md) defines current overflow recovery.

## Problem

An adapter failure had two public representations: an exception from selection, dispatch, iterator construction, or iteration, and an in-band `finish { kind: 'error' | 'aborted' }`. `LlmRuntime` tagged thrown objects in a stream-keyed sidecar so the agent loop could distinguish them from middleware and consumer failures. The consumer still needed a catch around iteration, signal checks, chunk logging, and assembly; correctness therefore depended on proving which statement threw and consulting metadata attached to the exact returned iterable.

Retry policy had the same indirect ownership. It was discovered through the stream sidecar after dispatch even though `prepareCall()` had already captured the serving registration. A wrapper-owned route and an adapter-owned route consequently shared one opaque lookup API despite having different authority.

## Decision

`LlmRuntime` is the normalization boundary for one adapter attempt. It catches only final-adapter selection, synchronous dispatch, iterator construction, and `next()` failures, converts the thrown value to immutable `LlmFailure`, and emits one terminal `finish`. Caller cancellation or an `ABORTED` failure selects the aborted reason; every other adapter failure selects error. An adapter may also emit either terminal reason directly.

The adapter-owned catch ends before each yielded chunk. Errors from `llm/stream` middleware, nested calls, adapter cleanup, chunk consumers, logging, signal checks, and assembly remain thrown as defects or lifecycle failures; they never enter model-request recovery. A transport failure after partial deltas may leave blocks open before a terminal error or aborted finish. No assistant message or tool call is assembled from that incomplete output.

`PreparedLlmCall` exposes the immutable retry policy captured with its config and registration. One-shot reuse and config mismatch remain synchronous `INVALID_PREPARED_CALL` misuse errors. A route served entirely by `llm/stream` middleware has no prepared registration and therefore no serving policy.

The agent loop consumes one failure representation. It iterates and logs chunks without a classification catch, inspects the terminal finish, and passes its failure facts plus the prepared policy to `agent/request-error`. The public `isLlmAdapterFailure`, `llmFailureOf`, and `llmRetryPolicyOf` sidecar APIs are absent.

## Alternatives considered

**Keep call-local error tagging.** This preserves thrown object identity, but makes every consumer catch a region containing its own fallible work and couples classification to the identity of an iterable wrapper. The original error object has no durable role in recovery; normalized facts are the useful boundary value.

**Require every adapter to emit failure chunks and forbid throws.** Library iterators, transports, and JavaScript dispatch can still throw. Requiring every adapter to reproduce the same catch boundary duplicates ownership and does not protect a direct `LlmRuntime` consumer from an incomplete implementation.

**Catch every iteration error in the agent loop.** The loop cannot reliably distinguish provider failure from middleware, session append, cancellation, or assembly failure without restoring a sidecar map from stream objects to the adapter calls that created them. Classification belongs where the adapter call is made.

**Return a `Result` before streaming.** A pre-stream result cannot represent a transport failure after partial output without adding a second response lifecycle. The existing terminal chunk already represents both early and late attempt outcomes.

## Consequences

All `LlmRuntime.stream()` consumers receive adapter operational failures through one typed terminal protocol, while programming and lifecycle failures retain ordinary exception semantics. Recovery gives up exact thrown-object identity and exposes only detached provider-neutral facts. The stream service owns slightly more adapter plumbing, but consumers delete catches that identify which adapter threw and delete stream-keyed metadata. Prepared calls carry their policy explicitly, and middleware-only routing remains visibly policy-free.
