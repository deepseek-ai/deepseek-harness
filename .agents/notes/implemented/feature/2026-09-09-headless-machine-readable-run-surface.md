# Agent Note: Headless machine-readable run surface

Status: implemented

English | [中文](2026-09-09-headless-machine-readable-run-surface.zh.md)

## Problem

`dsh --profile headless` serves a human terminal: the task arrives only through argv, stdout carries one final assistant message, provider reasoning streams to stderr, and every run creates a fresh random session. [Headless is a direct core entry point](../../archived/architecture/2026-08-09-headless-direct-core-entry-point.md) owns that transport and completion contract; [headless reasoning progress](../../archived/feature/2026-08-21-headless-reasoning-progress.md) owns the stderr projection.

A supervising process that drives one headless process per wake, such as an external agent runtime, needs three things that contract does not provide. It needs the task over a private pipe rather than argv, because a long prompt exceeds the argument limit and argv is visible to other processes. It needs a machine-readable stream that separates assistant text, reasoning, tool calls and results, turn boundaries, and usage, because scraping stderr yields only reasoning and the final stdout line yields no tool activity. It needs an exact session identity it can pass back on the next wake, because a fresh random session per process makes continuity impossible.

## Decision

The `dsh-headless` bundle owns an opt-in machine-readable run surface. The default invocation keeps the previous contract unchanged: one final assistant message on stdout, reasoning on stderr, exit 0 exactly when the terminal `turn/end` reason is `completed`.

Three additions extend the app-owned command line that [Apps own their command lines](../../archived/architecture/2026-08-06-app-owned-command-line.md) established:

- `--json` replaces the stdout payload with newline-delimited JSON run events. Reasoning becomes an event instead of stderr output, so stderr carries only `dsh:` diagnostics.
- `--session-id <id>` selects the exact session identity: adopt the persisted session with that id, and fail when no such log exists. Without the flag the run mints `session-<uuid>` as before.
- The task text also arrives on stdin when no positional task is present, or when the positional is `-`.

A per-run `--model` override is deliberately out of scope; the composition default stays authoritative.

The product change is confined to `packages/bundle/headless`: `src/startup.ts`, `src/index.ts`, the new `src/json-stream.ts`, the package manifest and `tsconfig.json`, and its tests. Around it, the product-profile expectation test in `apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` covers both output modes end to end and adds one optional caller-owned `cwd` to the `packages/test-support/loader-smoke` harness so two wakes can share a world. `scripts/check-workspace-constraints.ts` and the package manifest publish the shared `lib/json-stream-*.js` chunk both entries import, and `pnpm-lock.yaml` records the new `@deepseek-ai/dsh-session-query` workspace link. No core session, persistence, session-controller, base composition, or launcher file changes.

### Command-line contract

```text
dsh --profile headless [--json] [--session-id <id>] [<task>... | -]
```

Task resolution order: joined positionals, then `-`, then piped stdin. A whitespace-only positional is a usage error on its own, even when stdin is not a terminal, so an accidental blank argument never consumes a pipe; a task that is absent entirely is a usage error only when stdin is a terminal. A lone `-` is the only stdin marker: mixing it with other task words is a usage error instead of a task that starts with a dash. A piped task is sent verbatim, trailing newline included. In `--json` mode every usage error — including commander's own grammar rejections such as an unknown option or a missing option value — writes the `error` event before the process exits, because the runner never mounts to write it; the event message omits commander's `error: ` prefix so one event type carries one message shape.

`--json` changes the stdout payload and the destination of the reasoning projection only. Exit status, shutdown ordering, session flush, and the durable session log are unchanged, so a supervisor classifies a run exactly as it does today.

### Event stream

`--json` writes one JSON object per line to stdout and nothing else. The vocabulary is a projection of the session event log, not the log itself.

