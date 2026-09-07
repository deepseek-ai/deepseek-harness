# Agent Note: Subagent teardown tests inherit their execution lane budgets

Status: implemented

English | [中文](2026-09-07-subagent-teardown-test-budgets.zh.md)

## Problem

The [Windows coverage run](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34085536250/job/101628739668) reports two teardown failures despite granting tests and hooks 90 seconds. The ACP ignored-EOF test races disposal against its own five-second timer. The real Codex test overrides the hook budget with 30 seconds. Neither deadline tests a product latency guarantee. The Codex body has already observed process-tree exit before its hook fails; the log does not identify whether context disposal, HTTP closure, or temporary-directory removal exceeded the hook budget.

## Decision

The [ACP test](../../../../packages/subagent/subagent-acp/tests/subagent-acp.spec.ts) awaits disposal under the execution lane’s test budget, then checks the actual child outcome. Failure cleanup awaits disposal and child completion before removing the private directory. A deferred exit observation proves that disposal cannot finish merely because termination was requested. The production EOF and termination grace periods remain unchanged.

The [Codex test](../../../../packages/subagent/subagent-codex/tests/real-product.spec.ts) inherits the execution lane’s hook budget. Cleanup captures its contexts, HTTP fixtures, and temporary roots before its first asynchronous wait, so an overdue hook cannot drain resources registered by another test. It preserves context-disposal, server-closure, and directory-removal ordering, waits for every captured disposer, and attempts the remaining cleanup stages after a rejection. Collected errors identify each failing stage or path and retain their causes; cleanup reports them only after all captured resources have been attempted.

The [native Windows CI decision](../process/2026-08-08-native-windows-pull-request-ci.md) continues to own lane scheduling and budgets. This change only removes conflicting local deadlines and strengthens resource-lifetime assertions; it does not establish a Windows process-kill or filesystem defect.

## Alternatives considered

- Increase production grace periods or filesystem retries: the failures do not demonstrate incorrect product timing or exhausted removal retries.
- Replace local deadlines with larger constants: that would still override future lane budgets.
- Return from cleanup immediately after requesting termination: that would permit children or sockets to outlive the fixture.
- Serialize coverage: unrelated tests need not lose concurrency to accommodate two local deadline overrides.

## Consequences

The lane timeout remains a bound on hangs. Focused tests verify observed child completion and cleanup ownership instead of host termination speed. Native Windows runs remain necessary for taskkill, process-exit delivery, and NTFS removal evidence; passing macOS tests cannot prove those mechanisms. No model-visible output, Session fixture, production timeout, or CI routing changes.
