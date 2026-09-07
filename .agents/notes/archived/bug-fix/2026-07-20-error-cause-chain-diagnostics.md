# Agent Note: Render error cause chains at every diagnostic boundary

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-20-error-cause-chain-diagnostics.zh.md)

## Problem

A TUI run against an unreachable DeepSeek endpoint failed with the single notice `fetch failed` and no further detail. Two independent gaps produced that dead end:

1. undici's `fetch` wraps every transport failure (DNS, refused connection, TLS, proxy) in a bare `TypeError: fetch failed` whose actionable detail — `ECONNREFUSED`, `bad port`, the Happy Eyeballs AggregateError — lives on `error.cause`. Every diagnostic boundary in the harness rendered only `error.message` (or `String(error)`, which is equivalent for Errors), so the wrapper masked the diagnosis in the TUI notice, the durable `turn/end` reason, and every logger line.
2. The readline entry point (`dsh-stdio`) rendered no failure reason at all: a `turn/end` with `reason.kind === 'error'` printed nothing but the next `> ` prompt, so the same failure in `demo:repl` was pure silence.

## Decision

- `dsh-llm` exports `errorChain(value)`: renders a thrown value with its full `cause` chain (`outer: inner: …`) and AggregateError members (`msg [m1; m2]`), with circular-cause and hostile-coercion containment. It is a diagnostic-output renderer only; routing stays on `HarnessError.code`.
- The DeepSeek adapter wraps a pre-response transport failure in `LlmError('TRANSPORT')` naming the configured `baseURL` and chaining the original rejection as `cause`. An aborted request becomes `LlmError('ABORTED')`; because the turn signal is already aborted, the loop still classifies the turn as cancellation rather than recovery.
- Every diagnostic boundary renders through `errorChain` instead of `error.message`/`String(error)`: the agent-loop's durable `turn/end` error message (`errorData`), its logger warnings, the TUI's `agent/error` notice and startup-failure line, and `dsh-stdio`'s startup-failure log lines. The live `agent/error` event and `SettleReason` preserve the thrown value as `unknown`; each diagnostic Consumer renders it instead of the loop wrapping it into another error. The per-package `renderThrown` copies in `dsh-agent-loop`, `dsh-stdio`, and `dsh-tui` are deleted in favor of the one shared renderer.
- `dsh-stdio` renders failure `turn/end` reasons: `[turn failed <code>] <message>`, `[turn aborted] <reason>`, `[turn rejected] <reason>`, `[turn interrupted by a previous process exit]`, and the output-token-limit notice. Unknown merge-extended kinds fall through as ordinary turn ends.

`errorChain` lives in `dsh-llm` beside `HarnessError` for the same reason the base class does: it is the leaf package every consumer already imports, so sharing costs no new dependency edge.

## Alternatives considered

**Chain rendering inside each error's constructor (bake the cause into `message`).** Rejected: it double-renders once consumers also walk `cause` (the first draft of the adapter fix produced `… fetch failed: bad port: fetch failed: bad port`), and it destroys the structured chain for consumers that want to route on the inner error.

**A `cause`-aware logger exporter only.** Rejected: the durable `turn/end` reason and the TUI notice are not logger lines; the masked message would persist in the session log — the single durable record of an in-turn failure — and in the primary UI.

**Per-package `renderThrown` upgrades.** Rejected: three packages already carried near-identical private copies; upgrading each separately entrenches the duplication the shared renderer removes.

## Consequences

- A transport failure now reads `DeepSeek API request to <baseURL> failed: fetch failed: connect ECONNREFUSED …` in the TUI notice, the readline transcript, and the persisted session log, at the cost of longer diagnostic strings.
- Durable `turn/end` error messages include cause detail. Existing snapshot fixtures replay byte-identically because their scripted errors carry no `cause` (for such errors `errorChain(err)` equals `err.message`); only unit-test expectation strings changed. A fixture recorded from a real transport failure would carry the chain.
- `errorChain` renders `message` without the class name (`String(error)` rendered `Error: <message>`), so a bare `TypeError` in a log line loses its type label unless its message is empty (then the name is the fallback). The chain detail was judged worth more than the class name at these diagnostic boundaries.
- `dsh-stdio` output for failed turns is no longer silent; piped consumers that parsed the transcript see new `[turn …]` lines.
- Remaining `renderThrown` copies in `dsh-subagent`, `dsh-workflow`, `dsh-skill`, and `dsh-workflow-worker-thread` still render without the chain; they wrap package-local errors that carry their own messages, and can adopt `errorChain` when their diagnostics prove insufficient.
