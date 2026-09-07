# Agent Note: dsh-hooks-claude-code + dsh-hooks-codex — the Claude Code / Codex hook bridges

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-30-hook-bridges.zh.md)

## Problem

The harness's extension surface is its typed interception points ([the interception extension-points Agent Note](2026-06-30-interception-extension-points.md)): a "native hook" is just an ordinary cordis plugin subscribing to `agent/session-start`, `agent/pre-step`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-stopping`, `subagent/start`, or `subagent/end`. But users arrive with **existing** Claude Code (CC) and Codex hook configs — a `hooks.json` (or a settings file's `hooks` key) full of shell-command hooks — and want those to run unmodified. This Agent Note introduces the two **bridge plugins** that translate that external shell-hook protocol onto the typed extension points, built on the shared wire-protocol library ([the hook-protocol-lib Agent Note](2026-06-30-hook-protocol-lib.md)).

The core rule is: **a bridge is a compatibility adapter, not a power tool.** Anything a bridge does (block a tool, inject context, force continuation, observe a subagent) a native cordis plugin does more powerfully — typed returns, full `ctx`, no serialization boundary. The bridge's reason to exist is to run the explicitly supported subset of external CC/Codex command hooks. That keeps each bridge thin: parse the config, pick a matcher mode, build the per-event payload, call `runHook` + `mergeHookOutputs` from the shared lib, and map the neutral outcome to a typed Decision. The package READMEs own the exact current unsupported-event and partial-field inventory against the official protocols.

## Decision

Two independent plugins in the `packages/hooks/` group, each a function/namespace plugin (`name`/`inject`/`Config`/`apply`, NO default export — see [postmortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md)) injecting only `bash`:

- **`dsh-hooks-claude-code`** — the CC dialect. Seven of Claude Code's current hook points: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop`. Owns CC-shaped per-event stdin payloads (a base of `session_id`/`transcript_path`/`cwd`/`hook_event_name` plus per-event fields), `CLAUDE_PROJECT_DIR` plus `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` substitution, and the literal-or-regex matcher mode. `transcript_path` is the persistence locator result or `''`; stdin carries a **trailing newline**.
- **`dsh-hooks-codex`** — five of Codex's current hook points: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, and `Stop`. It uses an always-regex matcher, Codex-shaped snake_case payloads with `turn_id`/`model`/`permission_mode` extras written WITHOUT a trailing newline, no Codex plugin-env injection or config-time placeholder substitution, and no pre-tool approval or rewrite path. `transcript_path` is the same locator result or `null`; tool payloads carry the real `tool_name` in the reduced `tool_input: { command }` shape.

### Outcome → Decision mapping

Each bridge maps the neutral `MergedHookOutcome` from the shared lib onto each extension point's typed Decision:

| Extension point | CC | Codex |
|---|---|---|
| `agent/session-start` (emit) | additionalContext → `agent.inject()` | plain-stdout output → additionalContext → `agent.inject()` |
| `agent/pre-step` | `deny`→`reject`; context-only→delegate+fold into `enter` | `block`→`reject`; context-only→delegate+fold into `enter` |
| `tools/pre-execute` | `deny`→`deny`; `ask`→`ask` | `block`→`deny` (no allow/ask) |
| `tools/post-execute` | `deny`→`block`+feedback; context-only→delegate+fold | same |
| `agent/turn-stopping` | blocking Stop → next-step steering | same |
| `subagent/start` (emit) | additionalContext → inject into a live in-process child; a remote child has no local injection target | unsupported by this bridge |
| `subagent/end` (emit) | observe-only | unsupported by this bridge |

The CC bridge's `ask` result is a real permission path, not a terminal bridge decision: `dsh-tools` resolves it through the optional [approval seam](2026-07-06-approval-seam.md). An ACP automation client may answer the owning session's one-shot machine-policy request and `allowed-once` proceeds; without an ApprovalService or answerer, the call fails closed to `deny`.

### Context source is always the plugin (the mislabel guard)

Every bridge `inject()` and additional-context input explicitly passes `{ kind: 'plugin', plugin: 'hooks-claude-code' | 'hooks-codex' }`. Unit coverage pins the resulting `user/message.source` as the plugin rather than the user.

`UserPromptSubmit` runs at pre-step after `turn/start`, so every invocation writes its turn-scoped `hook/invoked` / `hook/result` pair. Rejection leaves the claimed input removed, closes the turn as blocked with no step, and retains the hook pair as its durable decision evidence. The Codex payload receives that open turn's `turn_id`.

### Adding context is not a veto — delegate, then prepend

