---
description: "An immutable snapshot of this run's environment that remembers which layer supplied each value, for packages that must resolve user-facing values without trusting a flattened process.env."
kind: "package-library"
---

# @deepseek-ai/dsh-launch-environment

English | [中文](README.zh.md)

## Summary

`dsh-launch-environment` freezes this run's environment at launch into an immutable snapshot that records which layer supplied each value. Resolving a name searches the layers from most to least trusted — the inherited process environment, the invoking directory's `.env`, then the Harness home's `.env` — so the winning value always carries its source. A caller can also resolve from a named subset of layers, which is a refusal rather than a demotion: omitted layers are unreachable no matter how trust ordering changes later. Values still reach `process.env` for config expressions and third-party libraries, but nothing the harness resolves treats that flattened view as authoritative. It is a zero-dependency library that product packages import directly; a `cordis.yml` cannot load it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Resolve user-facing values through the snapshot instead of `process.env` whenever the layers are not equally trusted — for example a credential override a caller must never take from a project directory.

### Resolving a value

```ts
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

declare const ctx: import('@deepseek-ai/cordis').Context
const endpoint = launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value
```

`get(name)` searches every layer, most trusted first. `getFrom(name, sources)` searches only the named layers without changing that trust order — a caller that must never accept a layer leaves it out of the list, so no future reordering can let it back in.

### How layers rank

| Layer | What it is |
|---|---|
| Inherited process environment | What the launching shell, CI job, or container passed in — this run's explicit intent |
| `<invocation cwd>/.env` | The project the harness was launched in, which the product trusts to configure its own agent |
| `$DSH_HOME/.env` | The user's own machine-level defaults |

Names match the way the platform matches them: exactly on POSIX, case-insensitively on Windows. A case-sensitive lookup on Windows would rank the wrong layer — a shell's `deepseek_api_key` and a project `.env`'s `DEEPSEEK_API_KEY` are one variable to the OS.

### When no launcher booted the tree

`launchEnvironmentOf(ctx)` returns the launcher's snapshot when the product CLI booted the tree, and otherwise the inherited environment as the only layer. The fallback does not weaken the rules: an SDK host or a bare `cordis.yml` discovered no files, so everything it has is the environment it was launched with.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The snapshot is built on one separation: the launcher owns which files exist, and the snapshot owns how values rank.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createLaunchEnvironmentSnapshot`, `launchEnvironmentOf`, and the `ctx.launchEnvironment` slot |
| — | No runtime invariant companion is published; the snapshot is frozen before any fiber starts and this package owns no event stream or mutable runtime data; its lookup and rejection rules are enforced by unit tests. |

### How the snapshot stays frozen

`createLaunchEnvironmentSnapshot` copies every layer's values at construction, so a later mutation of the source object cannot change the snapshot. Lookups walk a canonical trust order regardless of construction order; on Windows, names are folded to uppercase before storage so case variants cannot split precedence.

### What omission means

`getFrom` filters by the canonical order, never by the caller's list order. Omitting a layer is a refusal: the value is unreachable through that call, which is the mechanism a caller uses when a layer must never influence a specific decision.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the launcher that builds the snapshot or the consumers that resolve through it.

- [Boot package](../../boot/app-boot/README.md) — the launcher that fills `ctx.launchEnvironment` before any config entry mounts.
- [Credentials store](../../credentials/credentials-local/README.md) — resolves stored credentials against the snapshot's layers.
- [DeepSeek provider](../../llm/llm-deepseek/README.md) — reads provider configuration through the launch environment.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the snapshot is not a security boundary. They are current package constraints, not a task backlog.

- **The snapshot is not a subprocess boundary** — every layer is also materialized into `process.env`, so ordinary project variables reach child processes under [`dsh-subprocess`](../../subprocess/subprocess/README.md)'s scrub; the product launcher's [`.env` contract](../../boot/app-boot/README.md) rejects bootstrap variables before materialization.
- **No per-workspace layer** — the project layer is the invoking directory, fixed at launch; a workspace selected later in the Web UI contributes nothing, deliberately, because following it would let a model's own workspace change the harness environment mid-session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
