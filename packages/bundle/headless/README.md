---
description: "One-shot task mode for dsh: run a single task from the command line and get the final answer printed, for users scripting or automating dsh."
kind: "package-bundle"
---

# @deepseek-ai/dsh-headless

English | [中文](README.zh.md)

## Summary

`dsh-headless` runs one dsh task from the command line and prints the final answer, then exits — no GUI, no server, no browser. Type `dsh --profile headless "run the tests"` and the agent handles it with the same model, tools, and safety defaults as every other surface. It suits scripts, CI, and one-off jobs: it opens no ports and leaves nothing running behind. It also offers a JSON event stream (`--json`) and `--session-id` to resume a conversation. Exit code 0 means the task completed; 1 means it aborted or errored. The boundary: one task per invocation, no interactive follow-up.

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

Run one task, get the final answer, and exit. The task is the command-line argument, or stdin when you omit it; the whole invocation is the smallest working example.

### Running a one-shot task

```sh
dsh --profile headless "run the tests"
```

The agent works through the task, streams each non-empty provider reasoning delta to stderr under a `dsh: reasoning:` heading, then prints the final answer on stdout and exits. Consecutive reasoning deltas stay in one section, and the runner closes that section before later output when the provider supplied no trailing newline. A successful run without reasoning keeps stderr empty; a failure exits 1 and prints `dsh: <code>: <message>` to stderr. The task comes from the positional argument, or from stdin when the argument is omitted or is a lone `-`; a blank positional argument or an empty pipe is rejected before anything runs. A positional task is used as-is and stdin is not read, so put the whole prompt in the pipe when you want piped input; a piped task is sent verbatim, its trailing newline included.

```sh
{ echo "Summarize these changes:"; git diff --stat; } | dsh --profile headless
```

The task and run options are supplied through three settings:

| Field | Default | Meaning |
|---|---|---|
| `task` | stdin | The task text; stdin supplies it when omitted or `-` |
| `sessionId` | `session-<uuid>` | Exact Session identity to adopt; an unknown id fails |
| `json` | `false` | Project the run as newline-delimited events on stdout |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-headless) is the exhaustive source for every accepted field and its JSDoc.

### Choosing the session identity

Every invocation defaults to a fresh `session-<uuid>` identity, which `--json` reports in its opening `session` event. Pass `--session-id <id>` to continue that conversation: the runner adopts the persisted Session with that id, and an id with no stored Session fails before the task runs rather than quietly opening an empty history. Adoption requires the composed `sessionPersistence` and `sessionQuery` services, so a profile that omits either fails loudly instead of returning an id whose history dies with the process. An Agent already live under the requested id in this process is refused: another owner may still drive it, so the runner cannot claim an exclusive run interval over it. The identity is opaque, so the exact string is used, whitespace included. The working directory is resolved through the mounted filesystem provider (`fs.resolve('.')` and `fs.processPath()`), or the process cwd when no filesystem service is mounted; new Sessions record that directory. Adoption compares the recorded cwd with the same provider-resolved directory and refuses a Session that is a subagent or forked session, that recorded no working directory, that runs under an agent preset this profile does not compose, or whose preset record is malformed — the check reads the preset the Session log currently records, so a Session that switched preset while blank is rejected too. A supervisor therefore cannot silently drive someone else's conversation under a different composition; any mismatch fails before the task runs.

### Machine-readable output

`--json` replaces the final-text stdout line with a newline-delimited JSON event stream, while stderr keeps only the `dsh:` diagnostics. The stream opens with `session` (carrying the identity the run used) and closes with `final`, and carries `status`, `text`, `thinking`, `tool_call`, and `tool_result` events in between. `text` and `thinking` are projected from committed assistant messages, so a retried or discarded attempt never reaches the stream; they arrive when the step commits, not per token, and default-mode stderr reasoning remains the only live text channel. The terminal `final` event carries the same lossless answer as the default mode and is not capped; every other string and object key is capped at 8 KiB and flagged with `truncated`, and one event line, its newline included, is capped at 32 KiB — an over-long event keeps its scalar fields, drops structured ones, and at the extreme reduces to `type` and `truncated`, while a payload nested 64 levels or deeper is cut at that depth. An empty tool-argument string projects as `{}`, matching what the executor runs, while arguments that JSON cannot round-trip — an overflowing number such as `1e400` — keep their raw text rather than the `null` that `JSON.stringify` would report. A failure the runner raises outside a turn writes an `error` event and ends the stream without `final`, in addition to the `dsh:` stderr line; a profile whose own plugins fail to load exits before the runner mounts, so that case keeps only the loader's stderr diagnostics. A turn that fails in-turn still ends with a `final` event (often empty) and no `error` event, so a well-formed stream can still describe a failed run: treat exit code 1 and the `turn_end` reason as the failure signal.

### When to use it

Use headless for scripted or automated dsh runs — CI steps, batch jobs, quick answers from a terminal. Avoid it when you need a multi-turn interactive session or a GUI; the browser surface ([dsh-web-app](../web-app/README.md)) serves that. The process stays alive only for the run, opens no listening port, and exits on its own, so it fits pipelines that wait on the process. When a supervisor needs progress rather than just the answer, `--json` gives it the event stream and `--session-id` lets a later invocation continue the same conversation.

### Help and task errors

