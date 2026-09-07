---
description: "Runtime invariant checks for live compositions: the registry service that runs package-owned checks, for users and maintainers choosing, configuring, or debugging them."
kind: "package-reference"
---

# @deepseek-ai/dsh-invariants

English | [中文](README.zh.md)

## Summary

`dsh-invariants` runs package-owned runtime checks — invariants — inside a DeepSeek Harness composition: any package can ship a `./invariant` companion that verifies its own durable relationships (authoritative event streams and mutable snapshots) while the composition runs. Checks run automatically, and a failed check reports an `InvariantError` attributed to the package that owns the violated relationship. Choose it for compositions that want self-checking diagnostics with a global switch and package-name filters; the standard agent composition already mounts it with the four core companions, and loading the service alone installs no checks.

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

Mount the registry when a composition should verify its own runtime contracts, then decide which packages' checks run. The service exposes `ctx.invariants`; companions register checks under their package's exact npm name, and every failure carries the owning package name.

### When to use it

Use the registry for compositions that want live diagnostics. [`dsh-sdk-minimal`](../../bundle/sdk-minimal/README.md) mounts it with the four core stateful companions — `dsh-session`, `dsh-agent`, `dsh-scope`, and `dsh-agent-loop`; `dsh-base` deliberately omits runtime diagnostics. Custom compositions mount the registry and add companions for any other loaded package whose contracts they want checked. Loading the registry alone installs no checks: it ships no product checks of its own, so a composition that never mounts a companion observes no diagnostic behavior.

### Enabling checks and selecting packages

The registry is enabled by default and checks every registered package unless filters say otherwise. Use `enabled` as a global switch, `package_allowlist` to admit only named packages, and `package_blocklist` to exclude packages after allowlist matching — a blocklist match overrides an allowlist match. Patterns are case-sensitive JavaScript regular-expression sources (unanchored unless they supply `^` and `$`), and an invalid, blank, or duplicate entry fails service startup instead of being skipped.

