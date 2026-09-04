# Agent Note: Web GUI 的无密钥浏览器 e2e 车道

Status: implemented

[English](2026-07-24-web-gui-browser-e2e-lane.md) | 中文

## 问题

Web GUI 以一条真实组装链交付——chromium 页面 → client 插件 bundle → HTTP 单次 RPC + 两条 SSE（Server-Sent Events）流 → `toFetchHandler`/apiproxy → host 端的 agent loop（智能体循环）、工具与 JSONL 持久化——却没有任何测试无密钥且确定性地检验这条链。[GUI 测试体系](../process/2026-07-20-gui-testing-system.zh.md)覆盖第 1 层（Node 中的协议同构）、第 2 层（对象层状态机）与第 3 层冒烟测试，但无密钥冒烟驱动的是 `FixtureApiClient`——没有 host、没有 wire、没有 agent loop——而全链路冒烟需要 `DEEPSEEK_API_KEY` 和真实模型，因此不确定、在无密钥 CI 中自行跳过。[docs/testing.md](../../../../docs/testing.zh.md) 的快照哲学——带密钥录制一次、永久无密钥回放、格式变动时刷新——已覆盖 ACP（Agent Client Protocol）、headless `stream-json` 与 TUI 三个 transcript（文本记录）表面；web 表面是唯一没有这层保障的组装形态。而缺口恰恰是两起已实证 GUI P0 藏身之处：fixture（测试前置数据）客户端短路掉的 wire 承载链。

## 决策

`pnpm run test:web` 携带 `apps/web/tests/` 下的无密钥、确定性浏览器 e2e 车道：录制的会话日志 fixture 经 `@deepseek-ai/dsh-llm-replay` 对真实进程内 web 组合回放；用户可见状态使用规范化的 aria 预期输出，持久化的世界状态则使用进程内断言。配套的产品约定包括 `dsh-llm-replay` 的节奏控制、消费检查与已校验的索引式覆写 patch；跨包的 `dsh-llm` 失败通过自有数据属性保留经校验的提供方信息；已交付的 web 组合挂载 `llm-retry`，以处理瞬态模型失败。

### Scaffold：`apps/web/tests/scaffold.ts`

一个普通的共享 fixture 模块（[测试政策认可的形态](../../../../docs/testing.zh.md)），不是包：值得门禁把守的逻辑——回放推导、会话解析、日志脱敏、持久化——都在已受门禁的包 `dsh-llm-replay`、`dsh-session-snapshot`、`dsh-session-persistence-jsonl` 中；剩下的只是启动接线和浏览器胶水，而驱动 chromium 的源码在无浏览器的覆盖率 runner 上无法诚实保持逐文件 100% 覆盖率。

`launchWebScaffold()` 通过 vendored Loader 的 include 机制，从交付的 `apps/cli/config/base.cordis.yml` 与 `apps/cli/config/web.cordis.yml` 启动真实 web 组合——与 `AppCLIEntry` 为 `dsh web` 驱动的是同一棵树、同一套机制。差异全部经 include patch 覆盖在这棵树上，即 ACP `cordis.snapshot.yml` 模式的进程内表达：临时 `persistenceRoot`；每个主机级 `skill-filesystem` 根目录（`dshHome`、`agentsHome` 和 `bundledSkillDir`）都钉在临时工作区下并禁用监听，因为环境 skill（技能）目录是模型可见输入；禁用 `agent-instructions`（录制的 fixture 不得嵌入本仓库的 AGENTS.md）；禁用 `session-title-llm`（其发后不管的标题调用会与循环争抢会话的回放游标）；webserver 行钉到端口 0，并使用已构建的 dist；无密钥模式下禁用 `llm-deepseek`。patch 的 id 一旦不再匹配任何行，boot 扫描会大声失败而不是漂移。boot 在临时工作区 `chdir` 下运行，使 api-gateway 的 `process.cwd()` 会话默认值、工具 cwd 与 fixture 一致；`dsh web` bin 自身的胶水（argv、profile json、AppCLIEntry）仍由 `smoke-real.e2e.ts` 中的无密钥 CLI（命令行界面）冒烟把守。初始化回滚和正常关闭都会先对 Cordis 树执行 dispose（资源释放），再删除 scaffold 持有的两个临时根目录；每项清理都会独立尝试，并会报告清理失败而不掩盖初始化失败。

