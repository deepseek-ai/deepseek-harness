---
description: "Local per-platform sandbox backends for users and maintainers choosing, configuring, or debugging process confinement on Linux, macOS, or Windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-local

English | [中文](README.zh.md)

## Summary

`dsh-sandbox-local` provides the platform confinement backends behind `ctx.sandbox`: Linux runs commands under `bwrap` when that works, otherwise under the Landlock launcher; macOS uses Seatbelt (`sandbox-exec`); Windows uses the ACL restricted-token runner. It selects one runner per host, so every command — and everything it spawns — runs confined. When no runner is usable the provider fails closed with `SANDBOX_UNAVAILABLE` — a command never silently runs unconfined. Each wrap reports how completely the backend enforces the mode (`full` or `partial`) plus the backend's denial signatures, so consumers can tell a broken sandbox apart from a denied command. Mount it behind `ctx.sandbox` with a confined executor to give every bash or pwsh call a confined default.

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

Mount this provider behind `ctx.sandbox` and a confined executor, and every command the executor spawns runs confined under the policy you resolve. The shipped [base bundle](../../bundle/base/cordis.patch.yml) owns the default policy and executor wiring.

### When to choose it

Choose it when commands must run confined on the host: it is the default backend for Linux, macOS, and Windows compositions that mount `ctx.sandbox`. Choose a different mechanism when the process must run in an isolated environment — a container or remote executor replaces whole capabilities, and this provider shares the host kernel and filesystem.

### Minimal configuration

Load the sandbox service and mount the provider; the defaults below are the selection policy.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

| Field | Default | Meaning |
|---|---|---|
| `runnerCommand` | `[]` | Custom runner argv; bwrap-compatible profile arguments are appended, full enforcement is asserted, and built-in selection and probes are skipped |
| `runnerFailureSignatures` | `[]` | Case-insensitive stderr substrings identifying the custom runner's own failure dialect; required with `runnerCommand` |
| `probeTimeoutMs` | `5,000` | Timeout for each functional probe of a competing runner candidate |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-local) is the exhaustive source for every accepted field and its JSDoc.

### Confined execution and enforcement

With the provider mounted, a command runs under the mode you resolve per call. Enforcement is a reported fact, not a promise: `full` means the backend governs every promised file effect, while `partial` means it governs only a subset — the Windows ACL rung (Everyone and hard-link boundaries) and older Landlock ABIs are the current partial cases, so a consumer that requires an absolute boundary can reject or surface them. Denied file effects surface through the backend's denial dialect, and a runner that fails before executing the command reports a structured runner-failure signature.

### Failures and recovery

An unsupported platform or an unusable runner fails closed: `confine()` throws `SANDBOX_UNAVAILABLE` and names the runner options for the platform, and the consumer surfaces that error rather than running the command unconfined. A runner that starts but refuses its profile is identified by its fatal stderr signature and exit code, so a broken sandbox is not mistaken for a denied command. The `runnerCommand` override is an operator assertion: it skips functional probes and assumes the configured runner implements the bwrap-compatible profile honestly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains runner selection, the per-platform profiles, and the failure dialects; the observable behavior is fully covered in [Use this package](#use-this-package).

### Runner selection

Selection is by platform first, probes second: each platform has a runner chain (`linux`: `bwrap` then Landlock; `darwin`: Seatbelt; `win32`: the ACL restricted-token runner). A sole candidate is selected without a probe; competing candidates are functionally probed once in chain order, and the first usable verdict is cached for the provider's lifetime. A platform with no chain, or a chain where every probe fails, is unavailable and fails closed at `confine()`.

### Platform profiles

The bwrap profile combines a read-only host root, a fresh `/dev`, and `/proc` from a private PID namespace — commands manage their descendants but cannot see host processes, so procfs magic links cannot bypass the mounts; `workspace-write` adds an ephemeral `/tmp` and a writable workspace bind. The [private-PID note](../../../.agents/notes/implemented/bug-fix/2026-08-06-bwrap-private-pid-namespace.md) records the boundary.

The Landlock launcher ships as an npm-distributed native addon (`@deepseek-ai/node-addon-landlock-run`) that supplies the platform launcher, functional probe, and grant vocabulary; this provider maps mode to grants only, keeping path resolution and probe parsing with the versioned binary.

The Seatbelt profile is allow-default with `(deny file-write*)` plus write allow-lists derived from the shared `writableRoots` helper, so exactly the mode's promised file effects are governed; every root is canonicalized because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`).

The Windows rung keeps one deterministic write SID and standing ACE per workspace, while every live session/workspace pair gets a random private temp directory with a distinct SID and revocable ACE — sessions sharing a workspace share its intended write authority without inheriting one another's temp authority. A fresh provider always chooses a new temp path and SID, so crash residue cannot block or authorize a resumed session. The rung reports `partial` enforcement because the restricted token must retain Everyone and NTFS hard links alias one file object across paths.

### Denial and runner-failure dialects

Each runner's kernel speaks its own denial dialect, carried on every wrap as `denialSignatures`, and `runnerFailureRules` give each runner's fatal signature, so consumers classify a runner refusal before checking denial signatures. The exact strings and exit codes live in [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: runner chain selection, functional probes, per-call wrap, ACL grant lifecycle |
| [`src/profiles.ts`](src/profiles.ts) | Per-platform profile builders: bwrap mounts, Landlock grants, Seatbelt SBPL |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the shared vocabulary, then the seam contract, the consumers, and the win32 rung.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and classification dialects.
- [Sandbox seam package](../sandbox/README.md) — the service contract this provider implements.
- [Bash sandbox executor](../../shell/bash-sandbox/README.md) — the confined bash consumer.
- [Windows ACL restricted-token rung](../sandbox-windows-acl/README.md) — the win32 backend this provider mounts.
- [The subprocess sandbox decision](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) — capability boundary and runner selection semantics.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), which render this provider's enforcement and denial facts, while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and this provider owns runner selection, and profiles stay outside context.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a general platform comparison or a task backlog.

- **Windows ACL enforcement is partial** — the restricted token must retain Everyone for process initialization, so external objects granting Everyone write access remain writable; NTFS hard links also alias one file object across workspace and external paths. The provider reports `enforcement: 'partial'` rather than overstating that boundary as full.
- **Landlock may be partial** — older supported kernel ABIs confine only the access classes they expose, reported as `enforcement: 'partial'` rather than overstated as full.
- **Seatbelt depends on deprecated `sandbox-exec`** — macOS still ships it, but this provider cannot replace or probe that private policy engine if Apple removes it.
- **Runner selection is cached for the provider lifetime** — installing, removing, or repairing a runner requires reloading the plugin before selection changes.
- **`runnerCommand` is an operator assertion** — a configured custom runner skips functional probes and is assumed to implement the bwrap-compatible profile honestly; if it is itself a Bash script, its interpreter startup runs before that script applies confinement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: environment-coherent groups

The [sandbox decision](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) lists an environment-coherent capability group example (for example bash plus fs against one container) as a deferred phase; it is not decided.

</details>
