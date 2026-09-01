---
description: "The sandbox-enforcing ctx.fs backend for deployments and maintainers confining model file mutations to a session workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-sandbox

English | [中文](README.zh.md)

## Summary

`dsh-fs-sandbox` provides the sandbox-enforcing `ctx.fs` backend: it extends [`fs-local`](../fs-local/README.md) with every text-storage behavior intact and adds only a per-call mode fence on writes and edits, while reads always pass through. Under `read-only` every mutation is refused; under `workspace-write` a mutation is allowed only when the target sits under the session workspace or a platform temp root; under `danger-full-access` mutations run unfenced. Loading it instead of `fs-local`, together with the shared `ctx.sandboxPolicy` service, is the whole swap — the model-facing tools and the policy plugin are untouched. A denial is a structured `FS_SANDBOX_DENIED` error that the tools render as the familiar `[sandbox: file access denied under <mode> mode]` marker with a same-turn escalation hint. Choose it when a session's file mutations must be confined to its workspace.

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

Mount this backend instead of `fs-local` when the model's file writes and edits must be confined by the session's sandbox mode, while reads stay unconfined. The fence applies per call: the tool layer resolves the calling session's mode and workspace root into the same policy the bash runner receives, so the filesystem and shell families never confine to different roots.

### Minimal composition

Load the shared policy service, then this backend, then the tools; the read-before-edit policy plugin stays optional.

```yaml
- name: '@deepseek-ai/dsh-sandbox-policy'
- name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: /absolute/path/to/workspace
- name: '@deepseek-ai/dsh-tool-fs'
```

The backend's config is the local backend's unchanged (`cwd` resolution default and `diffBasisMaxBytes` overwrite bound); the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fs-sandbox) is the exhaustive source.

### How the fence behaves

The effective mode comes from the calling session's override or escalation grant, falling back to the deployment default when neither is in force. `read-only` denies every mutation with the structured `FS_SANDBOX_DENIED`. `workspace-write` allows a mutation only when the target canonicalizes under the workspace root or a platform temp area (`/tmp`, `os.tmpdir()`) — the same writable set the Seatbelt profile grants. `danger-full-access` delegates unfenced.

### Observable success and failures

Reads, listings, and metadata work exactly as with `fs-local`. A denied mutation returns an `FS_SANDBOX_DENIED` error carrying the effective mode; through the tools the model sees `[sandbox: file access denied under <mode> mode]` plus the one-approved-wider retry hint, identical to bash's denials. A session with an approved escalation may retry the same operation at a strictly wider mode for that one call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the sandbox backend and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The fence is a policy check in trusted code over a model-controlled path — not a kernel boundary. The operations are the seam's own (open, rename); only the target path is untrusted, so canonicalize-then-contain is the complete answer to this surface. Kernel-grade isolation of untrusted code stays `ctx.shell`'s job.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SandboxedFileSystem`: mode fence on `writeText`/`editText`, `sandboxMode` fact |
| [`src/containment.ts`](src/containment.ts) | Ancestor containment check with lexical fast path and identity-based fallback |

### How a mutation is fenced

Each mutation resolves the per-call policy (`danger-full-access` returns the caller's target untouched; `read-only` throws `FS_SANDBOX_DENIED`), then for `workspace-write` re-canonicalizes the target immediately and requires containment under one of the writable roots derived from the single `writableRoots` function — the same set the Seatbelt profile grants, so the fs fence and the bash runner cannot drift. The fresh target is the one mutated, so a symlink ancestor swapped since the tool resolved it is caught.

### Threat model

The residual resolve-to-syscall TOCTOU is narrowed by re-canonicalizing immediately before the write and is accepted for this threat model; a kernel-tight boundary would need `openat2`-class primitives whose portability cost is not worth it here. A denial is a structured `FsError`, not stderr inference — an in-process fence knows exactly what it refused.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this backend to the shared policy home and the confinement decisions behind it.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [dsh-fs](../fs/README.md) — the `ctx.fs` contract this backend implements.
- [fs-local](../fs-local/README.md) — the local backend this one extends.
- [sandbox-policy](../../sandbox/sandbox-policy/README.md) — the shared per-session policy resolver this backend requires.
- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and fail-closed errors.
- [Cross-family fs sandbox decision](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) — the shared mode fence and its escalation choreography.

-----

<a id="model-experience"></a>
## Model Experience

### Filesystem policy and refusals

#### What the model sees

The policy owner contributes capability-neutral `sandbox:policy` context. Indirectly, `dsh-tool-fs` renders this backend's `FS_SANDBOX_DENIED` refusals as the `[sandbox: file access denied under <mode> mode]` marker plus the same-turn escalation hint.

#### Token effect

The current-policy clause adds a small runtime-context message while this backend is mounted; a denial adds the bounded marker and escalation hint to conversation history.

#### KV Cache effect

A standing-policy change appends an owner-rendered superseding runtime-context snapshot after retained history; operation results remain append-only.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the sandbox backend is a poor fit or needs special operational care. They are current package constraints, not a general sandbox comparison or a task backlog.

- **A policy fence, not a kernel boundary** — the check is trusted code over a model-controlled path, so the residual resolve-to-syscall TOCTOU is narrowed (by the in-place re-canonicalization) but not eliminated; adversarial host processes are out of scope. Kernel-grade isolation of untrusted code stays `ctx.shell`'s.
- **Fence-vs-runner parity is derived from one owner** — the writable set comes from `writableRoots`, shared with the Seatbelt profile; a runner profile that defines its writable set elsewhere would drift.
- **Requires `ctx.sandboxPolicy`** — tools use it to resolve each session policy and the backend uses it for agentless-call fallbacks; the backend does not confine without it composed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This stateless adapter delegates policy and filesystem relations to their owning seams.
