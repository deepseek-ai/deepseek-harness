---
description: "The sandbox-consuming PowerShell executor for deployments and maintainers choosing, configuring, or debugging confined PowerShell command execution with denial facts."
kind: "package-reference"
---

# @deepseek-ai/dsh-pwsh-sandbox

English | [中文](README.zh.md)

## Summary

`dsh-pwsh-sandbox` is the sandbox-consuming PowerShell executor: every command runs as a fresh `pwsh -Command` process confined through the `ctx.sandbox` capability, with the selected mode, enforcement, and denial facts stamped on each settled result. On Windows the sandbox seam resolves to the ACL restricted-token runner chain; on Linux and macOS it uses bwrap, Landlock, or Seatbelt. When no runner can enforce a confined mode, the call fails closed with a structured `SANDBOX_UNAVAILABLE` error rather than running unconfined. It is the pwsh twin of `dsh-bash-sandbox`, mirroring it call-for-call.

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

Mount this executor instead of `dsh-pwsh-local` when PowerShell commands must not run with the harness process's full file authority. It registers as `ctx.shell`, inherits `dsh-pwsh-local`'s process mechanics, and requires a `ctx.sandbox` provider plus `ctx.sandboxPolicy`.

### When to choose it

Choose it when a deployment needs file-level confinement for PowerShell commands, typically on Windows. The confinement substance is platform-neutral: the sandbox seam picks the platform's runner — the ACL restricted-token chain on Windows, bwrap/Landlock/Seatbelt elsewhere — while this executor owns the pwsh side. The sandbox policy (mode plus workspace root) is not this package's config: it rides each call from `ctx.sandboxPolicy`, with tool calls passing the calling session's resolved policy and direct calls falling back to deployment policy.

### Modes and file effects

| Mode | File effects |
|---|---|
| `read-only` (default) | Writes are denied; the boundary stays partial because the restricted token retains Everyone |
| `workspace-write` | Writes under the policy's workspace root plus a private temp directory; `TMP`/`TEMP` are rewritten to it before spawning |
| `danger-full-access` | No confinement; the provider is never consulted, and results carry `sandbox: { mode, denied: false }` |

### Minimal configuration

On Windows, mount the ACL restricted-token provider; on Linux and macOS, mount the local runner provider instead. The executor's own config is the local pwsh executor's knobs verbatim; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-pwsh-sandbox) is the exhaustive source.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-windows-acl'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd() # fallback for calls without a session cwd
- id: bash
  name: '@deepseek-ai/dsh-pwsh-sandbox'
```

### Denials and escalation

A denied command is reported as a fact: the result carries `sandbox: { mode, denied: true }`, and the tool layer converts it into the standard permission-denied surface — the same one the bash tool uses. When escalation is available, the model may retry the exact command once with the narrowest wider mode and a one-sentence justification; the approval prompt asks the user, and nothing executes before approval. This executor never negotiates permissions itself.

### Failures and recovery

If no runner can enforce a confined mode, the foreground call fails with `SANDBOX_UNAVAILABLE` and a background process records a runner-failure fact — never a silent unconfined run. A provider rejection is attributed to the confinement runner only when its `ENOENT`/`EACCES` path or syscall independently names `argv[0]`; otherwise it keeps the local executor's stage-neutral provider-failure semantics.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the executor and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The executor is the pwsh twin of `dsh-bash-sandbox`: it inherits `dsh-pwsh-local`'s process mechanics, consumes its argv-level seam (`argv()`/`runArgv()`/`startArgv()`/`onProcessDone()`), and wraps the exact pwsh invocation through `ctx.sandbox.confine()` before spawning. The confinement substance is platform-neutral — the sandbox seam resolves to the platform's runner — while this package owns the pwsh side only: the selected mode, enforcement completeness, and denial classification on results.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SandboxPwshExecutor`, per-process fact retention, run/start wrapping |
| [`src/helpers.ts`](src/helpers.ts) | Denial, runner-failure, and runner-spawn-failure classification |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seams. |
| `tests/` | Exercised behavior across the ACL and platform runners |

### Main flow

For a confined mode, `resolve()` stamps the per-call policy; `run` and `start` wrap the pwsh argv through the provider and hand the confined argv to the inherited subprocess path. At settlement the executor classifies the outcome: a runner failure outranks a denial because the command never ran, a failed run whose stderr carries the runner's denial dialect is reported `denied: true`, and every confined run carries its mode and enforcement facts. `danger-full-access` bypasses the provider entirely and stamps `denied: false`.

### Invariants

- **Fail closed** — a confined mode with no usable runner throws `SANDBOX_UNAVAILABLE`; unconfined passthrough never happens for a confined policy.
- **Deny-only at the seam** — this executor never grants permission; the approval flow lives in the tool layer.
- **Per-process facts** — confinement facts are retained per handle until settlement, because a provider may vary enforcement between overlapping calls.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the executor contract is not enough. They move from the seam to the confinement backends and the pwsh tool.

- [shell seam](../shell/README.md) — the executor contract this provider implements, including the request/spec split.
- [bash-sandbox](../bash-sandbox/README.md) — the bash twin of this executor, with the shared denial and escalation surface.
- [pwsh-local](../pwsh-local/README.md) — the process mechanics this executor inherits.
- [sandbox-windows-acl](../../sandbox/sandbox-windows-acl/README.md) — the Windows restricted-token runner chain.
- [Bash executor subsystem](../../../docs/subsystems/shell.md) — request/spec vocabulary, results, and the service contract in full.
- [pwsh executor and tool note](../../../.agents/notes/archived/feature/2026-08-01-pwsh-tool-and-executor.md) — the decision behind the pwsh executor and tool pair.

-----

<a id="model-experience"></a>
## Model Experience

### Confinement works, denial surfaces as command failure

#### What the model sees

The confined command's own stderr — for example `Access to the path '...' is denied.` under the Windows ACL runner; the tool layer converts classified denials into the standard permission-denied surface exactly as it does for the bash tool.

#### Token effect

No model-visible text beyond the command's stderr and the tool layer's standard denial surface.

#### KV Cache effect

None directly; the denial surface belongs to the tool layer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this executor is only a partial boundary on Windows. They are current package constraints, not a roadmap.

- **Reads are unrestricted on Windows** — the ACL runner restricts writes only; the read boundary is documented in `@deepseek-ai/dsh-sandbox-windows-acl`.
- **Windows workspace-write temp authority is private** — per live session/workspace pair; agentless calls receive a fresh private directory per invocation; the ambient temp root is never granted, and the runner rewrites `TMP`/`TEMP` to the private directory before spawning.
- **Windows read-only grants no explicit writable root but remains partial** — the restricted token must retain Everyone; objects whose DACL grants Everyone write access — including compatible opens of the NUL device — remain ambient authority, while PowerShell's `> $null` redirection still works without opening NUL.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
