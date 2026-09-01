---
description: "Scriptable OpenAI-compatible fault server for testing LLM adapters and recovery policy without a provider key, for test authors and demos."
kind: "package-library"
---

# @deepseek-ai/dsh-llm-mock-server

English | [中文](README.zh.md)

## Summary

`dsh-llm-mock-server` stands in for a real model provider during tests as a scriptable OpenAI-compatible HTTP/SSE server: you script a sequence of wire behaviors — stream resets, stalls, malformed chunks, rate limits, server errors, successful completions, tool calls — and each accepted `/chat/completions` request consumes the next one. It serves the shipping DeepSeek adapter and the agent loop over real HTTP, so recovery policy such as retries, backoff, and timeouts is exercised against a genuine wire boundary without a provider key. A CLI (`pnpm run mock:llm`) runs the server standalone; the library entry `startMockLlmServer` embeds it in tests and returns captured requests. A `random` behavior with seeded weights mixes failures for open-ended stress runs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package lets a test or demo speak the provider protocol without a provider: start the server, script the wire behaviors you want to exercise, and point a real LLM adapter at its base URL.

### Running it standalone

Run the source entry from this repository:

```sh
pnpm run mock:llm \
  --port 8000 \
  --api-key mock-key \
  --sequence partial_disconnect,success \
  --partial-text "discard this half"
```

Point the shipping DeepSeek adapter at the server; it appends `/chat/completions` to the configured base:

```sh
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1 \
DEEPSEEK_API_KEY=mock-key \
pnpm dsh --profile headless "test provider recovery"
```

The repository script writes JSONL to stdout: a `ready` record carries the `/v1` base URL and random seed, followed by request/result records that name both the scripted behavior and the concrete behavior selected. The package exposes no installable binary.

### Scripting behaviors

`--sequence` is a comma-separated FIFO. Exhaustion returns a structured HTTP 500; `--repeat-last` explicitly reuses the last entry.

| Behavior | Wire result |
|---|---|
| `connection_reset` | Destroy the socket before HTTP headers |
| `stream_disconnect` | Send SSE headers, then reset before the first event |
| `partial_disconnect` | Send text deltas, then reset the socket |
| `stall` | Send SSE headers and remain idle until client/server cancellation |
| `empty` | Send a valid content-less stop and `[DONE]` |
| `empty_body` / `stream_eof` / `partial_eof` | End cleanly without the required `[DONE]` boundary |
| `malformed_json` / `malformed_event` | Send invalid SSE JSON or an invalid provider chunk shape |
| `rate_limit` / `server_error` / `service_unavailable` | Return retry-oriented 429/500/503 JSON errors |
| `auth_error` / `invalid_request` / `context_overflow` / `quota_exceeded` | Return terminal or separately recovered provider errors |
| `success` / `slow_success` / `reasoning_success` | Stream a complete text response, optionally delayed or preceded by reasoning |
| `tool_call_success` / `max_tokens` | Complete with a tool call or `length` finish |
| `wrong_content_type` | Send a valid SSE body under `application/json` |
| `random` | Select a concrete request behavior from weighted seeded randomness |

`connection_refused` is CLI-only and must be the first entry. It delays binding a caller-specified nonzero port, so requests during `--listen-delay-ms` receive a real TCP refusal; the remaining entries begin after the listener starts.

### Random mode

Use a repeating `random` entry for an open-ended mixed run:

```sh
pnpm run mock:llm \
  --port 8000 \
  --sequence random \
  --repeat-last \
  --seed 42 \
  --random-weights 'success=60,slow_success=10,connection_reset=5,stream_disconnect=5,partial_disconnect=10,empty=5,server_error=5'
```

Omitting `--seed` generates one and prints it in the `ready` record. `--random-weights` accepts non-negative relative `behavior=weight` entries and requires at least one positive concrete behavior. The exported default is a success-heavy stress profile containing reset, disconnect, partial output, empty completion, stall, 429/5xx, clean truncation, and malformed JSON; it is test pressure, not an estimate of production incident frequency. `connection_refused` is excluded because a bound request handler cannot produce a true refusal. When random weights include `stall`, configure the client under test with a short stream-idle timeout so the scenario terminates promptly.

### Timing and content controls

The CLI exposes `--success-text`, `--partial-text`, `--reasoning-text`, `--chunk-size`, `--chunk-delay-ms`, `--disconnect-delay-ms`, `--retry-after-ms`, `--request-id`, `--tool-name`, and `--tool-arguments`. Millisecond delays are bounded integers within Node's timer range; `retryAfterMs` must also be positive. The library accepts the same camel-case options. An optional exact `apiKey` validates `Authorization: Bearer <token>`; omission accepts any token.

### What can go wrong

- **The script runs out** — exhaustion returns a structured HTTP 500; set `--repeat-last` or lengthen the sequence when a run needs more requests.
- **Random weights without a positive concrete behavior are rejected** — every entry must name an existing behavior and at least one must carry positive weight.
- **Invalid requests do not consume the script** — wrong methods, paths, bearer tokens, and malformed JSON get ordinary 4xx responses, so a misconfigured client can burn retries without advancing the sequence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the server; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

The server is built on one rule: each accepted chat-completions request consumes exactly one behavior from an arrival-ordered FIFO cursor, and the server never retries or interprets harness policy. Validation happens before the cursor advances — only a `POST` whose path ends in `/chat/completions`, with a valid bearer token when one is configured and a parseable JSON body, consumes the script; everything else receives an ordinary 4xx. `random` entries resolve at request time through a seeded PRNG over the configured weights, so a run is reproducible from its printed seed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `startMockLlmServer`: listener, behavior table, seeded randomness, telemetry, captured request records |
| [`src/cli.ts`](src/cli.ts) | `--sequence` and timing/content option parsing, JSONL stdout telemetry |
| [`src/bin.ts`](src/bin.ts) | The `pnpm run mock:llm` source entry |
| — | No runtime invariant companion is published; this standalone test server owns no Cordis event stream or shared data; its wire behavior and lifecycle are exercised through direct HTTP and assembled-loop tests. |

### Wire flow

A request enters the handler, is validated, and selects a behavior: a concrete script entry runs directly, `random` draws one, and an exhausted script reports `script_exhausted` as a structured 500. `runBehavior` then executes the wire result — socket destroy, SSE stream, JSON error, or completion — while every request and outcome is recorded in arrival order on the returned handle for test assertions. `close()` stops accepting requests and force-terminates stalled connections.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the fault server to the adapter contract it exercises and the keyless alternative for recorded success transcripts.

- [LLM package](../../llm/llm/README.md) — the provider stream contract and retry policy this server exercises.
- [llm-replay](../llm-replay/README.md) — the keyless counterpart that replays recorded success transcripts instead of faulting.
- [Testing policy](../../../docs/testing.md) — the coverage tiers and recovery tests this server serves.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this test server substitutes provider wire behavior without invoking a real model.

#### KV Cache effect

None; requests terminate locally and never reach a provider cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the server needs special care. They are current package constraints, not a task backlog.

- **Random weights model test pressure, not production incidence** — callers that want an environment-specific distribution must provide measured weights and record the emitted seed.
- **Request scripts are arrival-ordered** — concurrent callers share one cursor, so deterministic per-session fault assignment requires separate server instances.
- **True connection refusal is a listener lifecycle phase** — the CLI delay must overlap the client attempt; request-level random selection can only reset an accepted connection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
