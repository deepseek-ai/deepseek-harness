# Agent Note: Expose agent session identity to tools and hooks

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-10-agent-session-identity-and-log-location.zh.md)

## Problem

An agent can identify its workspace through `session.header.cwd`, but a model using bash cannot reliably identify the session that owns the call. Resume, forks, and concurrent parent/child agents make any ambient guess unreliable, while future plugins may need to expose other harness-owned environment facts to shell commands.

The boundary must preserve two properties: the owner of a fact decides how to resolve it, and every child receives a per-execution snapshot rather than process-global mutable state. In particular, a nested harness must not leak its ambient `DSH_*` values into a child whose current agent, persistence backend, or configuration differs.

## Decision

The model-facing bash package owns a `ctx.shellEnv` registry. A contributor declares its stable name, every `DSH_*` key it may return, a description for each key, and `resolve(execution: ToolExecution)`. Duplicate contributor names, duplicate key ownership, reserved keys, malformed declarations, undeclared runtime output, and non-string output fail loudly. Registration is a Cordis effect and is removed with the contributing plugin fiber. `list()` exposes declarations without running resolvers, keeping the environment API enumerable for diagnostics and future prompt/UI consumers.

The registry rebuilds a trusted overlay for every foreground and background bash `ToolExecution`:

- `DSH_HOME` is always the absolute configured Harness home. The standalone [`@deepseek-ai/dsh-home-paths`](../../../../packages/util/home-paths/README.md) utility owns its precedence: explicit `dshHome`, then ambient `$DSH_HOME`, then `~/.dsh`.
- `DSH_SHELL=1` is always present and identifies a model bash child managed by DeepSeek Harness.
- `DSH_SESSION_ID` is present when the execution has an agent and equals `agent.session.header.id`.

A transcript-location fact is deliberately absent. An earlier form of this decision also extended the persistence seam with a `locate()` path query feeding a `DSH_SESSION_JSONL` variable and the hook bridges' `transcript_path`; the [persistence export and pre-release trims](../simplification/2026-08-27-persistence-export-and-pre-release-trims.md) note owns removing that half — the paths were only readable with compression disabled, and the seam no longer exposes artifact locations.

Plugins that need shell-visible facts depend on the registry and register their own keys; they do not modify `process.env`.

The bash seam exports `DSH_ENV_PREFIX` as the single namespace source and derives `DshEnvironmentKey` from its `typeof`. Tool-bash derives built-in names and model guidance from that constant, while executors use it for ambient filtering. The seam carries the managed overlay separately as `ShellExecRequest.dshEnv` / `ShellExecSpec.dshEnv`: ordinary `env` remains the general in-process plugin surface used by hooks, while `dshEnv` is typed to managed keys. The local executor removes every inherited ambient managed key, applies its ordinary scrub/terminal environment/explicit `env`, and finally merges the trusted `dshEnv` snapshot, so an `env` entry can never displace a managed value. This guarantees that a missing value means absent now rather than inherited from an outer or previous harness. The model-facing tool still ignores model-supplied `env`/`stdin` arguments.

The bash tool description teaches only the durable convention: current harness environment facts are available through managed `$DSH_*` variables and may be inspected when needed. It does not enumerate persistence-specific keys or add a permanent system-prompt section. Tool schemas are already logged in request headers and tool output is logged as `tool/result`, so no new session event is required.

The [Claude Code and Codex hook bridges](2026-06-30-hook-bridges.md) keep `transcript_path` in their wire payloads for protocol shape but always send `''` (Claude Code) / `null` (Codex); the [persistence export and pre-release trims](../simplification/2026-08-27-persistence-export-and-pre-release-trims.md) note owns that degradation.

## Peer product findings

Peer products separate stable identity from physical storage. Codex injects stable `CODEX_THREAD_ID` into spawned shells while recorder and hook integrations own transcript paths. Claude Code supplies `session_id` and `transcript_path` as structured hook/status input. OpenCode carries identity in structured tool context; Kimi Code expands a session placeholder; Reasonix keeps the active session path on its controller. The portable rule is to inject identity at the invocation boundary, let storage resolve location, and never use a process-global current-session variable in a concurrent harness.

## Lifecycle and persistence semantics

A fresh session receives its id before the first turn, so its first bash call can read `DSH_SESSION_ID`. Resume reuses the loaded header and therefore the same id. Fork and spawn create new session ids. Parent and child calls resolve from their own `ToolExecution.agent`; each command receives an immutable snapshot even when calls overlap. The registry is effect-scoped and HMR-safe.

`dshHome` is session-independent deployment context. Agent-core resolves one value through `@deepseek-ai/dsh-home-paths` and routes it to both tool-bash and local skill discovery; standalone consumers call the same resolver. If top-level `dshHome` and `skills.local.dshHome` are both supplied and resolve differently, composition fails instead of exposing contradictory homes. Persistence may change independently without freezing its facts into the session prefix.

## Testing

Unit coverage pins registry declaration validation, effect disposal, per-execution collection, the `dshHome` precedence, and the local executor's `DSH_*` scrub/rebuild order. Request-recording tests cover foreground/background snapshots, no-agent calls, ignored model `env`, and parent/child isolation. Both hook bridge suites pin the constant degraded transcript dialects.

A keyless full-loop integration drives the real agent loop, JSONL persistence, tool-bash, and bash-local on the first turn. The child prints `DSH_HOME`, `DSH_SHELL`, session id, and an inherited stale sentinel; the test verifies current values, absence of the stale variable, and the eventual persisted header. Snapshot coverage pins the generic bash description in the recorded request header. No with-key test is required because the contract is deterministic local execution rather than model choice.

## Alternatives considered

**Only an id plus `find`.** Search cannot know a custom root or backend layout and races under multiple sessions.

**Global `process.env`.** Concurrent agents would overwrite one another and nested harnesses would inherit stale current-session values.

**A typed waterfall event.** Listeners cannot declare ownership without running, and later listeners can silently overwrite keys. A registry detects key conflicts at registration and remains enumerable.

**Have each persistence backend register bash env directly.** That reverses the dependency from storage into one consumer and forces bash into deployments that do not use it.

**A model-facing `session_info` tool.** It adds schema and another call while bash already supplies the query API; the registry generalizes to future environment facts without one tool per fact.

## Consequences

Every model bash child receives current Harness home and shell identity, and agent calls additionally receive stable session identity. The managed `DSH_*` facts inside these children come from the harness: ambient values are removed, current trusted values are re-added last, and an ordinary caller's `env` entry cannot displace them.

The namespace is discoverable but not secret. `DSH_HOME` can reveal a configured root, and a command can override variables inside its own shell syntax. Consumers treat them as correlation and environment facts and rely on sandbox/filesystem policy rather than variable secrecy for authorization.
