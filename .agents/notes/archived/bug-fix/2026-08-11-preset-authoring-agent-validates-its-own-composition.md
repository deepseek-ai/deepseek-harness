# Agent Note: The preset-authoring agent mount-validates its own composition

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-preset-authoring-agent-validates-its-own-composition.zh.md)

## Problem

The `cordis` preset ships `editing-cordis-compositions`, the only guidance an agent has when it authors a preset. Four of its statements were false, and the two that carried the most weight pointed at the rule the skill itself calls "the rule that catches people".

It named `tool-bash` as the worked example of a row whose name hides a service — "reads like a tool but provides `bashEnv`". `tool-bash` provides nothing; it declares `inject: ['tools', 'bash', 'systemPrompt', 'bashEnv']`, and `bashEnv` comes from the host composition's own `shell-env` row. An agent wrapping `tool-bash` in an `isolate` realm on that advice strands the row waiting for a service its realm hides, and the whole preset fails to mount.

Its `isolate` example composed `jobs-local` with `tool-jobs`. `jobs-local` is host-plane, and the shipped compositions say in their own comments that an entry-local realm around `tool-jobs` makes `run_in_background` answer "background jobs unavailable". The example contradicted the file next to it.

It described a string realm label as pooling one instance across subtrees. Labels join realms; `provide()` still throws on the second registration under the same realm symbol, which `standard`'s header comment already stated.

It sent the agent to a package's README to learn whether a row publishes a service. Every harness package declares `files`, and no declaration includes its README, so an installed deployment carries none. There that instruction cannot be followed at all.

Underneath all four sat a capability claim: the agent "cannot start one \[a session\] yourself", so verification was hand-reading YAML fields and handing the result to the user through the settings page's red marking. That marking is discovery's shape check, which is far weaker than the sentence implied.

## Decision

The skill teaches the agent to mount-validate its own composition through `ctx.agentPresets`, and every remaining example is taken from a shipped composition in the same repository.

`standingKeyFor(id)` is the check. It runs `ensureStanding()` — the same real mount a session start performs, minus the agent — so it rejects a row whose package does not resolve, a row whose config is invalid, a service published into the root realm, and a row that never activated. A failed mount deletes the standing entry and disposes its scope, leaving nothing behind; a successful one installs the standing generation the first real session would have installed anyway. The skill therefore places it as the final check on a finished edit rather than a per-line loop.

The skill states plainly that `list()`'s `broken` field is **not** validation. Discovery's health check proves the file parses in the loader's dialect and holds named rows, and every one of the four failures above passes it.

The agent reaches the roster service the way `cordis_mount` documents: a temporary plugin declaring `inject: ['agentPresets', 'tools']` that registers a tool for itself, because a mount returns only its own acknowledgement and a registered tool is how a service answer reaches the model on the next step. The skill ships that plugin verbatim. `agentPresets` is in the generated `cordis_inspect what:"api"` catalog with full JSDoc, and the sandbox façade gates services on `fiber.inject` alone rather than an allowlist, so nothing about this path is special-cased for the skill.

`copy(from, id, name)` is named as the authoring write, in place of a shell copy: it validates the id, refuses one any root supplies, rolls a failed copy back, rewrites the copy's `preset.yml`, and runs host-side without sandbox escalation. The escalation guidance stays, moved to where it applies — editing `agent.cordis.yml` afterwards still writes outside the session workspace.

"Whether a row publishes a service" resolves through `cordis_inspect what:"services"`, which names the owning fiber of every live service.

The guidance keeps `${DSH_HOME:-$HOME/.dsh}/.agent-presets/` as the answer to "where do my presets live" while routing the path an agent actually reads or edits through `list()` or `resolve()`. Stating the path is right for talking to a person and wrong for feeding a file tool: a deployment may configure other roots, and `list()` cannot reveal a user root that holds nothing yet.

