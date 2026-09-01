---
description: "The skill provider registry for users and maintainers choosing, configuring, or debugging how skills from any source are merged, resolved, and loaded."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill

English | [中文](README.zh.md)

## Summary

Agents and users can access reusable, task-specific instructions through one lookup no matter where the instructions come from: any provider can contribute skills from local directories, embedded plugin data, or a remote service, and every consumer receives one merged catalog with the winning skill for each name and can load any skill's full instructions on demand. Mount this plugin when skills should be loadable from more than one source or from a non-filesystem source, and skip it when a composition loads no skills. It ships no skill content of its own — pair it with at least one provider (the shipped `dsh-skill-filesystem`), and with `dsh-tool-skill` when agents should load skills.

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

Mount the plugin to give a composition one skill registry. Skill sources (providers) and consumers (the model-facing catalog and loader, or your own code) all talk to `ctx.skills`; the registry merges everything any provider reports, so one lookup sees skills from every source.

### When to choose it

Use `dsh-skill` when agents should load skills from more than one source through one interface, or when the source of skills is not the local filesystem. Avoid it when a composition needs no skill loading at all — the plugin adds a service and a per-lookup discovery cost. The shipped local provider (`dsh-skill-filesystem`) and the model-facing consumer (`dsh-tool-skill`) are separate packages; mount them alongside when the deployment wants local skills and model access.

### Mount and configure

Load the plugin like any Cordis plugin. The only configuration limits how many completed provider catalogs are kept in memory; everything else is provider behavior.

```yaml
- name: '@deepseek-ai/dsh-skill'
```

| Field | Default | Meaning |
|---|---|---|
| `collectCacheMaxEntries` | `128` | Completed cwd/provider catalogs kept in memory |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skill) is the exhaustive source for every accepted field.

### What the registry gives you

- **One merged catalog.** A consumer asks for the current catalog of a workspace and receives every winning skill summary from every provider, sorted by name — no provider-specific ordering or deduplication to do.
- **On-demand loading.** Asking for one skill by name returns the full instruction body from whichever provider owns the winning candidate; the registry re-validates the loaded definition and rejects a stale selection whose name changed between discovery and load.
- **Embedded skills.** Plugins register an in-memory skill with `ctx.skills.register(...)`; the registry fills in a default invocation policy and the `runtime` provider label. Same-name runtime registrations in one layer are first-wins with a warning.
- **Provider registration.** A provider contributes its catalog with `ctx.skills.registerProvider(...)`; registration is synchronous, and the returned disposer removes the provider. `runtime` is a reserved provider name.

An invocation policy on every skill decides which surfaces may advertise and load it: `modelInvocable` for model-facing tools and catalogs, `userInvocable` for human-facing commands. The registry keeps all four combinations, so one discovery result can serve both surfaces without conflating their catalogs.

| Policy | Model | User |
|---|---|---|
| `{ modelInvocable: true, userInvocable: true }` | included | included |
| `{ modelInvocable: true, userInvocable: false }` | included | excluded |
| `{ modelInvocable: false, userInvocable: true }` | excluded | included |
| `{ modelInvocable: false, userInvocable: false }` | excluded | excluded |

### Observable success and failures

A skill that any provider reports appears in the merged catalog, and loading it by its exact kebab-case name returns the body; an invalid name returns no skill rather than throwing. A provider that fails discovery is logged and skipped, and the observation is reported incomplete so consumers keep their last-good catalog; an explicit incomplete observation still contributes its candidates. A malformed candidate fails fast — the registry validates names, descriptions, invocation booleans, and provider ownership before caching or returning anything.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the registry merges, caches, and invalidates provider catalogs; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is built on one separation: the registry owns merging, winning resolution, and validation, while providers own where skills come from. A provider is a borrowed same-process object with a `list()` that returns candidates and a `get()` that loads a body; the registry never inspects skill content beyond validating its semantic fields.

The registry is host+per-scope layered, the shape the tools registry established: a registration files into the layer of its calling context's scope — host rows and repository plugins land in the global layer, a plugin mounted by an agent preset's standing composition lands in that preset's layer. A read merges the global layer with the viewing scope's chain; the nearest layer wins a duplicate name outright, and within one layer duplicates resolve by rank, provider registration order, then provider-local order.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, `SkillRegistry` service, candidate and definition validation, shared model-facing rendering |
| — | No runtime invariant companion is published; provider/runtime maps and revisioned caches mutate atomically inside the registry, which exposes no independent change event or snapshot for cross-checking them. |

### Catalog collection

A read (`list`/`snapshot`) collects each layer's candidates: runtime skills first, then each provider's `list()` result, awaiting providers sequentially and containing failures. Candidates are validated, deduplicated within the layer, and merged across layers; summaries sort by name. Completed collections are cached per cwd, scope chain, and revision up to `collectCacheMaxEntries`; an in-flight collection retries once when a provider or runtime mutation bumps the revision mid-read, and a second change returns the latest candidates as an incomplete, uncached observation.

### Loading and staleness

`get()` selects the winning candidate, races the provider's load against the lookup's abort signal, and rechecks cancellation after selection or a cache hit. The returned definition must match the selected candidate's name; a mismatch invalidates the cached catalogs so the next snapshot rediscovers the provider's skills. Definitions are never cached — every load asks the provider for the current body.

### Invalidation

The registry has no TTL: only a provider calling its registration-scoped `invalidate()`, or a runtime registration or disposal, clears completed catalogs. Each invalidation bumps a revision, clears the cache, and emits the unfiltered `skills/change` event; consumers refetch with their own lookup options. `invalidate()` takes effect only while the exact registration that received it is still active, so a late callback cannot disturb a replacement provider with the same name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared skill vocabulary to the shipped provider, the model-facing consumer, and the design rationale.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry, provider contract, and local discovery priority.
- [skill-filesystem package](../skill-filesystem/README.md) — the shipped local provider that discovers skills from disk.
- [tool-skill package](../tool-skill/README.md) — the consumer that renders the session catalog and the `skill` tool.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skill) — every config field and its source declaration.
- [Skill invocation policy Agent Note](../../../.agents/notes/implemented/feature/2026-07-28-skill-invocation-policy.md) — the rationale for the model and user invocation controls.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders provider summaries into durable initial or replacement catalog messages and loaded instruction bodies into retained tool results.

#### KV Cache effect

No direct prompt effect. The named consumer owns the durable initial catalog and append-only replacements after invalidation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the registry is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Invalidation is provider-driven** — the registry has no TTL and cannot infer that an arbitrary remote source changed; each mutable provider must retain and call its registration-scoped `invalidate()` capability from its own observation mechanism.
- **Providers are queried sequentially** — one slow provider delays every provider registered after it; cancellation stops the caller's wait but cannot terminate work an uncooperative provider keeps running.
- **Incomplete observations are not retained** — rejected providers are omitted and explicitly supplied candidates remain available only to the current lookup; the registry owns neither a last-good catalog nor per-provider diagnostics.
- **Duplicate resolution is first-wins** — later lower-priority candidates within a layer are logged and hidden, and a nearer layer shadows a farther one silently; there is no API to inspect all shadowed definitions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. An open question is whether the registry should retain a last-good catalog or per-provider diagnostics for failed providers, or whether consumers should own that state; the incomplete-observations limitation records the current answer.

</details>
