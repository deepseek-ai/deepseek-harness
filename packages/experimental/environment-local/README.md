---
description: "Contribute a local execution environment backed by a managed Node process."
kind: "package-reference"
---

# @deepseek-ai/dsh-environment-local

English | [中文](README.zh.md)

## Summary

Run environment functions in a local Node process while origin callbacks stay in dsh. This provider contributes a stable handle, display name and transport to the shared registry. Filesystem and process operations use the configured local working directory and the execution process's permissions. The execution process starts on first use and is reused until disconnection or provider removal. This package is experimental and requires explicit composition.

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

Mount the registry and provider, then pass the contributed handle to the runners that `ctx.environments.define` returns. Multiple provider instances may contribute distinct local environments.

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-local'
  config:
    handle: local
    displayName: Local workspace
    cwd: /absolute/workspace
```

| Field | Default | Meaning |
|---|---|---|
| `handle` | `local` | Stable provider-owned identifier |
| `displayName` | `Local` | User-facing label |
| `cwd` | required | Absolute execution-process working directory |
| `node` | Current executable | Node executable used to start the process |
| `daemon` | Installed environment bundle | Absolute override for the execution-daemon entry |
| `killGraceMs` | 2000 | Additional daemon termination grace after the negotiated `exec` process-group grace |
| `maxStderrBytes` | 64 KiB | Retained daemon stderr |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-environment-local) owns the exhaustive field reference. The default daemon is the installed `dsh-environment` bundle and requires Node 24. Provider removal removes the handle and closes its connection. Before forcing daemon termination, the provider allows the registry's negotiated `exec` process-group grace plus this provider's additional `killGraceMs`. The registry owns cancellation, result validation and origin callbacks exactly as for SSH environments.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each transport open starts a fresh `daemon.js serve --stdio` process through `ctx.subprocess`; the registry reuses that process while its channel remains live. The transport owns process startup and termination. Standard input and output carry the registry's common protocol. The daemon supplies filesystem and process APIs from its own process, and the registry dispatches origin callbacks in dsh. The provider retains bounded stderr to explain startup and connection failures. Electron executables receive `ELECTRON_RUN_AS_NODE=1` when used as the Node executable.

[`src/index.ts`](src/index.ts) owns provider configuration, process creation and registry registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Environment registry](../environment/README.md) — handles, typed execution and lifecycle.
- [Environment subsystem](../../../docs/subsystems/environment.md) — public service reference.
- [SSH provider](../environment-ssh/README.md) — execution on another machine.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through tools that call the environment registry; those tools own schemas, model-visible results and logging. This provider adds no prompt section, model tool or Session event.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The execution process uses its filesystem permissions; this provider does not apply the originating Session's sandbox policy.
- Functions must be self-contained and exchange structured-clone values even though execution is local.
- No existing tool automatically selects this provider, and Windows behavior is not covered by its tests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Source composition tests explicitly select the erasable daemon entry, so they work without built artifacts. Installed-path verification uses the bundled daemon.

</details>
