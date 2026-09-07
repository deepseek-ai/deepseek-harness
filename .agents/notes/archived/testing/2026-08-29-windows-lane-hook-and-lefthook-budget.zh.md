# Agent Note: Windows 覆盖率 lane 的 hook 预算与 Lefthook 套件预算

Status: implemented
Archived: 2026-09-04

[English](2026-08-29-windows-lane-hook-and-lefthook-budget.md) | 中文

## 问题

两件事让 Windows 覆盖率 lane 在既没碰套件、也没碰 gate 的分支上持续失败。

[`scripts/install-lefthook.spec.ts`](../../../../scripts/install-lefthook.spec.ts) 在 `describe` 层取 `{ timeout: 30_000 }`，并以 `MULTI_PROCESS_TEST_TIMEOUT_MS` 常量的形式在其中五个用例上重复了同一个值。每个用例都会建临时 worktree 并通过 spawn 的 Git 与 Node 子进程驱动它，因此这个套件受进程创建约束，而不是受它的断言约束。在空闲的 macOS 主机上，它最慢的用例耗时 7.5 秒，也就是说这个上限只有约四倍余量——而 [translation-pairing-merge 套件](2026-08-27-translation-pairing-merge-budget.zh.md)在十倍以上余量的 15 秒上限下仍然触发。在自托管 Windows runner 数秒级的进程创建尖峰下，这个套件曾在没有改动它的分支上报出 `Test timed out in 30000ms`，而被观察到失败的两个用例正是它最慢的那个和第七慢的那个。

另一件事是 [`scripts/coverage-partitions.ts`](../../../../scripts/coverage-partitions.ts) 里的 `coverageTestTimeoutArgs`：它用 `DSH_COVERAGE_TEST_TIMEOUT_MS` 抬高了 `--testTimeout` 和 `--expect.poll.timeout`，却把 `--hookTimeout` 留在 Vitest 独立的 10 秒默认值上。setup 与 teardown 承受的是被抬高的测试预算所针对的同一种争抢：[`removeFixtureSafely`](../../../../scripts/test-fixture-cleanup.ts) 会在一个注释写明的 10 秒窗口内重试 Windows 句柄释放，因此一个真正用满该窗口的 `afterEach` 恰好撞上 hook 默认值。只抬高测试预算，只是把一个受争抢套件的失败从用例挪到它的 teardown，而不是消除它。

## 决定

Lefthook 套件取 `{ timeout: 90_000 }`，与 [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml) 里的 `DSH_COVERAGE_TEST_TIMEOUT_MS` 一致。逐用例常量被删除而不是被抬高：它只是重述了 `describe` 的取值，而 translation-pairing-merge 的 note 已经否决过逐用例余量——后续新增的用例若不带余量，就会静默继承另一个上限。

`coverageTestTimeoutArgs` 在原有两个参数旁边发出 `--hookTimeout`。一个环境变量管一份预算，覆盖受争抢的 lane 必须完成的工作，无论这份工作位于用例内还是位于它的 setup 与 teardown。

## 后果

共享卷 runner 上一次 `git` 或 `node` 的 spawn 尖峰不再决定这两个套件的结果，一次缓慢的 fixture teardown 也不再让一个用例全部通过的套件失败。两个取值都不是对「需要多久」的测量：Lefthook 套件最慢的用例在空闲主机上约 7.5 秒，而抬高上限不会让一次通过的运行变慢。

两份预算都放宽了「多长算可接受」，因此一个退化到几十秒的真实变慢现在会通过，而此前的上限会拦住它。这项检测能力是有意换掉的：那些上限触发的是宿主机争抢，不是回归。

hook 的改动在所有设置了 `DSH_COVERAGE_TEST_TIMEOUT_MS` 的地方生效：[ci.yml](../../../../.github/workflows/ci.yml) 的 Windows 覆盖率 lane，以及 [ci-master.yml](../../../../.github/workflows/ci-master.yml) 的 `serial-windows` master standby（[serial-windows notices 超时 note](../process/2026-08-31-serial-windows-notices-timeout-budget.zh.md) 记录了第二个 lane 的采用）。不设置它的 lane 保持全部 Vitest 默认值，包括 10 秒的 hook 预算。

## 备选方案

**给 `--hookTimeout` 单独一个环境变量。**两个旋钮描述宿主机的同一个属性，而只抬高其中一个的 lane 会以相反的方向复现同一个失败。

**改为缩短 `removeFixtureSafely` 的重试窗口。**这是用清理失败换共享自托管 `/tmp` 上的临时目录残留，而该残留已经两次耗尽宿主机的 inode 容量。

**只抬高 Lefthook 套件，保留 hook 默认值。**该套件的 `afterEach` 正是它 Windows `EPERM` 清理失败出现的位置，所以被抬高的用例预算只会把同一次运行改成以 hook 超时的形式暴露。