无密钥的模型替换 = 禁用适配器行的 patch 加 `installLlmReplay` 在停稳的根 ctx 上以提供方目录（providers-catalog）模式填充空的适配器注册表——绝不用 catch-all：适配器行被禁用后不存在任何适配器，catch-all 会让 `resolveModelInfo` 无路由可走，`compaction-basic` 的步后压力检查将步步告警，而不是被可证明地闲置（发布的 128k `contextWindow` 使该路径对小 fixture 保持闲置）。选择直接安装而非插入回放插件行是刻意的：直接安装返回收尾消费检查所需的 `ReplayHandle`。没有 fixture 的场景让注册表保持空置，任何意外的流式调用都会以 NO_ADAPTER 大声失败。

`seedSession()` 通过真实持久化 API 播种冷会话——一次性 `Context` 挂载 `SessionStore` + `JsonlSessionPersistence` 到 host 的根上下文，`create()` + `append()`，一次 `utimes` 回拨保证侧栏顺序确定（`semantic-checkpoint.snapshot.ts` 先例）——绝不裸写文件，因此播种器对桶哈希、文件名编码、压缩一无所知，host 的 zstd 默认值也无需任何启动开关。种子在播种时即校验（可解析、以 `turn/end` 结尾——未闭合的最终轮次会被恢复（resume）的崩溃修复改写）。

### 确定性规则

回放模式下浏览器断言的屏障栈，按序：（1）host 侧 `await agent.whenIdle()` 加超时，以进程内 `turn/end` 为锚——空闲翻转发生在持久化落盘之后，一次等待同时覆盖轮次完成与持久性；（2）浏览器安定轮询（流式输出节点已卸载、最终文本可见）。录制模式下，日志采收在 `whenIdle()` 之后、scaffold 释放之前进行，此时运行中的会话仍然可用。单独监听进程内 `turn/end` 是错误屏障（它先于 SSE 帧到达浏览器、先于 fsync 触发）；禁止轮询持久化文件来充当轮次完成或持久性屏障（NFS 上慢，且被 `whenIdle` 取代），但工具控制的临时就绪标记可以仅作为该完成屏障之前的交互门控进行轮询；`networkidle` 被彻底禁止（SSE 流保持打开时它永不解析）。导航断言会在页面加载前同时监听 `session.list` 和 `workspace.list` 的初始响应，随后等待播种数据投影到 DOM；仅凭 shell 已挂载不能判定就绪，因为较晚完成的 bootstrap 可能替换受控状态。

不做单次瞬态 DOM 断言：从 replay yield 到 React commit 的每一跳都可能合并 chunk，采样 `[data-streaming]` 天然就是竞态。流式增量性通过有序 `agent/assistant-stream` follow path 断言，最终持久 `assistant/message` 或 `assistant/attempt` 则嵌入 replay 使用的精确 stream。`dsh-llm-replay` 的可选 `paceMs`（默认缺省 = burst）只是让浏览器观察到真正增量 SSE 的真实感旋钮；正确性绝不依赖它，且 pace wait 期间 abort 会即时取消。

分页驱动会等待交互式加载行退出 pending 状态，并在滚动前记录请求前的行数。因此，即时提交的常驻页仍然可观测，不会变成一次滚动手势不会重复触发的请求基线。

每个场景都会因任何 pageerror 或客户端的连接丢失/间隙修复控制台警告而失败：否则重连机制加历史重同步会把一条死掉的 SSE 通路自愈掉，套件反而认证了坏 wire。Scaffold 的 `close()` 调用 `ReplayHandle.assertConsumed()` 收尾检查（每个已录脚本都被绑定、每个游标都耗尽），把静默的少放与错绑变成清晰诊断。车道不设 vitest 重试；每文件一个 chromium、每场景一个新 context、每场景一个 host；视口固定；交互选择器锚定 role、`data-*` 属性和可见文本，而 frame 与会话区采集则使用既有的 CSS 模块局部类名锚点。常规场景开启 `en-US` 浏览器，使本地化的 role 定位器和预期输出统一采用明确指定的语言；断言中文文案的场景则开启 `zh-CN` 浏览器，因为 Host settings 文档没有显式偏好时，客户端的暂定 locale 由 `navigator` 推导（[由浏览器推导初始 locale](../feature/2026-07-31-browser-derived-initial-locale.zh.md)）。`settings-chrome.e2e.ts` 还额外覆盖双向切换、全新英文浏览器默认态，以及共享同一 DSH home 的不同端口之间的偏好持久化。

