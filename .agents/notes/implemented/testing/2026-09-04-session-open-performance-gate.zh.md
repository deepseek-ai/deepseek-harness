# Agent Note: 打开大型 Session 的必需 CI 性能 gate

Status: implemented

[English](2026-09-04-session-open-performance-gate.md) | 中文

## 问题

Session format v2 的推出改变了两条成本随模型输出增长的路径：JSONL backend 迁移并发布 released-v0 log，Client fold 每个已结算回复中嵌入的紧凑 stream。两条路径都没有可执行的性能检查，因此首次打开在 127,400 事件的合成 log 上从约 35 ms 增长到约 5 s（在 575,000 chunk 的真实 log 上从约 0.3 s 增长到 26 s，峰值 RSS 2.7 GB，并在 512 MB 堆限制下耗尽堆），Client fold 也随流式 delta 数而不是紧凑记录数线性增长，这些退化未被察觉地进入了 master。

只测 `SessionPersistence.open()` 不能稳定表达用户或 Host 等待的结果。工作可以在 `open()`、`SessionHandle.read()`、Session restore 与 projection 之间移动，而首次历史页和冷 Agent 恢复还包含这些操作之上的独立编排。操作结束时未经 GC 的一次 `heapUsed` 采样也不能区分仍被 Session 持有的数据与可回收的迁移临时对象。

## 决定

Linux pull request 运行必需的 `node 24 / benchmarks` job，执行 `pnpm run check:ci:bench` → `pnpm run test:bench`。私有 `@deepseek-ai/dsh-benchmarks` workspace 拥有 benchmark 专属依赖。该命令先构建 workspace library 和 `benchmarks/.dsh-build/` 下的专用 worker，再调用 `vitest.bench.config.ts`。[标准托管运行器决策](2026-09-06-standard-hosted-benchmark-runner.zh.md)拥有运行器选择及外层 job 超时。该 job 单独运行 benchmark lane；Vitest 逐文件运行，只负责准备输入、启动测量子进程、汇总结果和执行预算断言。每条被计时的 Node CPU 路径都以纯 Node 执行编译后的 JavaScript，并移除 `NODE_OPTIONS` 且不加载 TypeScript runtime；workspace 裸导入因此从 `benchmarks/node_modules` 通过 package exports 解析到构建后的 `lib/` 入口。

必需性能 gate 位于顶层 `benchmarks/`，按被测用户路径而非 package 归属组织。Host 文件使用 `*.bench.ts`，Client 面文件使用 `*.bench.client.ts`，场景专属 worker 与 fixture 留在对应 benchmark 旁且不带 benchmark 后缀。包内 `.perf.ts` 文件仍是非门禁诊断；`scripts/` 负责编排而不承载 benchmark case。

Session benchmark 使用固定参数合成 released-v0 输入：200 轮，每轮 500 个 text delta 与 125 个 reasoning delta，共 127,400 个逻辑事件。输入使用 Zstandard，并固定 logical rows 的分组与 frame 拆分，使每次运行处理相同的事件、字节与 frame 分布。fixture 直接构造不可变的 released-v0 physical rows，不依赖当前 runtime 的历史 encoder；压缩以及所有被测读取和 migration 入口仍使用生产代码。输入在计时前写入每个样本独占的临时目录；benchmark 不使用录制的 Session。

每个 Session endpoint 都针对用户生命周期中的两个时点运行。`first-open` 最初只有 released V0 generation，包含 migration；只读消费者不发布后继文件，可写 Agent resume 才会发布。测试准备阶段在计时外通过同一套生产 migration 生成一次 `post-upgrade-reopen`，再把未改动的 V0 前代和已发布的 V2 后继一起复制到每个样本目录。Reopen 样本使用全新进程，因此测量用户升级完成后的磁盘再次打开，不包含 migration 或进程内 cache。

每个 access kind 与 endpoint 的样本都在全新、已编译的 Node 子进程中运行。模块加载、Host 服务初始化和 fixture 准备在测量开始前完成；测量进程不执行额外的预热解析。正常堆模式运行五个独立样本，报告全部样本及最小值、中位数和最大值，并以中位数执行各访问状态独立的固定预算。另一个子进程使用固定 128 MB old-space 上限运行同一路径，只判断能否完成；低堆限制引起的额外 GC 不进入正常时间基线。

该 lane 包含三个独立的 Session 打开 benchmark，并保留 Client fold benchmark：

| Benchmark | 被测路径 | 时间指标 |
|---|---|---|
| 阶段剖面 | 分别为 first open 与 post-upgrade reopen 执行真实 persistence open、handle read、Session restore 与 projection | `openMs`、`readMs`、`sessionRestoreMs`、`projectionMs` 各自使用固定预算；只读 migration 归入 first-open `openMs`；后继编码、verify 与 publish 属于可写 Agent resume |
| 首屏历史 | 两种 access kind 分别经 Host Session history controller 读取到首个分页 snapshot | First open 与 reopen 各有一个端到端预算；均包含 source stat、读取、Session restore、projection、分页与 snapshot 构造，first open 还包含 migration；两者都不包含 Gateway 网络传输、Client fold 或浏览器 paint |
| Agent resume | 对两种 access kind 分别调用 `ctx.agents.resume()`，直到 Agent 创建、setup、发布与 loop 启动完成 | First open 与 reopen 各有一个端到端预算；两条路径都不与首屏历史串行，也不依赖它留下的 cache |
| Client fold | 大小两个 v2 history window 经真实 `ConversationNodeAssembler` 与全部 Chat Definition fold | 大窗口的绝对时间与相对小窗口的缩放比各自使用固定预算 |