`dsh --profile headless --help` prints the command's help text and exits without running anything. A whitespace-only positional task is a usage error on its own — nothing runs and the process exits 1, even when stdin is not a terminal, so an accidental blank argument never consumes a pipe. A task that is absent entirely is a usage error only when stdin is a terminal; otherwise the runner reads the task from stdin and rejects an empty result the same way. A lone `-` is the only stdin marker; mixing it with other task words is a usage error rather than a task that starts with a dash. In `--json` mode every usage error — including commander's own grammar rejections such as an unknown option or a missing option value — also writes an `error` event to stdout before the process exits, so a line-oriented supervisor sees a well-formed stream even when the runner never mounts; the event `message` carries the text without commander's `error: ` prefix.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runner is a direct driver over the core API carrier: it resolves the Agent identity — a fresh `session-<uuid>` by default, or the persisted Session `--session-id` names — and folds the owned durable event interval into one process-level outcome.

### Run flow

The runner awaits the complete application (`ctx.get('loader')?.await()`) so the composed tools and adapters are not half-mounted, reads the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection, resolves the task from config or stdin, then resolves the Agent identity: a fresh `session-<uuid>` by default, or the persisted Session `--session-id` names, which it adopts through [`sessionQuery`](../../session-query/session-query/README.md) and refuses when no log exists. It submits the task as an ordinary user message. Without `--json` it streams that Agent's non-empty reasoning deltas to stderr; with `--json` it projects the run instead. It waits for quiescence, then flushes the Session and folds the owned interval (`firstSeq` onward) into the last non-empty `assistant/message` text and final `turn/end` reason. It writes the final text to stdout (or the `final` event) and requests exit.

### Patch surface over base

The patch rides over `dsh-base`: it inherits the projection cache and shared PTC runtime, sets the coding persona prefix and separate cwd suffix on the base `system-prompt` row, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`) as the Web surface, disables the shared HMR row, and mounts the startup provider and the runner. The cache checkpoints each persisted one-shot session for later consumers; its durability barrier flushes each covered log prefix before publishing the cache row and may split otherwise coalesced JSONL runs. The startup provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), reads the positional argument and the `--session-id`/`--json` options, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its task and run options from lazy config.

### Exit mapping

A completed final `turn/end` exits 0; any other outcome — aborted, error, or no turn in the owned interval — exits 1. An `error` reason also writes `dsh: <code>: <message>` to stderr. A direct driver failure (for example, Agent creation or an unusable `--session-id`) writes `dsh: <message>` to stderr and exits 1, and in `--json` mode also emits an `error` event.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `headless-runner` plugin: run flow, session resolution, output contract, exit mapping |
| [`src/startup.ts`](src/startup.ts) | The `headless-startup` provider: task positional, `--session-id`, `--json`, and `--help` |
| [`src/json-stream.ts`](src/json-stream.ts) | The `--json` projection: event vocabulary, commit-point emission, string bounding |
| [`cordis.patch.yml`](cordis.patch.yml) | The one-shot patch over `dsh-base` |
| — | No runtime invariant companion is published; the runner's observable contract (provider reasoning on stderr, final text on stdout, exit code by turn-end reason) is process-level and owned by the launcher e2e; it registers nothing and holds no mutable relation to audit inside the tree. |
| [`tests/headless.spec.ts`](tests/headless.spec.ts) | Run flow, aggregation, flush, session adoption, and exit mapping |
| [`tests/json-stream.spec.ts`](tests/json-stream.spec.ts) | Projection ordering, commit-point emission, bounding, and disposal |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |

### Invariant ownership

No invariant companion is published because the runner's observable contract (final text on stdout, exit code by turn-end reason) is process-level and owned by the launcher e2e; the plugin registers nothing and holds no mutable relation to audit inside the tree.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core, the sibling GUI, or the command-line handoff.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core headless runs on.
- [dsh-web-app](../web-app/README.md) — the interactive browser sibling for multi-turn work.
- [dsh-cmdline](../../boot/cmdline/README.md) — how the launcher hands the command line to the app.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-headless) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the runner submits the task as an ordinary user message and the composed base and headless rows own the prompts and tools.

#### KV Cache effect

The runner adds nothing to the request prefix; it only drives one user message through the composed tree.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits tell you when headless does not fit and what it needs from the `dsh` launcher. They are current package constraints, not a general CLI comparison or a task backlog.

- **One task per run** — after the task is answered the process exits; there is no interactive follow-up, so split multi-step work into separate runs.
- **Runs through the `dsh` launcher** — starting the headless profile another way fails at startup, because only the launcher can request the process exit.
- **No pre-token heartbeat** — in default mode stderr stays silent until the provider emits a non-empty reasoning delta; a delayed first token exposes no earlier progress signal.
- **Reasoning enters stderr logs** — in default mode, redirection and supervisors may retain substantially more and potentially sensitive model output; route stderr to a controlled sink when needed.
- **Default stdout carries only the final answer** — a run without an assistant message prints an empty stdout line and exits 1; intermediate tool output is not printed unless you opt into `--json`.
- **Adoption is cwd-, ownership-, and preset-scoped** — `--session-id` refuses a Session recorded in another working directory, one that recorded no working directory, one that is a subagent or forked session, or one that runs under an agent preset this profile does not compose or whose preset record is malformed, and requires the composed Session query and persistence services; an identity already live in the process is refused too, because the runner cannot own an exclusive run interval over it.
- **The event stream is a projection, not the log** — `--json` caps every string except the terminal `final` at 8 KiB and omits events the projection does not model, so it is not a lossless copy of the Session log.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