### 预期输出

具有稳定所属区域的场景会为每个不同的用户可见状态提交一份规范化的 `ariaSnapshot()`；跨区域的 workspace 管理状态则使用语义 DOM 断言与权威 host 状态检查。UUID、cwd、workspace basename 与时长等易变内容会归一为稳定 token；采集过程持续轮询，直到连续两次规范化读取结果相同。Role 与文本锚点继续充当可评审预期输出周围的语义防线，并直接覆盖跨区域状态。拥有录制 Session 的场景默认将规范化后的重新持久化根 generation 与选定的最高 parent fixture 比较（v0 为 `session.jsonl`，正 generation 为 `session.vN.jsonl`）；借用或派生 fixture 的场景显式关闭该比较。世界状态断言仍使用权威 host 状态或独立、完整的 `workspace.expected/`，因为 transcript 匹配不能证明外部效果。`refresh` 是 ARIA 预期输出的唯一 writer；replay 模式下缺少预期输出时，测试会连同重新生成命令一起失败。

类型检查平面切分是结构性的：host scaffold、其支持模块，以及每个启动或检查 host 组合的 web spec 都会从注册在 client 侧的 `apps/web` 工程中排除，并逐文件纳入 `tsconfig.host.json`。一个程序不能同时持有 Cordis `Context` 合并的两侧。

### 模式与 fixture

`DSH_SNAPSHOT` 选择 replay（默认，无密钥）、record（带密钥）或 refresh（无密钥）。发起提示的 spec 将所有模式共用的驱动步骤与仅供 replay/refresh 使用的断言分开；record 模式驱动真实输入框，采收内存中的会话 header 与事件，脱敏请求头，并 token 化当次运行的会话、cwd 与 RPC 标识。随后一次无密钥 refresh 重新生成 ARIA 预期输出。每条提示词都会与 fixture 中录制的 `user/message` 核对；每个场景目录都采用封闭清单，其中每个 JSONL 都是脱敏不动点。语料 manifest 为每个 Web 组合/header 类分配且仅分配一个 pin，并只在该 pin 的 sidecar 中保留提示词与工具 schema 正文。

### 覆盖约定

该车道覆盖三类行为。实时轮次场景钉住普通工具执行、取消、不可重试失败、瞬态重试、常驻提问与轮次中途 steering（中途引导）；同步依赖持久事件、`whenIdle()` 或显式回放标记，而不使用延时。冷历史场景通过真实持久化 API 播种，在不调用模型的情况下覆盖历史渲染、侧栏搜索、Trajectory 与 waterfall（瀑布式事件）视图及工具详情。浏览器生命周期场景覆盖首次发送时物化工作区、重新加载恢复、布局重置、主题与语言偏好，以及工作区的创建、重命名和视图操作。每类场景都断言浏览器表面和权威的 host 状态；意外的模型调用或未耗尽的 fixture 会使拆卸失败。必需车道还包含一份合成的 88 轮 Chat 滚动约定，其中混合了换行 Markdown、围栏代码以及成对的 bash 调用/结果。真实 wheel、输入框、工具、tab、会话与 viewport 交互会在并发历史前插加带节奏流式输出、贴底/离底流式输出、工具 disclosure 离屏循环、扩展历史后的视图/会话重新挂载、宽度重排、贴底后立即重新挂载、输入框尺寸变化以及 textarea wheel 链场景中，断言一个已稳定的具名行相对 transcript scrollport 的顶部位置和到真实底部的距离；真实键盘翻页与触摸式惯性滑动模拟额外钉住不依赖 wheel 的贴底跟随所有权（[读者滚动归因笔记](../bug-fix/2026-08-06-reader-scroll-attribution-observed-top-ledger.zh.md)）；它刻意不钉 DOM 基数或绝对 `scrollTop`，因此同一约定可以验收虚拟化实现。另一份基于同一 fixture 的交互约定钉住异构行顺序、相邻工具 disclosure 的独立状态、用户消息剪贴板内容的精确值、以轮次为边界的消息 fork、源会话/子会话隔离，以及子会话中的一次真实追问轮次；wheel 输入只用于导航到语义目标，不承载几何预期。一份简短的实时历史约定从空白工作区开始，连续驱动输入框轮次，其中包括真实的 bash 调用/结果轮次和一段带节奏的长篇最终响应；它钉住单一会话身份、每轮事件的精确归属、浏览器回显唯一性与输入框恢复，不设置时间阈值。

