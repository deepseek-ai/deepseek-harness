---
description: "The process-sandbox service contract for users and maintainers composing, using, or extending same-world subprocess confinement."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox

English | [中文](README.zh.md)

## Summary

`dsh-sandbox` confines same-world subprocesses to a file-effect policy: commands run `read-only`, write only under the session workspace (`workspace-write`), or run unrestricted (`danger-full-access`), and every confined execution runs under a per-call policy. The bash and pwsh executors consume it, so a command — and everything it spawns — runs confined without the consumer knowing which platform runner is behind it. When the requested mode cannot be enforced, the call fails closed with a `SANDBOX_UNAVAILABLE` error instead of running unconfined. A denied call can request a strictly wider mode that a human approves once. Confinement is same-world only — backends share the host kernel and filesystem, while containers, microVMs, and remote executors replace whole capabilities instead.

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

Compose this service with one backend and a confined consumer, and every command the consumer runs executes under the policy you resolve — you see only the confinement result and its enforcement completeness, never the platform runner.

### When to choose it

Choose this package when a composition confines subprocesses on the host: it is the contract the local backends and the confined executors both implement, so mounting `sandbox-local` behind `ctx.sandbox` and a confined executor behind `ctx.shell` gives every bash or pwsh call a confined default. Choose something else when the process must run in an isolated environment — a container, microVM, or remote executor replaces the whole `ctx.shell`/`ctx.fs` capability rather than adding a backend here.

### Confining a command

Mount the service with a backend and a confined executor; the [base bundle](../../bundle/base/cordis.patch.yml) owns the shipped composition.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'     # the per-platform backend provider (ctx.sandbox)
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'    # the deployment default mode and workspace-write root
  config:
    mode: workspace-write                    # the deployment default every session starts from
    workspaceRoot: !!js process.cwd()        # the boundary workspace-write may write under
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'      # the confined executor behind ctx.shell
```

With this composition, a bash call runs confined under `workspace-write`: writes inside the workspace succeed, writes outside it are denied, and the model can recover through the escalation flow below.

### Modes and enforcement

The mode names the file effects a command may perform; enforcement completeness reports how fully the backend governs them.

| Mode | Effect |
|---|---|
| `read-only` | Denies writes except required sinks such as `/dev/null` |
| `workspace-write` | Allows writes under the workspace root plus a backend-defined temp area |
| `danger-full-access` | Bypasses confinement; the consumer spawns its original argv |

Enforcement is reported per call: `full` means the backend governs every promised file effect, while `partial` means an active backend or older kernel ABI governs only a subset — the Windows ACL rung and older Landlock ABIs are the current partial cases, so a consumer that requires the absolute boundary can reject or surface them.

### Denied calls and escalation

When a confined call is denied, the operation reports a denial marker naming the mode — `[sandbox: file access denied under <mode> mode]` — and, when the composition advertises escalation, an escalation hint. The model may retry the exact call once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a `justification`; the user sees one approval prompt and can allow once, reject, or cancel. The escalation must be strictly wider than the call's effective mode, and it applies to that one call only.

### Fail-closed behavior

When no backend can enforce the requested mode, the call fails with `SANDBOX_UNAVAILABLE` rather than running unconfined; the error text names the missing platform runner. A backend that fails after starting also reports a structured runner-failure signature, so a broken sandbox is distinguishable from a command failure.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the contract and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Same-world by contract.** `ctx.sandbox` wraps argv under a host-path file policy; containers, microVMs, and remote execution replace the surrounding capability seam instead.
- **Policy rides the call.** `SandboxPolicy` is carried per call, never fixed on the provider: two consumers may confine under different policies at the same instant, and an escalated retry is a new call with a wider policy. Defaulting and resolution are explicit consumer steps.
- **Fail closed.** `confine()` returns enforcing argv or throws `SandboxUnavailableError`; silent unconfined passthrough is forbidden, and functional probes arbitrate multi-runner chains.
- **One vocabulary for denial and escalation.** The marker and hint texts and the strictly-wider ladder live here so the bash and fs families cannot drift apart.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SandboxProvider` service, mode/enforcement/policy types, fail-closed error |
| [`src/escalation.ts`](src/escalation.ts) | Escalation vocabulary: wider-mode ladder, argument validation, denial and hint markers, approval choreography |
| [`src/roots.ts`](src/roots.ts) | Writable-root derivation shared by the Seatbelt profile and the in-process fs fence |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Escalation choreography

