# Agent Note: Scriptable LLM wire fault server

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-25-scriptable-llm-wire-fault-server.zh.md)

## Problem

Adapter unit tests use local HTTP servers to classify individual provider failures, while retry tests use an in-process scripted `LlmAdapter` to prove closed-step recovery. Neither boundary provides a reusable server for running the shipping HTTP adapter, agent loop, and retry policy together, and neither lets a developer point an existing app at deterministic transport faults by changing only its base URL and API key.

Connection refusal, a reset before the first event, clean EOF without `[DONE]`, a valid content-less completion, and a reset after partial output have different adapter and recovery outcomes. Treating them as one generic mock failure hides whether the provider boundary preserved the distinction and whether failed chunks remained outside committed model history.

## Decision

`@deepseek-ai/dsh-llm-mock-server` is a private support package with an importable Node HTTP server. The repository-local `pnpm run mock:llm` source entry provides a standalone process for manual fault injection; the package exposes no installable binary. It accepts OpenAI-compatible root and `/v1` chat-completions paths, validates an optional bearer token, captures requests, and consumes one explicit behavior per accepted request. Script exhaustion fails loud; repetition requires `repeatLast`.

Request behaviors cover socket reset, post-header disconnect, partial disconnect, stall, valid empty completion, clean truncated streams, malformed payloads, representative HTTP failures, complete text/reasoning/tool-call responses, slow streaming, and max-token completion. A true `connection_refused` is a CLI listener-lifecycle phase because a bound request handler cannot refuse its own TCP connection.

The `random` script entry performs a new weighted selection for every request. The server exposes and logs its unsigned 32-bit seed, accepts caller-supplied relative weights, and ships a success-heavy stress profile that mixes transport, protocol, provider, timeout, and semantic-empty outcomes. The profile is configurable test pressure rather than an estimate of production incident frequency; `connection_refused` remains outside the request-level pool.

The server reports wire facts only and does not classify retryability. Real-composition tests route it through `dsh-llm-deepseek`, `dsh-agent-loop`, and `dsh-llm-retry`: connection refusal, hard disconnect, partial reset, idle timeout, and a valid content-less completion recover under the existing default policy; clean partial EOF remains `STREAM_CLOSED` and is not retried by default. The package does not change those policies.

## Verification

Package tests exercise every request behavior, split UTF-8 request decoding, HTTP validation without script consumption, script exhaustion/repetition, stalled-connection teardown, CLI parsing and delay bounds, IPv6 base URLs, random seed reproducibility, weight validation, single-result telemetry, lifecycle cleanup, and the invariant companion under the per-file coverage gate. The retry integration suite proves exact request counts, numbered retry steps, request-body identity, failed partial-chunk isolation, semantic-empty recovery, clean-EOF classification, timeout recovery, true refused-connection recovery after delayed listener startup, and bounded exhaustion through the real HTTP/SSE adapter.

## Alternatives considered

**Implement the server in Python** — rejected because Node's standard HTTP and socket APIs expose every required fault, while TypeScript keeps the server, CLI parser, tests, package build, lint, and coverage inside the repository's existing toolchain. A second runtime would add environment and subprocess dependencies without increasing wire isolation.

**Keep separate inline mock servers in adapter tests** — rejected because those fixtures cannot be launched by an existing app and would duplicate behavior sequencing, randomization, telemetry, and connection cleanup across suites. A support package gives tests a shared implementation without promoting it to product API.

**Use only an in-process `LlmAdapter` mock** — rejected because it bypasses fetch, HTTP status/header parsing, SSE framing, socket termination, and the adapter idle watchdog: the exact boundaries this test infrastructure exists to exercise.

**Expose an installable workspace binary** — rejected because pnpm links dependency binaries before repository build outputs exist, coupling clean installs to a test-only artifact. The repository-local source command supports the same manual fault injection without adding a package installation surface.

**Change retry defaults with the server** — rejected because the server reveals existing semantics rather than deciding policy. Extending recovery to `STREAM_CLOSED` requires a separate decision with its own cost, latency, and duplicate-generation trade-offs.

## Consequences

Developers can reproduce fault sequences by changing only provider URL/key configuration, and automated tests can keep socket-level failures deterministic through explicit scripts and seeds. The same wire fixture now exposes gaps between hard resets, clean truncation, and recovered empty completions without splicing attempts or modifying model history.

The server adds a private support package and behavior vocabulary that must remain compatible with both direct tests and repository-local CLI examples. Arrival-ordered scripts are intentionally shared across clients, random defaults are stress weights rather than operational truth, and exact connection refusal requires coordinating the client attempt with the pre-listen interval.
