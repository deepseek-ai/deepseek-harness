# Agent Note: deterministic assertions and dispose budgets for the Windows coverage lane

Status: implemented

English | [中文](2026-08-31-windows-coverage-flaky-test-budgets.zh.md)

## Problem

The `windows node 24 / coverage` lane is excluded from `all-checks-passed.needs` because it is unstable, not because its verdict is unimportant. The instability is a set of timing-sensitive tests that pass on a quiet runner and fail on a contended one. Two failure shapes recur across many PRs (3184, 3185, 3179, 3181) and are unrelated to the PR diffs that trigger them:

1. `packages/session/session-projection-cache/tests/cache.spec.ts` — `SessionProjectionCache` writes are fail-soft and fire-and-forget (the event listener calls `void flushSoft(...)`, `coldSnapshot` calls `void this.put(...)`). Six tests asserted the durable outcome after a fixed `settle()` of 40 ms. On a contended runner the write does not drain within 40 ms, so the mock assertion fails with `AssertionError: expected "Mock" to be called with arguments: [ StringContaining{…} ]` at the `expect(warn).toHaveBeenCalledWith(...)` lines, or the stored-row assertion reads a stale cut. These are the two cache.spec cases that fail on every affected run.
2. `packages/sdk/client/tests/sdk-client.spec.ts` and `packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts` — dispose ladder tests launch a real child process and pass tight confirmation budgets (`disposeGraceMs: 100`–`300`). On a contended runner the child's exit edge after SIGKILL can arrive after the budget, so `close()` rejects with `runtime process did not exit within 100ms after SIGKILL` even though the child was reaped correctly. The product defaults are `disposeEofGraceMs: 6000` / `disposeGraceMs: 3000`; the tight values were test-only speed choices that misreport slow reaps as dispose failures.

A separate, historical coverage gap in `packages/workflow/workflow-worker-thread` (host.ts/index.ts below the per-file 100% gate) was tracked as part of this lane's instability. Investigation in this change found that the local reproduction was a DSH-session environment artifact, not a code defect: the session exports `TSX_TSCONFIG_PATH` pointing at the DSH staging checkout's tsconfig, which redirects the tsx-in-worker resolution of workspace bare specifiers to the staging copy and drops their named exports. With `TSX_TSCONFIG_PATH` unset, `workflow-worker-thread.spec.ts` passes 54/54. The Windows-side reports of that gap predate the ReFS clone install (#3342) and have not recurred since; any recurrence needs Windows-side per-line uncovered lists before it can be attributed.

## Decision

Replace every fixed-wait assertion in cache.spec.ts with `vi.waitFor` polling of the observable outcome, with a 5 s timeout (the same pattern the file already used for the cold-read write-back cases since `7746ed64f0`). The two mock-assertion cases poll for the warning call itself:

```ts ignore-check
await vi.waitFor(() => {
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn/end write for "fail-soft" failed'))
}, { timeout: 5_000 })
```

The polling assertion still fails when the condition never becomes true — the negative case (an impossible string) times out and fails the test — so the fail-soft contract stays enforced.

For the dispose-ladder tests, pass the product-default budgets instead of the tight test-only values:

- `sdk-client.spec.ts`: `disposeGraceMs` `100` → `3_000` (bounds-profile case), `1_000` → `3_000` (SIGTERM ladder), `300` → `3_000` (SIGKILL escalation).
- `subagent-dsh-sdk.spec.ts`: the concurrent diagnostic-isolation case uses `DEFAULT_SHUTDOWN_TIMEOUT_MS` / `DEFAULT_DISPOSE_EOF_GRACE_MS` / `DEFAULT_DISPOSE_GRACE_MS` from `run.ts` instead of `100`/`200`/`200`.

The dispose.spec.ts negative cases (`disposeGraceMs: 10` with a fake child that never exits) still verify that a truly stuck child fails the ladder within its budget; only the real-child tests with overly tight budgets were widened.

## Verification

- cache.spec.ts: 17/17 pass locally; negative case (impossible warning string) fails via the `vi.waitFor` timeout.
- sdk-client.spec.ts: 42/42 pass locally; dispose.spec.ts 16/16 pass (the 10 ms refused/accepted negative cases still fail correctly).
- subagent-dsh-sdk.spec.ts: 55/55 pass locally.
- workflow-worker-thread.spec.ts: 54/54 pass locally with `TSX_TSCONFIG_PATH` unset — no code change made for the historical coverage gap.
- CI on this PR: the windows coverage lane should stop failing on these tests.

## Alternatives considered

**Keep the fixed settle windows and rerun flaky lanes.** Reruns eventually pass, but every affected PR pays a re-run cycle and the lane stays excluded from `all-checks-passed.needs`. The polled assertion costs nothing when the write is prompt and removes the timing dependency entirely, matching the file's existing `vi.waitFor` pattern from `7746ed64f0`.

**Keep the tight dispose budgets and treat SIGKILL timeouts as runner faults.** A truly stuck child must still fail the ladder, which the fake-child negative cases in dispose.spec.ts already cover at 10 ms. The real-child cases were widened to the product defaults because they measure the ladder's escalation, not a performance bound, and a contended runner's exit edge is not a code defect.

## Consequences

The windows coverage lane keeps its per-file 100% gate while its tests no longer depend on a 40 ms wall-clock window or a 100–300 ms SIGKILL confirmation. The two cache.spec mock-assertion cases and the concurrent subagent-dsh-sdk case stop failing under runner contention, so the lane's flake rate drops without weakening any assertion: every polled condition still fails on timeout, and every dispose negative case still bounds a stuck child.
