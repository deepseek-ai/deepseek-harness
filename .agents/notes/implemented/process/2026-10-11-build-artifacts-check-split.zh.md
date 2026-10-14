# Agent Note: 拆分 build:artifacts 与 build:check，build 并发执行两者

Status: implemented

[English](2026-10-11-build-artifacts-check-split.md) | 中文

## 问题

`pnpm run build` 串行执行 native addon、包库构建（Host `tsc -b tsconfig.host.json` → Host tsdown → Desktop bundle → Client `tsc -b tsconfig.client.json` → Client tsdown）和 Web 构建。Host 与 Client 聚合配置除了引用各包 project，还各自带有一个 `noEmit` 根程序，覆盖 tests、scripts、benchmarks 与 website。这两个根程序不产出任何文件，也不是后续产物步骤的输入，却位于串行关键路径上：单独计时时 Host 根程序为 68.5 s、Client 根程序为 36.0 s，串行包库构建约为 249 s（2 个样本的中位数）。

开发迭代只需要产物，测试与脚本的类型检查在声明完成前才需要。能跳过两个根程序的只有面向 CI 的 `pnpm run build --artifacts-only`；它没有本地开发命令名，也没有只做这两项检查的对应命令。同时，`pnpm run build` 必须保持完整，能检测出所有类型错误。

## 决策

### 命令

每个命令只做自己的工作。

| 命令 | 职责 | 步骤 | 调度 | client build record |
|---|---|---|---|---|
| `pnpm run build:artifacts` | 产出 `build` 的全部产物；包 project 照常完整类型检查，不检查两个聚合根程序 | native → host-src → host-bundle → desktop-bundle → client-src → client-bundle → web | 一条线性链 | 开始时删除，全部通过后写入 |
| `pnpm run build:check` | 只类型检查两个聚合根程序 | host-check、client-check | 两步并发，无前置步骤 | 不读写 |
| `pnpm run build` | `build:artifacts` 与 `build:check` 的全部步骤 | 下文依赖图 | run-gates 调度器并发执行 | 开始时删除，全部通过后写入 |

`build:check` 不检测、不重建、也不校验 `build:artifacts` 的产物；前置产物缺失或过期时，由编译器自身的诊断（例如 TS6305、TS2307）报告，任何命令都不增加前置检查、守卫或回退逻辑。`build:artifacts` 产出的产物与 record 和 `build` 相同，并取代 `--artifacts-only`；该参数与 `compile-referenced-projects.ts` 的 `libraries` 模式已删除，Python executable builder 使用 `--build-artifacts`。`build:official` 仍是 `tsx scripts/build.ts --profile official`，执行完整的 `build`。

### 步骤与依赖

| 步骤 | 命令 | `build` 中的 `needs` |
|---|---|---|
| native | `pnpm run build:native-system` | — |
| host-src | `node --max-old-space-size=4096 <tsc> -b <tsconfig.host.json 的 references>` | native |
| host-bundle | `tsdown --config-loader native --env.DSH_BUILD_FACE host`（运行 Typert） | host-src |
| desktop-bundle | `pnpm --filter @deepseek-ai/dsh-desktop run bundle` | host-bundle |
| client-src | `<tsc> -b <tsconfig.client.json 的 references>` | desktop-bundle |
| client-bundle | `tsdown --config-loader native --env.DSH_BUILD_FACE client` | client-src |
| web | `pnpm run build:web` | client-bundle |
| host-check | `node --max-old-space-size=4096 <tsc> -p tsconfig.host.json` | host-src |
| client-check | `<tsc> -p tsconfig.client.json` | client-src |

```text
native → host-src ─┬─ host-check ───────────────────────────────────────────────────────┐
                   └─ host-bundle → desktop-bundle → client-src ─┬─ client-check ───────┤ → record
                                                                 └─ client-bundle → web ┘
```

