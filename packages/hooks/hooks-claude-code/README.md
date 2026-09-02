---
description: "Run your existing Claude Code hooks.json or settings hook config during agent runs — block prompts and tools, attach context, or force continuation — for users and maintainers of the bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-hooks-claude-code

English | [中文](README.zh.md)

## Summary

`dsh-hooks-claude-code` runs the hooks from your existing Claude Code config — a `hooks.json` or a settings file's `hooks` key — during agent runs, so the behavior you already wrote keeps working without rewriting it. Your hooks fire at the matching moments: when a session starts, when a prompt is submitted, before and after a tool runs, when the run is about to stop, and when subagents start or end. A hook can block a prompt or tool call with a message the model sees, attach extra context to the conversation, or force the run to continue. Choose it when you have Claude Code command hooks and want them to work in the harness as-is; behavior with no Claude Code equivalent belongs in a native plugin.

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

Mount this package, point `configPath` at your hook config, and the hooks you already have start firing at the corresponding moments in agent runs. There is nothing else to set up before the first hook works.

### When to choose it

Use it when you own a Claude Code `hooks.json` (or a settings file whose `hooks` key holds the config) and its command hooks should gate prompts, tools, and turns. Skip it for behavior with no Claude Code equivalent: a native plugin has the full harness API, while this bridge runs only the reference tool's command-hook subset.

### Smallest working setup

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: ./.claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

| Field | Default | Meaning |
|---|---|---|
| `configPath` | required | Path to a `hooks.json` or a settings file whose `hooks` key holds the config |
| `pluginRoot` | — | Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings |
| `projectDir` | session workspace | Replaces `${CLAUDE_PROJECT_DIR}` and sets the `CLAUDE_PROJECT_DIR` env var |
| `defaultTimeoutMs` | `600,000` | Per-hook timeout when a hook sets none (the Claude Code default) |
| `stderrSummaryMaxChars` | `500` | Character cap on the persisted `hook/result` stderr summary |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-hooks-claude-code) is the exhaustive source for every accepted field.

### What your hooks can do

| Your hook | When it runs | What it can do |
|---|---|---|
| `SessionStart` | when a session starts | attach context the model sees in that session |
| `UserPromptSubmit` | when the agent receives a prompt | block the prompt, or attach extra context |
| `PreToolUse` | before a tool runs | block the tool, or ask for approval before it runs |
| `PostToolUse` | after a tool runs | block the result with feedback, or attach extra context |
| `Stop` | when the run is about to stop | force another step with a reason |
| `SubagentStart` | when a subagent starts | attach context to a still-running subagent (in-process only) |
| `SubagentStop` | when a subagent ends | observe only — cannot block or add context |

### How hooks run and fail

