---
description: "Managed SSH subprocess and terminal behavior for Bash, LSP and Node runtime consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-ssh

English | [中文](README.zh.md)

## Summary

`dsh-subprocess-ssh` implements `ctx.subprocess` using the shared SSH helper. Executable lookup, ordinary processes, fd 7 control traffic and terminal sessions run beside the SSH filesystem. Remote native process owners govern termination and quiescence; consumers continue to own command semantics, output limits and execution deadlines.

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

Mount this provider with [`dsh-ssh`](../ssh/README.md) and its filesystem provider. It has no deployment configuration of its own. `resolveExecutable()` checks the remote executable namespace; fully specified spawn requests supply the remote cwd, environment, stream dispositions and cleanup grace.

Ordinary spawn returns a handle while remote allocation proceeds. Piped stdin and the optional duplex control endpoint accept writes during allocation. Terminal allocation, writes, foreground inspection, signals and termination retain their asynchronous interfaces.

Terminal requests forward `shellActivity` to the execution provider, and `inspectActivity()` returns its validated state and revision. Opted-in terminals remain addressable after root exit until their owner explicitly terminates them; the SSH helper lease still governs connection-level cleanup.

A direct exit reported by `done` does not prove managed-range quiescence; `waitForExit()` observes that separately. Its optional signal bounds the entire observation, including pending allocation and termination, and cancellation returns `false` without stopping the process. An already confirmed empty range returns `true`; genuine observation failures reject. `terminate()` targets the same remote owner. Connection loss rejects unconfirmed work, and automatic replay never follows an ambiguous launch or mutation.

-----

Terminal shell facts and executable verification come from the remote helper. Lookup misses remain distinct from SSH failures. PTY creation forwards the caller's `terminalType`, and `resize()` updates the remote terminal without replacing its process.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The helper reserves and authenticates all required streams before launch. Stdout, stderr, stdin and fd 7 use separate SSH channels. Collected output publishes a final bounded raw-tail snapshot with whole-stream byte offsets, so network lag cannot change the completed observation. Optional spill files use the local provider’s private retained-output directory on the remote host.

Remote execution delegates to [`subprocess-local`](../../subprocess/subprocess-local/README.md). Native process ownership and platform fallbacks therefore have the same meaning as local execution on that remote OS. SSH carries requests and observations; it does not itself confine the payload.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — spawn, collection, terminal and lifetime APIs.
- [SSH sandbox provider](../sandbox-ssh/README.md) — remote file-effect confinement.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through Bash, terminal, LSP and ptc-runtime consumers, which present their existing results and remote paths.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Completed spill files survive connection disposal and remain available until external temporary-file cleanup.
- Callers must consume or close raw output streams. Destroying public stdout or stderr closes its matching transport, including when destruction precedes remote allocation. Independent channels allow control progress when stdout is paused, but do not remove per-stream backpressure or shared-network congestion.
- Loss of the SSH connection leaves remote termination unconfirmed from the client; lease cleanup is a remote action, not a successful client acknowledgement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Wire validation and the owning filesystem, subprocess and sandbox providers enforce the observable obligations; this adapter adds no independently observed state relation.

</details>
