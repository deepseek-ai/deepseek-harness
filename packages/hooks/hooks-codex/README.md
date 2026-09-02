---
description: "Run your existing Codex hooks.json hook config during agent runs — block prompts and tools, attach context, or force continuation — for users and maintainers of the bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-hooks-codex

English | [中文](README.zh.md)

## Summary

`dsh-hooks-codex` runs the hooks from your existing Codex config — a `hooks.json` — during agent runs, so the behavior you already wrote keeps working without rewriting it. Five of Codex's hook points fire at the matching moments: when a session starts, when a prompt is submitted, before and after a tool runs, and when the run is about to stop. A hook can block a prompt or tool call with a message the model sees, attach extra context to the conversation, or force the run to continue. Choose it when you have Codex command hooks and want them to work in the harness as-is; behavior with no Codex equivalent belongs in a native plugin.

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

Mount this package, point `configPath` at your `hooks.json`, and the hooks you already have start firing at the corresponding moments in agent runs. There is nothing else to set up before the first hook works.

### When to choose it

Use it when you own a Codex `hooks.json` and its command hooks should gate prompts, tools, and turns. Skip it for behavior with no Codex equivalent: a native plugin has the full harness API, while this bridge runs only the reference tool's command-hook subset.

### Smallest working setup

```yaml
- name: '@deepseek-ai/dsh-hooks-codex'
  config:
    configPath: ./.codex/hooks.json
    model: deepseek-v4
```

| Field | Default | Meaning |
|---|---|---|
| `configPath` | required | Path to a Codex `hooks.json` |
| `model` | `''` | Model name stamped on every payload (Codex includes `model` on each event) |
| `defaultTimeoutMs` | `600,000` | Per-hook timeout when a hook sets none (the Codex default) |
| `stderrSummaryMaxChars` | `500` | Character cap on the persisted `hook/result` stderr summary |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-hooks-codex) is the exhaustive source for every accepted field.

### What your hooks can do

| Your hook | When it runs | What it can do |
|---|---|---|
| `SessionStart` | when a session starts | attach context the model sees in that session |
| `UserPromptSubmit` | when the agent receives a prompt | block the prompt, or attach extra context |
| `PreToolUse` | before a tool runs | block the tool |
| `PostToolUse` | after a tool runs | block the result with feedback, or attach extra context |
| `Stop` | when the run is about to stop | force another step with a reason |

### How hooks run and fail

- Hooks run in your project directory — the agent's session workspace — so `pwd` and relative paths in your hooks refer to your project, not the server's launch directory.
- One config applies to the whole process: it is read once at startup, and a relative `configPath` resolves from the directory that launched the process.
- Only synchronous command hooks run; an `async: true` or non-command hook is skipped with a warning.
- Hooks on the same event run one after another, in config order.
- If the config cannot be read or parsed, the bridge logs a warning and runs no hooks — the agent still starts.
- A hook that fails to run (a bad command or a crash) is logged, and the agent continues.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the bridge and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Hook point mapping

Each supported event programs against one harness extension point: `SessionStart` emits context into the new session (`agent/session-start`), `UserPromptSubmit` and `PreToolUse` are waterfalls that can reject the incoming action (`agent/pre-step`, `tools/pre-execute`), `PostToolUse` is a waterfall that can block with feedback or add context to the downstream decision (`tools/post-execute`), and `Stop` is a serial listener whose blocking result forces another step through `steer()` (`agent/turn-stopping`). Context-only hooks always delegate via `next()` before folding a sourced message into the downstream decision, so a later listener can still reject or rewrite; blocking decisions map to `deny` (`PreToolUse` has no `allow` or `ask`). The per-event wiring lives in [`src/index.ts`](src/index.ts).

### Payloads and environment

Payloads are Codex-shaped: snake_case with `turn_id` on turn-scoped events, `model` and `permission_mode: "default"` on every event, and stdin written without a trailing newline. A tool call's payload carries the real `tool_name` and the `tool_input: { command }` shape (the `command` argument when present, else `''`), so non-shell tool arguments are not faithfully exposed. The base payload carries `session_id` and `transcript_path`; the latter keeps the Codex `string | null` shape but is always `null` — the persistence seam exposes no artifact paths, and the default-zstd session log is not readable by hook scripts. Codex performs no command substitution and injects no plugin environment.

### Matcher subjects and serial execution

The matcher subject is the tool name (`PreToolUse` / `PostToolUse`) or the session source (`SessionStart`); `UserPromptSubmit` and `Stop` ignore matchers. Codex matchers are always unanchored regexes. Matched hooks run serially in config order, which keeps each hook's `hook/invoked` / `hook/result` pair adjacent in the log, and the most-restrictive fold is order-independent (`deny > ask > allow`).

### Detached runs and disposal

`SessionStart` is the one emit point and runs detached — no extension point awaits it. Each run chain is tracked, and disposing the bridge aborts a still-running hook process, then drains the continuation before the dispose resolves (`createDetachedRuns` in `dsh-hook-protocol`).

### Design philosophy

