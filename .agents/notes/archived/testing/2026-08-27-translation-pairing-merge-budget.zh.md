# Agent Note: translation-pairing-merge 套件的 coverage lane 预算

Status: implemented
Archived: 2026-09-04

[English](2026-08-27-translation-pairing-merge-budget.md) | 中文

## 问题

[`scripts/translation-pairing-merge.spec.ts`](../../../../scripts/translation-pairing-merge.spec.ts) 在 `describe` 层加了 `{ timeout: 15_000 }`。它的 23 个用例全部继承这个值，没有任何一个自带余量。

每个用例都会建一个临时仓库并通过 spawn 的 `git` 驱动它，因此这个套件受进程创建约束，而不是受它的断言约束。在自托管 Windows runner 上所有实例共用一个卷，而那里的进程创建表现为偶发的数秒尖峰，不是均匀变慢。在那种争抢下，这个套件曾在一个没有改动该文件的分支上报出 `Test timed out in 15000ms`，也就是说决定结果的是预算而不是被测改动。

## 决定

套件取 `{ timeout: 90_000 }`，与 [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml) 里的 `DSH_COVERAGE_TEST_TIMEOUT_MS` 一致，Windows 覆盖率 lane 把它作为 `--testTimeout` 传入。

`describe` 层的取值优先于那个 flag，而不是让位于它。所以更小的值会压低 lane 已经给出的预算；又因为这里没有任何用例自带余量，23 个用例全部被限制在 15 秒，而 lane 提供的是 90 秒。

## 后果

套件能容忍共享卷 runner 上一次数秒的 `git` spawn 尖峰，并让位于 coverage lane 提供的预算。这个值不是对「这些用例需要多久」的测量：最慢的三个用例视主机而定约为 0.7–1.2 秒，而抬高上限不会让一次通过的运行变慢。

抬高上限不会削弱断言：把预算抬到六倍之后，套件仍然通过它自己的断言失败而不是通过超时失败，因为上限只决定何时停止等待。但它确实放宽了「多长算可接受」——一个从几百毫秒退化到几十秒的真实变慢现在会通过，而此前的 15 秒会拦住它。这项检测能力是有意换掉的：15 秒上限触发的是争抢而不是回归，所以它拦住的是共享卷，不是代码。

## 备选方案

**给整个 unit lane 抬高 `testTimeout`。** 那会为了修一个成本特定于 spawn `git` 的套件而改变仓库里的每一个套件。

**给每个用例各自加余量。** 23 个分散的取值重复表达同一个机器属性，而后续新增的用例若没写，又会静默继承较低的上限。

**保留取值、失败时重跑。** 重跑只是把失败挪到另一个用例或另一次运行，同时留下一个不携带被测代码信息的红灯。
