# Agent Note: POSIX SSH execution providers

Status: implemented

English | [中文](2026-09-11-posix-ssh-runtime.zh.md)

## Problem

Remote coding requires file tools, Bash, terminals, language servers and Node programs to see one filesystem and process world. The [portable-consumer decision](2026-07-28-portable-execution-world-consumers.md) provides those interfaces. The [E2B retirement](../simplification/2026-09-11-remove-e2b-providers.md) preserves their asynchronous semantics while removing an integration whose standard-stream SDK needs a separate transport project to carry bidirectional PTC control traffic.

SSH supplies authenticated byte channels and per-channel flow control, but an ordinary exec request does not map arbitrary child descriptors. Treating SSH as a replacement for a process owner would leave control-stream bridging, launch publication, EOF, cancellation and disconnected cleanup without an implementation.

## Decision

A deployment-owned OpenSSH alias connects the local Harness to an installed POSIX helper. Filesystem, subprocess and sandbox providers share that helper; the Harness retains Cordis objects, model transport, permissions, callbacks and Session persistence. Terminal methods remain asynchronous. Provider paths describe the execution world without a separate local/remote flag.

Confinement is asynchronous and cancellable: the running helper resolves each policy through its loaded sandbox provider before the subprocess provider receives literal argv. `ShellExecutor.start()` resolves a `Promise<ShellProcess>` after preparation. Generic job admission remains synchronous; tool-owned `JobHooks` begin asynchronous shell preparation after preflight, cancel pending preparation and join any late process handle.

Private administrative RPC and each program stream use independent SSH channels. A remote reservation creates the requested stream endpoints before the payload starts. Stdout and stderr cannot carry administrative replies, and pausing one output channel does not consume fd 7’s flow-control window. This trades a larger remote helper for explicit binary transport and bounded stream retention.

Each stream receives a fresh 256-bit TLS pre-shared key through private administrative RPC. TLS 1.2 with `PSK-AES256-GCM-SHA384` authenticates both endpoints and protects subsequent bytes before the stream can publish. The key never travels as a stream preface. Socket permissions alone are insufficient: file-effect confinement can permit same-user connections or pathname replacement in writable temporary directories. No administrative Unix listener or stream secret is exposed to the payload. Cancellation transfers to the TLS wrapper after wrapping; cleanup closes that wrapper before the underlying socket so native TLS reads cannot outlive their transport.

Collected stdout and stderr carry bounded tail snapshots through handlers that only update output observations. Capture continues while a snapshot is waiting for transport. Final snapshots preserve raw-byte offsets, and completed spill files use the local provider’s retained-output storage after connection disposal.

Readiness verifies the installed helper digest and, when PTC is configured, the installed Node bootstrap digest. These checks pin expected deployment artifacts; they do not authenticate a malicious remote operating system. The helper disables Node debugger activation through `SIGUSR1`: file-effect confinement can still permit same-user signals, which must not expose the helper's unrestricted filesystem and process services. File-effect confinement delegates to the remote local sandbox provider and retains its full/partial disclosure and platform limitations.

Path canonicalization belongs where the files exist. The shared policy resolver preserves absolute execution-world spelling; enforcing providers resolve symlinks and `..` on their own filesystem. Headless records and validates cwd through `ctx.fs`. Host-path projection remains unavailable for SSH, so Node execution requires an explicitly installed remote bootstrap.

A lost connection invalidates pending operations without reconnect or replay. Helper EOF, signals and a heartbeat lease initiate remote native cleanup. The client cannot turn lease expiry into an observed successful termination: an interrupted mutation or launch can have an unknown outcome. Administrative request deadlines, consumer execution deadlines and cleanup remain separate owners.

## Alternatives considered

**Frame every stream over SSH exec stdout/stdin.** This avoids Unix-socket forwarding, but requires per-stream credits, queue bounds and independent EOF semantics inside the application protocol. Independent SSH channels use the transport’s existing flow control and keep program output away from administrative framing.

**Replace remote file operations with SFTP alone.** SFTP supplies file transport but does not directly preserve the existing guarded atomic-write, edit, policy and error semantics. Reusing the remote local filesystem providers keeps those mechanisms with their current owners.

**Expose TCP or HTTP endpoints for program streams.** This permits independent transports but introduces remote port exposure, endpoint authentication and server deployment beyond the existing SSH connection. Forwarded Unix sockets use the authenticated SSH session and additionally authenticate both stream endpoints with TLS-PSK against same-user connections or pathname replacement.

**Move the complete Harness to the remote host.** That is a separate deployment model. It moves model credentials, Session storage and plugin state with execution rather than supplying remote implementations of existing capabilities.

## Consequences

Remote providers add transport, reservation and disconnection responsibilities even though they reuse local file and process mechanisms. Raw streams, collected tails and remote spill files retain distinct lifetimes. Consumers must release their streams and handles; a helper’s cleanup result cannot be reconstructed after transport loss.

The initial composition scope is POSIX headless and custom profiles. Web workspace consumers with host-filesystem assumptions require their own integration. Network restrictions, process-visibility isolation, hostile-host attestation, persistent remote handles and automatic artifact provisioning are outside this provider family.

The portable-consumer decision remains active; this note supplies its SSH realization. The E2B retirement remains active for the removed integration and its maintenance tradeoff. Neither note is fully superseded.

## Verification

Required protocol and lifecycle evidence covers malformed frames, bounds, reservation cancellation, authenticated stream publication and disconnect errors. Native SSH acceptance must exercise remote file guards and symlink identity, Bash confinement, fd 7 binary traffic, control progress under paused output, terminal operations, LSP and Node execution. Live checks require an explicitly configured disposable remote workspace; keyless tests do not provision one.

Security evidence requires both a same-user connector and a replaced socket listener that cannot claim a reserved stream, learn its key, alter another run or receive its plaintext output. Process-lifecycle evidence distinguishes direct exit from managed-range quiescence and tests cancellation both before launch publication and after the payload starts. Source and built profile checks verify the installed helper/bootstrap arrangement without transferring host credentials to program environments.

## Deferred work

Persistent remote reconnection needs a separate operation-identity and recovery design; it cannot reuse live callback handles after disconnect. Broader Web support needs provider-owned workspace resources. Stronger resource accounting or revised PTC yield/wait and timeout policy belongs to the [Node runtime reference](../../../../packages/ptc-runtime/ptc-runtime-node/README.md), not the SSH administrative request deadline.