- client-src 必须在 host-bundle 之后：Client 包导入 `@deepseek-ai/dsh-*/remote`，其类型 `lib/typert.remote-client.d.ts` 由 Typert 写出：这些 scope 在 Host tsdown 中生成，typecheck scope 经 `scripts/generate-typert.ts` 生成。host-check 不读取 Typert 输出，干净的串行构建一直在 Host tsdown 之前完成 Host 聚合检查。
- 产物链保留 native → host-src 与 desktop-bundle → client-src 这两条非数据依赖；只有两个 check 步骤并行挂接到链上。
- [`compile-referenced-projects.ts`](../../../../scripts/compile-referenced-projects.ts) 拥有包库步骤列表 `libraryBuildSteps`、references 参数构造 `referencedProjectsCompilerArgs`（相对路径传参，避开 Windows 命令行长度上限）与聚合检查参数 `aggregateCheckArgs`。vendor 发布演练（`host-libraries`）与 CI benchmark（`--noCheck`）串行执行同一步骤列表。
- check 步骤使用 project mode（`tsc -p`）：它读取 references 已有的声明而不编译任何 reference，incremental 状态写入聚合配置已有的 `tsconfig.{host,client}.tsbuildinfo`。`build` 与 `build:check` 使用同一条命令，因此诊断相同。

### 调度、失败与输出

- [`scripts/build.ts`](../../../../scripts/build.ts) 拥有步骤表与三个范围，执行复用 [`scripts/run-gates.ts`](../../../../scripts/run-gates.ts) 的 `runAggregate`：每个步骤是一个带 `needs` 的 gate，shell-free 启动、按步骤缓冲输出、fail-fast 进程树终止、Windows `taskkill` 与宿主信号转发都沿用 run-gates 的实现。`build:artifacts` 为 `tsx scripts/build.ts --scope artifacts`，`build:check` 为 `--scope check`，`build` 不带 `--scope`，把两者作为一张图执行；`--profile` 只适用于产生产物的范围，与 `--scope check` 同用时参数解析失败。
- 并发上限取 `DSH_GATE_CONCURRENCY`，未设置时为可用 CPU 数；依赖图宽度最多为 3（host-check 尚未结束时，client-check 与 client-bundle 可能已开始）。master 串行参考 lane 设置 `DSH_GATE_CONCURRENCY=1`，`build` 在那里按拓扑顺序串行执行，符合[串行参考决策](2026-07-21-serial-cross-platform-ci-reference.zh.md)，无需修改 workflow。
- 缺省（本地）时，失败步骤的所有依赖方记为 skipped，正在运行的步骤和与失败无关的步骤继续运行到结束；执行集合只取决于各步骤的结果，因此一次运行报告所有相互独立的类型错误。`DSH_GATE_FAIL_FAST=1`（所有构建型 PR lane 已设置）时，第一个失败终止其余正在运行步骤的进程树，所有未完成步骤记为 skipped。
- 失败步骤打印 `== FAILED <步骤> ==`、命令、退出原因与该步骤完整的缓冲输出，结尾汇总列出 failed 与 skipped 步骤；成功步骤只打印 PASS 行，`DSH_GATE_VERBOSE=1` 打印全部输出。任一步骤 failed 或 skipped 时退出码为 1，且不写 client build record。所有步骤继承 `clientBuildProcessEnvironment` 选定的公开 Client 环境。
- CI 中 `build` 本身是外层 run-gates 的一个 gate；外层 fail-fast 终止会转发到内层调度。`check:node-compat` 与 `check:ci:lint:contracts-ready` 已使用同样的嵌套。

### 调用方

| 调用方 | 命令 | 聚合根程序检查 |
|---|---|---|
| `build`、`build:official`、`Makefile` `build`、`scripts/publish-npm-baseline.ts`、`apps/desktop/scripts/package-target.ts`、`scripts/dev-bundle-registry.ts`、`release-publish.yml`、`sandbox.yml`、`e2e.yml` 与 `release.yml` 的非 PR 分支 | `build` / `build:official` | 有 |
| `test:web`、`test:web:refresh`、`test:web:perf`、`test:web:stress`、`apps/desktop` `test:updates:local`、`test:bench` / `build:bench` | `build`；`build:bench` 运行 `build:native-system`、`build:lib` 与 benchmark tsdown | 有 |
| `typecheck`（pre-push hook 运行它） | `build.ts --scope typecheck`：host-src 与 host-typert（不打包、只读源码的 Typert 生成 `generate-typert.ts`）并行 → client-src，各 face 包编译后运行 `tsc -b tsconfig.{host,client}.json`；不含任何 bundle | 有 |
| `dev:web`（[`scripts/dev-web.ts`](../../../../scripts/dev-web.ts)）、`dev:desktop`（`apps/desktop/scripts/dev.ts`） | `build:artifacts` | 启动前无；`dev:web` 启动后的 `tsc -b tsconfig.client.json --watch` 持续检查 Client 聚合根程序 |
| `lint`、`lint:fix`、`doc-typecheck` 与 CI 的 Typert contracts gate 的前置步骤 | Host 包编译与不打包的 Typert 生成并行（`compile-referenced-projects.ts host-contracts`），不含任何 bundle | 无 |
| CI node 24 / snapshots and artifacts（`check:ci:consumers`）、windows node 24 / build & observational（`check:ci:windows-blocking`） | `build` | 有，两个必需 lane |
| CI node-compat 22.19 | `build:artifacts`（经 run-gates） | 无 |
| CI python runtime | `build-exe-for-python-sdk.ts --build-artifacts` | 无 |
| `e2e.yml`、`release.yml` 的 PR 演练 | `pnpm run build:artifacts --profile official` | 无 |
| `build-preview-cloudflare.yml` | `pnpm run build:artifacts` | 无 |
| CI node 24 / benchmarks | `run-ci-bench.ts`（`tsc -b --noCheck`） | 无 |
| `release-vendor.yml` 的 PR 演练 | `compile-referenced-projects.ts host-libraries` | 无 |
| `release-vendor.yml` 的非 PR 分支、`release-vendor-publish.yml` | `build:lib:host` | 仅 Host 聚合根程序 |

