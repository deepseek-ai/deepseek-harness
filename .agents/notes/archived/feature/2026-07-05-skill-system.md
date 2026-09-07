# Agent Note: Skill system — progressive disclosure instructions for agents

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-05-skill-system.zh.md)

## Problem

Agent products have converged on a skill pattern: keep the request prompt small by listing only available instruction bundles, then load the full body when the model decides a task matches. Codex, Claude Code, OpenCode, and Kimi Code differ in details, but all separate discovery metadata from complete instructions so a workspace can carry reusable behavior without paying the full prompt cost on every turn.

DeepSeek Harness uses the same primitive so project-specific review, plugin-authoring, and tool-usage guidance lives next to the workspace or the user's agent configuration instead of being hard-coded into the loop.

## Decision

`@deepseek-ai/dsh-skill` is the pure provider registry (`ctx.skills`), `@deepseek-ai/dsh-skill-filesystem` is the shipped local filesystem provider, and `@deepseek-ai/dsh-tool-skill` owns the durable session catalog and model-facing loader tool. `dsh-base` loads the registry, local provider, and consumer as separate rows so its profiles get the same behavior while embedded or remote providers contribute skills without changing the registry or consumer. Each row exposes only its owning package's configuration.

Dedicated packaged providers can contribute immutable skills without filesystem discovery. The shipped CLI declares `@deepseek-ai/dsh-skill-badge` disabled by default; enabling its composition row contributes the official badge instructions through the same registry and consumer (see [the package contract](../../../../packages/skill/skill-badge/README.md)).

Provider plugins register synchronously during `apply()`. Provider membership is direct effect-owned state: registration and disposal invalidate completed catalogs synchronously, and discovery reads the current provider map on demand rather than observing registry-change events. Provider catalogs return ranked candidates from awaited `list()` calls, where remote providers perform initialization, authentication, and discovery while honoring the lookup abort signal. The registry validates each candidate, resolves same-name skills first-wins by rank, provider registration order, and provider-local order, then sorts summaries by skill name for deterministic consumers. It caches only completed catalog snapshots and retries when a provider/runtime revision changes during discovery, so an unload cannot freeze a stale, unresolvable skill into a session catalog. Runtime `ctx.skills.register(...)` remains a convenience for embedded in-process skills and uses project-over-user priority; `runtime` is reserved as the registry-owned provider name.

The local provider scans cwd-sensitive project roots, custom roots, and user roots in first-wins rank order: project `.dsh`, project `.agents`, `customSkillDirs`, user `.dsh`, then user `.agents`. The user `.dsh/skills` scan skips `.system` so a system-owned directory is not treated as normal user content. The local provider does not synthesize built-in system skills; configured bundled roots and dedicated providers supply additional skills.

Each skill is either `<name>/SKILL.md` or `<name>.md` with YAML frontmatter. `name` and `description` are required; `whenToUse`, `metadata`, `disable-model-invocation`, and `user-invocable` are optional. Names are kebab-case. The invocation fields project into a typed nested policy as defined by the [independent model and user invocation decision](2026-07-28-skill-invocation-policy.md); the parser rejects the old camel-case spellings. YAML frontmatter is parsed with the `yaml` package instead of `js-yaml` or a hand-written parser: `yaml` is the already-declared modern parser for this package's limited frontmatter needs, and a narrow parser would either reject valid YAML users expect to work or grow into an unreviewed YAML subset.

Local skill filesystem I/O goes through `ctx.fs` when a filesystem service is loaded: project-root lookup probes `.git` with `resolve` and `stat`, root discovery uses `listDir`, and skill reads use `readText`. The Node filesystem remains a fallback for minimal contexts that mount `dsh-skill-filesystem` without the fs seam. Missing roots, unreadable or malformed skill files, and transient provider `list()` failures degrade to warn-and-skip so one bad source does not make every agent request fail; malformed candidates still fail fast because they are provider contract violations.