- **A compatibility adapter, not a power tool.** The bridge exists to run the explicitly supported subset of an existing Codex config; bespoke behavior belongs in a native plugin on the same extension points.
- **Adding context is not a veto.** A context-only hook delegates via `next()` before folding its message into a downstream enter decision, so a later `agent/pre-step` or `tools/post-execute` listener can still reject or rewrite.
- **Containment at every failure.** Config read/parse failures and invalid matchers register nothing; a throwing detached inject is caught and logged instead of breaking session boot or the loop.
- **Dispose reaches quiescence.** Detached runs are tracked and drained on disposal so no hook process or late callback outlives the fiber.
- **Dialect-shaped, not maximal.** Payloads stay snake_case with `turn_id` / `model`, stdin carries no trailing newline, and the bridge implements no pre-tool approval or rewrite path — the protocol's shape is preserved even where the harness could do more.

The [hook-bridges Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md) records the bridge design and the deferred gaps; the [hook-protocol-lib Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-protocol-lib.md) records the shared-versus-per-dialect split.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config validation, listener registration, per-event payloads, decision mapping |
| [`src/config.ts`](src/config.ts) | Codex config parsing: the five supported events, matcher validation, skip reasons |
| — | No runtime invariant companion is published; this bridge publishes hook-protocol session events, whose companion owns which invocation event each result cites. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared protocol to the bridge design and the extension points it programs against.

- [Hooks group map](../README.md) — the sibling group page and its package table.
- [Hook protocol library](../hook-protocol/README.md) — the shared hook rules this bridge applies.
- [Hook bridges Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md) — the bridge design, decision mapping, and deferred gaps.
- [Interception extension-points Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md) — the typed-Decision surface the bridge maps onto.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-hooks-codex) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Hook-provided context

#### What the model sees

`SessionStart`, accepted prompt, and post-tool hooks can add source-attributed context messages; a blocking `Stop` hook adds its reason as next-step steering.

#### Token effect

No cost when hooks return no context. Hook text is data-dependent, logged, and resent in later conversation requests until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Blocked prompt or tool outcome

#### What the model sees

Provider-supplied reasons pass through verbatim. When absent, a denied tool becomes `Error: blocked by PreToolUse hook`, blocked post-tool feedback is exactly `blocked by PostToolUse hook`, and a blocking stop adds steering exactly `continue: blocked by Stop hook`; a blocked prompt is discarded with no model-visible message, ending the turn as `blocked`. Codex `systemMessage` is not surfaced.

#### Token effect

Blocking a prompt removes that prompt's request tokens; denial or feedback adds the retained fallback or provider text; forced continuation pays another full request.

#### KV Cache effect

A blocked prompt sends no request and invalidates nothing. Denial, feedback, and forced-continuation context append after the reusable prefix without rewriting it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what your Codex hooks cannot do through this bridge yet, and where behavior differs from the reference tool. They are current package constraints, not a task backlog.

- **Unsupported hook events (5 of Codex's current 10)** — `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`, and `SubagentStop`. Config for these events is silently dropped during parsing. The comparison baseline is Codex's [official hook reference](https://learn.chatgpt.com/docs/hooks).
- **`SessionStart` is partial** — plain stdout and JSON `additionalContext` work, but the hook runs detached, so context can miss the first request.
- **`UserPromptSubmit` is partial** — blocking plus plain-stdout or JSON context work, but the common `systemMessage` and `{"continue": false}` controls are not enforced.
- **`PreToolUse` is partial** — blocking works, but `additionalContext`, `permissionDecision: "allow"`, and `updatedInput` are ignored. Every tool is represented as `tool_input: { command }`, so non-shell tool arguments are not faithfully exposed to the hook.
- **`PostToolUse` is partial** — blocking feedback and JSON `additionalContext` work, but `{"continue": false}` is not enforced, non-shell tool arguments are reduced to `{ command }`, and structured tool output is flattened to text in `tool_response`.
- **`Stop` is partial** — blocking forces another model turn, but `stop_hook_active` is always `false`, `last_assistant_message` is always `null`, and `{"continue": false}` is not enforced. An unconditionally blocking hook therefore force-continues every step unless it self-limits.
- **Common payload and output fields are partial** — every mapped event reports the statically configured `model` and `permission_mode: "default"` instead of current Codex runtime values, and `transcript_path` is never populated: it is always `null`, because the persistence seam exposes no artifact paths and the default-zstd session log is not readable by hook scripts. `systemMessage` is logged + warned but not surfaced, and `{"continue": false}` is recorded but does not apply Codex's event-specific stop behavior.
- **Config loading and execution are partial** — one process-level `configPath` is parsed at load; Codex's active user, project, session, system/managed, and plugin layers, trust controls, and inline `config.toml` hook form are not implemented. Only synchronous `command` handlers run, current metadata such as `statusMessage` and `commandWindows` is ignored, and matching handlers run serially rather than with Codex's concurrent launch semantics.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The deferred gaps above are the working queue: per-session hook-config discovery, a session-start delivery gate, a stop loop-guard, and a run-level halt for `continue: false`. None has a design yet; the official Codex reference is the baseline for closing any of them.

</details>
