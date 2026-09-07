# Agent Note: Windows coverage lane 的确定性断言与 dispose 预算

Status: implemented
Archived: 2026-09-04

[English](2026-08-31-windows-coverage-flaky-test-budgets.md) | 中文

## Problem

`windows node 24 / coverage` lane 不在 `all-checks-passed.needs` 里，是因为它不稳定，而不是它的结论不重要。不稳定来自一组对时序敏感的测试：在空闲 runner 上通过，在争抢的 runner 上失败。两种失败形态在多个 PR（3184、3185、3179、3181）反复出现，与触发它们的 PR diff 无关：

1. `packages/session/session-projection-cache/tests/cache.spec.ts` —— `SessionProjectionCache` 的写入是 fail-soft 且 fire-and-forget（事件监听器调 `void flushSoft(...)`，`coldSnapshot` 调 `void this.put(...)`）。六个测试在固定 `settle()` 40 ms 后断言持久化结果。争抢的 runner 上写入 40 ms 内没有排空，mock 断言以 `AssertionError: expected "Mock" to be called with arguments: [ StringContaining{…} ]` 失败（在 `expect(warn).toHaveBeenCalledWith(...)` 行），或 stored-row 断言读到陈旧 cut。这正是每次受影响 run 都失败的 cache.spec 两个用例。
2. `packages/sdk/client/tests/sdk-client.spec.ts` 与 `packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts` —— dispose 梯子测试启动真实子进程并传入紧的确认预算（`disposeGraceMs: 100`–`300`）。争抢的 runner 上 SIGKILL 后子进程的退出边缘可能晚于预算到达，于是 `close()` 以 `runtime process did not exit within 100ms after SIGKILL` reject，即使子进程已被正确回收。产品默认是 `disposeEofGraceMs: 6000` / `disposeGraceMs: 3000`；紧值是测试只为提速的选择，却把慢回收误报成 dispose 失败。

另有一个历史性的覆盖率缺口在 `packages/workflow/workflow-worker-thread`（host.ts/index.ts 低于 per-file 100% 门禁），曾被当作本 lane 不稳定的一部分跟踪。本次调查发现本机复现是 DSH 会话的环境假象而非代码缺陷：会话导出了指向 DSH staging checkout tsconfig 的 `TSX_TSCONFIG_PATH`，把 tsx-in-worker 对 workspace bare specifier 的解析重定向到 staging 副本并丢掉了 named exports。unset `TSX_TSCONFIG_PATH` 后 `workflow-worker-thread.spec.ts` 54/54 通过。Windows 侧对该缺口的报告早于 ReFS clone 安装（#3342），此后未再出现；任何复发都需要 Windows 侧逐行未覆盖清单才能归因。

## Decision

把 cache.spec.ts 里每个固定等待断言改成用 `vi.waitFor` 轮询可观察结果，超时 5 s（与该文件自 `7746ed64f0` 起在 cold-read write-back 用例中使用的模式一致）。两个 mock 断言用例轮询警告调用本身：

```ts ignore-check
await vi.waitFor(() => {
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn/end write for "fail-soft" failed'))
}, { timeout: 5_000 })
```

轮询断言在条件永远不成立时仍会失败——负例（不可能的字符串）超时并使测试失败——所以 fail-soft 契约仍被强制。

对 dispose 梯子测试，改用产品默认预算，去掉只属于测试的紧值：

- `sdk-client.spec.ts`：`disposeGraceMs` `100` → `3_000`（bounds-profile 用例）、`1_000` → `3_000`（SIGTERM 梯子）、`300` → `3_000`（SIGKILL 升级）。
- `subagent-dsh-sdk.spec.ts`：并发诊断隔离用例改用 `run.ts` 的 `DEFAULT_SHUTDOWN_TIMEOUT_MS` / `DEFAULT_DISPOSE_EOF_GRACE_MS` / `DEFAULT_DISPOSE_GRACE_MS`，而不是 `100`/`200`/`200`。

dispose.spec.ts 的负例（`disposeGraceMs: 10`，fake child 永不退出）仍验证真正卡住的子进程会在预算内使梯子失败；只有真实子进程用例的过紧预算被放宽。

## Verification

- cache.spec.ts：本地 17/17 通过；负例（不可能的警告字符串）经 `vi.waitFor` 超时失败。
- sdk-client.spec.ts：本地 42/42 通过；dispose.spec.ts 16/16 通过（10 ms refused/accepted 负例仍正确失败）。
- subagent-dsh-sdk.spec.ts：本地 55/55 通过。
- workflow-worker-thread.spec.ts：unset `TSX_TSCONFIG_PATH` 后本地 54/54 通过——历史覆盖率缺口未改代码。
- CI on this PR：windows coverage lane 应不再因这些测试失败。

## Alternatives considered

**保留固定 settle 窗口并重跑 flaky lane。** 重跑最终会通过，但每个受影响的 PR 都要付出一次重跑周期，lane 仍被排除在 `all-checks-passed.needs` 之外。轮询断言在写入及时时零成本，并完全消除时序依赖，与该文件自 `7746ed64f0` 起已有的 `vi.waitFor` 模式一致。

**保留紧 dispose 预算并把 SIGKILL 超时当作 runner 故障。** 真正卡住的子进程仍必须让梯子失败——dispose.spec.ts 的 fake-child 负例已用 10 ms 覆盖。真实子进程用例放宽到产品默认，因为它们测的是梯子的升级路径而不是性能上限，争抢 runner 上的退出边缘不是代码缺陷。

## Consequences

windows coverage lane 保留 per-file 100% 门禁，而其测试不再依赖 40 ms 墙钟窗口或 100–300 ms 的 SIGKILL 确认。cache.spec 两个 mock 断言用例与 subagent-dsh-sdk 并发用例在 runner 争抢下不再失败，lane 的 flake 率下降而不削弱任何断言：每个轮询条件超时仍失败，每个 dispose 负例仍约束卡住的子进程。
