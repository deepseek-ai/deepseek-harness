# Agent Note: Prompt variables and tool-guidance ownership

Status: implemented

English | [中文](2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)

## Problem

The assembled system prompt had four defects, all of one family: facts the harness already knows were restated by hand somewhere else, and drifted.

**The model could not know its own name.** `AgentOptions.model` drives every request, but no prompt text carried it — and nothing COULD carry it: sections in `dsh-system-prompt` were context-global while the model name is per-agent, and `assemble()` took no per-agent input at all.

**Tool guidance was hand-written prose in leaf YAML.** The shell/subagent/todo_write usage guidance lived in the coding-agent and ACP persona strings — two drifting copies (the ACP one was already abridged) — while `dsh-tool-fs` and `dsh-tool-web` owned their guidance as `ctx.systemPrompt.section()` contributions. Loading or dropping a tool plugin meant editing every deployment's persona by hand, and the old terminal welcome banner hand-enumerated the tool set too.

**The persona rendered after tool guidance.** The loop string-joined `agent.options.systemPrompt` AFTER the assembled sections, so the model read "Use the read tool…" before "You are a coding agent" — backwards relative to the identity-first convention (Claude Code, Codex) and a second composition path besides the section pipeline.

**The fork tool's description was false.** `dsh-tool-subagent` hardcoded one description written for spawn semantics — "a separate agent that works in its own context … it does not see this conversation" — and the `subagent_fork` instance (whose child inherits the parent's completed turns) got the same words; the YAML prose corrected the lie out-of-band. Minor kin: `PromptSection.name` was documented "(diagnostics / dedup)" but duplicates were silently accepted.

## Decision

**One principle: every fact in the prompt has exactly one owner.** The model name and workspace are config/session facts → the harness exposes them as variables and the persona references them. Per-tool semantics and when-to-use → the tool's `description`. Cross-call habits a description cannot carry → the tool package's prompt section. The product name and SDK identity line → the static `harness:identity` section. Deployment role and behavior → the deployment's persona.

### Assemble context

`SystemPrompt.assemble(context)` takes a merge-extensible `AssembleContext`. `dsh-system-prompt` declares the optional `scope` selector used for scoped routing, while `dsh-agent` declaration-merges the optional typed `agent` field onto it (a type-level edge `agent → system-prompt`, with no runtime dependency cycle). The loop calls `assembleContextFor(agent)` each step so both fields identify the same agent; section text providers may read that context, and the `system-prompt/assemble` waterfall receives it so a listener can filter or extend per agent.

### Prompt variables

Plugins register `{{name}}` values through `ctx.systemPrompt.variable(name, provider)`. Assembly resolves them into the waterfall-visible variable map. Rendering rejects unknown own-property references, registered providers that return `undefined`, malformed complete references, and unbalanced references that still contain a closing `}}`; a lone unmatched `{{` remains prose, and substituted values are not rescanned. Registration rejects invalid or duplicate variable names, and section names are unique.

`dsh-agent-loop` registers the two built-ins, both pure projections of the context agent: `model` (= `options.model`) and `cwd` (= `session.header.cwd`). The example personas write `powered by the {{model}} model` — the model name is stated once, in the `model:` config key. `{{cwd}}` is demonstrated in the ACP example only: every ACP session carries the client's cwd, while config-pre-created stdio agents have none (a persona claiming `{{cwd}}` there fails the turn — by design). The variables stay on the loop plugin (unlike the sections below): they are runtime facts of the agents THIS loop drives, and a replacement loop supplies its own.

### Persona as the order-0 section

`dsh-system-prompt` owns `harness:identity` at first-party order `-1000` and the configured `deployment:persona-prefix` at order 0, so both survive a replacement loop. Prompt rendering has one path, `renderPrompt(assembly)`, and the routed request header therefore records the exact prompt later replayed by `ctx.tokenMeter` for compaction pressure. An agent-scoped `deployment:persona-prefix` shadows the global default and lets subagent providers install a persona before publication. The [`dsh-system-prompt` README](../../../../packages/core/system-prompt/README.md) owns the sparse named placements for identity, policy, tool guidance, generated protocol, and final-output obligations.

### Tool guidance ownership