`lint`、`lint:fix`、`doc-typecheck` 与 Typert contracts gate 只读取 Typert 输出与包声明：两个聚合配置都是 `noEmit`，oxlint 自行构建程序，`doc-typecheck` 只引用包 project，它们都不读取 bundle。它们的前置步骤因此跳过 Host 聚合检查与所有 bundle；仅跳过 Host 聚合检查与 Desktop bundle 就使耗时从 159.8 s 降到 90.9 s（见下文测量）。

consumers lane 的 HMR Web 测试启动 `dev:web`，因此在该 lane 内使用 `build:artifacts`；同一 lane 的 `build` gate 仍运行两个聚合检查。CI 不单独调用 `build:check`：两个必需 lane 已通过 `build` 获得同一组检查。[PR 产物构建决策](2026-10-05-pr-artifact-typechecks.zh.md)的必需完整构建、benchmark `--noCheck`、job 与 worker 上限、node-compat 串行 Vitest、覆盖率权重与 pnpm 打包检查仍然有效；其中的 PR 产物构建由 `build:artifacts` 执行。

### 测量

原型测量的条件：256 vCPU 共享 Linux 主机（load average 23–70），Node v24.18.0、TypeScript 6.0.3，React 类型包已提升到根，不含[无损提速 Note](2026-10-11-lossless-build-speedups.zh.md) 的 Typert 改动；范围是包库构建（不含 native 与 web）。每轮从 `pnpm run clean` 开始，按 串行、并发、`build:lib`、`build:lib`、并发、串行 的顺序各运行一次；每个步骤由 `/usr/bin/time -v` 计时，进程树 RSS 每 250 ms 采样求和。原型中的聚合检查以 `tsc -b tsconfig.{host,client}.json` 在 references 已是最新时运行，此时 build mode 只构建聚合根程序。

| 方式（2 个样本的中位数） | wall（s） | CPU user+sys（s） | 进程树 RSS 峰值（GiB） |
|---|---|---|---|
| 串行 `pnpm run build:lib` | 249.4 | 378.0 | 5.95 |
| 各步骤依次单独运行 | 255.1 | 373.8 | 5.82 |
| 按依赖图并发 | 172.1 | 392.1 | 8.00 |

wall 中位数从 249.4 s 降到 172.1 s（−77.3 s，−31%）。各步骤单独运行的两次样本相差 28 s，因此把步骤拆成独立进程的开销无法分辨。CPU 增加约 14 s（+3.7%），主要是争用下 Host 聚合检查增加的 user 时间；RSS 峰值增加约 2.1 GiB，出现在 Host 聚合检查（约 4 GiB）与 Host tsdown（约 5.7 GiB）重叠时。并发时的关键路径是 host-src → host-bundle → desktop-bundle → client-src → client-check；host-check 在结束前约 33 s 完成，client-bundle 在结束前约 21 s 完成。

最终测量：master（合并基点）与本分支交替运行，每次均从 clean 开始，在 64 核 cgroup 中运行；除标注 n=1 者外，数值均为 2 个样本的中位数。

