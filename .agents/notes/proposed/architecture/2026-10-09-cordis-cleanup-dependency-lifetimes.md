# Agent Note: Keep cleanup dependencies usable until consumers finish

Status: proposed

English | [中文](2026-10-09-cordis-cleanup-dependency-lifetimes.zh.md)

## Problem

A disposer can await its consumers while another disposer has already removed the listener or closed the resource those consumers need. Awaiting a provider's final disposal promise therefore does not establish resource survival. This affects shutdown and plugin replacement, including final Session events, accepted reminder delivery, credential commits, and remote process termination.

The [Cordis audit skill](../../../skills/cordis-styling-nitpicking/SKILL.md#p0-cleanup-dependency-released-before-consumer-completion) classifies this lifecycle violation as P0. [Fiber unload (`Fiber._unload`)](../../../../vendor/cordis/src/fiber.ts) starts sibling disposers concurrently; [service withdrawal (`ReflectService.provide`)](../../../../vendor/cordis/src/reflect.ts) waits for dependent fibers only inside its own disposer. Service injection establishes dependency tracking but cannot prevent sibling resource closure. [Event subscriptions (`EventsService.register`)](../../../../vendor/cordis/src/events.ts) are independently owned effects, including subscriptions made through a caller-traced service context.

## Proposal

Make each required resource's owner retain it through the consumers' complete asynchronous cleanup. Stop admitting new work, settle accepted work and final publication, then drain and release the resource. Compose the actual disposers into an awaited ownership sequence; a returned wrapper does not capture an independently registered original effect. Preserve cancellation and error reporting while ensuring one failure cannot bypass remaining cleanup.

The audit below records unresolved production paths inspected on 2026-10-09. It proposes implementation work; this note and the skill do not fix runtime behavior. Findings target the cleanup-dependency rule only, not the skill's separate singleton and unreversed-effect rules.

## P0 findings

### Session persistence drops events emitted during cleanup

**Owners and evidence.** The [JSONL plugin (`apply`)](../../../../packages/session/session-persistence-jsonl/src/index.ts) composes service withdrawal before tracker disposal. The [tracker (`JsonlBackendTracker.install`)](../../../../packages/session/session-persistence-jsonl/src/storage.ts) removes live-event listeners before closing handles. This protects consumers unloaded by provider withdrawal, but concurrent root disposal can unregister consumer fibers before withdrawal discovers them; the plugin explicitly excludes that ordering guarantee. The Agent loop [cancels, awaits idle and scope disposal, then closes its handle (`AgentLoop.prepare`)](../../../../packages/core/agent-loop/src/index.ts). The `AgentLoop.prepare` teardown comment explicitly requires backend live-event listeners to remain mounted through driver shutdown to receive closing events. Its [turn unwind (`ReactLoopAgent.turn`)](../../../../packages/core/agent-loop/src/agent.ts) can publish recovered tool results and closing events after awaits.

**Failure and correction.** During root disposal, pause the turn's cancellation unwind. JSONL can remove its routing listeners and finish closing the currently buffered prefix before the turn emits its final events. Those events reach the live Session but never enter the writer; a later idempotent handle close cannot recover them. Retain routing, writers, and write ownership until every producer settles, then perform the final drain. This is source-traced; a full Session reproduction remains required.

The [handle-based persistence decision](../../implemented/architecture/2026-08-27-handle-based-session-persistence.md) explicitly permits losing the unemitted remainder during root disposal. This proposal intentionally tightens that policy for events emitted while graceful cleanup finishes. Crash repair remains necessary for abrupt termination, but cannot substitute for persisting actual final results during awaited shutdown. The [logical-session storage proposal](2026-09-06-logical-session-storage-rebuild.md) relocates enqueue ownership in stage 4; it must also establish this teardown ordering.

### Storage closes before Schedule commits accepted delivery

**Owners and evidence.** The storage-domain plugin independently registers [facility closure and service provision (`apply / DomainFacility.closeAll`)](../../../../packages/storage/storage-domain/src/index.ts). [Domain close (`DomainImpl.runClose`)](../../../../packages/storage/storage-domain/src/domain.ts) marks the domain disposing, and [later enqueues reject (`DomainImpl.enqueue`)](../../../../packages/storage/storage-domain/src/domain.ts). Schedule [awaits its runtime and management work before closing its domain (`ScheduleService`)](../../../../packages/schedule/schedule/src/index.ts). Accepted delivery [flushes the Session before retiring or advancing the task (`ScheduleRuntime.drive`)](../../../../packages/schedule/schedule/src/runtime.ts).

**Failure and correction.** Hold that Session flush, unload storage-domain, then release the flush. The provider's sibling closer can mark the domain closed while Schedule is still draining; the final task commit then fails. A reminder already persisted in the inbox remains active in task storage and can be delivered again after restart. Withdraw the service and await consumers before closing leftover domains; retain backend units through the domain drain. The [JSON backend](../../../../packages/storage/storage-json/src/index.ts) and [SQLite backend](../../../../packages/storage/storage-sqlite/src/index.ts) have the same sibling-close ownership concern and belong in that implementation review, not separate unproven consumer findings.

A focused in-memory experiment using the actual Cordis and storage-domain implementation paused an injected consumer before its final write, began provider disposal, then released it. The result was `domain 'audit' is closed`. This reproduces resource closure; the complete Schedule restart consequence is source-traced. The accepted crash window between Session persistence and task commit remains; graceful shutdown must not manufacture that window by closing storage early.

### Authorization loses required observation or an accepted credential write

**Owners and evidence.** Authorization's [commit observer (`AuthorizationService.attempt`)](../../../../packages/credentials/authorization/src/index.ts) is a caller-owned `ctx.on` effect. Its [commit operation (`AuthorizationService.attempt`)](../../../../packages/credentials/authorization/src/index.ts) awaits credential storage, while [success requires the observed update (`AuthorizationService.attempt`)](../../../../packages/credentials/authorization/src/index.ts). The account service [leaves committing attempts un-aborted and awaits their completion (`PlatformAccount`)](../../../../packages/credentials/deepseek-account-platform/src/index.ts).

**Successful write, false failure.** Pause a credential write, dispose the account consumer, then complete the write and emit its update. The observer can auto-unsubscribe alongside the account's drain; Authorization then rejects with `NOT_COMMITTED` despite successful storage. Keep observation owned by the operation until its result settles, or acknowledge successful `session.commit` directly while giving legacy direct-write observation an explicit lifetime. A focused experiment using actual Cordis and Authorization with a deferred in-memory credential provider reproduced `NOT_COMMITTED` after the provider write succeeded; the complete browser sign-in path is source-traced.

**Accepted write rejected during provider disposal.** Separately, credentials-local [sets `closed` before waiting for queued operations (`LocalCredentialProvider[Service.init]`)](../../../../packages/credentials/credentials-local/src/index.ts), and [queued record writes check that flag again (`LocalCredentialProvider.modifyRecord`)](../../../../packages/credentials/credentials-local/src/index.ts). With an earlier document operation held, an already-committing account attempt can have its accepted write rejected when the queue advances after provider disposal begins. Distinguish new admission from accepted operations, and retain write capability until dependent commit drainage finishes. This variant is source-traced, not independently reproduced. Fixing the observer alone cannot fix it.

### SSH disables cleanup requests before dependent process cleanup finishes

**Owners and evidence.** The SSH service's [disposal (`SshConnection.disposeOnce`)](../../../../packages/ssh/ssh/src/index.ts) sets `closed` and aborts its lifetime before awaiting helper shutdown. Its [request guard (`SshConnection.assertOpen`)](../../../../packages/ssh/ssh/src/index.ts) rejects subsequent use. The injected subprocess provider [terminates and awaits live processes and terminals during cleanup (`SshSubprocessRuntime`)](../../../../packages/ssh/subprocess-ssh/src/index.ts), which requires SSH requests.

**Failure and correction.** SSH provider disposal can close request admission while subprocess cleanup still needs termination and exit confirmation, despite `inject = ['ssh']`. The dependent reports that SSH process cleanup could not be confirmed. Keep the cleanup request capability available until dependents settle, then close the helper, sockets, and master. The helper's own close also attempts remote cleanup: the evidence establishes a lost cleanup capability and possible disposal errors, not guaranteed orphaned remote processes. A focused reproduction used real Cordis, SSH and subprocess providers with a mocked child-process/filesystem transport. It started a process and unloaded SSH after the exit-wait RPC was admitted. The handle rejected with `SSH connection is closed`; the helper received `close` without `process.terminate`. This verifies the composed-provider defect, not actual remote process quiescence.

### Windows sandbox releases temporary process resources during consumer cleanup

**Owners and evidence.** The local sandbox's [sibling cleanup effect (`LocalSandboxProvider`)](../../../../packages/sandbox/sandbox-local/src/index.ts) calls [grant revocation and temporary-directory removal (`LocalSandboxProvider.revokeAclGrants`)](../../../../packages/sandbox/sandbox-local/src/index.ts). The [temporary capability (`LocalSandboxProvider.materializeAclGrant`)](../../../../packages/sandbox/sandbox-local/src/index.ts) belongs to the provider and is embedded in the confined runner arguments. The injected Node PTC runtime [aborts and awaits accepted runs (`NodePtcRuntime`)](../../../../packages/ptc-runtime/ptc-runtime-node/src/index.ts); [completion awaits process exit and output drainage (`NodePtcRuntime.execute`)](../../../../packages/ptc-runtime/ptc-runtime-node/src/index.ts).

**Failure and correction.** Unloading the sandbox can revoke a live process's temporary-directory permission and remove its directory while the PTC consumer is still awaiting process termination. Final temporary-file access can fail, and removal can encounter a still-running process. Retain temporary capabilities through the admitted process lifetime, then revoke and remove them after actual process quiescence. Standing workspace grants intentionally remain; this finding concerns revocable temporary resources. Holder-owned shell processes also require process lifetime ownership, so merely ordering executor unload is insufficient.

A controlled reproduction used actual Cordis, the local sandbox provider, and real temporary directories with mocked Windows ACL operations. While an injected consumer's disposer was paused and provider disposal remained pending, the directory was already absent and its temporary grant revoked. This establishes provider release timing; the concrete PTC dependency is source-traced. Native Windows restricted-token access and live PTC termination were not exercised.

## Scope and existing decisions

The [persistent PTY decision](../../implemented/feature/2026-07-16-persistent-pty-sessions.md) remains active. Its early registration closure does not authorize removing observers required for quiescent teardown. Admission and optional notifications may stop first; completion dependencies must remain usable. This clarifies the scope of that teardown policy without replacing PTY ownership, rollback, or process-tree cleanup decisions.

Four independent directory scans covered core/session/jobs; execution, SSH, terminals, sandbox, subagents and workflow; host/client/API/boot/SDK/ACP/MCP/browser/computer packages and apps; and storage/schedule/credentials plus remaining provider groups. Candidate discovery used cleanup registrations, followed by consumer and resource-owner tracing. Surviving findings were rechecked against current master after refreshing the checkout. This is not an exhaustive semantic proof for every package.

The current AgentLoop composite retains projection registrations through ownership disposal, so the earlier projection candidate is excluded. Jobs cancellation already awaits settlement. Working-directory and title work revalidate cancellation after awaits. Projection-cache failures are explicitly fail-soft for rebuildable data; the inspected production telemetry consumer is on-demand. The Session history promotion candidate concerns admission after a drain snapshot, without an established prematurely released cleanup dependency, and is excluded from this focused rule.

The active-note supersession audit retains the handle-based persistence decision and logical-session storage proposal, cross-linked above: only graceful-shutdown tail retention overlaps, while their handle APIs, format, storage separation, and other rationale remain applicable. No implemented note is fully superseded by this proposal. The [Host schedule storage decision](../../implemented/architecture/2026-09-16-host-schedule-storage.md), [authorization flow decision](../../implemented/architecture/2026-08-13-credential-records-and-authorization-flows.md), and [account-login decision](../../implemented/architecture/2026-09-14-deepseek-account-login.md) remain active: independent task authority, fresh-commit evidence, and settlement of admitted commits are required. A preexisting configured record cannot stand in for evidence of this attempt's successful commit. The [Windows ACL sandbox decision](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) also remains active: temporary capabilities stay revocable, with final revocation ordered after the process lifetime. This proposal supplies the missing cross-owner teardown requirement.

## Alternatives considered

**Add injection or reverse disposer registration order.** Dependency withdrawal already waits for consumers, and reverse invocation still starts sibling async cleanup concurrently. Neither keeps resources usable across consumer awaits.

**Serialize every Cordis disposer globally.** This would change unrelated lifetimes, risk dependency deadlocks, and obscure which operations require each resource. Explicit composition expresses the necessary order locally.

**Catch closed-resource errors or rely on crash repair.** Suppressing errors cannot recover an unrouted result or a failed task commit, and can report a successful credential write as failed. Crash recovery remains useful after abrupt loss, not as a replacement for graceful completion.

**Wait for a broad storage or Session redesign.** The logical-session proposal may remove event-routing dependence, but the same lifetime rule also affects credentials and SSH. Each owner can establish the required order without waiting for all architectural stages.

## Acceptance criteria

- Each finding receives a controlled-promise regression that pauses the real consumer before its last dependency use, starts provider or enclosing-owner disposal, releases the pause, and awaits both operation and disposal. Verify required resources and listeners survive the pause and are released afterward.
- Session teardown persists the exact emitted final suffix, including tool results and closing events; compare live and restored history rather than checking only that `close()` ran. Cover provider replacement and root disposal, including cleanup failure paths.
- Schedule provider unload during the flush-to-task-commit interval retains successful final task state; restarting does not redeliver that completed occurrence. Keep the separately documented abrupt-crash duplication policy.
- Account consumer disposal during successful commit returns an outcome consistent with stored credentials. Credentials provider disposal drains an already-admitted queued commit and rejects new admission without cancelling that commit.
- SSH provider unload with live processes and PTYs completes dependent termination and confirmation before request resources close. Verify remote quiescence through the real helper; test failure propagation without claiming cleanup success from top-level process exit alone.
- Windows sandbox unload or replacement preserves the temporary grant and directory until a confined process finishes a delayed termination and final temporary write. Verify restricted-token access on native Windows, then assert grant revocation and directory removal.
- Update affected provider documentation and current owning decisions when fixes ship; preserve durable formats and add the required composition/snapshot coverage for any changed user-visible result.

## Risks

Incorrectly composed dependencies can deadlock shutdown or retain a resource indefinitely. Tests must release controlled pauses even after failures, and implementations must preserve existing bounded external-operation policies. Holding providers longer can increase shutdown latency; hiding cleanup failure or silently dropping required final writes is not an acceptable shortcut.

The focused experiments isolate storage, Authorization, composed SSH-provider teardown, and sandbox resource-release timing. They do not exercise complete product compositions or native Windows access. Session, Schedule consequences, queued credentials, actual remote process exit, and native sandbox behavior still need the integration evidence above before a fix can be considered complete. Listener ownership follows the actual caller context, so moving cleanup to a provider object without transferring its effect ownership may leave the race intact.
