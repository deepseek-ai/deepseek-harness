---
description: "Per-session agent composition from preset cordis.yml files, for users and maintainers choosing, configuring, or debugging agent presets."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-presets

English | [中文](README.zh.md)

## Summary

`dsh-agent-presets` composes each agent session from one preset: a directory holding a single `agent.cordis.yml` that names the plugins the session runs with. A session that names a preset gets that preset's tools, prompt sections, and skills, while every other session keeps its own, so one process can run several differently composed agents at once. The package maintains the preset roster: it lists every preset the configured roots supply — shipped ones and your own under `<dshHome>/.agent-presets` — shows a reason when a preset cannot start a session, and lets you create new presets by copying existing ones. The default preset is a setting you can override per deployment or per user, and a session can switch to a different preset only while it has produced nothing. A preset is as privileged as the plugins it names, so a preset you author carries the same trust as shell access.

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

Mount this package in a composition that should give each agent session its own tools, prompt sections, and skills from a preset file. Every session names a preset — explicitly or through the configured default — and is composed from it; without the package, sessions fall back to whatever the host composition mounts.

### What a preset gives a session

A session composed from a preset runs the plugins that preset's `agent.cordis.yml` names: its tools, prompt sections, and skills. Sessions joined to the same preset share one installed composition, and each session's state stays separate. A child agent (subagent) joins its parent's composition, so it sees the same tools and prompt sections as the agent that spawned it.

The presets you can choose from come from two places: the presets shipped inside this package under `presets/`, and your own presets under `<dshHome>/.agent-presets`. The picker shows each preset's display name and description; a preset whose composition cannot load is listed with the reason rather than hidden, so you can see what to fix or delete.

### Minimal configuration

The plugin needs a `default` preset id and scans `roots` for presets:

```yaml
- name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
    roots:
      - path: ~/company-presets
        trust: system
```

| Field | Default | Meaning |
|---|---|---|
| `default` | required | Preset id composed when a session names none |
| `roots` | `[]` | Scanned directories in precedence order; each supplies `path` (a leading `~` expands) and `trust` (defaults to `user`) |
| `includeShippedRoot` | `true` | Prepend the package's bundled presets as a `system` root before every configured root |
| `includeUserRoot` | `true` | Append `<dshHome>/.agent-presets` as a `user` root, after every configured root |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-presets) is the exhaustive source for every accepted field and its JSDoc.

The shipped root is prepended before every configured root, so the built-in set remains available and wins duplicate ids even when a patch replaces the roster configuration. `includeShippedRoot: false` drops that built-in set for deployments that supply all presets themselves. `includeUserRoot: false` drops the derived writable root; tests that pin an exact roster disable both derived roots.

### Choosing the default preset

The `default` config sets the deployment default. When a settings provider is composed, this plugin registers the `agent-presets` namespace with `config.default` as its base, so a user document layers a per-user default over the deployment's:

```yaml
agent-presets:
  default: minimal
```

The value is read when a session is created, so a changed default affects only sessions created afterwards; running sessions stay on the preset they were composed from. Clearing the user field re-inherits the composition default.

### Authoring presets

Authoring is copy-only: creating a preset copies an existing preset's whole directory — composition, display metadata, skill directories, assets — into the first `user` root. The copy keeps the source's description but gets its own id and an optional display name, so no caller supplies composition text and a copy grants nothing the roster did not already carry. After creation, everything happens in the preset's own files.

A copy is refused when the id is not `[a-z0-9][a-z0-9-]*` (the id becomes a directory name), when the id is already taken (a copy never overwrites), or when the source is unknown. Deleting removes only locally authored presets; presets that ship with the deployment are not removable. A session already running on a deleted preset keeps running on it.

### Switching a session's preset

A session can switch to a different preset only while it has produced nothing — no messages or tool calls. After that, the composition is fixed for the session's life, because swapping tools mid-conversation would leave logged tool calls the new composition cannot make. A committed switch emits `tools/change` because the resolved tool set changed without a registry edit. The switch is also recorded in the session log, so a resumed or forked session rebuilds under the composition it ran.

### Failures and recovery