阶段剖面显式调用各层正式入口，不复制 decode、migration、restore 或 projection 算法。首屏历史和 Agent resume 分别以新的 first-open 与 reopen 根目录运行真实上层入口，因此组件数据不冒充端到端结果，一个场景也不会给另一个场景预热进程或 Session cache。四阶段之和仅用于解释成本；首屏与 Agent resume 的端到端时间各自由外层时钟直接测量。

正常堆模式在 Host 初始化完成且 Session 尚未访问时执行固定的两轮显式 GC，记录起点内存；操作计时结束后，在该场景要求的长期对象仍明确可达时再次执行同样的 GC，再记录终点内存。Agent resume 场景在终点保留 Agent、Session、完整 events 与正常服务 cache，它的 `heapUsed` 增量是常驻 Session 内存预算的主指标。每个场景同时报告 `external`、`arrayBuffers`、GC 后 RSS 和 `process.resourceUsage().maxRSS`；128 MB 模式继续防止瞬时分配峰值被终点 GC 隐藏。显式 GC 时间不计入操作时间。

性能 gate 不重复功能测试的内容断言，只要求目标调用完成并到达对应的可观察终点。Client fold benchmark 继续使用真实 `ConversationNodeAssembler` 与全部 Chat Definition，要求大窗口的绝对时间和相对小窗口的缩放比均低于固定预算。

预算按各测量终点分别校准。两次 Node 24.19 x64 CI 运行的中位数最大相差 5.2%；其 CPU 密集型壁钟时间是 Node 24.18 arm64 参考运行的 1.95–2.06 倍。除当前 generation `open` 外，源码常量记录参考机器上的预期耗时；`ciTimeBudget()` 将其乘以实测的 2 倍 CI 时间系数和 1.25 倍波动余量。当前 generation `open` 使用标准运行器直接测得的 50 ms 预期值，仅乘以 1.25 倍余量，向上取整得到 63 ms 预算。GC 后增量堆与 Client fold 缩放预算不属于壁钟时间，因此只使用 1.25 倍余量。128 MB 完成性检查仍是独立的瞬时分配限制。由此得到的 first-open 时间上限、受限堆检查与 Client fold 上限都会拒绝已知退化。栈前参考提交固定为 `0d7ea53743e273930a31e9e2b6ca682f21dd4ca5`，只用于校准和评审预算；CI 不 checkout 或执行历史仓库。预算是源码中的受评审常量，不由环境变量覆盖。

## 校准证据

比较按用户生命周期正交，而不是按产物表示正交。两种实现的 first open 都接收完全相同的固定 V0 字节。Reopen 时，每种实现都在全新进程中读取自己认定的当前格式：栈前参考版本仍读取 V0，V2 实现则读取它已发布的 V2 后继。这里有意比较同一用户后续打开的体验，而不是让两个 codec 处理同一种数据结构。

同一台 Node 24 参考机器上的五次样本中位数构成正反例：

| Access kind | 实现 | 四阶段总时间 | 首屏历史 | Agent resume | Agent GC 后增量堆 | 128 MB old space |
|---|---|---:|---:|---:|---:|---|
| First open | 栈前参考版本 | 249.0 ms | 253.8 ms | 100.7 ms | 26.1 MB | 完成 |
| First open | 重复 snapshot 退化实现 | 4,197.5 ms | 4,284.8 ms | 4,197.9 ms | 4.4 MB | 堆耗尽 |
| Post-upgrade reopen | 栈前参考版本 | 251.1 ms | 253.8 ms | 100.7 ms | 26.1 MB | 完成 |
| Post-upgrade reopen | 重复 snapshot 退化实现 | 49.2 ms | 50.4 ms | 43.8 ms | 4.5 MB | 完成 |

栈前实现以 V0 作为当前格式，因此 first open 不改变磁盘表示；它的原生 V0 首屏历史与 Agent resume 测量同时适用于两个生命周期行。

`ca3ffe95dac2c55eefeb16ed9b61067bbd19ee90` 上的[标准双 CPU 运行](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34023970384/job/101461539961)使用 Node 24.20.0 x64 和 Ubuntu 镜像 `20260831.293.1`。当前 generation `open` 的五次样本为 49.2、47.4、49.1、48.6 和 48.1 ms：中位数 48.6 ms，最大值 49.2 ms。取整后的 50 ms CI 预期值给出 63 ms 上限，不重复乘以 2 倍机器系数。日志标明两个可用 CPU，但未记录型号；它无法区分硬件变化与 Node 版本变化的影响。这是端点专属的运行器校准，不是应用优化或参考机器新测量的证据。其他每项 benchmark 均通过既有预算。确定性正反例在历史 30 ms 上限下拒绝实测中位数，在 63 ms 下接受它，拒绝合成的 75 ms reopen 中位数，并以未改变的 550 ms 上限拒绝合成的 4,000 ms 首次打开耗时。这些正反例验证预算执行，不代表测得新的退化。