`dsh-tool-skill` injects one durable user-role `<system-reminder>` catalog as a sourced `user/message` at the session's first `agent/pre-step`, and only when that agent's tool view resolves this plugin's exact `skill` registration. The catalog contains sorted skill name and description only; it excludes bodies, paths, sources, providers, and routing hints. Descriptions are whitespace-normalized, XML-escaped, and capped by `catalogDescriptionMaxLength`, whose default is `500` and minimum is `3`. Full skill bodies are never included in the catalog. (The catalog originally rode the request-only [session-prefix extension point](../../archived/feature/2026-07-07-session-prefix.md), archived; the [unified sourced-message decision](../architecture/2026-07-22-unified-send-and-coalesced-user-messages.md) moved it into durable history.)

The registry's `list()` returns every winning summary, while model and user consumers apply the invocation predicates owned by the [independent invocation-policy decision](2026-07-28-skill-invocation-policy.md). The `skill({ name })` tool loads one model-invocable skill for the current agent cwd and returns a tool result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`. `resourceBase` supplies a directory, URL, or opaque provider-managed base for explicitly referenced scripts, references, and assets; resources load only as needed, without directory enumeration. An unresolved name reports that the skill is unknown or no longer available; invalid names and skills with `invocation.modelInvocable: false` retain distinct tool errors. The tool result is the model-visible disclosure path.

The data structures and catalog/tool contract are documented in [skills.md](../../../../docs/subsystems/skills.md), with service signatures in the generated [services catalog](../../../../docs/subsystems/skills.md#cordis-surface).

## Alternatives considered

**Inject full skill bodies into every system prompt.** Rejected because it destroys progressive disclosure and makes every request pay for instructions that may not apply.

**Expose skills only as slash commands.** Rejected because model-initiated loading is the core capability; human command advertisement does not change discovery.

**Put local filesystem scanning directly inside `ctx.skills`.** Rejected because coding agents, web agents, and future plugin ecosystems need different skill sources. A provider registry mirrors the subagent seam: the registry owns conflict resolution and consumers, while implementations own loading.

**Use a system-prompt section.** Rejected because the rendered system prompt is a single string, while the catalog is a user-role `<system-reminder>` message. The [request-only session-prefix extension point](../../archived/feature/2026-07-07-session-prefix.md) (archived) was the original mechanism; after the unified sourced-message decision removed it, the catalog became a durable sourced injection with the same message shape.

**Materialize built-in DSH authoring skills under `~/.dsh/skills/.system`.** Rejected because bundled skills do not write user home on startup, and embedded or remote providers supply configured skills.

**Recursively discover nested `**/SKILL.md`.** Rejected. Flat files and one-level directory bundles cover the configured roots while keeping duplicate handling and catalog order easy to reason about.

**Hand-parse frontmatter.** Rejected because the accepted schema includes an open `metadata` object. A narrow parser would either reject valid YAML users expect to work or grow into an unreviewed YAML subset.

## Consequences

The agent-core spine includes one catalog contributor, one local provider, and one model-facing tool. Skill discovery is cwd-sensitive, so callers that create agents with different session cwd values can observe different project skill overrides by design.

The catalog is deterministic for a fixed root set and runtime registration revision. The local provider watches configured roots and invalidates completed catalogs after relevant disk changes; runtime registration and provider disposal also invalidate them.

## Deferred

Forked skill contexts (`context: fork`), parameter declarations and hints (`arguments` and `argument-hint`), and per-skill tool constraints (`allowed-tools` and `disallowed-tools`) are outside the shipped contract. The registry, local provider, and model-facing tool do not parse, advertise, or enforce these fields. Direct user invocation shipped as a TUI affordance over the shared invocation policy and trusted `get()` primitive; see [the archived TUI skill slash command](../../archived/feature/2026-07-21-tui-skill-slash-command.md).