| `type` | Fields | Emitted |
|---|---|---|
| `session` | `sessionId`, `cwd` | first line, before any model output |
| `status` | `phase` (`turn_start`, `step_start`, `step_end`, `turn_end`), `turn`, `step`, `usage`, `reason` | one per boundary |
| `text` | `text` | one committed assistant text block |
| `thinking` | `text` | one committed reasoning block |
| `tool_call` | `callId`, `tool`, `input` | once per call |
| `tool_result` | `callId`, `status`, `result` | once per appended result |
| `error` | `message` | a failure the runner raises outside a turn |
| `final` | `text` | last line |

Projection rules:

- Text and reasoning are projected only from a committed `assistant/message`, never from live attempt deltas. A retried or discarded attempt appends `assistant/attempt`, which the projection ignores, so the stream never carries content the durable log does not contain ([publish state only at its commit point](../../../../packages/AGENTS.md)).
- Each committed content block becomes exactly one `text` or `thinking` event in content order; `tool-call` blocks are not projected because the `tool/call` event owns them. `user/message` echoes and internal session events (title, model selection, projection, checkpoint, goal, subagent) are not projected.
- A `tool/result` is projected only when its `surfaceOp` is `append`. A compaction replacement of an older result is history, and projecting it would emit a call id with no matching `tool_call`.
- Every projected string and object key is bounded at 8 KiB, an event with a cut value carries `truncated: true`, and one serialized event line, newline included, is bounded at 32 KiB — an over-long event keeps its scalar fields, drops structured ones, and at the extreme reduces to `type` and `truncated`, while a payload nested 64 levels or deeper is cut at that depth so no legal input can overflow the bounding recursion. This includes the process-level `error` event; a literal `__proto__` argument key is copied as data rather than through the inherited setter, an empty tool-argument string projects as `{}` to match the executor, and arguments that JSON cannot round-trip (an overflowing number such as `1e400`) keep their raw text rather than the `null` that `JSON.stringify` would report. The terminal `final` event is deliberately unbounded: it carries the same lossless answer the default mode prints.
- Text and reasoning arrive when the step commits, not per token; default-mode stderr reasoning remains the only live text channel. A turn that fails in-turn still ends the stream with `final` and no `error` event, so a supervisor classifies that run from the exit code and the `turn_end` reason even when the stream is well formed.
- `usage` appears on `step_end` only when every attempt in the step reported a sample, summed across them — including a retried attempt whose only usage sample sits in its discarded `assistant/attempt` stream — so a partial total is never presented as exact.
- Raw session events stay out of scope. A debug escape hatch can be added later without changing this vocabulary.

### Session identity

The runtime owns identity. A run without `--session-id` mints `session-<uuid>` and reports it in the first event. A supervisor persists that value and passes it back on the next wake.

`--session-id <id>` is adopt-only: observe the persisted session and resume it, failing when the log does not exist. The first wake omits the flag, so the runtime mints the identity and reports it in the `session` event; every later wake names that value and continues the history. A requested id with no stored log is an error rather than a fresh conversation, so a mistyped or stale id cannot silently open an empty history the caller believes it is resuming, and the JSONL store's refusal of an existing log id ([session persistence](../../implemented/architecture/2026-06-14-session-persistence.md)) is never on this path. The id is opaque, so the runner validates non-emptiness on the trimmed value and passes the caller's exact string through, whitespace included.

Adoption compares the persisted session's recorded cwd with the process cwd, since sessions are organized per project directory ([project session directories](../../implemented/architecture/2026-07-24-project-session-directories.md)). A mismatch exits 1 with a `dsh:` diagnostic instead of silently continuing a conversation rooted elsewhere, and a session that recorded no cwd is rejected for the same reason. A session running under an agent preset is rejected because this bundle composes no preset roster: resuming it here would run it under the headless tools and prompts instead of the composition its log records. The check reads the preset the log currently records — the creation header advanced by any `agent-preset/selected` event — because a blank session may switch preset after creation while the header stays a creation fact, and a malformed selection record fails closed rather than reading as no preset. A session linked to a parent or subagent — including a user fork — is rejected. A live Agent already holding the requested id is refused outright: its owner may still drive it, and `whenIdle` is not a single-message signal, so the runner cannot own an exclusive interval over it. The resumed log is checked again after the runner's idle wait, so a preset selected in that window is still rejected. A whitespace-only `sessionId` is rejected on both the CLI and the direct-config path. Two live processes cannot write one id; the store's write lease already rejects the second writer. The runner reads the observation through the composed `sessionQuery` service and fails loudly when `--session-id` is requested without it — the observation is how it finds the id it must resume — or when the requested identity would lack the `sessionPersistence` service that makes it durable.

