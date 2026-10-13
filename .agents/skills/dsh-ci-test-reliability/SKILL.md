---
name: dsh-ci-test-reliability
description: Design, review, and diagnose DeepSeek Harness tests and fixtures that can fail nondeterministically under CI concurrency, shared host resources, clocks, process-global state, subprocesses, network listeners, or asynchronous teardown. Use when adding or changing tests with those risks, investigating flaky CI, or reviewing test isolation; use dsh-pre-push-checks separately to select outgoing commands.
---

# Reliable DSH CI tests

Build tests that remain correct under the repository's real CI topology, not only when run alone on a quiet workstation. This skill owns isolation and reliability decisions; it does not replace the repository's test-tier policy or select every command for a push.

## Read the owning rules

- Use [the testing policy](../../../docs/testing.md) to select unit, coverage, expected-output, snapshot, browser, or real-API evidence.
- Use [the defensive patterns](../../../docs/defensive-patterns/general.md) for lifecycle, subprocess, cancellation, and teardown behavior.
- Read the active Vitest config and GitHub workflow when their worker or job topology affects the test.
- For recorded-session scenarios, also follow [the snapshot instructions](../../../snapshots/AGENTS.md).
- Use [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) after the test design is sound to select outgoing validation.

## Model the execution topology

Assume these layers can overlap unless the active configuration proves otherwise:

1. Tests in one Vitest file.
2. Separate Vitest files or worker processes.
3. Independent Vitest or repository-gate processes in one job.
4. Different Actions jobs whose runners share one host.

Process isolation does not isolate host ports, predictable filesystem paths, external services, databases, sockets, or inherited child processes. For every acquired resource, identify its owner, atomic allocation mechanism, observable readiness signal, registered cleanup, and quiescent completion signal.

Do not serialize an entire suite merely because one fixture lacks isolation. Narrow the exclusive scope or change the resource allocation first. A sequential Vitest block cannot protect a host resource from another file, process, job, or runner.

## Allocate resources atomically

Use the resource owner's allocator instead of checking availability and claiming it later.

- Network fixtures bind loopback with `listen(0)` and read the assigned address only after the server reports that it is listening. Never scan for a free port and bind it later.
- Create private per-test temporary roots with `mkdtemp`; do not acquire predictable shared paths.
- Give shared databases, sockets, sessions, and output locations unique per-test namespaces.
- Use exclusive creation where a path must not already exist.
- Keep stable recorded identifiers separate from ephemeral transport addresses. Translate inside the fixture instead of forcing the live resource to use the recorded value.

Literal paths and URLs used only as parser inputs or expected values are not acquired resources. Do not rewrite them merely because they look fixed.

## Contain process-global state

Treat `process.env`, `cwd`, fake timers, locale and timezone, module mocks, registries, console hooks, `globalThis`, and global `fetch` interception as exclusive mutable resources.

Prefer an injected dependency or instance-local adapter. When mutation is required:

- capture whether the original value was absent or present;
- restore that exact state;
- register restoration immediately;
- use `try/finally` around the smallest mutation scope;
- keep an `afterEach` fallback when failure before the local `finally` is plausible;
- intercept the narrowest exact request or call that the fixture owns.

## Respect platform-owned semantics

CI runs the same suite on Windows and on POSIX hosts, and a value the operating system owns does not always come back the way a test wrote it.

- Writing a value back is safe only when the assertion tolerates the write-back failing. Restoring a file's `mtime` to prove that a fingerprint invalidates anyway holds everywhere; restoring it to prove that a record stays valid assumes a lossless round trip, which NTFS's 100-nanosecond ticks do not give a fractional millisecond. When the assertion depends on the restoration, take the expected value from a fresh read rather than from the remembered one.
- Windows matches environment variable names case-insensitively, so a fixture seeding `http_proxy` and `HTTP_PROXY` as separate keys holds one entry there.
- Windows releases file handles asynchronously, so a rename or removal that completes at once on a POSIX host needs a bounded retry sized to the observed contention.
- Windows has no POSIX permission or signal semantics. A case that depends on them takes an explicit platform skip naming the reason, rather than an assertion weakened everywhere.

