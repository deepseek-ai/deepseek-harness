# Agent Note: 双发布安装布局的工作量预算

Status: implemented

[English](2026-09-28-dual-release-install-layout-work-budget.md) | 中文

## Problem

`Dependency layout` lane 把两个互不兼容的合成 DSH 发布打进临时消费者目录，对它们跑一次真实 npm 解析，并断言 npm 选定的物理摆放。它用 npm 子进程上的 `TIMEOUT_MS = 300_000` 判定通过或失败。这个期限度量的是 runner，而不是图：同一张图在空闲开发机上用 137–205 秒解析完成，在 CI runner 上用 288.59 秒，比期限低 4%，而摆放断言没有报告任何错误。诊断信息只给出耗时，因此 runner 慢和依赖图变大无法区分。

## Decision

`scripts/verify-npm-install-layout.ts` 用 `assertResolutionWorkBudget` 判定规模增长，它以 `dshPackagesPerVersion * checkedDshEdges` 为工作量单位，与 `MAX_RESOLUTION_WORK_UNITS = 875_000` 比较。两个计数都来自 `assertDualDshInstallLayout` 返回的汇总，因此预算作用于 npm 实际产出的图，而不是对图的预测。超过预算的图会带着自己的计数、预算值，以及「测量新的解析开销并调高该常量」的指示失败。

npm 子进程仍保留墙钟上限 `NPM_HANG_GUARD_MS`，由 `4 * MAX_RESOLUTION_WORK_UNITS * SECONDS_PER_WORK_UNIT` 推导（910 秒）。它是挂起保护，不是增长判据：比实测主机慢四倍以内的 runner 无法决定该门禁的结果，而由预算推导可避免两个数值彼此漂移。

这恢复了[发布依赖门面](2026-08-26-published-dependency-faces.zh.md)中「`verify-npm-install-layout` 不限制 resolver 耗时」的决定；300 秒期限与该决定相矛盾。

## What the resolution costs

2026-09-28 在空闲的 M 系列主机上，针对 `origin/master`（每个发布 277 个 DSH 包、2524 条内部边），用 `--timing` 和 `--cpu-prof` 运行 lane 自身的 npm 调用测得：

| 阶段 | 开销 |
|---|---|
| Registry 合成（`buildRegistryIndex`，3952 个已安装 manifest 加 319 个 DSH workspace manifest，合成 1544 个包名） | 1.67 s |
| npm 子进程 | 端到端 185.07 s 中的 180.66 s |
| 该子进程内的 `idealTree:buildDeps` | 153.30 s，且几乎全部落在 877 个按节点计时器中的 14 个上 |
| `checkCanPlace` / `canPlacePeers` peer 冲突分析 | 117.3 s，其中 `new URL()` 65.9 s、`SemVer` 27.9 s |
| Registry 流量 | 682 次请求、383 KB packument 响应体 |
| 布局断言与进程启动 | 4.4 s |

同一个依赖图加上 `--legacy-peer-deps` 后 1.12 s 解析完成，因此 peer 摆放占 153.8 s 中的 152.7 s。`canPlacePeers` 会把每条内部边与其 peer 目标的入边重新核对一遍，这使开销随「摆放次数 × 边数」增长；嵌套发布的 `@deepseek-ai/dsh-base` 副本单独耗时 48.8 s，而同一棵树上根位置的同一包只耗时 1.3 s。被校验的内部边约有四分之三是 peer 边（2524 条中的 1874 条），所以这部分工作是断言本身，而不是断言之外的开销。

同一台主机上对同一张图的重复运行，npm 耗时在 137.8 s 到 204.8 s 之间波动，输入没有任何变化却有 1.5 倍差距，这正是墙钟阈值无法区分「主机慢」和「图更大」的原因。

## Alternatives considered

**跨次复用同一个 npm cache 目录。** lane 的 `npm_config_cache` 位于临时消费者目录内，registry 监听临时端口，因此 `make-fetch-happen` 把每个 cache 条目键为 `http://127.0.0.1:<port>/<name>`，持久化的 cache 无法命中。用冷启动那次留下的 4.4 MB cache 加 `--prefer-offline` 重跑整张图，产出的 package lock 逐字节相同，耗时 189.8 s，而冷启动为 153.8 s：结果正确，但更慢。profile 中 10.2 s 的空闲时间是任何网络节省的上限，因为 npm 把其余时间都花在自己的摆放代码里。

**合并或并行两个发布。** lane 已经在一次 npm 调用里解析两个发布，这正是共存声明可被校验的原因；而 `canPlacePeers` 会检查整棵树，一个发布无法复用另一个的 peer 分析。把图拆成两次相互独立的解析会丢掉断言存在的理由：共享 Cordis 与跨发布摆放。

**调大 `TIMEOUT_MS`。** 更大的期限保留了原有失效模式：判定仍取决于 runner 速度，而一个增长到在任何机器上都慢的图仍会失败，且不给出任何关于「什么变大了」的测量。

**`--prefer-dedupe`。** 它用 126.8 s 解析同一张图，但选择了不同的摆放（809 条 lock 条目对 815 条，8 条条目不同），因此 lane 断言的将是非默认的 npm 摆放。

**`--legacy-peer-deps`。** 它 1.12 s 完成解析，但丢掉了 52 个由 peer 安装的包，也丢掉了构成断言大部分覆盖面的 peer 边。

## Consequences

lane 的失败判定如今取决于依赖图，因此新增少量 DSH 包的 pull request 在任何 runner 上都能通过，而「包数乘边数」增长超过约四分之一的图——即包数与内部边数同步增长约 12%——会带着实测计数确定性地失败。预算是棘轮：调高它是一次刻意修改，必须附带新的解析实测，该常量注释里记录了推导所用的计数。预算内的图仍会花掉完整的解析时间，因为这次改动移动的是判定位置而不是工作本身；这里没有任何东西能减少 npm 摆放双发布所需的 153 s。真正挂起的 npm 现在会消耗该 lane 最多 910 秒才失败，而旧期限把它限制在 300 秒。若图的增长改变了形状却没有改变「包数乘边数」，它仍留在预算内，只有在挂起保护到期时才被发现。
