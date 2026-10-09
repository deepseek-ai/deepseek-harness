# Agent Note: PR 产物构建与 aggregate TypeScript 检查

Status: implemented

[English](2026-10-05-pr-artifact-typechecks.md) | 中文

## Problem

PR job 需要相同的编译包来运行 benchmark、兼容性、打包和运行时检查。每个产物 job 都构建仓库级测试和脚本 program，会重复执行昂贵的诊断。在允许使用的 #3661 baseline 中，benchmark 在 432 秒的串行测量前花费约 304 秒准备构建。在 macOS arm64、Node 24.19.0 上，一次冷启动 Host 编译器 profile 耗时 84.01 秒，其中 aggregate program 占 55.92 秒；282 个有 emit 的 project 合计耗时 24.33 秒。提高并发会消耗更多共享运行器资源。

## Decision

必需的 Linux consumer 与原生 Windows build job 保留普通构建，包括两个完整 aggregate program。公开的 `build` 和 `typecheck` 保留相同检查。[Node 版本职责](2026-07-06-node-engine-floor.zh.md)与[原生 Windows 职责](2026-08-08-native-windows-pull-request-ci.zh.md)仍然有效。

带检查的 PR 产物构建通过一个串行 `tsc -b` 进程编译各 compiler face 的全部现有 project reference，然后运行普通 Typert、bundling、Desktop 和 Web 阶段。helper 读取现有 Host 与 Client aggregate，而不维护另一份包清单。它只省略各 root 附加的测试和脚本 program；包诊断、emit 输出及 Host 先于 Client 的顺序仍然必需。非 PR 的 release 和真实 API 工作流构建保留普通检查。

只有 CI benchmark helper 选择 `tsc -b --noCheck` 来 emit 包。benchmark 消费 JavaScript 和 Typert 运行时元数据；其声明与 build-information 文件是临时产物，不会发布。Typert 独立分析源码类型，语义诊断由必需的完整构建负责。语法与配置错误仍会拒绝 benchmark 准备。TypeScript 记录待检查状态，使后续普通增量构建无需删除缓存或强制重建，就能诊断相同源码。公开 benchmark script，以及所有 release、Python、preview、compatibility 和普通产物 builder，均保留带检查的默认行为。

Python executable builder 在验证 runtime closure 后，通过 `--artifacts-only` 选择产物编译。无效 closure 在编译、部署或打包前失败；默认完整构建和复用预构建产物的 `--skip-build` 模式保留原有阶段。

CI 直接调用内部 build helper，并保持 root package manifest 不变。即使只修改 build alias，root manifest 改动也会激活独立的 native-addon 平台矩阵；避免这一触发条件，可以在不削弱 native 验证的情况下保留现有 workflow 集合与并发 job 上限。

job 清单、runner 选择和 benchmark sample 数量保持固定；gate 与 worker 上限不提高。三个 compatibility case 每次运行一个 job；双目标 Python runtime 矩阵在 keyless Python SDK job 成功后启动。四个 Linux lane、Python SDK、三个 Windows lane 和一个 compatibility job，初始最多占用九个 worker job。SDK job 完成后，剩余七个独立 lane、一个 compatibility job 和两个 runtime target，最多占用十个 job。runtime plan 与 wheel 阶段先于这些 target，各占一个 job。这允许 runtime 验证与 Node 22 构建重叠，同时保持原有十个 job 的上限。覆盖率分区在各自的平台和 runner pool 内复用精简的文件成本元数据。并行 release 打包使用 pnpm 现有的有界调度器；串行发布保持 family 顺序。

每个 Node 版本在一次串行 Vitest 调用中运行相同的七个 source compatibility spec。文件并行和 CLI worker 上限均固定为一，gate 还设置 `VITEST_MAX_WORKERS=1`，因为该环境变量会覆盖 Vitest 的 CLI 上限。文件保持 fork 隔离；依赖构建的 Node 22 lazy-search smoke 保留独立的 build 依赖。三对本地样本保持全部 253 个 assertion outcome，将启动开销比较的 median 从 11.52 秒降至 8.69 秒，且不增加所拥有 descendant process 的峰值。

## Alternatives considered

**提高 job 或 worker 并发。** 否决，因为共享运行器必须保持现有资源上限。

**从所有构建中移除 aggregate 检查。** 否决，因为包 project 不会检查所有仓库测试和脚本的类型；必需的 Linux 与 Windows job 必须保留这些诊断。

**跨 revision 缓存编译输出。** 暂缓，因为缓存正确性与失效规则增加了额外义务，而移除重复 aggregate 工作无需承担这些义务。

## Consequences

冷启动 Host reference 构建耗时 23.49 秒、峰值 RSS 为 1.91 GiB；完整编译器阶段为 84.01 秒和 3.87 GiB。全部 5,932 个 emit 文件的路径与 SHA-256 相同。这些是单次本地编译器样本，不含 bundling 和测试；PR 延迟结果以当前 head 的 CI 为准。benchmark 场景与预算保持不变。

在 Apple M4 Pro / Node 24.19.0 上，三对交替冷启动准备构建比较带检查的 reference 编译与仅用于 benchmark 的 emit：前者为 61.16、82.53、57.80 秒，后者为 55.53、50.82、50.75 秒。准备阶段中位数从 61.16 降至 50.82 秒（16.9%）；范围包括 native support、library、benchmark worker 和 Web 产物，不含依赖安装与测量。每对都包含相同的 11,894 个输出路径，其中 3,181 个 JavaScript 文件逐字节相同，source map 不变。356 个 build-information 文件不同，九个声明仅调整 union 成员顺序；benchmark lane 不会发布这些文件。library 构建的 user CPU 中位数从 76.45 降至 64.23 秒，maximum RSS 中位数保持在约 2.75 GiB。完整 PR 耗时以必需 CI 为准。

并行打包依赖锁定的 pnpm CLI 正确处理精确 recursive filter、pack destination、workspace 并发上限及各包的 lifecycle hook。升级 pnpm 时，必须先通过 `scripts/release/pack.spec.ts` 中的真实 CLI 检查，再让 release 打包采用该版本。

覆盖率权重累加 Vitest 互不重叠的 environment、preparation、setup、collection 和 execution 成本。CI 的平台/environment/pool cache prefix 不匹配原来的 `coverage-times-<run>` archive。持久化本地 checkout 在切换期间可能为未测量的文件保留墙钟权重；删除 `.coverage-times.json` 可重置该历史。这些参考权重影响分区分配，完整清单与合并后的覆盖率阈值仍然必需。

带检查的产物构建有意不诊断仅属于 aggregate 的测试或脚本错误。必需的普通构建拒绝这些错误；fixture 检查还验证两个路径都会拒绝包错误，并比较 emit 的 JavaScript、声明、map 和 build 信息。删除或改变必需的完整构建前，必须先把两个 aggregate 检查转交另一处阻塞型 owner。master 串行 reference 按[现有政策](2026-07-21-serial-cross-platform-ci-reference.zh.md)保持完整。
