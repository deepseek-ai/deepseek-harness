# Agent Note: Reuse the PTC Node sandbox for workflows

Status: implemented

English | [中文](2026-09-13-workflow-ptc-sandbox-reuse.zh.md)

## Problem

Dynamic workflows evaluate model-written JavaScript and start subagents. A worker thread keeps script execution off the host event loop, but code escaping its VM can use Node with the host process's file authority. PTC already owns a Node process implementation with OS file confinement, isolated program state, bounded output and control traffic, and managed cleanup. Maintaining a second launcher would duplicate those responsibilities.

## Decision

`dsh-workflow-ptc` implements `WorkflowEngine` through the shared Node `PtcRuntime`. Each run keeps the existing VM and workflow helpers inside one PTC process. Host bindings connect the guest to the configured subagent provider and workflow observers; the host supplies the calling Agent and resolves its Session's standing file policy and cwd.

The VM defines the helper API and cooperative concurrency, total-agent and item caps. It is not a security boundary, and those counters are not host-enforced security quotas. File enforcement, V8 heap limits, output and control limits, and managed process cleanup remain owned by PTC and its sandbox/subprocess providers. Network access and provider-specific containment limits remain the same as PTC.

Workflow execution passes `timeoutMs: null`, which explicitly disables the elapsed timer in the Node runtime. Omitted and numeric PTC requests keep their configured defaults and caps; `run_code` continues to accept only positive numeric overrides. The initial VM slice retains its own synchronous timeout. A caller's abort signal, including an enclosing tool deadline, still cancels the workflow.

Cancellation immediately aborts the PTC process and the signal shared by pending and active child agents. The adapter awaits pending starts and child disposal, including a child that publishes after cancellation. PTC stops the program; its caller remains responsible for host bindings already in flight. There is no additional workflow cleanup timer or guest cancellation acknowledgement.

Progress uses one binding call at a time. The first batch starts synchronously; later events queue in order and drain before child disposal and the final result. This prevents ordinary log bursts from exhausting PTC's pending-call limit. Child-result waits stop on cancellation while child disposal remains awaited.

The Node bootstrap keeps its control pipe open after sending the terminal frame until the host closes it. Unawaited binding replies may still be in flight, so eager child-side close would let an `EPIPE` race an already completed program.

The [dynamic-workflows decision](../feature/2026-07-05-dynamic-workflows.md) retains the script, structured-output, event and tool semantics; this note supersedes only its execution substrate and trust realization. The [sandboxed Node PTC decision](2026-09-11-sandboxed-node-ptc-runtime.md) retains execution and control guarantees; the explicit null deadline extends its service options. The [agent-scope runtime design](2026-07-12-agent-scope-runtime-design.md#workflow-children-are-pending-starts-or-published-records) retains pending-start and child-cleanup ownership.

## Alternatives considered

**Retain worker-thread execution.** Worker termination cannot apply the Session's OS file policy or provide the managed process cleanup already required by direct Node code.

**Create a separate workflow subprocess runtime.** Another launcher, control transport and sandbox adapter would maintain the same execution responsibilities twice. PTC already accepts programs and named asynchronous host bindings without knowing about tools or Sessions.

**Replace the VM with direct Node workflow APIs.** The VM and helpers preserve the existing script semantics, synchronous-slice timeout and JSON materialization. Removing them is unnecessary for OS confinement.

**Apply PTC's numeric deadline to workflows.** A workflow may await a long series of subagents. Explicit `null` preserves caller-controlled lifetime without changing ordinary PTC defaults or treating an arbitrarily large number as no deadline.

## Consequences

Workflow and opt-in Ralph execution share PTC's security and process lifecycle implementation. Ralph remains disabled in shipped defaults. Scripts still use the same hooks and result envelope; no new authoritative progress ledger or host child-count quota is introduced.

Cancellation does not wait for cooperative script progress. The adapter waits for child cleanup, so a subagent provider that does not fulfill its lifecycle contract can delay disposal. Process cleanup retains the selected subprocess provider's managed-range limitations; this change does not claim process-tree CPU/RSS accounting or universal descendant termination.