| 场景 | master | 本分支 | CPU user+sys（master → 本分支） | 进程树 RSS 峰值（master → 本分支） |
|---|---|---|---|---|
| 完整构建 `pnpm run build` | 317.1 s | 169.1 s（−46.7%） | 423.1 → 374.4 s（−11.5%） | 6.11 → 7.53 GiB（+1.42） |
| 本分支串行构建 `DSH_GATE_CONCURRENCY=1 pnpm run build`（n=1） | — | 266.7 s | 389.5 s | 6.27 GiB |
| 产物构建：master `build --artifacts-only`，本分支 `build:artifacts` | 185.8 s | 153.6 s（−17.3%） | 256.2 → 231.2 s | 6.58 → 6.18 GiB |
| 开发迭代：master `build`，本分支 `build:artifacts` | 317.1 s | 153.6 s（−51.6%） | 423.1 → 231.2 s（−45.4%） | 6.11 → 6.18 GiB |
| `pnpm run build:check`（`build:artifacts` 之后） | — | 67.7 s | 144.6 s | 5.33 GiB |
| `pnpm run build:check` 无改动重跑 | — | 19.4 s | 33.1 s | 未测量 |
| `lint` 与 `doc-typecheck` 的前置步骤：master `build:lib:host`，本分支 `host-libraries`（后由 `host-contracts` 取代，见[本地门禁提速](2026-10-12-local-gate-speedups.zh.md)） | 159.8 s | 90.9 s（−43.2%） | 234.7 → 136.0 s | 未测量 |

本分支串行样本运行时主机上有其他工作（外来 CPU 742 s），因此它的 wall 可能高估串行成本。串行构建的各段中（master → 本分支，各一个样本），Host tsdown 从 22.5 s 降到 11.7 s，Client 包编译从 55.6 s 降到 48.7 s，Client 聚合检查从 68.2 s 降到 35.9 s，Client tsdown 从 13.9 s 降到 10.5 s；各段合计分别为 308.5 s 与 254.9 s。这些缩短来自[无损提速 Note](2026-10-11-lossless-build-speedups.zh.md)；从 254.9 s 的串行各段合计到 169.1 s 的并发构建，其余缩短来自本 Note 的调度，它把 Host 聚合检查（约 66 s）移出关键路径。并发构建的关键路径是 native → host-src → host-bundle → desktop-bundle → client-src → client-check，host-check 在最后一步结束前约 30 s 完成（取自更早的一个样本）。`build:check` 并发运行 Host 与 Client 聚合检查，因此其 wall 等于 Host 聚合检查的 wall（约 65 s）。

### 完整性与无损依据

`build` 运行的编译器程序集合与串行构建相同：host-src 与 client-src 编译两个 face 的全部包 project，host-check 与 client-check 检查两个聚合根程序，且使用与 `build:check` 相同的命令。原型的 6 轮运行中，`{packages,apps,vendor,native}/**/lib/**`（排除 `*.tsbuildinfo`）的 11,580 个文件在串行与并发之间逐字节一致，每轮之后 `tsc -b --dry tsconfig.host.json tsconfig.client.json` 报告没有过期 project。tsbuildinfo 写入方归属为：host-src 292 个，client-src 76 个（恰好是 client-only project），两个聚合检查各 1 个；client-src 不改写 host-check 读取的任何 tsbuildinfo 或声明，因此该依赖图中不存在写入竞争。fixture 测试 `checks only the aggregate program in project mode` 表明 `tsc -p` 写出的 tsbuildinfo 被 `tsc -b --dry` 视为最新，`reports missing package declarations without compiling references` 表明 project mode 不编译 references。本实现中，并发 `build` 与 `DSH_GATE_CONCURRENCY=1 pnpm run build` 产出逐字节一致的 `lib/`（11,584 个文件）、`apps/web/dist`（156 个文件）与 client build record；之后 `tsc -b --dry` 对两个聚合配置报告 372 个 project 全部为最新，没有需要构建的 project。

| 错误 | `build:artifacts` | `build:check` | `build` | `typecheck` | 必需 CI lane |
|---|---|---|---|---|---|
| 包源码类型错误 | host-src / client-src | 不报告（读取已有声明） | host-src / client-src | 报告 | 报告 |
| 只属于聚合根程序的测试、脚本、benchmark、website 类型错误 | 不报告 | host-check / client-check | host-check / client-check | 报告 | consumers、windows-build |
| 包 tsconfig 配置错误 | host-src / client-src | 不报告（`tsc -p` 不校验被引用 project 的 tsconfig 选项与语法） | host-src / client-src | 报告 | 报告 |
| Typert 分析错误 | host-bundle | 不报告 | host-bundle | 报告（经 host-typert） | 报告 |
| 前置产物缺失 | — | 编译器诊断（TS6305、TS2307） | — | — | — |