A hook that only attaches `additionalContext` (no block/deny) is NOT a decision the bridge should return on its own: returning `enter` from a waterfall listener WITHOUT calling `next()` short-circuits every later `agent/pre-step` / `tools/post-execute` listener, so a policy/sandbox plugin registered after the bridge would never see the prompt. Each bridge therefore delegates via `next()` before adding its context to a downstream enter decision. The bridge preserves every downstream message, while a downstream pre-step rejection drops the whole claimed batch because no step opens. Post-tool decisions retain their independent ordered `additionalContexts` semantics, including PTC mode deferral through the outer `run_code` result. Only a real `deny`/`block` from the hook itself short-circuits. Tests assert a later listener can still reject a prompt after a context-only hook and that retained prompt and post-tool contexts remain separate.

### CLAUDE_PROJECT_DIR defaults to the session workspace

Claude Code always exports `CLAUDE_PROJECT_DIR`, and common unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths. An explicit `config.projectDir` wins; when it is omitted (the default ACP wiring configures only `configPath`), the bridge defaults the env var per-run to the agent's session workspace — the same `session.header.cwd` the hook already runs in — rather than leaving it empty. So a stock project-relative hook works in the default setup.

### Containment

The config is parsed ONCE at load; a read/parse failure logs and registers nothing rather than crashing boot (a typo'd path must not take the agent down). Only shell-form `type: 'command'` hooks run for CC; `http`, `mcp_tool`, `prompt`, and `agent` handlers are parsed-and-skipped. Codex runs only synchronous command handlers and skips `async: true` or non-command entries. The emit-listener paths (`session-start`, `subagent/start`) run detached, with their `inject` contained in a `.catch` that logs (a throwing inject must not break session boot or the loop).

### Where hooks run, and where their config comes from

Hooks run in the agent's session workspace, so relative paths target the user's project. `configPath` is resolved once against the process launch cwd and applies to every session. Per-session project-local discovery remains deferred under `TODO(per-session-hook-config)`.

## Deferred compatibility gaps

- **Tool-input rewrite.** A CC/Codex `updatedInput` is logged + warned, not honored — input rewrite is a deferred consistency-design problem ([the pre-tool-input-rewrite Agent Note](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md)), because the pre-execution args are read by `tool/call` audit + `assistant/message` history + tool presentation, so an honest rewrite is a design unit, not a field.
- **Stop loop-guard** (`TODO(stop-loop-guard)`). Claude Code supplies `stop_hook_active` and overrides a hook after eight consecutive blocks; Codex supplies `stop_hook_active` but documents no equivalent cap. Both bridges always report `false`, so a Stop hook that unconditionally blocks force-continues every step — a hook author must self-limit until state tracking lands.
- **Hook `continue:false` (hard halt).** A hook can ask to halt the whole run (CC/Codex `continue:false`); the shared merge folds it into `MergedHookOutcome.stop`/`stopReason`, but no bridge acts on it (`TODO(hook-continue-false)`) — the interception points have no "hard-halt the agent" primitive yet (a Decision blocks/steers a single point, not the run). Deferred with the loop-guard work; mid-turn requests record the halt in `hook/result`, and the hook keeps its per-point effect (decision/context) meanwhile.
- **Config discovery.** The path is explicit in `cordis.yml` and process-level (see above); the full multi-layer CC/Codex precedence walk, per-session project-local discovery, and the trust/hash model are not reimplemented (`TODO(per-session-hook-config)`).
- **Session-start / subagent-start context is best-effort (`TODO(session-start-gating)`).** Both hooks run detached from startup, so their context is injected when ready but may miss the first request or a short-lived child. Guaranteeing first-request delivery requires an awaited startup extension point.

## Alternatives considered

**Concurrent per-point hook execution.** The reference engines run a point's matched hooks concurrently and fold the results. These bridges run them **serially** (`await` per hook inside the match loop) and fold with the same most-restrictive merge. Serial is deliberate: for turn-scoped points it keeps each hook's `hook/invoked`/`hook/result` pair adjacent and in deterministic order, and the fold is order-independent for the decision (`deny > ask > allow`) so the outcome matches. The cost is latency (hook *N* waits for hook *N−1*) and that per-hook timeouts are not overlapped — acceptable for the hook counts real configs use; revisit if a config ever fans out enough for the wall-clock to matter.

## Consequences

Matcher semantics, exit-code handling, and merge precedence live in `dsh-hook-protocol`; each bridge only parses config, builds dialect payloads, and maps outcomes. Per-file coverage includes config branches plus end-to-end mappings through a real loop, `dsh-bash-local`, and shell scripts, while a real-Loader smoke guards the package export shape. Native plugins bypass the wire protocol and return typed decisions directly.