That path is now a property of the package rather than of one launcher. `AgentPresets` derives `<dshHome>/.agent-presets` as a `user` root unless `includeUserRoot` is false, the way [`dsh-skill-filesystem`](../../../../packages/skill/skill-filesystem/README.md) derives `<dshHome>/skills`, and `apps/cli` supplies only the SHIPPED root — the one path an installed app alone can resolve. The asymmetry it replaces cost a bug: with both roots patched in by one launcher, `dsh run` booted a roster with no roots at all and failed resolving `standard` (fixed then by teaching every launcher the patch). The derived root is appended after every configured root, so a shipped id still shadows a home directory claiming it, and `writableRoot()` still prefers an explicitly configured `user` root. It is resolved once at construction: a root set that changed between a `list()` and the `copy()` acting on its answer would author into a directory the caller never saw.

The prohibition on touching the shipped install is promoted from a paragraph inside the authoring steps to a top `## Off-limits` section, extended to cover editing the host composition as a workaround. The new self-validation calls do not weaken it: `copy()` refuses an id any root supplies, and `remove()` refuses a preset that ships with the deployment.

## Measured behavior

Each row was produced by booting the shipped Web composition and calling the tools through `ctx.tools.execute` on an agent composed from `cordis` — no model in the loop.

| Composition under test | `list()` `broken` | `standingKeyFor()` |
|---|---|---|
| row names an absent package | empty | `Cannot find package '@deepseek-ai/dsh-does-not-exist'` |
| service row with no realm, name the host supplies | empty | `service "tasks" has been registered at <LocalJobRegistry>` |
| service row with no realm, name the host does not supply | empty | `row(s) published process-global service(s) [workflows]; …` |
| same row inside `isolate` | empty | mounts |
| consumer row with no provider | empty | `1 row(s) did not activate: … waiting for workflows` |
| row missing a required config field | empty | `invalid config: $.allowParallelInProgress missing required value` |

The skill's own `cordis_mount` snippet was executed verbatim through the tool registry: it mounts, its `preset_check` tool appears in the composing agent's catalog on the next read, and it answers `mounted OK` for a valid preset and the mount rejection for an invalid one.

## Alternatives considered

**Leaving verification with the user and only fixing the four errors.** The errors and the capability claim share a cause — the guidance was written from the preset layer's public surface rather than from what the composed agent can reach — and an agent that cannot check its work hands over compositions whose defects the settings page cannot see either.

**Teaching `list()`'s `broken` field as the check.** It is the one the settings page shows, so it reads like the intended answer. It passes every failure that matters, and presenting it as validation is what made the original guidance feel complete.

**Adding a first-class preset-validation tool to the preset.** The composed path already exists and is documented by `cordis_mount`'s own schema; a dedicated tool would add a model-facing row to a preset whose point is that the runtime is reachable without one.

## Consequences

- A successful validation leaves a standing generation that is never reclaimed, which is the [standing-mount](../architecture/2026-08-08-per-preset-standing-mounts.md) cost the roster already carries per generation — the agent pays it once at the end of an edit instead of the user paying it at the first session.
- The skill now depends on `cordis_inspect`'s generated API catalog staying current for `agentPresets`; `verify-cordis-api` in `doc-sync` is what holds that.
- Two examples are now quotations of `standard`'s composition. They drift if that file's `delegation` group changes, which the `web-agent-presets` e2e does not catch.
- The four corrected statements were the skill's only concrete illustrations of the realm rule. Replacing rather than deleting them keeps the rule teachable; the replacements are verifiable by reading one shipped file.

## Related

Supersedes the creator-guidance bullet in [broken presets are roster rows](2026-08-09-broken-preset-roster-rows.md), whose health-check decision remains current — this note reverses only its "the agent cannot start sessions; the settings page's red marking is the user's check" conclusion. Authoring's copy-only shape is owned by [copy-only preset authoring](../simplification/2026-08-08-copy-only-preset-authoring.md).