```yaml
- name: '@deepseek-ai/dsh-invariants'
  config:
    enabled: true
    package_allowlist:
      - '^@deepseek-ai/dsh-'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Global switch for all registered checks |
| `package_allowlist` | `[]` | Regex sources admitting package names; empty admits all |
| `package_blocklist` | `[]` | Regex sources excluding package names after allowlist matching |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-invariants) is the exhaustive source for every accepted field and its JSDoc.

### Which checks run

Each companion protects relationships its package owns, and a companion installs a check only for an observable event or mutable-data relationship — never for a service or method presence. The shipped executable companions cover:

| Companion | Checks |
|---|---|
| `dsh-session`, `dsh-agent`, `dsh-scope`, `dsh-agent-loop` | Session log enclosure and call/result trace, agent-status transitions, scope-filtered dispatch subjects, loop-built request reconstruction |
| `dsh-llm`, `dsh-llm-retry`, `dsh-tools`, `dsh-system-prompt` | LLM stream grammar, retry-failure shape, tool-pipeline stage pairing and frozen results, prompt-assembly section names |
| `dsh-compaction`, `dsh-hook-protocol`, `dsh-sandbox-policy` | Compaction stream pairing, hook invocation/result pairing, sandbox mode values |
| `dsh-fs`, `dsh-subagent`, `dsh-workflow`, `dsh-tool-workflow` | Filesystem event identity, subagent provider and start/end pairing, workflow lifecycle identity, workflow record shape |
| `dsh-goal`, `dsh-goal-round-driver` | Durable goal-stream folds and reconstructed continuation prompts |
| `dsh-permission-presets`, `dsh-user-approval`, `dsh-commands` | Preset references to live presets, approval asked/decided pairing, command run/done pairing |
| `dsh-jobs`, `dsh-tool-todo`, `dsh-time-context` | Job snapshot field relationships, whole-list todo shape, durable clock readings |
| `dsh-credentials`, `dsh-settings`, `dsh-storage-domain`, `dsh-workspace` | Commit events against the live service or memory state, entity-cache mirroring |
| `dsh-agent-presets`, `dsh-session-title`, `dsh-plan-mode`, `dsh-schedule` | Preset mount placement, title source citation, plan-mode payload, schedule stream |
| `dsh-client-hmr`, `dsh-client-modules`, `dsh-client-runtime` | Browser/node-half stat-watcher lifecycle, boot entry graph, slot mutation versioning |

Every other workspace package omits the companion and states the package-specific reason in its README.

### Adding a companion to a custom composition

A companion is a normal plugin you mount beside the registry. It declares any services it needs and registers under its package's exact npm name; the registry joins its setup before the registration completes.

```ts
import type { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'

declare const ctx: Context

ctx.plugin(InvariantRegistry, { enabled: true })
ctx.plugin(SessionInvariant)
```

### When a check fails

A violation throws an `InvariantError` from the context that reported it: it carries the stable code `INVARIANT`, the full npm `packageName` of the owning package, and a message prefixed `invariant violated by "<package>": …`. The failure is therefore attributable to a package without the registry importing any product code. A companion whose installer itself fails is disposed and its registration rolled back, so a broken check cannot leave partial listeners behind.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the registry; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Product-independent registry.** The service imports no session, agent, scope, or agent-loop package and contains none of their checks; companions carry checks next to their owners.
- **Real relationships, not synthetic assertions.** A companion checks an event-stream or mutable-data relationship its package owns; confirming a method, plugin name, injection, or fixed pure result is a type, load, or unit-test concern, never a runtime invariant.
- **Registration reserves ownership.** A package name is reserved even when filters keep its installer inactive, so two plugins can never silently claim the same name.
- **Companion wiring is mechanically enforced.** `pnpm run verify-package-invariants` rejects empty installers, installers that omit or ignore the reporter, wrong registration names, incomplete publication wiring, and stale wiring for omitted companions ([companion-omission note](../../../.agents/notes/implemented/simplification/2026-08-28-omit-unneeded-invariant-companions.md)).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `InvariantRegistry` service, selection, registration, `InvariantError` |
| — | No runtime invariant companion is published; registration ownership and child lifecycle are the service's mutation boundary itself; observing them from the same registry would only duplicate its implementation. |

### Selection and registration lifecycle

`register(packageName, installer)` reserves the full npm name and returns an effect-scoped disposer. An enabled installer runs in a dedicated child fiber; `installer.inject` declares the services that fiber may access, and synchronous or asynchronous completion is joined before registration succeeds. Failure disposes the child and releases the reservation atomically. The service owns every registration fiber, while the returned disposer also belongs to the companion fiber, so unloading either side removes listeners, trace state, and the reservation — a companion can reload and register the same name again without retained state. Session-backed companions rebuild their baseline from durable events; live-only companions observe operations that begin after reload.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the generated service reference to the decision evidence and the group map.

- [Runtime invariants subsystem](../../../docs/subsystems/invariants.md) — the generated reference for `Config`, the installer, the service, and the companion contract.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-invariants) — every accepted config field and its source declaration.
- [Invariant runtime contracts Agent Note](../../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.md) — what a runtime invariant may assert and the mechanical gate that enforces companion wiring.
- [Runtime-diagnostics group map](../../README.md) — adjacent diagnostics packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the observer validates requests but never rewrites their context.

#### KV Cache effect

Checks observe assembled requests and durable state without mutating request content, so provider cache reuse is exactly what the underlying composition produces.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the registry is a poor fit or needs operational care. They are current package constraints, not a task backlog.

- **Filters are fixed for the service lifetime** — `enabled`, `package_allowlist`, and `package_blocklist` are compiled once at startup; changing them requires a Cordis plugin reload.
- **Live-only companions miss pre-reload operations** — a companion that only observes live operations cannot reconstruct operations that began before its own reload; session-backed companions rebuild their baseline from durable events.
- **Request reconstruction covers loop-built requests only** — the `dsh-agent-loop` companion reconstructs requests explicitly built by the loop; direct one-shot LLM calls remain outside that contract even when callers freeze them or attach a session id.
- **No checks without a companion** — the registry ships no product checks; a composition that mounts the service alone observes nothing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
