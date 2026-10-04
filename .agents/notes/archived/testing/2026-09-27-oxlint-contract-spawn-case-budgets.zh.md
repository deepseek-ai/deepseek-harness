# Agent Note: 会 spawn 进程的 Oxlint 契约用例携带 90 s 上限

Status: implemented
Archived: 2026-09-30

[English](2026-09-27-oxlint-contract-spawn-case-budgets.md) | 中文

## 问题

[`scripts/oxlint-contract.spec.ts`](../../../../scripts/oxlint-contract.spec.ts) 的 14 个用例中有 12 个会启动真实子进程：`runOxlint` 启动 oxlint CLI，`runRepositoryOxlint` 在 tsx 下引导 [`scripts/run-oxlint.ts`](../../../../scripts/run-oxlint.ts)，后者运行 oxlint，并在 `--fix` 之后再运行一次。根 `vitest.config.ts` 没有设置 `testTimeout`，因此没有自带预算的用例继承 Vitest 的 5000 ms 默认值；coverage 通道通过 `DSH_COVERAGE_TEST_TIMEOUT_MS=90000` 抬高它，Windows 原生通道传入 `--testTimeout 90000`，而 `sandbox.yml` 中的 `unit tests (darwin parity, macos-latest)` job 与开发者本机的 `pnpm run test` 都直接运行。7 个用例（5 个 `it` 声明，其中一个是三路 `it.each`）携带 #3115 把有争抢的 Windows spawn 预算对齐到的显式 `90_000`；另外 7 个跑在默认值上，其中 5 个会 spawn。两类 runner 暴露了这一点：自托管 Windows 池，其进程创建会出现数秒尖峰（#2581）；以及 Sandbox run 36332053320 的托管 macos-latest runner，它跑整个文件比通过的 run 36320394290 慢 2.2 倍，并让 `prints only the final diagnostics when a fix retry still fails` 在 6309 ms 时超时，而该用例在通过的 run 中耗时 1122 ms。`Test timed out in 5000ms` 既不指出契约违规，也不指出超时的那次 spawn。

## 决策

文件中每个会 spawn oxlint 或仓库 lint 入口的用例都携带同一个显式的用例级 `90_000` 上限。两个只检查配置的用例 `keeps the complete stylistic contract in Oxlint` 与 `keeps repository lint workflows Oxlint-only` 不 spawn 任何进程，保持默认值。该值是针对挂起的完成上限，不是延迟目标：慢 darwin runner 上最慢的用例耗时 9507 ms，12 核宿主机上六倍 CPU 超订下整个文件的峰值为 20767 ms，两者都不到上限的四分之一。断言、不加重试、以及 Vitest 全局 `testTimeout` 均不变。

## 曾考虑的替代方案

**`describe` 级 `{ timeout: 90_000 }`。** 拒绝：用例级取值已经约束 7 个用例并且优先于 `describe` 级取值，因此套件级数字只会作用于其余 7 个用例，包括两个不 spawn 的纯配置用例，而且文件会同时带两种预算风格。用例级取值保持一种风格，每个用例的上限只在一处可读，不 spawn 的用例保持默认值。两种形式都覆盖通道的 `--testTimeout` 而不是让位于它（#2677）。已归档的 [translation-pairing-merge](../../archived/testing/2026-08-27-translation-pairing-merge-budget.md) 与 [Lefthook 预算](../../archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md)两篇 Note 为用例本身不带常量的文件选择了 `describe` 形式，理由是之后新增而未带余量的用例会继承默认值；本文件已经带有用例级常量，因此这里接受该风险并在「后果」中点名。

**给 darwin parity job 传入 `--testTimeout 90000`，让用例继承通道预算**，这是 [CI 测试可靠性工作流](../../../skills/dsh-ci-test-reliability/SKILL.md#budget-timeouts-against-the-lane)对进程创建受限套件偏好的形式。拒绝：成本来自本文件自身的 tsx 引导加两次 oxlint 运行，不是 darwin 的属性，因此开发者直接运行的 `pnpm run test` 仍会停留在默认值；parity job 的存在意义就是运行与开发者相同的命令；而且 7 个用例已带常量，通道旗标会把本文件的预算拆到两个来源。

**抬高 Vitest 全局 `testTimeout`。** 拒绝：整个单元测试清单都跑在默认值上；为吸收一个文件的进程 spawn 而放宽它，会移除默认值在其他所有地方提供的挂起检测。

**按观测到的 6.3 s 收紧取值。** 拒绝：Windows 争抢表现为数秒尖峰，在对齐到 90 s 之前曾在 15–30 s 预算下于各用例间轮转出现；更小的数字只是移动 flake 而不是消除它。

## 后果

契约违规仍通过其自身断言在上限之内早早失败；本次加边界的 5 个用例在空载宿主机上 0.5–1.7 s 内结算，文件中任何会 spawn 的用例在那里都不超过 3.8 s，因此只有真正的挂起才会等满 90 s。Windows 自托管通道、Linux coverage 通道、darwin parity job 与本机 `pnpm run test` 对本文件读到同一个上限，与 `DSH_COVERAGE_TEST_TIMEOUT_MS` 无关。之后新增而未自带 `90_000` 的 spawn 用例会跑在默认值上，直到有人核对本文件的清单。在 12 核宿主机上以 72 个忙循环进程加载时，原本无边界的 fix-retry 用例在改动前于 7084 ms 复现 `Test timed out in 5000ms`，改动后在上限内通过。