A preset whose composition is missing, unparsable, not a list of named plugin rows, or naming a module that cannot be resolved is listed as broken with a reason naming the rows at fault; composing such a preset is refused up front, so a session never starts half-composed. What survives to session creation is a row whose module loads and then refuses — a plugin that throws, or one waiting for a service the composition never supplies — which fails the creation and rolls it back, naming every failed row including those inside a group. Fix the preset's file or delete it, then retry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the roster and the standing mount; observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One standing composition per preset.** A preset is mounted once per process under a standing scope; agents join by parenting their scope key to the mount, so the mount's registrations and listeners cover every joined agent and no sibling preset's.
- **Generations keyed on the composition file.** The mount records the composition file's stamp (mtime and size); a session that finds the stamp stale starts the next generation, while sessions already joined keep the generation they run on — a running session outlives its file changing or disappearing.
- **The preset file is an input, never a persistence target.** The mounted subtree overrides `write()` as a no-op, so a loader-initiated write-back never rewrites a shared preset file.
- **Discovery owns health.** A directory whose composition is missing or unloadable is a broken roster row with a reason, not a skip — a skipped directory would still occupy its id while no surface shows anything to delete.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: `Config` schema, settings namespace, roster API, standing-mount coordination |
| [`src/discovery.ts`](src/discovery.ts) | Filesystem discovery: root scanning, health checks, id validation, ordering |
| [`src/composition-inventory.ts`](src/composition-inventory.ts) | Flattened composition rows for plugin-listing surfaces: file reads with evaluated disabled gates, mount reads with fiber states |
| [`src/preset.ts`](src/preset.ts) | Vocabulary: preset id rule, `AgentPreset` and `PresetRoot`, error types |
| [`src/mount.ts`](src/mount.ts) | Subtree mounting, host base-URL handling, mount audit, `write()` suppression |
| [`src/authoring.ts`](src/authoring.ts) | Copy/delete/read of locally authored presets, permission tightening |
| [`src/metadata.ts`](src/metadata.ts) | `preset.yml` display metadata |
| [`src/session.ts`](src/session.ts) | `agent-preset/selected` event and the `agentPreset` Session projection |
| [`src/types.ts`](src/types.ts) | Client-safe wire payloads and cordis event declaration |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: post-mount service-leak recheck, unjoined-agent failure |

### The standing mount

`ensureStanding` keeps one pending promise per preset id, single-flight, so two agents racing the first use of a preset share one composition. A settled failure is removed so a later session retries a preset whose file has been fixed. The mount runs in the roster service's own untraced context — a subtree minted from a traced context would resolve services through the caller's shadow fiber — so it survives every agent and unwinds only with whole-tree teardown. `serviceForAgent` reads an agent's instance of a service its preset mounted behind an `isolate` realm, which is otherwise invisible outside the group.

### The composition inventory

`compositionInventory()` answers plugin-listing surfaces with each preset's flattened rows beside its roster identity (id, trust, display name, default marking): a preset with a live standing mount — matched within this runtime's own root, so a second Cordis runtime in the same process never answers for it — answers from its newest generation's Loader entries, even when its file has since broken, because the mount is what sessions run and the broken verdict applies only to a preset nothing composed; one never composed since boot answers from its composition file with `!!js` disabled gates evaluated against the Loader context, so both answers reflect the same host. Reading never mounts a preset — a settings page listing every composition activates none of them. A gate the evaluator refuses stays `'conditional'`, and a file that stopped reading as a composition between discovery's health verdict and the row read is reported broken with the raced reason rather than dropped. The `./display` subpath exports the `presetDisplayText` fold mapping shipped preset ids to their dictionary copy keys; it has no imports, browser bundles inline it, and it is the one home for which shipped id carries which copy.

### The mount audit