The ladder is a closed table — `read-only` may escalate to `workspace-write` or `danger-full-access`, `workspace-write` only to `danger-full-access` — checked at execution, never baked into a tool schema, whose enum stays the closed target vocabulary. [`approveEscalation`](src/escalation.ts) validates the `sandbox_permissions`/`justification` pairing, rejects non-widening requests without prompting a human, and maps every approval outcome to its own error before anything executes.

### Writable roots

`workspace-write` means "the workspace root plus the host temp areas": `writableRoots` derives that allow-list canonically, resolving symlinks and deduplicating, so the Seatbelt profile and the in-process fs fence grant exactly the same roots.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the exhaustive contract, then the backends, consumers, and policy source that realize it.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — the complete vocabulary, per-call policy, and classification dialects.
- [The subprocess sandbox decision](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) — capability boundary, escalation design, and deferred phases.
- [Local sandbox backends](../sandbox-local/README.md) — the per-platform runners behind `ctx.sandbox`.
- [Bash sandbox executor](../../shell/bash-sandbox/README.md) — the confined bash consumer.
- [Sandbox policy package](../sandbox-policy/README.md) — where the per-call mode and workspace root come from.

-----

<a id="model-experience"></a>
## Model Experience

### Confinement error, indirectly

#### What the model sees

Through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), a requested confined mode with no usable backend produces code `SANDBOX_UNAVAILABLE` and the exact error below; an execution-time runner failure appends ` Runner failure: <detail>`.

##### Exact error

```markdown
sandbox mode "<mode>" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.
```

#### Token effect

Conditional error text is visible for that call and retained in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Escalation request and outcome

#### What the model sees

A denied call surfaces the marker `[sandbox: file access denied under <mode> mode]` and, where the composition advertises escalation, the hint `[sandbox: escalation available — retry this exact <subject> once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`. The retry carries `sandbox_permissions` and a `justification`; the user's `allowed-once` / `rejected` / `cancelled` decision becomes the call's result text.

#### Token effect

Only the denied call's error and any escalation outcome text are visible; both are retained in history until compaction.

#### KV Cache effect

Append-only; escalation text follows the retained prefix and does not invalidate cached entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special operational care. They are current package constraints, not a general sandbox comparison or a task backlog.

- **File effects are the whole policy vocabulary** — the seam expresses no network, process, syscall, device, or credential restrictions.
- **Same-world confinement only** — containers, microVMs, and remote execution require replacing capability implementations rather than adding a provider here.
- **Denial reporting is a stderr dialect** — the seam returns backend signatures instead of a typed runtime denial channel, so consumers that need classification infer it from the child process's output.
- **Runner diagnostics are in-band** — exit status plus stderr evidence cannot prove which process wrote a matching line, so a confined child that deliberately mimics its runner can cause a false availability or diagnostic attribution; this cannot bypass confinement, and an out-of-band runner-status channel is deferred.
- **One provider per context** — composing different sandbox mechanisms simultaneously requires a provider-level ladder or separate Cordis contexts; callers choose policy per call, not backend identity.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: consumers and environments

The [sandbox decision](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) lists deferred phases — an optional `subagent-acp` consumer that confines child agents (unconfined default) and environment-coherent capability group examples. Neither is decided; the Windows chain that note listed as deferred has since shipped through the ACL restricted-token rung of `sandbox-local`.

</details>
