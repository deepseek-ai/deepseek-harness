# Agent Note: Remove the E2B execution providers

Status: implemented

English | [中文](2026-09-11-remove-e2b-providers.zh.md)

## Problem

The E2B experiment supplied one remote filesystem/process world for file tools, Bash, PTY and language servers while the Harness, credentials, model transport and session state stayed on the host. Its three providers demonstrated that those consumers can share the existing filesystem and subprocess interfaces without provider-specific tools.

PTC Node confinement requires bidirectional control traffic separate from arbitrary program stdin/stdout/stderr. The pinned `e2b@2.29.1` SDK exposed standard process streams and PTY output, with no extra descriptor transport. Creating a descriptor inside the VM does not expose it to the Harness host; a remote relay or a separate authenticated stream must bridge it.

Such a bridge owns independent progress when output blocks, bounded retention, channel closure, startup publication, command identity, cancellation and disconnect cleanup. The SDK retained complete stdout/stderr even when a consumer applied backpressure, so stream-level queue bounds alone could not bound host memory. Extending that adapter would turn the experiment into a separate remote transport project.

## Decision

The repository excludes the E2B sandbox owner, filesystem provider and subprocess provider, their SDK dependency, integration fixtures, opt-in workflow and generated registrations. It supplies no E2B execution backend. The removal trades that integration for a smaller maintained implementation set; it does not imply that E2B cannot support a suitable transport or that published packages have no external users.

The [portable execution-world decision](../architecture/2026-07-28-portable-execution-world-consumers.md) remains authoritative for `ctx.fs` and `ctx.subprocess`. The pair describes one path namespace and process world. Providers own path conversion, executable lookup, ordinary streams, terminal allocation and managed cleanup; consumers retain tool semantics, policy and presentation. A local/remote metadata label adds no authority to those operations.

Remote execution remains an intended capability. Terminal allocation, writes, foreground inspection and signalling retain their Promise contracts and pending-operation cancellation guarantees. A local implementation completing these calls synchronously does not justify removing the asynchronous behavior required by remote providers. Process completion, terminal readiness, emulator parsing and managed-range quiescence also retain their existing owners.

This decision removes one provider family. It changes neither PTC execution nor the shared filesystem, subprocess and terminal interfaces. Direct Node confinement and validation of program-authored control traffic require their own implementation and evidence.

## Alternatives considered

**Retain E2B and refuse the control-channel request.** This preserves the existing remote functionality with little new transport code, but retains its SDK and remote lifecycle obligations while excluding the new execution capability. Retirement makes that maintenance tradeoff explicit.

**Multiplex the channel over E2B standard streams.** A relay can frame stdin/control input and stdout/stderr/control output. It also needs channel-specific flow control and closure, bounded queues, and a solution to cumulative SDK output retention. These are remote transport semantics, not descriptor plumbing.

**Use a separate authenticated stream.** This can avoid the SDK's retained-output path and let control traffic progress independently. It adds endpoint access, authentication, network policy, startup coordination and connection-failure cleanup. The removal does not introduce that transport.

**Make terminal operations synchronous.** This simplifies local wrappers but removes delayed-operation behavior needed by remote providers. The shared asynchronous interface and its cancellation/ordering tests remain useful independently of E2B.

## Consequences

Custom compositions that depend on the repository's E2B packages lose that supplied backend. External adoption is unknown. Removing the integration also removes its live remote composition evidence; remaining local and delayed-provider tests protect their own contracts, not an unimplemented replacement.

The [native containment](../architecture/2026-08-28-subprocess-native-containment.md), [outbound proxy](../architecture/2026-08-27-outbound-proxy-policy.md) and [workspace-file service](../architecture/2026-09-05-workspace-files-service.md) decisions remain active. Their E2B implementation and verification inventories are retired while their process ownership, routing and file-access requirements remain intact. The portability decision is partially superseded only in its E2B realization.

## Reintroduction conditions

A remote provider needs a concrete execution use case and evidence for shared file/process coordinates, policy enforcement, bounded transport retention, independent control progress, precise channel closure and managed cancellation. Source and built compositions must exercise those behaviors. A connection loss cannot justify replaying a possibly executed program or claiming unobserved cleanup succeeded.

The [POSIX SSH providers](../architecture/2026-09-11-posix-ssh-runtime.md) use binary channels outside the E2B command SDK's retained-output path. Ordinary SSH exec does not map arbitrary child descriptors, so their remote helper owns control-stream bridging, file semantics, process lifetime and remote policy enforcement. That implementation uses the retained interfaces; the E2B integration remains retired.

## Verification

The removal inventory finds no live E2B package, workflow, import, dependency or catalog entry. Every surviving lockfile importer and package resolution matches its original value. The shared subprocess and terminal implementation, delayed-provider tests and PTC source are unchanged.

The remaining filesystem, subprocess, Bash, terminal and LSP suites pass alongside the affected generator and workflow tests. `pnpm run build`, `pnpm run test:docs`, `pnpm run doc-sync`, `pnpm run lint` and `pnpm run hygiene` pass for the removal. These checks validate the resulting tree; deleted E2B tests provide no evidence for it.