Prefer an observation that holds on every platform. When a case genuinely cannot, exclude it on that platform explicitly.

## Budget timeouts against the lane

A `describe` or case timeout overrides the runner's `--testTimeout` instead of yielding to it, so a value below the lane's budget lowers what CI already granted — and the same literal reads as a widening on a host whose default is smaller. A suite bound by process creation takes the lane budget; a tighter value carries the reason it is tighter.

Raise the hook budget with the test budget. Setup and teardown pay the same contention, so lifting only the case budget moves a contended failure into `afterEach`.

Where a timeout is the subject, keep the outer wait far larger than the timeout under test. A case proving that a 20 ms deadline fires must not race the harness's own wait, or load decides which deadline reports first.

## Synchronize on state

A fixed sleep is not evidence that setup completed or cleanup settled.

- Wait for an explicit readiness event, handshake, state transition, owned promise, or externally observable condition.
- Use deferred promises or barriers to place a race at a deterministic point and prove the relevant operations overlap.
- Use a timeout only to bound a wait, never as the condition that makes the assertion correct.
- Do not assert scheduler-dependent ordering unless that ordering is the product behavior under test.
- When time itself is the subject, inject or fake the clock and always restore real timers.

## Dispose to quiescence

Register cleanup immediately after acquisition so assertion failures also release the resource. Cleanup stops new callbacks or requests, detaches listeners, restores global hooks, terminates owned work, and awaits child exit, server close, worker termination, or the equivalent completion signal.

Calling `abort()`, `close()`, or `kill()` without awaiting the owned completion signal is incomplete teardown. When late completion is possible, prove that disposal prevents it from mutating another test.

## Prove the intended regression

- Observe an ordinary regression fail before the fix when practical.
- For a new static or corpus guard, temporarily introduce the rejected case and observe the intended failure.
- For a race, use barriers to prove overlap; repeated execution alone is not a race test.
- For ports, sockets, shared paths, subprocesses, or other host resources, run independent test processes concurrently when cross-process isolation is part of the fix.
- Where a fixture spawns with its own deadline, assert that no signal or timeout ended the child before asserting its exit status, so a killed child reports as a timeout instead of as a status mismatch.
- Verify external state, events, files, logs, exits, or disposal instead of trusting the component's self-report.

Stress runs supplement a deterministic regression; they do not replace one.

## Reject flake-masking fixes

Do not present these as root-cause fixes for deterministic local tests:

- increasing a timeout without identifying the awaited state;
- adding retries;
- making all files serial;
- swallowing an error or unhandled rejection;
- weakening an assertion;
- normalizing away unstable behavior;
- adding a sleep before cleanup or assertion.

Retries remain valid for documented transient external-provider tests under the real-API policy. Keep that exception at the external boundary.

Restoring a budget is not masking. Raising a suite to the lane budget it already had, or sizing a bounded retry to the contention actually measured on the runner, names the awaited work and returns what the lane granted; neither invents headroom around an unexamined wait.

## Diagnose existing flakes

For an existing probabilistic CI failure, read [the CI flake diagnosis workflow](references/ci-flake-diagnosis.md). A diagnosis-only request remains read-only: report the cause and evidence unless the user also asks for a fix.

## Validate and report

Run the smallest focused regression for the affected behavior. Add topology-specific evidence only when the change owns that risk:

- global mutation needs restoration evidence;
- lifecycle or subprocess work needs quiescent teardown evidence;
- ports, sockets, or shared paths need concurrent independent-process evidence;
- a new guard needs a negative control.

Before a push, use [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md). Report exact commands and observed results; do not describe retries, skipped tests, or pending CI as passing.