- Hooks run in your project directory — the agent's session workspace — so `pwd` and relative paths in your hooks refer to your project, not the server's launch directory.
- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` in command strings are replaced from your config, and `CLAUDE_PROJECT_DIR` is set for every hook process.
- One config applies to the whole process: it is read once at startup, and a relative `configPath` resolves from the directory that launched the process.
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

Each supported event programs against one harness extension point: `SessionStart` emits context into the new session (`agent/session-start`), `UserPromptSubmit` and `PreToolUse` are waterfalls that can reject the incoming action (`agent/pre-step`, `tools/pre-execute`), `PostToolUse` is a waterfall that can block with feedback or add context to the downstream decision (`tools/post-execute`), and `Stop` is a serial listener whose blocking result forces another step through `steer()` (`agent/turn-stopping`). The two subagent events emit into the child lifecycle (`subagent/start`, `subagent/end`): start injects context into a live in-process child, stop observes only. Context-only hooks always delegate via `next()` before folding a sourced message into the downstream decision, so a later listener can still reject or rewrite; blocking decisions map to `deny` (`ask` for `PreToolUse`). The per-event wiring lives in [`src/index.ts`](src/index.ts).

### Payloads and environment

The bridge builds each event's stdin payload from a base of `session_id`, string-shaped `transcript_path`, `cwd`, and `hook_event_name` plus per-event fields. `transcript_path` stays in the payload for compatibility but is always `''`: the persistence seam exposes no artifact paths, and the default-zstd session log is not readable by hook scripts. `CLAUDE_PROJECT_DIR` defaults per-run to the session workspace when `projectDir` is omitted, matching the directory the hook runs in; `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` substitution happens at config parse time.

### Matcher subjects and serial execution

The matcher subject is the tool name (`PreToolUse` / `PostToolUse`), the session source (`SessionStart`), or the constant `agent_type` `general-purpose` (`SubagentStart` / `SubagentStop` — the subagent seam carries no per-kind label); `UserPromptSubmit` and `Stop` ignore matchers. Matched hooks run serially in config order, which keeps each hook's `hook/invoked` / `hook/result` pair adjacent in the log, and the most-restrictive fold is order-independent (`deny > ask > allow`).

### Detached runs and disposal

The three emit points (`SessionStart`, `SubagentStart`, `SubagentStop`) run detached — no extension point awaits them. Each run chain is tracked, and disposing the bridge aborts still-running hook processes, then drains the continuations before the dispose resolves (`createDetachedRuns` in `dsh-hook-protocol`).

### Design philosophy

- **A compatibility adapter, not a power tool.** The bridge exists to run the explicitly supported command-hook subset of an existing Claude Code config; bespoke behavior belongs in a native plugin on the same extension points.
- **Adding context is not a veto.** A context-only hook delegates via `next()` before folding its message into a downstream enter decision, so a later `agent/pre-step` or `tools/post-execute` listener can still reject or rewrite.
- **Containment at every failure.** Config read/parse failures and invalid matchers register nothing; a throwing detached inject is caught and logged instead of breaking session boot or the loop.
- **Dispose reaches quiescence.** Detached runs are tracked and drained on disposal so no hook process or late callback outlives the fiber.
- **Serial, not concurrent.** Matched hooks run serially in config order: each `hook/invoked` / `hook/result` pair stays adjacent in the log, and the decision fold is order-independent, so the outcome matches the reference engines' concurrent launch at the cost of serialized latency.

The [hook-bridges Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md) records the bridge design and the deferred gaps; the [hook-protocol-lib Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-protocol-lib.md) records the shared-versus-per-dialect split.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config validation, listener registration, per-event payloads, decision mapping |
| [`src/config.ts`](src/config.ts) | Claude Code config parsing: supported events, matcher validation, command substitution |
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
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-hooks-claude-code) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Hook-provided context

#### What the model sees

`SessionStart`, accepted prompt, post-tool, and live in-process subagent-start hooks can add source-attributed context messages; a blocking `Stop` hook adds its reason as next-step steering. Remote-child injection has no local target.

#### Token effect

No cost when hooks return no context. Hook text is data-dependent, logged, and resent in later conversation requests until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Blocked prompt or tool outcome

#### What the model sees

Provider-supplied reasons pass through verbatim. When absent, a denied tool becomes `Error: blocked by PreToolUse hook`, blocked post-tool feedback is exactly `blocked by PostToolUse hook`, and a blocking stop adds steering exactly `continue: blocked by Stop hook`; a blocked prompt is discarded with no model-visible message, ending the turn as `blocked`. `systemMessage` and `updatedInput` are logged or warned but are not model-visible in this implementation.

#### Token effect

Blocking a prompt removes that prompt's request tokens; denial or feedback adds the retained fallback or provider text; forced continuation pays another full request.

#### KV Cache effect

A blocked prompt sends no request and invalidates nothing. Denial, feedback, and forced-continuation context append after the reusable prefix without rewriting it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what your Claude Code hooks cannot do through this bridge yet, and where behavior differs from the reference tool. They are current package constraints, not a task backlog.

- **Unsupported hook events (23 of Claude Code's current 30)** — `Setup`, `InstructionsLoaded`, `UserPromptExpansion`, `MessageDisplay`, `PermissionRequest`, `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `Notification`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `SessionEnd`, `Elicitation`, and `ElicitationResult`. Config for these events is ignored before group parsing, so an unsupported event cannot invalidate or register hooks. The comparison baseline is Claude Code's [official hook-event reference](https://code.claude.com/docs/en/hooks#hook-events).
- **`SessionStart` is partial** — JSON `additionalContext` is consumed, but plain stdout context, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`, and `CLAUDE_ENV_FILE` are unsupported. The hook runs detached, so context can miss the first request, and the payload omits optional fields such as `model`, `agent_type`, and `session_title`.
- **`UserPromptSubmit` is partial** — blocking and JSON `additionalContext` work, but plain stdout context, `sessionTitle`, and `suppressOriginalPrompt` are unsupported. Unless overridden, the bridge also uses its 600-second default instead of Claude Code's event-specific 30-second command timeout.
- **`PreToolUse` is partial** — `deny` and `ask` decisions work; `allow` does not pre-approve, `defer` is unsupported, `additionalContext` is ignored, and `updatedInput` is logged + warned but not honored ([the pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)).
- **`PostToolUse` is partial** — blocking feedback and JSON `additionalContext` work, but `updatedToolOutput` and `updatedMCPToolOutput` are unsupported and `tool_response` is flattened to text.
- **`SubagentStart` and `SubagentStop` are partial** — both report a constant `agent_type` of `general-purpose` and use the child session id where Claude Code reports the parent session. Start context is best-effort and can only reach a live in-process child; stop is observe-only and cannot block the subagent or feed it context. Stop omits `agent_transcript_path`, `last_assistant_message`, `background_tasks`, and `session_crons` and always reports `stop_hook_active: false`.
- **`Stop` is partial** — blocking forces another model turn, but `stop_hook_active` is always `false`, `last_assistant_message`, `background_tasks`, and `session_crons` are omitted, and the consecutive-block cap is not implemented. An unconditionally blocking hook therefore force-continues every step unless it self-limits.
- **Common payload and output fields are partial** — mapped event payloads omit `prompt_id`, `permission_mode`, and `effort` where Claude Code would provide them, and `transcript_path` is never populated: it is always the empty string, because the persistence seam exposes no artifact paths and the default-zstd session log is not readable by hook scripts. `systemMessage` is logged + warned but not surfaced; `{"continue": false}` is recorded but does not halt the run; `suppressOutput`, `stopReason`, and `terminalSequence` are not applied.
- **Handler and config support is partial** — only shell-form command handlers run. `http`, `mcp_tool`, `prompt`, and `agent` handlers are skipped; command-handler options such as `args`, `async`, `asyncRewake`, `shell`, `if`, `once`, and `statusMessage` are not honored. Matching handlers run serially and are not deduplicated, whereas Claude Code runs them in parallel and deduplicates identical handlers. One process-level `configPath` is parsed once at load; Claude Code's layered project, user, plugin, and policy discovery and live reload are not implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The deferred gaps above are the working queue: per-session hook-config discovery, a session-start delivery gate, a stop loop-guard, and a run-level halt for `continue: false`. None has a design yet; the official Claude Code reference is the baseline for closing any of them.

</details>
