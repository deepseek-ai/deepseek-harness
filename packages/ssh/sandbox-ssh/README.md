---
description: "Remote file-effect confinement for compositions using SSH filesystem and subprocess providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-ssh

English | [中文](README.zh.md)

## Summary

`dsh-sandbox-ssh` supplies `ctx.sandbox` for processes launched by the SSH subprocess provider. The remote host selects its installed local sandbox backend and applies each call’s policy there. Bash and Node receive the same backend’s enforcement level, denial signatures and runner-failure classification.

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

Mount this provider with the shared [`SSH connection`](../ssh/README.md), SSH filesystem and SSH subprocess providers. It has no package-specific configuration. Await `confine(argv, policy, signal)` to resolve each policy and command through the running remote helper.

Pass a complete `read-only` or `workspace-write` policy. The workspace is interpreted and canonicalized on the remote host. Consumers bypass `confine()` for `danger-full-access`; the connection does not invent an additional local/remote policy flag.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The running helper canonicalizes the policy root and asks its loaded sandbox provider for the enforcing argv, enforcement level and runner-failure evidence. The SSH subprocess provider executes that returned argv directly and owns fd 7 transport and managed process lifetime. Cancellation or an unavailable backend rejects before the caller receives a command to launch.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — policy meanings and enforcement disclosure.
- [Local sandbox provider](../../sandbox/sandbox-local/README.md) — backends and platform limitations inherited on the remote host.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through existing sandbox consumers, which report mode, denial and enforcement and own approval presentation and model arguments.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- File-effect modes do not restrict network access or process visibility. A remote `partial` backend remains partial.
- The SSH host and installed helper are trusted infrastructure. Digest checks and file-effect confinement do not establish a hostile-host security boundary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Wire validation and the owning filesystem, subprocess and sandbox providers enforce the observable obligations; this adapter adds no independently observed state relation.

</details>