### CI 立场

根据[浏览器快照 CI 决策](2026-07-30-web-browser-snapshot-ci-gate.zh.md)，该车道是 Linux 拉取请求必需的只比较门禁。`node 24 / snapshots and artifacts` 消费方任务在[消费方独立构建](../process/2026-07-30-independent-ci-consumer-build.zh.md)中负责唯一一次 Linux 构建，安装锁文件选定的 Chromium，恢复以操作系统和锁文件为键的缓存，并用 `DSH_SNAPSHOT=replay` 运行该车道。这是有意的平面切分：host 与 spec 使用 [tsx 源码启动约定](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)，浏览器则消费 `apps/web/dist` 和包的 `lib/client.js` 产物，因此门禁依赖 `built-package-invariants` 提供这些客户端产物。自托管的默认分支 Linux 串行热备运行同一门禁；不存在托管 Linux 串行生产者生成供 PR 消费的浏览器缓存，持久化自托管池则不需要托管侧缓存。CI 从不录制或刷新预期输出。场景仍面向 POSIX，并继续置于 Windows 和 macOS 矩阵之外。

高基数性能诊断使用单独按需启用的 `apps/web/tests/**/*.perf.ts` 清单，并且只由 `vitest.web.perf.config.ts` 选中。`complex-history.perf.ts` 的隔离用例复用真实 scaffold：工作区用例播种 1,000 个紧凑会话以及一份包含 500 次工具调用的 500 轮次历史，在 Chat 中穷尽并重新挂载该历史，并报告 Chromium 主线程、DOM、监听器、堆内存、分页、搜索和 Trajectory 测量结果。两个续聊用例播种同一份长历史，但比较默认的 24 轮次 Chat 窗口与展开全部 500 轮次的状态，然后各自通过真实输入框、agent loop、SSE wire、工具和持久化继续进行 8 个相同轮次；其中两轮执行真实 `bash` 调用并断言其持久化结果，最后一轮则填入一条包含 8,232 个字符的混合语言提示词，并回放 120 个带节奏的文本增量。一个单独的 soak 用例从空白会话开始，通过真实输入框连续驱动 100 轮，每第 10 轮执行一次 `bash` 调用并产生结果，每 10 轮强制执行一次 GC，并报告每 10 轮的延迟窗口及保留的浏览器状态。随后它通过受信任的浏览器点击提交第 101 个纯文本轮次，并使用浏览器时钟分别测量发送到 transcript DOM 和发送到绘制后的延迟，排除输入框的草稿镜像，并与完整轮次完成时间分开。逐轮诊断涵盖输入框填入、点击到用户消息回显、点击到首个分片、完成、浏览器变更、持久化分片和工具事件；合成回放模型拥有足够的上下文容量，可使 fixture 基数保持稳定，而不会因压缩（compaction）消耗脚本化调用。结构性断言钉住预期的负载、流和工具形状，但时间仍不设阈值，因为机器速度不属于正确性约定。必需的 `vitest.web.config.ts` 清单仍仅限 `*.e2e.ts` 和 `*.snapshot.ts`，因此 `test:web:built` 及其 CI 门禁都不会收集性能用例。

## 业界先例