Per-tool semantics and selection guidance live in tool descriptions. Prompt sections carry only cross-call habits, such as checking bash exit markers or preferring filesystem tools over shell commands. `todo_write` and subagent tools need no section because their descriptions contain the full contract. Deployment personas contain only role and behavior.

### The subagent conversation-history descriptor

`SubagentProvider.inheritsParentContext` describes conversation seeding, not scope, services, tools, or authority. Spawn and ACP set it to `false`; fork sets it to `true`. `dsh-tool-subagent` derives its tool and prompt-parameter descriptions from the flag, including that fork inherits completed turns but not the in-flight turn. Provider lifecycle events keep that wording synchronized with reactive provider registration; their rationale lives in the [provider-lifecycle-events Agent Note](../../archived/architecture/2026-07-05-subagent-provider-lifecycle-events.md).

## Alternatives considered

- **The loop composes an identity line itself** — hardcodes model-facing prose in the one package that must stay thin ("plugins, not loop changes"), and outside the section pipeline it would be a second composition path. (The identity DOES ship as a code literal — but as an ordinary section registered by `dsh-system-prompt`, whose `system-prompt/assemble` waterfall remains the escape valve for a deployment that must drop it.)
- **Inject the model name via the `agent/request` waterfall** — prompt text would be composed in two places and the earlier rendered persona could disagree with the final routed header. The request plugin that owns late routing must also own any earlier prompt claim about that model.
- **Hand-write the model name in each persona** — duplicates the `model:` key one line above and silently lies after a config edit; the exact disease this decision cures.
- **Lenient interpolation (leave unknown refs verbatim, or substitute empty)** — a typo ships `{{modle}}` (or a hole) to the model and nobody notices until transcript review.
- **Per-instance subagent wording in config** — returns model-facing prose to every deployment × instance, reviving the hand-written-guidance-in-leaf-YAML drift. **Keying wording off the provider NAME** — `providerName` is itself config, so a renamed provider silently gets the wrong words.
- **Resolving the provider at `apply` time (a load-order requirement)** and **section-only subagent wording (lazily resolved at assemble)** — the alternatives to the provider-lifecycle events; both rejected in [the provider-lifecycle-events Agent Note](../../archived/architecture/2026-07-05-subagent-provider-lifecycle-events.md).

## Out of scope

- Further variables (`date`, platform, git state) — the registry makes each a one-line contribution by whichever plugin owns the fact; none is claimed here.
- A config `cwd` for pre-created stdio agents (would let the stdio persona use `{{cwd}}` and partition persistence by real path) — deferred until the session-cwd story is revisited.

## Shipped invariants

- The tui-agent prompt renders identity, persona with the interpolated model, then fs/shell/web guidance through one assembly path.
- Fork and fresh subagent descriptions reflect whether the provider inherits completed conversation turns; the tool appears, disappears, and is reworded with provider lifecycle changes.
- Unknown, valueless, malformed, or unbalanced variable references name the section and throw; duplicate section, variable, and tool registrations also throw.
- Snapshot replay is prompt-independent: it keys recorded chunk streams by turn and step without comparing the outgoing request.

## Consequences

- Every fact in the assembled prompt now has exactly one owner, and the hand-maintained tool prose in leaf YAML is gone: loading or dropping a tool plugin no longer means editing any deployment's persona.
- `{{model}}` reflects `AgentOptions.model` at assembly time. A plugin that switches models in the `agent/request` waterfall makes the prompt's claim stale for that step, and one that SUPPLIES the model there (options.model unset — the loop's documented fallback) leaves the variable valueless at render, failing a `{{model}}` persona before the waterfall runs. Both have the same remedy, and it is the ownership rule itself: the plugin that owns the late-bound model fact states it early on the `system-prompt/assemble` waterfall (`assembly.variables['model'] = …`) — one owner, both statements; a loop test pins the supply path end-to-end. Accepted.
- While a bound provider is absent (not yet activated, unloaded, mid-HMR-reload), the subagent tool does not exist and a model request in that window simply lacks it. That is the honest state — the alternative was a registered tool whose description or execution could not be trusted.
- Strictness means a persona can fail a turn at render (e.g. `{{cwd}}` on a cwd-less session). The failure is contained — the turn ends `error`, the loop survives — and it is an authoring error we WANT loud.
- No escape syntax for a literal `{{name}}` in prompt prose yet; add one if a real prompt ever needs it.
