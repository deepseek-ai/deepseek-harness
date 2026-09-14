# Agent Note: Subprocess control pipe

Status: implemented

English | [中文](2026-09-11-subprocess-control-pipe.zh.md)

## Problem

A managed Node program can write arbitrary bytes to stdout and stderr. A host protocol sharing either stream cannot distinguish those bytes from program diagnostics without restricting ordinary Node behavior. Windows process wrappers also require explicit descriptor inheritance before the child runtime allocates its own descriptors.

## Decision

Ordinary subprocess requests optionally set `stdio.control: 'pipe'` and receive a raw `Duplex` as `handle.control`. The target opens fd 7 through `@deepseek-ai/dsh-subprocess/control`. The provider owns the environment marker; the child helper consumes it. Consumers own bounded framing, message validation, backpressure, and endpoint closure. Standard output collection and managed-range lifetime retain their existing semantics. The provider tracks open control endpoints independently until they close, including after their managed range exits, and disposal closes remaining endpoints after attempting range teardown.

POSIX launchers preserve fd 7 across exec. Windows ordinary Job and restricted-token launchers place the pipe at slot 7 in the CRT startup descriptor table, preserve standard handles, and leave slots 3–6 closed in the payload. Each wrapper closes its carrier after transferring ownership. Handle inheritance is enabled only around process creation. This channel grants no host capability: the child remains untrusted, and every host tool request requires its usual dispatch and approval checks.

Control pipes use Node's `overlapped` stdio disposition, which equals `pipe` on POSIX and creates Windows handles with `FILE_FLAG_OVERLAPPED`. Reads and writes can then proceed independently, including a child sending its first message before the host sends anything.

Windows managed-range proof observes the runner process exit and its private IPC result independently of caller stream drains. A clean runner exit with a received result confirms its range; a clean exit without a result remains pending only until the IPC channel closes. Paused control output cannot delay this proof or prevent provider disposal from closing the endpoint.

The filesystem and subprocess services remain replaceable together by remote providers. Neither the public handle nor its request exposes a host path, process identifier, execution-world flag, or transport negotiation catalogue. Terminal allocation remains asynchronous and does not gain an extra descriptor.

## Alternatives considered

**Stdout framing.** Native code and ordinary `process.stdout.write` can emit arbitrary bytes, so protocol integrity would depend on intercepting program output.

**Synchronous Windows pipes.** A blocking read on an inherited synchronous pipe can prevent a concurrent write on the same handle from progressing. A parent-first echo does not expose this deadlock; child-first readiness and teardown require overlapped handles.

**Node IPC.** The Windows process supervisor already uses a private IPC channel. Coupling payload requests to that management protocol would expose supervisor operations and complicate remote transport.

**A late Windows descriptor replacement.** Replacing fd 7 after Node starts can overwrite an internal descriptor. The CRT startup table reserves it before runtime initialization and keeps the child API identical across hosts.

**A different descriptor per platform.** Per-platform numbers would add bootstrap branching without removing the native startup work. One fixed slot also allows remote providers to preserve the same child API.

## Consequences

Native wrappers must preserve and close one extra pipe explicitly. The subprocess service does not interpret control messages or buffer them for callers, so protocol consumers must bound their own retained input and output. The OS sandbox and managed process owner remain responsible for confinement and teardown; a dedicated transport is not a JavaScript security boundary.