调研了 AI（人工智能）聊天/agent web UI 与 mock 层（LibreChat、vercel/ai-chatbot + AI SDK、lobe-chat、open-webui、OpenHands、Chainlit、continue、cline、langfuse、gradio/streamlit；Playwright HAR/route、MSW、Polly/nock、WireMock、aimock）。自有后端的应用的主流成熟架构是：真实后端约定后放一个进程内伪造/回放模型，下游全部真实（LibreChat 的 `LIBRECHAT_TEST_RUN_HOOK` 伪模型；ai-chatbot 的 `MockLanguageModelV3` + `simulateReadableStream`；continue 的脚本化 mock 提供方类）——这正是 `dsh-llm-replay` 已然所是。浏览器层 SSE 拦截无法检验增量渲染（`route.fulfill` 一次性交付整个响应体；playwright#33564），且服务端 SSE 栈完全失测，因此各项目只把它用于边缘用例。分片节奏作为 fixture 参数反复出现（LibreChat 默认 10ms 附慢速档；ai-chatbot 500ms）；CI 里的真实模型会腐烂（open-webui 的套件长出 120 秒超时，先被禁用后被删除）；会话在持久化层以受控时间戳播种（LibreChat 直插回拨时间的 Mongo 文档；langfuse 播种其数据库）。没有任何被调研项目为 UI 测试把录制的 agent 事件日志经真实后端回放——最接近的是提供方层录制 fixture（aimock）与前端层 socket 历史发射（OpenHands MSW）——因此会话日志即 fixture 的设计沿着本仓库「模型可见 ⟺ 已记录」不变式所指的方向比业界先例多走了一步。

## 曾考虑的替代方案

**浏览器网络层 SSE 拦截（`page.route`）。** 已否决：`route.fulfill` 无法流式输出，增量 token 渲染无从检验，且服务端 SSE/背压/关闭路径——两起已实证 P0 的藏身处——完全失测。

**`DEEPSEEK_BASE_URL` 处的 mock HTTP 提供方。** 作为本车道机制已否决（仅保留给既有的工作区探针冒烟）：fixture 会变成手写的 OpenAI SSE 字节脚本，一种与仓库其余部分录制回放的会话日志格式渐行渐远的第二 fixture 格式；适配器的真实 HTTP 路径归带密钥 e2e 管。

**扩展 `?fixture` 客户端。** 已否决：分层纪律——`FixtureApiClient` 的存在意义就是脱离服务器测试客户端 shell；client API 边界以下按构造即失测。

**用占位 `DEEPSEEK_API_KEY` + 回放拦截替代禁用适配器行。** 尽管零组合改动且树内有两处先例仍被否决：它用谎言满足 `llm-deepseek` 的快速失败密钥检查，还留下一个挂载却被拦截的死适配器；禁用行（ACP overlay 的同款做法）是诚实的无密钥，并在最早可解析点快速失败。

**`packages/test-support/web-snapshot` 包 + `defineWebSnapshotSuite` 工厂。** 已否决：驱动 chromium 的源码在无浏览器的覆盖率 runner 上无法诚实保持逐文件 100%，且除受门禁的包已导出的辅助工具与本地 scaffold 外，这些场景专用交互尚未形成稳定的无浏览器约定。出现第二个 web 形态消费方，或被证实重复的生命周期代码确立该约定后，再重新考虑。

**单独维护第二份规范化 Session 日志预期输出。** 不予采用：把选定的录制 generation 再复制成另一个文件会使 refresh 成本翻倍，却不会增加独立 oracle。语料改为将规范化持久化结果与驱动 replay 的同一份最高 generation parent fixture 比较，同时以 host 状态和完整 workspace 断言保留独立的世界验证义务。

**以 `DSH_SNAPSHOT` 回放分支拉起 `dsh web` bin。** 已否决：它需要在交付的 CLI 中增加测试专用回放分支和环境变量管道。进程内 scaffold 已加载同一份 `apps/cli/config/base.cordis.yml` 与 `apps/cli/config/web.cordis.yml`；只剩 argv、profile JSON 和 `AppCLIEntry` 胶水不在其覆盖范围内，而这些路径已由无密钥 CLI 冒烟覆盖。

**为可测试性改 wire 协议。** 已否决：约定已有第一等的无密钥进程内路径（`InProcessApiClient(toFetchHandler(api))`），逐事件不合批的 SSE 恰是回放在浏览器中可观测的原因，测试一条不再交付的 wire 会颠倒该层的存在意义。