A directly-plugged subtree is absent from `ctx.loader.entries()`, so no boot audit covers it; `mountPreset` proves the result usable itself and rejects three shapes: an unscoped target (the preset's tools would register globally), a row still waiting for a service the composition never supplies, and a row that published a service into the root realm (process-global, so the second preset publishing the same name collides). The invariant companion re-checks the last rule on every service notification, because a row publishing from a timer or an asynchronous continuation would escape the one-shot audit.

### Authoring mechanics

A copy dereferences symlinks so it is self-contained, re-tightens the tree to owner-only (`0o600` files keeping their owner-execute bit, `0o700` directories), and creates the root on first copy. The copied `preset.yml` is rewritten: the source's description is kept for the author to edit, its name and roster `order` dropped, so the roster keeps distinguishing the copy from its source. Removal refuses presets that ship with the deployment and clears a user default that named the preset just deleted.

### The session record

The creation header names the preset a session started with; the `agentPreset` Session projection names the preset it runs. A switch appends an `agent-preset/selected` event after the swap commits because the preset decides the tool schemas and prompt sections the model sees. The service re-emits that committed fact as the unscoped cordis event `agent-preset/selected(sessionId, agentPreset)`. Reconstruction consumes the projection, which starts from the creation header and applies the newest selection; it never folds the log independently.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the composition model to the scope and prompt mechanics the mount relies on, and to the decision evidence.

- [persona package](../persona/README.md) — the composable row a preset mounts to give a session its own persona.
- [Scope subsystem](../../../docs/subsystems/scope.md) — scope keys and the parent chain agents join through.
- [System prompt subsystem](../../../docs/subsystems/system-prompt.md) — how preset prompt sections register and assemble.
- [Session package map](../../session/README.md) — the durable session record a preset switch appends to.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-presets) — every accepted config field and its source declaration.
- [Per-session agent presets note](../../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md) — design rationale and alternatives.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the plugins a preset's standing composition installs, which own every tool schema, prompt section, and skill the preset makes visible to the agents joined to it.

#### KV Cache effect

Prefix-stable for the life of an agent: a composition is installed once, before the agent is published and therefore before its first request, and is never re-read while the agent runs. Choosing a different preset for a new session establishes a different prefix for that session alone and cannot invalidate reuse for any session already running.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the roster is a poor fit or needs special operational care. They are current package constraints, not a general composition comparison or a task backlog.

- **A preset outside the writable root is discoverable but not deletable** — `remove()` refuses anything that does not live under the first `user` root, so a deployment that configures its own writable root while leaving `includeUserRoot` on lists the harness-home presets, mounts them, and answers "it does not live under the writable preset root" for every delete. A deployment that wants only its own presets sets `includeUserRoot: false`.
- **A session cannot change preset once it has produced anything** — switching re-links a blank session's parent scope to another standing mount, and only a blank one: swapping tools mid-conversation would strand tools the model has called.
- **A generation is keyed on the composition file alone** — the stamp check notices `agent.cordis.yml` changing, not an edit to a skill file or asset beside it; those reach new sessions only once the composition file itself moves or the process restarts.
- **A superseded generation is never reclaimed** — sessions already joined keep the generation they run on, and the roster holds no join count that could tell when the last one left, so the whole subtree stays mounted until the process ends. The cost is per generation rather than per session, but it is not free: `dsh-skill-filesystem` watches its roots by default, so each edit-then-create cycle adds a live watcher set.
- **A copy is never mounted to validate** — it is byte-identical to its source, so a source broken on disk yields a copy exactly as broken as the source; discovery's health check marks both rows on the next roster read rather than deferring the failure to a session start.
- **Health asks what is installed, not what would import** — discovery proves the composition parses in the loader dialect, holds named rows, and that each row it can prove will start names a package present above the harness base or a file that exists; it never imports one, so a package whose own entry file is missing, a plugin that throws on apply, and one waiting forever for a service all still fail at the first session. `disabled` is the one entry field the Loader interpolates, so a row carrying an expression there is left unchecked rather than judged from the file.
- **A copy is a snapshot that drifts** — upgrading the deployment does not update copies of shipped presets, and there is no patch semantics at this layer to express "standard plus one change"; the shipped set itself accepts the same cost — `cordis` and `code` each duplicate `standard`'s full assembly and then edit it — so the whole assembly stays readable in one file.
- **Root scans are not watched** — every read hits the filesystem instead, which keeps the roster fresh but puts one `readdir` per root on each `list()`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: reclaiming superseded generations

Reclaiming a superseded standing mount needs a joined-agent count on `StandingMount`, incremented in `mount`/`composeFrom`/`recompose` and decremented when the agent's scope key dies — the `TODO` at `ensureStanding`. The subtree is not inert: `dsh-skill-filesystem` watches its roots, so an unreclaimed generation keeps a live watcher set alive until the process ends.

</details>
