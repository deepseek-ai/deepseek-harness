---
description: "The sandbox-consuming Bash executor for deployments and maintainers choosing, configuring, or debugging confined command execution with denial and escalation facts."
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-sandbox

English | [中文](README.zh.md)

## Summary

`dsh-bash-sandbox` is the sandbox-consuming Bash executor: every command runs as a fresh `bash -c` process confined through the `ctx.sandbox` capability instead of with the harness process's full file authority. Each settled result carries the mode the command ran under, whether the sandbox denied a file operation, and how completely the selected runner enforced the requested mode. When no runner can enforce a confined mode, the call fails closed with a structured `SANDBOX_UNAVAILABLE` error rather than running unconfined. It is the confining sibling of `dsh-bash-local` — sharing its process mechanics — and the tool layer's escalation fields appear only while it is mounted.

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

Mount this executor instead of `dsh-bash-local` when commands must not run with the harness process's full file authority. It registers as `ctx.shell` and requires a `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the model-facing `bash` tool works over it unchanged and advertises the `sandbox_permissions`/`justification` escalation fields.

### When to choose it

Choose it when a deployment needs file-level confinement for Bash commands: the configured policy decides the default mode and workspace root, and each session can run under a different mode per call through the tool's escalation flow. The modes govern file effects only — network stays unrestricted and process visibility is backend-specific. For unconfined execution, or when no sandbox backend is available on the platform, mount `dsh-bash-local` instead.

### Modes and file effects

| Mode | File effects |
|---|---|
| `read-only` (default) | No writes anywhere; of `/dev`, only the `/dev/null` node is writable, so `>/dev/null` keeps working |
| `workspace-write` | Writes only under the policy's workspace root plus `/tmp` (ephemeral under bwrap, the host `/tmp` under Landlock, `/private/tmp` plus the per-user temp dir under Seatbelt) |
| `danger-full-access` | No confinement; the provider is never consulted, and results carry `sandbox: { mode, denied: false }` |

### Minimal configuration

The executor takes no sandbox configuration of its own: the default mode and workspace root come from `ctx.sandboxPolicy`, and the runner choice belongs to the `ctx.sandbox` provider. Its own config is the local executor's knobs verbatim; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-bash-sandbox) is the exhaustive source.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd() # fallback for calls without a session cwd
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
```

### Denials are result facts

A denied command is reported, not retried silently: the result carries `sandbox: { mode, denied: true }` and the model-facing tool appends the denial marker. When escalation is available, the model may retry the exact command once with the narrowest wider mode and a one-sentence justification; the approval prompt asks the user, and nothing executes before approval. This executor never negotiates permissions itself — the tool layer drives the override.

### Failures and recovery

If no runner can enforce a confined mode, the foreground call fails with `SANDBOX_UNAVAILABLE` and a background process records a runner-failure fact — never a silent unconfined run. A provider rejection is attributed to the confinement runner only when its `ENOENT`/`EACCES` path or syscall independently names `argv[0]`; otherwise it keeps the local executor's stage-neutral provider-failure semantics.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the executor and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The executor is the sandboxing Service Provider for the `ctx.shell` seam: it inherits `dsh-bash-local`'s process mechanics and re-wraps each command's exact `['bash', '-c', command]` argv through `ctx.sandbox.confine()`, spawning the returned argv directly. Which platform runner confines the command — and whether one is usable at all — is the provider's concern; this package owns the bash side only: the selected mode, enforcement completeness, and denial classification on results.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SandboxBashExecutor`, per-process fact retention, run/start wrapping |
| [`src/helpers.ts`](src/helpers.ts) | Denial, runner-failure, and runner-spawn-failure classification |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |
| `tests/` | Exercised behavior across the bwrap, Landlock, and Seatbelt runners |

### Main flow