**以真实模型浏览器测试充当无密钥车道。** 已否决：按构造即不确定；被调研的前车之鉴（open-webui）长出无界超时后被删除。带密钥的真实 host 冒烟仍是真实模型侧的补充。

**在必需的浏览器门禁中运行高基数性能用例。** 已否决：其 fixture 设置和完整历史渲染会增加数十秒耗时，而壁钟时间和内存值随 host 不同而变化，无法提供稳定的正确性阈值。必需车道保留确定性行为断言；贡献者在调查或更改大列表和长历史渲染时运行该诊断用例。

**客户端 `data-dsh-busy` 安定信号。** 暂缓：host 侧 `whenIdle` 屏障配合稳定 DOM 轮询，足以覆盖当前场景。第一次安定轮询抖动，或必要状态在 DOM 中不可观察时，再重新考虑。

## 测试

`pnpm run test:web` 构建并无密钥运行该车道；`test:web:built` 基于现有构建产物运行。`pnpm run test:web:perf` 构建并运行手动性能清单；`test:web:perf:built` 复用现有产物。`DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/<spec>` 对真实模型录制一个发起提示的场景，`DSH_SNAPSHOT=refresh pnpm run test:web` 则无密钥重写 aria 预期输出。CI 显式选择回放模式。live-interactions AUTH 场景会把不可重试的终态失败钉为 Chat 内联状态，其中携带适合展示的消息与错误码，并验证提供方回显的凭据片段不会出现在 Chat 或 Trajectory 中；该场景同时覆盖输入框恢复与 `turn/end` 错误。scaffold 环境隔离场景会在全部 3 个环境 skill 根目录中分别填入不同条目，并要求这些条目都不得进入组装后的目录。`dsh-llm-replay` 单元覆盖率钉住节奏控制、取消、消费诊断、sidecar 校验、按索引替换与唯一的追加位置。

## 暂缓

- **恢复后追问场景**：真实 wire 上的历史/实时缝合路径；当该代码变更或回归时作为独立场景补充。
- **输入框 steering 手势**：输入在运行期间锁定（只能停止或等待），因此 steering 场景从页面走 wire 做 steer；`TODO(web-steer-composer)` 待产品长出真实的输入框手势后，把驱动步骤升级为该手势。
- **拖拽会话重排**：`workspace.insertSessionBefore` 尚无浏览器场景；它需要在同一个工作区里物化两个会话，并合成 HTML5 拖拽事件。当该表面变更或回归时再补充。无行为的会话 Rename/Fork/Delete 和工作区 Delete 菜单行待获得行为后再补充场景。
- **长历史 Chat 到 Trajectory 的 Inspect**：两个视图共用 Session 分页，而所选 Trajectory 记录由一个派生的表格索引定位；随着较早页面前插，该索引可能移动。短历史 Inspect 仍有覆盖；在选中项具有稳定的语义身份之前，长历史交互约定不包含这项交接。

## 后果

Web 表面获得了录制一次/永久回放的层级：真实 chromium → SSE → apiproxy → 循环 → 工具 → 持久化的链路以约 10-30 秒无密钥运行，重复运行结果确定，fixture 由车道自身持有并可重录。接受的成本：每次有意的会话 UI 变更都以一次无密钥 `DSH_SNAPSHOT=refresh` 收尾（预期输出变动是受评审的 diff，锚断言保住语义绿色）；aria 格式归 Playwright 所有——仓库唯一不受自己控制的提交快照格式——因此 playwright 版本升级必须是刻意的升级加刷新提交（依赖在 `apps/web/package.json` 中浮动为 `^1.49.0`；若变动伤人则改为精确锁定）；回放的首次调用顺序绑定把每个场景限制为至多一个发起提示的会话，消费断言是绊线；`compaction-basic` 与会话共享回放游标，仅在目录中发布的 128k 上下文窗口下保持闲置；必需的消费方任务承担 Chromium 供给与一次浏览器运行的成本，使改动组装后 UI 的 PR（Pull Request）持有相应的预期输出 diff。按需启用的性能车道保留了可重复的诊断工作负载，又不会向 CI 添加受 host 差异影响的时长或内存预期；在仓库拥有经校准的基准测试环境之前，性能回归仍是需要人工解读的信号。