校准后的源码预算如下：

| 测量项 | 参考机预期 | CI 预算 |
|---|---:|---:|
| First-open `open` | 220 ms | 550 ms |
| 当前 generation `open` | 12 ms（历史参考值；CI 预期值：50 ms） | 63 ms |
| 完整 read | 8 ms | 20 ms |
| Session restore | 24 ms | 60 ms |
| Projection | 14 ms | 35 ms |
| First-open 首屏历史 | 220 ms | 550 ms |
| 当前 generation 首屏历史 | 48 ms | 120 ms |
| First-open Agent resume | 180 ms | 450 ms |
| 当前 generation Agent resume | 40 ms | 100 ms |
| Agent GC 后增量堆 | 26.1 MB | 33 MB |
| Client fold 绝对时间 | 16 ms | 40 ms |
| Client fold delta 缩放比 | 2.5× | 3.125× |
| 受限 old space | — | 128 MB |

## 考虑过的替代方案

**每次 CI checkout 历史提交并做相对比较。** 拒绝：历史 checkout 需要独立安装，旧版与当前版还可能把工作放在不同 API 阶段，增加时间、依赖和接口漂移。固定 workload 与经正反例校准的静态预算更容易复现和评审。

**只测从 V0 first open。** 拒绝：migration 是一次性升级成本，不能防止进入稳定当前 generation 后的后续打开发生退化。两种 access kind 需要独立的测量与预算。

**只测四个组件阶段。** 拒绝：组件测量便于定位，但会遗漏 source stat、编排、分页和 snapshot 构造，也不能证明首屏路径整体仍然可用且足够快。

**只测首屏或 Agent resume 总时间。** 拒绝：端到端数字能保护结果，却不能指出退化来自存储、读取、Session restore 还是 projection；四阶段预算保留可操作的归因。

**在生产实现内部添加细粒度计时桩。** 拒绝：这些桩会扩大生产接口并让 benchmark 与实现细节耦合。测试只使用既有服务和对象边界；无法由这些边界解释的成本保留在端到端结果中。

**从 TypeScript 源码运行被测 worker。** 拒绝：源码 loader 会改变模块解析与启动行为，并使嵌套 worker 选择仅适用于源码的启动路径。Vitest 仍可作为不计时的编排层；每个被计时的 worker 都像纯 Node 消费方一样执行构建产物。

**只用时间预算或只看 GC 后内存。** 拒绝：时间无法发现内存退化，终点存活内存也看不到迁移期间的瞬时爆发。正常堆的 GC 后增量与受限堆的完成性分别覆盖两类风险。

**用真实录制语料做 benchmark。** 拒绝：语料 fixture 按策略保持小体量，录制材料不得成为 benchmark 输入，且其重新录制会静默移动 workload。

**把 benchmark 放进现有 gate 聚合中运行。** 拒绝：聚合在一个 runner 上并发运行各 gate，壁钟测量会继承邻居的 CPU 负载。

**把每个跨包 gate 放在一个参与的产品 package 下。** 拒绝：Session 打开跨越 persistence、migration、projection、Host history 与 Agent resume；任选一个参与方都会形成误导性的归属和仅为 benchmark 增加的 package 依赖。仓库级目录拥有集成用户路径，包内诊断仍留在对应实现旁。

**把 benchmark case 放在 `scripts/` 下。** 拒绝：scripts 拥有命令、生成器与编排，而 benchmark case 拥有带类型的测试文件、worker、fixture、预算和生命周期清理。未来的报告或校准命令可以消费 `benchmarks/`，不需要把 case 移入其中。

## 后果

每个 pull request 多付出一个必需 Linux job；该 job 的 Session 部分运行多个短生命周期子进程，以换取冷 cache、独立 V8 heap、明确 GC 状态和可归因的失败。仓库级 benchmark 目录接受有意的跨包测试依赖，而不修改产品 package manifest。固定 Zstandard workload 同时覆盖事件规模与 frame 拓扑；first-open 测量保护一次性升级体验，reopen 测量防止后续打开退化，四阶段预算定位成本归属，首屏预算保护用户可见等待，Agent resume 预算与 GC 后增量保护完整冷恢复及常驻内存，128 MB 模式保护瞬时分配上限。

Session 与 Node-fold 场景不测量网络传输、浏览器渲染或真实录制 Session，也不是持续性能趋势系统。[前端性能预算](2026-09-06-frontend-performance-budgets.zh.md)拥有浏览器工作流测量。Node 或 runner 变化需要用同一 workload 重新采样并评审预算；修改业务实现时不得顺带放宽预算而不提供新的正反例数据。