For a confined mode, `resolve()` stamps the per-call policy (the session's mode override, or the deployment fallback); `run` and `start` wrap the bash argv through the provider and hand the confined argv to the inherited subprocess path. At settlement the executor classifies the outcome: a runner failure outranks a denial because the command never ran, a failed run whose stderr carries the backend's denial dialect is reported `denied: true`, and every confined run carries its mode and enforcement facts. `danger-full-access` bypasses the provider entirely and stamps `denied: false`.

### Invariants

- **Fail closed** — a confined mode with no usable runner throws `SANDBOX_UNAVAILABLE`; unconfined passthrough never happens for a confined policy.
- **Deny-only at the seam** — this executor never grants permission; the approval flow lives in the tool layer.
- **Per-process facts** — confinement facts are retained per handle until settlement, because a provider may vary enforcement between overlapping calls.
- **File effects only** — the mode vocabulary claims only file effects.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the executor contract is not enough. They move from the seam to the sandbox capability this executor consumes.

- [shell seam](../shell/README.md) — the executor contract this provider implements, including the request/spec split.
- [bash-local](../bash-local/README.md) — the process mechanics this executor inherits.
- [sandbox seam](../../sandbox/sandbox/README.md) — the confinement capability, its modes, and its fail-closed contract.
- [sandbox-policy](../../sandbox/sandbox-policy/README.md) — the per-session mode and workspace root this executor honors.
- [sandbox-local](../../sandbox/sandbox-local/README.md) — the shipped runner backends: bwrap, Landlock, and Seatbelt.
- [tool-bash](../tool-bash/README.md) — the model-facing `bash` tool and its escalation surface.
- [Sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) — the sandbox design, escalation, and switching contract.

-----

<a id="model-experience"></a>
## Model Experience

### Bash tool schema, indirectly

#### What the model sees

The generated [`dsh-tool-bash` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash) are the baseline. By advertising a confining `sandboxMode`, this backend augments `bash` with `sandbox_permissions` (enum `workspace-write` | `danger-full-access`) and `justification`. The policy owner separately contributes the current capability-neutral `sandbox:policy` context.

#### Token effect

Small fixed schema increment on requests where `bash` is visible, plus the current-policy clause owned by `dsh-sandbox-policy`.

#### KV Cache effect

A standing-policy change appends a complete owner-rendered context snapshot after retained history, preserving the existing system/history prefix byte-for-byte. Changing executor capabilities alters the `bash` schema.

### Bash tool result, indirectly

#### What the model sees

After ordinary bounded output, a denied call appends exactly `[sandbox: file access denied under <mode> mode]`. When escalation is available it next appends `[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`. A settled background runner failure instead appends `[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; this is a sandbox problem, not a command failure]`.

#### Token effect

Zero additional tokens on an unremarkable allowed run beyond ordinary output. Denial or failure adds the quoted conditional marker, retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Bash tool error, indirectly

#### What the model sees

If no runner can enforce a confined mode, the foreground call propagates the `SANDBOX_UNAVAILABLE` error from the sandbox seam. A provider rejection with `ENOENT`/`EACCES` path or syscall evidence that names `argv[0]` supplies the original error as runner-failure detail; another rejection remains a stage-neutral provider error. A settled runner failure supplies the matched fatal stderr line and preserves the original stderr collection; the appended `Runner failure: <detail>` is the authoritative diagnosis over the generic `SANDBOX_UNAVAILABLE` prefix.

#### Token effect

Conditional error text is visible for that call and retained in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this executor is not a general security boundary. They are current package constraints, not a roadmap.

- **Confinement covers file effects only** — network restriction and a uniform process-visibility guarantee are absent, so the modes are not a general-purpose security sandbox.
- **Denials are inferred from failed-command stderr** — backend signatures make the inference portable, but a matching application error can be classified as a denial and a denial omitted from the retained tail can be missed.
- **An asynchronously observed background runner failure has no immediate error channel** — it is recorded on the settled process and surfaces when the caller reads the generic task with `job_output`; a synchronous subprocess throw that names the runner path instead fails `start()` immediately.
- **`danger-full-access` deliberately bypasses `ctx.sandbox`** — it is an explicit unconfined mode, not a wider sandbox profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
