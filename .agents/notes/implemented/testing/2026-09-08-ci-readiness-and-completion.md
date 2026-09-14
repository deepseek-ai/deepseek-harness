# Agent Note: CI assertions wait for owned completion

Status: implemented

English | [中文](2026-09-08-ci-readiness-and-completion.zh.md)

## Problem

The empty master PR run (run 34206953049) fails while waiting one second for webhook Session creation and five seconds for PowerShell output. Neither test measures a startup latency guarantee. A separate run (run 34207864157) shows the same short-budget problem in a desktop worker readiness test and captures a feedback acknowledgement while the composer still holds the submitted command.

Another Windows coverage run (run 34224004885, job 102053583437) reports a null publint child status and an LSP initialization-marker timeout. Their helpers impose five- and three-second limits inside the lane's 90-second test budget. These cases verify publication contents and cancellation behavior rather than cold-start latency.

The ACP coverage run (run 34242280527, job 102115221228) exhausts a one-second registry poll after transport failure. Disconnect cleanup includes cancellation, output draining, persistence, and owner disposal; registry removal alone does not establish complete teardown.

A worker-runtime coverage failure (run 34248221544, job 102135631932) exhausts the slow-binding fixture's one-second compute allowance. Concurrent native Windows reproductions exceed that allowance before calling the binding. Worker initialization contributes measured active time; the delayed binding contributes idle time.

The Windows coverage run (run 34324325375, job 102377982193) reports an SDK subprocess exit beyond a fixture's 200 ms confirmation window and an Inspector Worker startup beyond its ten-second default. Neither the protocol-error routing case nor the Cordis tree projection case measures those latency guarantees.

## Decision

The [webhook browser test](../../../../apps/web/tests/github-ready-review.e2e.ts) observes the model request caused by delivery before checking Session registration. The [feedback test](../../../../apps/web/tests/feedback-command.e2e.ts) waits for the empty composer and enabled attachment control before comparing ARIA output. Matching consecutive snapshots cannot prove that the command RPC has settled: its event stream can publish the acknowledgement first.

The [desktop transaction test](../../../../apps/desktop/tests/project-manager.spec.ts) gives the worker readiness marker the active test's execution budget. Its independent `afterEach` releases and awaits workers before deleting private roots, including when the runner abandons a timed-out test body. The poll observes runner cancellation, and teardown reports transaction failures independently from assertion failures. The [PowerShell tests](../../../../packages/shell/pwsh-local/tests/executor.spec.ts) register each helper-created Context before plugin initialization and dispose those Contexts before deleting temporary directories. The background-input case awaits process completion before checking complete output, completed status, and exit code. Consuming reads remain covered by their separate streaming tests.

The [publint runner tests](../../../../scripts/publint-all.spec.ts) pass the active test budget to their child and check launch errors and termination signals before interpreting its exit code. The [LSP instance test](../../../../packages/lsp/lsp-stdio/tests/instance.spec.ts) uses the same budget for its fixture marker, observes the actual pending `didOpen` write before aborting, and captures the query's rejection before waiting for readiness. Its [server fixture](../../../../packages/lsp/lsp-stdio/tests/fixture-server.ts) publishes the marker after pausing stdin. Teardown captures the instance list, Context, and directory before its first await.

The [ACP disconnect tests](../../../../packages/acp/acp/tests/dispose.spec.ts) await the real session handle disposer for both EOF and transport failure. A barrier holds disposal pending while the test checks ownership, then releases it before awaiting completion and checking both registries. Neither case invokes plugin disposal to trigger the behavior under test. The independent teardown hook releases the barrier before disposing the captured Context, including when the test body times out.

The [subagent teardown decision](2026-09-07-subagent-teardown-test-budgets.md) owns lifecycle cleanup budgets. The [persistent PowerShell decision](2026-09-07-pwsh-ci-observable-completion.md) owns exact versus inferred terminal readiness; a one-shot process's completion promise has different semantics.

The [sandboxed Node decision](../architecture/2026-09-11-sandboxed-node-ptc-runtime.md) supersedes worker active-time accounting. The [Node runtime suite](../../../../packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts) exercises the replacement elapsed deadline through real managed processes. The other completion observations and fixture lifecycle rules in this note remain in force.

The [SDK subagent protocol-error test](../../../../packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts) uses the provider's normal shutdown and exit grace periods and registers disposal before its assertions. The [Inspector tree tests](../../../../packages/experimental/inspector/tests/cordis-tree.host.spec.ts) pass the active test budget to Worker startup and register cleanup while startup is still pending. A cancelled test cannot receive a late-ready handle; cleanup awaits initialization and closes a successfully started Worker. Failed initialization already terminates the Worker before rejecting. A controlled late-start test verifies cancellation and closure through the real Worker's HTTP endpoint. Production defaults remain unchanged.

## Alternatives considered

**Larger independent waits.** Rejected where a completion promise already exists. A separate polling deadline continues to compete with the execution lane's budget.

**Refresh the feedback golden.** Rejected: the populated composer and disabled attachment control describe an in-flight submission. The settled expected UI remains the intended behavior.

**Serialize CI or retry these tests.** Rejected: neither establishes the missing completion condition or releases a blocked child after assertion failure.

## Consequences

Readiness and output assertions preserve their original content and ownership checks. Controlled desktop readiness, webhook preflight, command-response, PowerShell output, publint startup, and LSP initialization delays reproduce the original failures and pass with the completion waits. A stalled desktop-worker control still reports a test timeout while proving that teardown drains the child before removing its directory. The execution lane bounds test bodies and cleanup hooks separately; native Windows execution remains necessary to verify PowerShell and process cleanup there.
