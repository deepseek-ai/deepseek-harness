---
description: "One-shot task mode for dsh: run a single task from the command line and get the final answer printed, for users scripting or automating dsh."
kind: "package-bundle"
---

# @deepseek-ai/dsh-headless

English | [中文](README.zh.md)

## Summary

`dsh-headless` runs one dsh task from the command line and prints the final answer, then exits — no GUI, no server, no browser. Type `dsh --profile headless "run the tests"` and the agent works through the task with the same model, tools, and safety defaults as every other surface. It is ideal for scripts, CI, and one-off jobs: the process opens no ports and leaves nothing running behind. The exit code tells you the outcome — 0 when the task completed, 1 when it aborted or errored. The main boundary: one task per invocation, with no interactive follow-up.

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

Run one task, get the final answer, and exit. The task is the command line itself, so the whole invocation is the smallest working example.

### Running a one-shot task

```sh
dsh --profile headless "run the tests"
```

The agent works through the task, streams each non-empty provider reasoning delta to stderr under a `dsh: reasoning:` heading, then prints the final answer on stdout and exits. Consecutive reasoning deltas stay in one section, and the runner closes that section before later output when the provider supplied no trailing newline. A successful run without reasoning keeps stderr empty; a failure exits 1 and prints `dsh: <code>: <message>` to stderr. A missing or blank task is rejected before anything runs. The task text is supplied through the single `task` setting:

| Field | Default | Meaning |
|---|---|---|
| `task` | required | The task text for the single run |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-headless) is the exhaustive source for every accepted field and its JSDoc.

### When to use it

Use headless for scripted or automated dsh runs — CI steps, batch jobs, quick answers from a terminal. Avoid it when you need a multi-turn interactive session or a GUI; the browser surface ([dsh-web-app](../web-app/README.md)) serves that. The process stays alive only for the run, opens no listening port, and exits on its own, so it fits pipelines that wait on the process.

### Help and task errors

`dsh --profile headless --help` prints the command's help text and exits without running anything. A missing or whitespace-only task is a usage error: nothing runs and the process exits 1.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runner is a direct driver over the core API carrier: it creates one fresh Agent through the registry and folds the owned durable event interval into one process-level outcome.

### Run flow

The runner awaits the complete application (`ctx.get('loader')?.await()`) so the composed tools and adapters are not half-mounted, reads the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection, creates one fresh persisted Agent with that provider and model, and submits the task as an ordinary user message. It streams that Agent's non-empty reasoning deltas to stderr, waits for quiescence, then flushes the Session and folds the owned interval (`firstSeq` onward) into the last non-empty `assistant/message` text and final `turn/end` reason. It writes the final text to stdout and requests exit.

### Patch surface over base

The patch rides over `dsh-base`: it inherits the projection cache, sets the coding persona prefix and separate cwd suffix on the base `system-prompt` row, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`) as the Web surface, disables the shared HMR row, inserts PTC mode's worker as a core execution capability, and mounts the startup provider and the runner. The cache checkpoints each persisted one-shot session for later consumers; its durability barrier flushes each covered log prefix before publishing the cache row and may split otherwise coalesced JSONL runs. The startup provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), reads the positional argument, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its task from lazy config.

### Exit mapping

A completed final `turn/end` exits 0; any other outcome — aborted, error, or no turn in the owned interval — exits 1. An `error` reason also writes `dsh: <code>: <message>` to stderr. A direct driver failure (for example, Agent creation) writes `dsh: <message>` to stderr and exits 1.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `headless-runner` plugin: run flow, output contract, exit mapping |
| [`src/startup.ts`](src/startup.ts) | The `headless-startup` provider: task positional and `--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | The one-shot patch over `dsh-base` |
| — | No runtime invariant companion is published; the runner's observable contract (provider reasoning on stderr, final text on stdout, exit code by turn-end reason) is process-level and owned by the launcher e2e; it registers nothing and holds no mutable relation to audit inside the tree. |
| [`tests/headless.spec.ts`](tests/headless.spec.ts) | Run flow, aggregation, flush, and exit mapping |
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
- **No pre-token heartbeat** — stderr stays silent until the provider emits a non-empty reasoning delta; a delayed first token exposes no earlier progress signal.
- **Reasoning enters stderr logs** — redirection and supervisors may retain substantially more and potentially sensitive model output; route stderr to a controlled sink when needed.
- **Only reasoning and the final answer are printed** — a run without an assistant message prints an empty stdout line and exits 1; intermediate tool output is not printed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
