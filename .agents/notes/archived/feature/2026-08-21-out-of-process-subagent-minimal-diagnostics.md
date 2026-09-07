# Agent Note: Out-of-process subagents expose minimal actionable diagnostics

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-out-of-process-subagent-minimal-diagnostics.zh.md)

## Problem

An ACP or DSH SDK child can stop because it reached a remote limit, denied a required permission, ended with a non-completed child turn, lost its protocol transport, or exited as a process. The shared result historically reduced these outcomes to a stop reason such as `error`, while startup and cleanup rejection messages could expose the original exception. A parent could not choose between narrowing the task, adjusting permission policy, or repairing the child deployment without Host logs.

Copying exceptions, stderr, task content, tool input, paths, environment values, credentials, or protocol payloads into `SubagentResult.diagnostic` would make untrusted child text model-visible. Reusing a complete product-specific error union would also duplicate independently versioned authorities in the provider-neutral [subagent seam](2026-06-21-subagent-capability-seam.md).

## Decision

Each out-of-process provider owns a small mapping from facts it already receives at its protocol and process lifecycle points to fixed safe display text. The ACP provider derives it from closed stop reasons, current operation, closed tool kind, configured permission policy, selected permission outcome, and the managed subprocess exit code or signal. The DSH SDK provider derives it from the child `turn/end` reason, current SDK operation, and exported SDK error class. Consumers continue to use the existing optional `SubagentResult.diagnostic`; they do not parse its punctuation or provider-private category names.

### Safe failure text

Generic error diagnostics have this fixed field order:

```text
Subagent failure (provider: <provider>; stage: <stage>; category: <category>; stop reason: <reason>; exit code: <code>; signal: <signal>)
```

Unavailable optional fields are omitted. The complete result is limited to 4096 UTF-8 bytes by the shared settlement boundary. Successful results and local cancellation carry no failure diagnostic. Partial assistant output remains in `SubagentResult.output` and is presented separately.

When an ACP permission request contributes to a non-completed result, a fixed line records `policy`, the closed ACP tool `request` kind, and `decision`. Tool titles, raw input, locations, option names, and metadata are excluded. For `max-tokens`, `refusal`, or remote `aborted`, the public stop reason already carries the terminal fact, so the permission line is the complete diagnostic; generic error paths append it after the failure line. A diagnostic-bearing remote `aborted` result keeps its public stop reason; the one-shot Job adapter treats it as failed, while diagnostic-free local cancellation remains killed.

### ACP facts

| Stage | Owned operation | Safe categories and facts |
| --- | --- | --- |
| `initialize` | Parent workspace resolution and ACP initialize | `configuration`, `transport`, or `process-exit` |
| `new-session` | ACP `session/new` and returned session-id validation | `protocol`, `transport`, or `process-exit` |
| `prompt` | ACP prompt request, remote stop reason, and permission callback | `remote-limit`, `transport`, `unknown`, or a permission-only diagnostic |
| `process` | Child-process spawn failure, or a managed child exits before a prompt terminal response | `process-start`, or `process-exit` plus independently observed exit code and signal |
| `teardown` | EOF quiescence and managed process-tree termination | Fixed teardown facts; the original cleanup failure remains internal |

`max_turn_requests` remains the shared `error` stop reason and adds `remote-limit`. An unknown stop reason remains `error` and becomes the fixed `unknown` category without copying the value. `max_tokens`, `refusal`, and `cancelled` keep their existing shared stop reasons; they add a diagnostic only when a permission decision must be explained.

### DSH SDK facts

| Stage | Owned operation | Safe categories and facts |
| --- | --- | --- |
| `initialize` | Parent workspace resolution, SDK runtime spawn, and initialize handshake | `configuration`, `protocol`, `transport`, or `unknown` |
| `session-run` | Prompt acceptance, session notifications, and final child reason | `child-error`, `child-disposed`, `child-unknown`, `missing-terminal`, `protocol`, `transport`, or `unknown` |
| `shutdown` | Bounded SDK shutdown and runtime process release | `unknown`; protocol-shutdown failures remain Host-only in the SDK client |

