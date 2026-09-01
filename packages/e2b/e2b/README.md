---
description: "One shared remote Linux sandbox for E2B-backed file and command work: configuration, lifetime, and what happens at startup and shutdown."
kind: "package-reference"
---

# @deepseek-ai/dsh-e2b

English | [中文](README.zh.md)

## Summary

`dsh-e2b` provides one shared remote Linux sandbox for the E2B provider family: the agent's file operations, shell commands, and terminals all run inside this sandbox instead of on your machine. The sandbox is created when the family starts and deleted automatically when the configured lifetime expires or the app shuts down — anything it held disappears with it. You configure three things: an API key, a remote working directory, and the sandbox lifetime. Use it together with `dsh-fs-e2b` and `dsh-subprocess-e2b`; on its own it adds no user-visible features. Nothing here reaches the model, and no shipped composition enables this family by default.

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

Use this package when you want the agent's file and command work to run in a remote Linux sandbox rather than on your machine. It is the foundation of the E2B family: with the filesystem and subprocess packages mounted, all of that work shares one remote working directory and process world.

### When to choose it

Choose the E2B family when work should be isolated from the host machine — for example, when you want the agent's file edits and command runs to happen somewhere disposable. Choose the local filesystem and subprocess packages when running on the host is fine. This package is invisible to the model and adds no request cost.

### Minimal configuration

Three settings matter: an API key (or the `E2B_API_KEY` environment variable), an absolute remote working directory, and the sandbox lifetime. A bad key, a relative working directory, or an invalid lifetime rejects startup before any remote work happens.

```yaml
- name: '@deepseek-ai/dsh-e2b'
  config:
    apiKey: <E2B API key>
    cwd: /home/user/workspace
    timeoutMs: 300000

- name: '@deepseek-ai/dsh-subprocess-e2b'
- name: '@deepseek-ai/dsh-fs-e2b'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `E2B_API_KEY` | API key for the host SDK connection; never installed in the sandbox |
| `cwd` | `/home/user/workspace` | Remote working directory the family shares; absolute POSIX path |
| `timeoutMs` | `300,000` | Sandbox lifetime in milliseconds; the sandbox is deleted when it expires |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-e2b) is the exhaustive source for every accepted field and its JSDoc.

### What you get

With this package mounted, file reads and writes, shell commands, and terminals all operate inside the sandbox's working directory, so the agent sees one consistent remote world: what it writes with the file features is what its commands can read, and vice versa. The remote working directory is created if it does not exist yet.

### Starting and stopping the sandbox

Loading the plugin starts the sandbox in the background; the filesystem and subprocess features are ready once it is up. The sandbox lives for the configured lifetime (default five minutes) unless the app stops first — in both cases it is deleted, so save anything you still need before then. If the sandbox disappears while running (expired or removed elsewhere), the family treats that as a clean end rather than an error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the owner and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One sandbox, one handle.** All adapters await the same `getSandbox()` promise, so filesystem and process operations share one remote Linux world.
- **Secure by construction.** The sandbox is created with `secure: true` and `lifecycle: { onTimeout: 'kill' }`, so expiry always deletes it.
- **Isolated control shells.** `e2bControlEnvs()` gives every internal command shell a fresh randomized `HOME`, and `quoteE2BShellArg()` preserves opaque arguments through the SDK's unavoidable `/bin/bash -l -c` layer.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `E2BRuntime` service, `Config` schema, validation, sandbox open and teardown |
| — | No runtime invariant companion is published; sandbox creation and teardown have one SDK promise and no independent event or mutable-data relationship to cross-check. |

### Lifecycle

`open()` creates the sandbox, prepares `cwd` and the private runtime root, rejects a non-directory or symlink runtime root, and applies `chmod 700`. Disposal prevents new handle acquisition, awaits setup, and deletes the sandbox, accepting `SandboxNotFoundError` as quiescence. `getSandbox()` re-checks the disposed flag after awaiting readiness, so disposal racing readiness still rejects acquisition; an eager connection failure stays observed but does not reject plugin load, and `getSandbox()` surfaces it.

### Setup failure handling

Any directory-setup failure makes one deletion attempt and preserves the original error; a failed rollback is bounded by E2B's configured sandbox timeout (see the Dev Note). Provider plugins must load after this owner and dispose before it, because every adapter awaits the same handle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the family composition to the subprocess seam surface and the decision evidence behind the remote execution world.

- [E2B provider family map](../README.md) — the three packages and the opt-in composition.
- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — the subprocess seam contract and the generated Cordis surface, including `ctx.e2b`.
- [Portable execution-world decision](../../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md) — why consumers delegate to `ctx.fs` and `ctx.subprocess`, and what stays in the host.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-e2b) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the shared remote-runtime owner registers no model context; provider adapters and consumers own rendered effects.

#### KV Cache effect

No direct invalidation: the owner contributes no request tokens and never mutates a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the E2B family is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Not a whole-harness runtime** — Cordis services, agent/session state, session logs, LLM requests, skills, and SDK-side buffers stay in the host process.
- **Sandbox state is ephemeral** — disposal and timeout delete the sandbox; reconnect, pause/leave retention, templates, volumes, and snapshots are outside this POC.
- **No deployment platform is configured** — network policy, host-workspace synchronization, and sandbox discovery are outside this POC.
- **`cwd` is a resolution convention, not containment** — adapters and commands can address other sandbox paths; E2B network access retains the base image's policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code.

#### Open: sandbox setup rollback

The `open()` failure path makes a single deletion attempt and preserves the original setup failure. Retry state stays deferred unless a real double failure outlives E2B's configured sandbox timeout (TODO(e2b-setup-rollback)).

</details>