负对照：在只属于 Host 聚合根程序的 `scripts/pnpm-invocation.spec.ts` 中加入类型错误（TS2322）后，`build:artifacts` 以 0 退出；`build:check` 以 1 退出，其中 Host 聚合检查失败、Client 聚合检查通过；`build` 以 1 退出，9 个步骤中 8 个通过、1 个失败，且不写 client build record。在临时 fixture 中，被引用 project 的 tsconfig 含无效 `target`、JSON 语法错误或未知编译选项时，`tsc -p` 以 0 退出，`tsc -b` 分别报告 TS6046、TS5092 与 TS1012、TS5023 并以 1 退出；被引用 project 缺少 `composite` 时，两者都报告 TS6306。

CI 证据：PR #6005 上，两个运行并发 `pnpm run build` 的必需 lane 均通过：`node 24 / snapshots and artifacts`（`check:ci:consumers`，运行于 `blacksmith-16vcpu-ubuntu-2404`）与 `windows node 24 / build & observational`（`check:ci:windows-blocking`，运行于 `blacksmith-16vcpu-windows-2025`）；GitHub 托管的 4 vCPU benchmarks lane 不运行 `build`。内层并发取 `DSH_GATE_CONCURRENCY`：master 串行 lane 设为 1，consumers lane 在 self-hosted failover 时设为 10，未设置时取可用 CPU 数，且不超过 9 个步骤。

### 有意的取舍（非无损）

- **部分命令跳过聚合检查：** `build:artifacts`、`dev:web` 与 `dev:desktop` 的启动构建，以及 `lint`、`lint:fix`、`doc-typecheck` 与 Typert contracts gate 的前置步骤，都不类型检查两个聚合根程序，这些前置步骤只产出声明与 Typert 输出，不打包。完整性由 `build`、`build:check`、`typecheck`（pre-push hook）与两个必需 CI lane 负责；`dev:web` 与 `dev:desktop` 不会因测试类型错误而拒绝启动。
- **`build:check` 不检查新鲜度：** 在 `build:artifacts` 之后修改源码时，`build:check` 基于旧声明（包括 Typert Remote 声明）检查；需要先重跑 `build:artifacts`。完整 `build` 不受影响。
- **并发 `build` 提高内存峰值：** 本分支完整 `build` 的进程树 RSS 峰值为 7.53 GiB，master 串行构建为 6.11 GiB（+1.42 GiB，2 个样本的中位数），本分支串行构建为 6.27 GiB（n=1）；同时 CPU 从 423.1 s 降到 374.4 s，因为[无损提速 Note](2026-10-11-lossless-build-speedups.zh.md) 省去的工作多于并发争用增加的工作。原型（不含 Typert 改动）中，单独的并发调度使 RSS 峰值增加约 2.1 GiB（5.9 → 8.0 GiB）、CPU 增加约 3.7%。上限由 `DSH_GATE_CONCURRENCY` 控制；内存紧张时使用 `DSH_GATE_CONCURRENCY=1 pnpm run build`，或分别运行 `build:artifacts` 与 `build:check`。windows-build lane 中 `build` 与 `docs:build` 同时运行。
- **成功步骤的输出默认不显示：** 只有失败步骤打印完整输出。
- **`tsc -p` 不跳过已是最新的根程序：** 无改动时立即重跑 `build:check` 仍需 19.4 s 与 33.1 s CPU，因为两个程序都要重新解析；`tsc -b` 会跳过已是最新的根。
- **多核冷启动时 `build:artifacts` 只比 `build` 快 15.5 s：** 本分支冷启动 `build` 为 169.1 s，`build:artifacts` 为 153.6 s（2 个样本的中位数），因为 host-check 不在关键路径上，client-check 只比 client-bundle 与 web 之和长约 16 s。`build:artifacts` 的其余收益是 CPU 与内存：CPU 从 374.4 s 降到 231.2 s，RSS 峰值从 7.53 GiB 降到 6.18 GiB；在少核机器与增量重建中，这部分也转化为 wall。
- **CI 调用根 manifest 中的公开命令：** PR 产物构建调用 `build:artifacts`，而不是内部 helper 参数；修改根 manifest 中这些 script 的 PR 会激活独立的 Node Addon System 平台矩阵。