Child `completed`, `max-tokens`, and ordinary `aborted` results keep their existing shared stop reasons without extra text. An `aborted` turn whose closed cause is `disposed` keeps `aborted` and adds `child-disposed`. `blocked` reuses `refusal`; `error` adds `child-error`. Persistence repair alone produces `interrupted`, so this fresh-session provider leaves it as generic `error` without a diagnostic. A missing terminal event adds `missing-terminal`; an unknown reason uses `child-unknown` without copying the value or the child's structured failure message.

During initialize or session run, `SdkProtocolError` and JSON-RPC error responses map to `protocol`, and `TransportClosedError` maps to `transport`; the provider never reads their messages. Other exceptions and shutdown rejection use `unknown`. Request timeout classification remains deferred because this provider does not configure or propagate a request timeout.

### Ownership and lifecycle

| Fact or resource | Owner | Consumer behavior |
| --- | --- | --- |
| Protocol terminal fact | ACP server or child Harness Session | Each provider maps only its owned closed values and uses fixed unknown fallbacks |
| Current failure stage and operation-local detail | One provider run | Derived at the failure point and discarded with the run; concurrent runs share no diagnostic state |
| Exit code and signal | ACP's `dsh-subprocess` handle | Displayed only after the managed outcome is observed; stderr is never parsed |
| SDK error category | TypeScript SDK client error class | Classified with `instanceof`; the Error message and stderr tail remain internal |
| Diagnostic bytes and presentation | `dsh-subagent`, foreground tool, and Job runtime | The same bounded text stays separate from assistant output in foreground and one-shot background modes |
| Raw failure | Child runtime, Error cause chain, and Host logger | Available for Host diagnosis only, never copied into the parent model result |

Startup publishes no run until the provider's handshake completes. Successful startup cleanup rolls the private child back to quiescence before rejection. Cleanup failure preserves startup plus teardown/shutdown for an ordinary failure, or cleanup alone after cancellation, without claiming complete managed-process quiescence. A published run settles its result without rejection, and `dispose()` independently reports safe teardown or shutdown facts while still using the backend's existing process cleanup ladder.

## Verification

ACP package tests drive a real stdio protocol child and pin every stop-reason mapping, remote-limit and unknown fallbacks, permission allow/deny facts, configuration, initialize, new-session, prompt, process, and teardown stages, startup rollback, successful-result and local-cancellation omission, partial output, concurrent-run isolation, Host-only raw errors, process quiescence, and the shared multibyte diagnostic limit. DSH SDK package tests drive the real SDK client against its stdio fake runtime and pin every reachable child reason, current typed SDK category, initialize/session-run/shutdown stages, SDK-owned failed-start cleanup, cancellation cleanup, partial output, concurrency, sanitization, and quiescence. Loader compositions prove each real configured provider reaches the model-visible foreground result. Keyless ACP and JSON-RPC snapshots pin each provider's exact foreground and one-shot background diagnostic text.

## Alternatives considered

**Return raw exceptions, stderr, or protocol payloads.** These values can contain task content, tool input, paths, environment values, credentials, and upstream prose. Fixed allowlisted facts preserve the actionable distinction without expanding the model-visible trust boundary.

**Add a shared structured error enum.** ACP and other process-backed providers own different lifecycle points and closed termination vocabularies. A shared enum would invent false equivalence and force unrelated consumers to track provider releases.

**Parse exception messages or stderr into categories.** Free-form text is neither stable nor safe. Only closed protocol values, typed errors, current call sites, and managed process outcomes qualify as diagnostic inputs.

**Change existing stop reasons.** The stop reason remains the provider-neutral terminal result. The optional diagnostic explains why a non-completed result needs a different next action without adding new public result states.

**Add retries, recovery state, or interactive approval.** Diagnostics report a failure; they do not own remediation. Retry policy, session recovery, and human interaction require separate user contracts and lifecycle owners.

## Consequences

The parent can distinguish an ACP remote limit or permission decision and a DSH child-turn, protocol, transport, or shutdown failure without receiving child-controlled text. Startup and cleanup errors use the same safe facts as published results, while Host observation retains the original cause.

The diagnostic remains display text rather than a public protocol. Consumers may present it but must not branch on its format. This decision adds no retry policy, recovery controller, shared provider-error enum, stderr classifier, authentication taxonomy, session persistence, progress stream, or new ACP capability.
