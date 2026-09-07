# Agent Note: 覆盖率豁免重型套件

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-coverage-exempt-heavy-suites.md) | 中文

## Problem

CI 覆盖率 lane（`check:ci:coverage`）的墙钟被少数几个重型测试文件钉死：本地 6-worker 全量剖析中，555 个测试文件聚合 1595 秒，其中 `packages/typert/generator/tests/type-model.spec.ts` 一个文件占 885 秒，前 10 个文件占聚合时长的 84%。这类套件的共同点是每个用例都做全工作区编译器分析或真实子进程 fixture（测试前置数据），v8 插桩把这类代码的运行时间放大数倍。

关键的浪费在于：这些套件缴纳的插桩税对 per-file 100% 阈值**没有任何贡献**——它们进程内执行的被度量代码，要么本来就不在阈值口径内，要么已由其他套件独立满覆盖。继续在插桩下运行它们，纯粹是用 lane 时长换零信息。

## Decision

`ci-coverage` 聚合拆成两个并行 gate，全部测试仍然执行，只有重型套件不再交插桩税：

- **插桩 gate**（`test:coverage`）：设 `DSH_COVERAGE_EXEMPT_HEAVY=1`，`vitest.config.ts` 据此从两个 project 的 exclude 中剔除豁免套件，其余全部文件照旧插桩并承担全部阈值证明。经 gate 自带 env 注入（既有 `Gate.env` 机制），不进 workflow 全局环境，因此并排的无插桩 gate 和本地直跑 `vitest run` 都看不到该变量、行为不变。
- **无插桩 gate**（`test:coverage-exempt-heavy`）：用配对的 positional filter 恰好运行豁免套件，保证正确性信号不缩水。

Linux 覆盖率 CI 与原生 Windows CI 在插桩门禁内部使用 [job 内分区覆盖率](2026-08-18-in-job-partitioned-coverage.zh.md)。其合并报告承担相同的阈值证明；豁免门禁及其成员资格规则保持不变。

`scripts/coverage-exempt.ts` 是唯一名单点，集中持有成员资格约定与 filter/exclude 配对，防止两侧漂移。

该名单还包含构建镜像可加载性套件。这个套件读取工作区构建产物，而它导入的 packer 与 Web Worker runtime 源码已排除在阈值外。原生 Windows 会让无插桩门禁等待 `build`，因此该套件不会观察到只完成部分输出的依赖闭包。

### 豁免名单与逐项对账

一个套件对覆盖率有贡献，当且仅当它在进程内执行了被度量的文件（`coverage.include` = 包 src 树）。现行名单逐项核对：

| 豁免套件 | 进程内执行的被度量代码 | 覆盖由谁接住 |
| --- | --- | --- |
| typert generator 全部 6 个 spec | generator 自身 src | generator src 已整包 threshold-excluded（`vitest.config.ts`），本不在阈值口径内 |
| 其中 tools-catalog.spec 额外 import | `typert-registry`、`tool-cordis` 的 src | 两包各自的测试独立满覆盖（focused coverage 实测无阈值错误） |
| `scripts/install-lefthook.spec.ts`、`scripts/oxlint-contract.spec.ts`、`scripts/change-scope.spec.ts`、`scripts/translation-pairing-merge.spec.ts` | 无——被测对象是 `scripts/` 源码（从不在 coverage.include），执行方式是 spawn 子进程 | 无需接 |
| `packages/experimental/webworker-runtime/tests/compile/transform-corpus.spec.ts` | 无——spawn 子进程对全部已构建 bundle 做 transform 并 import（oracle 是 Node ESM loader） | webworker-runtime src 已整包 threshold-excluded（`vitest.config.ts`），本不在阈值口径内 |
| `packages/experimental/webworker-packer/tests/image-loadable.spec.ts` | packer 与 Web Worker runtime 源码，两者都在 `vitest.config.ts` 中排除阈值 | 该套件为构建产物提供正确性证据；原生 Windows 在构建后通过无插桩门禁运行它 |

### 成员资格约定

新增豁免必须同时满足：套件进程内执行的每个被度量文件都已由其他套件满覆盖（或在阈值排除名单内）；filter 与 exclude 选中完全相同的文件集。约定文本随名单同文件维护。

### 门禁自动守卫名单正确性

per-file 100% 阈值本身就是豁免名单的守卫，名单错误无法静默通过：

- 若未来某个豁免套件实际独家覆盖着某个被度量文件，插桩 gate 当场红（该文件跌破 100%）；
- 反向同理：出现「只有豁免套件才覆盖」的新代码，同样立刻红。

因此覆盖率结果的不变性不依赖人工维护名单，符合「misconfiguration fails loud」约定。唯一失去的是豁免套件自身的执行不再产出覆盖数据——由上表可知这些数据全部冗余，最终报告在阈值意义上逐文件相同。

## Alternatives considered

- **CLI `--exclude` 从插桩 gate 剔除豁免套件。** 实证无效：vitest 4 的 `cliExclude` 不参与 per-project include 解析，多 project 配置下豁免套件仍被选中，故改走 env + config。
- **降低 worker 数或提高 gate 并发。** 事故期间实测无效：lane 墙钟被尾部最长文件钉死（聚合/墙钟 ≈ 4× 有效并行），并发旋钮两个方向都动不了尾巴。
- **跨 runner 分片（`--shard` + blob 合并）。** 不予采用，因为 matrix、产物流水线和合并 job 会引入第二套工作流拓扑。所选的 [job 内分区](2026-08-18-in-job-partitioned-coverage.zh.md)只把 Vitest shard 用作既有 job 内的本地单 worker 进程。
- **直接删除或跳过重型套件。** 拒绝：它们是 typert generator 与 scripts 工具的唯一正确性证据，无插桩并排执行保住全部信号。

## Verification

CI 实测（16 核 runner）：拆分前 gate 段 424 秒，拆分后两 gate 并行 `test:coverage` 95.9 秒 + `test:coverage-exempt-heavy` 71.1 秒，lane 收敛于较慢者约 96 秒；拆分前后插桩 gate 阈值错误均为零。`vitest list` 验证 env 开关两态恰好增删豁免集；`run-gates.spec.ts` 覆盖聚合图构造。

## Consequences

- 豁免套件在执行时不会向阈值门禁叠加插桩开销；分区墙钟数据由 [job 内分区决策](2026-08-18-in-job-partitioned-coverage.zh.md)负责记录。
- 原生 Windows 让豁免门禁等待构建，因此构建镜像套件会读取完整的工作区产物树。
- `DSH_GATE_CONCURRENCY` 在本 lane 重新拥有两个可调度对象，聚合调度器不再是直通。
- 向名单新增重型套件必须完成上述成员资格对账；错误条目会让插桩 gate 大声失败，而不是静默侵蚀覆盖率。
- 豁免套件不再出现在覆盖率报告的贡献文件列表中；其正确性信号完全由无插桩 gate 的红绿承载。