## Consequences

What landed: `src/startup.ts` parses `--json` and `--session-id <id>`, treats an absent or `-` task as "read stdin", and raises the usage error only when stdin is a terminal. `src/index.ts` resolves the task, adopts the named session — or mints a fresh identity when the flag is absent — and wires either the stderr reasoning projection or the new `src/json-stream.ts` projection. `cordis.patch.yml` forwards the two new settings. `package.json` publishes the shared `lib/json-stream-*.js` chunk both entries import, so the installed tarball loads.

- Default mode is unchanged: a text-only run writes one final assistant line to stdout and nothing to stderr, and exit status still follows the terminal reason.
- `--json` stdout parses line by line as JSON, starts with `session`, ends with `final`, and contains no plain text. Stderr carries no reasoning in this mode.
- A step that retries publishes `text` and `thinking` only for the attempt that commits, so a discarded attempt leaves no trace in the stream.
- Two consecutive runs with the same `--session-id` share history, and a requested id with no stored log exits 1 before the task runs. A run whose cwd differs from the persisted session, that recorded no cwd, that is a subagent or forked session, that runs under an agent preset, that carries a malformed preset record, or whose identity is already live in the process, exits 1 with a diagnostic.
- A piped task with no positional task is honored, a whitespace-only positional is rejected instead of consuming the pipe, and an interactive invocation without a task still fails with the usage error.
- Unit coverage lands in `packages/bundle/headless/tests/startup.spec.ts`, `tests/headless.spec.ts`, and `tests/json-stream.spec.ts`. The product headless profile expectation test in `apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` covers both output modes end to end.

Deferred and open:

- The per-run `--model` override is unimplemented. A later change must respect the session-local selection precedence owned by the Session Controller rather than overriding a stored selection.
- Cold start plus log replay grows with session length, so a long-lived conversation pays more per wake than a fresh one.
- `--json` moves reasoning from stderr to stdout, so a log collector that watches stderr sees nothing on a reasoned run in that mode.
- Bounded `tool_result` payloads hide full output from the supervisor; the 8 KiB string/key cap and the 32 KiB line cap are owned by `src/json-stream.ts` and should stay constants, with the terminal `final` event the only exemption.

## Alternatives considered

**`--verbose` human text on stderr.** A supervisor parses stdout, so a stderr-only projection is invisible to it. Default-mode stderr reasoning already is the human verbose surface.

**Dump raw session events.** They repeat the assembled message beside its deltas, echo `user/message`, and include internal events. Measured on one prompt, pi's delta stream produced 84 lines and 11.7 KB against opencode's 3 lines and 962 B, with roughly a quarter of pi's bytes spent repeating one message across `message_end`, `turn_end`, and `agent_end`.

**A long-lived SDK process instead of one process per wake.** The SDK already speaks structured events and an explicit session identity, but it replaces the one-process-per-wake model the supervisor is built on. Measured cold start for the headless profile is about 0.45 s warm and 1.2 s cold, small against a real turn.

**Let the supervisor mint the session id.** Identity belongs to the runtime that owns the log. The supervisor records what the first event reports.

**Adopt-or-create `--session-id`.** Creating the requested id when no log exists would let a mistyped or stale id silently open an empty history that the supervisor believes it is continuing; the first wake already omits the flag and reads the minted id from the `session` event, so no caller needs `--session-id` to create.

**Task from argv only.** Long prompts exceed `ARG_MAX` and expose the prompt in the process list.