## 考虑过的替代方案

- **只在 `typecheck` 中保留聚合检查：** `pnpm run build` 必须完整，能检测出所有错误。
- **保留 `--artifacts-only` 并新增 `build:artifacts` 别名：** 同一件事有两个名字。
- **命名为 `build:src` 与 `build:test`：** `build:artifacts` 产出全部产物，包括 tsdown bundle、Desktop bundle 与 Web，而不只是编译后的源码；`build:check` 除测试外还检查脚本、benchmarks 与 website 代码。
- **按编译器术语命名（`build:b`/`build:p`、`build:project`、`build:emit`）或命名为 `build:dist`：** tsc 只出现在两个产物步骤中，`-p` 只是 check 步骤的实现选择；TypeScript 把 `tsc -p` 一侧称为 project；`emit` 容易被理解为只 emit 的 `--noCheck` 模式，而包 project 仍完整检查；包产物位于 `lib/`，`dist` 则让人联想到发布打包。
- **`build:check` 使用 `tsc -b <aggregate>`：** build mode 会编译过期的 references，即执行 `build:artifacts` 的工作。
- **`build:check` 先补齐或校验前置产物：** 违背每个命令只做自己的工作，并增加前置逻辑；编译器诊断已经指明缺失的输出。
- **新的调度实现（shell `&`/`wait`、`concurrently`、turbo/nx）：** 重复 run-gates 已有的失败汇总、进程树终止与 Windows 处理。
- **在 CI 的 run-gates 中把 `build` 展开为多个 gate：** `pnpm run build` 必须是本地与 release workflow 可直接使用的完整命令，record 也由它写入。
- **放宽产物链内的非数据依赖（native ∥ host-src、desktop-bundle ∥ client-src）：** 未测量；Desktop bundle 本身只占 4.0–4.5 s。
- **把测试移入新的 tsconfig：** 现有聚合配置已经把包 references 与根程序分开。
- **把聚合根程序拆成多个子程序：** 每个子程序都要注入 242 个含模块增强的文件，CPU 增加 9–57%，只降低 wall（见[无损提速 Note](2026-10-11-lossless-build-speedups.zh.md)）。
- **CI 单独运行 `build:check`：** 必需 lane 已通过 `build` 获得同一组检查，再单独运行是重复工作。

## 后果

开发迭代可以用 `build:artifacts` 跳过两个聚合根程序（冷启动比 master 的 `build` 快 51.6%），在声明完成前用 `build:check` 或 `build` 补齐检查。`build` 保持完整：Host 聚合检查不在关键路径上，Client 聚合检查与 Client bundle、web 并行，冷启动比 master 快 46.7%（含无损提速 Note 的改动，2 个样本的中位数）。代价是更高的内存峰值、并发争用带来的少量额外 CPU、默认更少的成功输出，以及多个开发与前置命令不检查测试类型（见上文取舍）。

删除或改变 consumers 与 windows-build 两个必需 lane 的 `build`，必须先把两个聚合检查转交另一处阻塞型 owner。typecheck scope 与 lint 类前置步骤不打包即生成 Typert 约定（[本地门禁提速](2026-10-12-local-gate-speedups.zh.md)）；产物 scope 仍在 Host tsdown 中生成。

[Typert Remote 方法调用](../architecture/2026-08-02-typert-remote-method-calls.zh.md)描述的“Client 编译前先完成 Host 与 Remote 产物”由 client-src 对 host-bundle 的依赖保证。

验证：`scripts/build.spec.ts` 覆盖类型剥离检查、已删除参数与非法范围的拒绝、`--profile` 与 `--scope check` 的冲突、范围选择、步骤依赖与环境；`compile-referenced-projects.spec.ts` 覆盖 project mode 只检查聚合程序、缺失声明的诊断，以及 `tsc -b --dry` 接受 `tsc -p` 写出的 tsbuildinfo；失败传播、输出缓冲与进程树终止沿用 run-gates 的调度实现及其测试；`run-gates.spec.ts`、`ci-workflow.spec.ts`、`preview-workflow.spec.ts`、`build-exe-for-python-sdk.spec.ts`、`dev-web.spec.ts` 与 `tests/ci-release-selfhosted.spec.ts` 固定各调用方的命令。
