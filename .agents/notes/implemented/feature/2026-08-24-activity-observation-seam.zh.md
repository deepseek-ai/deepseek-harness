# Agent Note：activity 观察 seam（`ctx.activities`）与 Web 客户端实时输出流

状态：implemented

Superseded：本文描述的独立 seam 已折入 `ctx.jobs`，成为逐 job 的观测 record——见 [jobs 吸收 record](../architecture/2026-09-01-jobs-absorb-activity-record.zh.md)；下文关于持久化与实时通道的分析仍然成立。

[English](2026-08-24-activity-observation-seam.md) | 中文

## 问题

shell、terminal 与 jobs 各层的增量读取器全都是单读者且消费型的：`ShellProcess.readOutput()`、`TerminalSendOperation.readOutput()` 与 `JobRegistry.read()` 返回即销毁增量，因为预期读者就是持有模型。[Web 后台任务显示](2026-08-08-web-background-job-display.zh.md)在这一前提下交付了 roster——其载体被测试钉死绝不调用 `ctx.jobs.read()`，否则浏览器读取会无声偷走模型 `job_output` 永远看不到的字节——并把输出阶段明确推迟给"一个独立的非消费观察 API"。于是人在 Web 客户端只能看到后台构建"在跑"，看不到一行输出；脚本被告知用来叙述进度的 `workflow/log` / `workflow/phase` 事件更是全无消费者。

bash 之下的底座其实早有正确形态：`SubprocessOutputReader.readFrom(fromByte)` 是按 offset、明确非消费的，`bash-local` 在 shell seam 把它窄化成了单游标对。

## 决策

新建能力 seam `packages/activity/`，作为非消费观察面。**activity** 是一个可观察的长时工作单元：一条 append-only 的有界输出流加实时状态。该 seam 是纯观察——不启动、不取消任何工作，对模型不可见。模型可见事实原地不动（工具结果、`ctx.jobs` 游标），"模型可见 ⟺ 已记录"不变量不受影响；不装该 seam 的组合只失去实时观察。

- **`@deepseek-ai/dsh-activity`（Service Definition）**——`ctx.activities` 上的抽象 `ActivityRegistry`：`open(spec) → ActivityHandle { append, updateDetail, end }`、有栅栏的 `get`/`list`、按绝对 UTF-8 字节 offset 的非消费 `read(id, from)`、owner 相对投递的 `onActivitiesChanged`（roster）与 `onOutput`（推进信号，只带 id）。`ActivityCorrelation { callId?, jobId? }` 把行关联到工具调用与 job。`pumpActivityOutput` 是 pull 型底座的共享泵。
- **`@deepseek-ai/dsh-activity-local`（Service Provider）**——每个 activity 一个内存 chunk 环。offset 跨淘汰稳定（`outputEarliest` 指明最老保留字节；低于它的读取是 `lossy` 而非错误）；单个超上限 chunk 保留 UTF-8 安全尾部并带 `gapBefore`。配置 `retainBytes`（256 KiB）存活，结算时裁到 `settledRetainBytes`（16 KiB）。记录存续期长于生产者 fiber；owner 销毁强制终结并移除；`end` first-wins，end 后写入记日志后丢弃，生产者的收尾 flush 砸不掉自己的 teardown。
- **`@deepseek-ai/dsh-api-activity-controller`**——wire 层，取 workspace-controller 的形态：`activity.control` 流出一份 roster baseline 加按 owner 会话的整桶替换帧（jobs 帧的自愈语义）；`activity.observe({ activityId, from? })` 流出一帧 `opened` 锚点、合并的 `output` 帧（`flushMs` 窗口、`maxFrameBytes` 软预算）、再在同一条流上发终态 `status` 后关闭——结算永远不会与仍开着的输出通道竞态。重连以上一帧的 `next` 续传。客户端半区安装 `ctx.activityFeed`（roster 镜像 + 按引用计数的观察流与有界渲染尾巴）。
- **`@deepseek-ai/dsh-client-ui-activity`**——会话头部任务列表（[与 job 行合并](../../archived/feature/2026-08-25-unified-task-list.md)）；展开某行即把其观察流打开进 `TerminalBlock` 面板，收起即关——只有有人在看时输出才流动。`TerminalBlock` 本身获得实时渲染能力：running 且提供了 `output` 的块在 running 状态下显示文本，而非历史上的仅提示行画面。

生产者一律经 `ctx.get('activities')` 尽力镜像，绝不声明 inject，一切观察失败只记日志并吞掉——该 seam 严格可选，永远不能破坏它所观察的工作：

- `ShellProcess` 新增可选 `observed`——底座的非消费 offset 读取器复出（bash-local 与 pwsh-local 返回 `handle.collected`；e2b subprocess provider 满足同一契约）。`dsh-tool-bash` / `dsh-tool-pwsh` 在 `jobs.start()` 提交后打开带关联的 activity，并以 `activityPollMs`（默认 150 ms）泵取 `observed`。
- `dsh-tool-workflow` 把每个被记录的顶层运行镜像为 push 形态的 `workflow` activity，让此前无人消费的 `workflow/phase` / `workflow/log` 事件有了消费者。

### 为何不用持久会话事件、control 流或 jobs seam

同行产品收敛于同一切分（Codex 在 rollout policy 里把所有 exec 输出 delta 标为 "Transient, non-durable"；Claude Code 持久化文件路径而非 delta；Kimi 的信封有一等的 `volatile: true`；OpenCode V2 把 V1 逐 chunk 持久化 part 更新纠正为 "stream fragments are live-only"）。在本仓库持久路线还有具体的坏处：chunk-run 打包只认三种 `assistant/chunk` 形态，新输出事件零压缩；每事件一条未合并的 WebSocket 帧；重连缺口修复要重读窗口——且 job 显示 note 已否决过它（"spill 的存在就是为了让超大工具输出不进日志"）。session control 流的整值帧对 roster 自愈、对流则是二次方开销。扩 jobs seam 只覆盖 jobs——workflow 叙述与未来的前台流都覆盖不到——还要重翻已定案的"生产者拥有自己的缓冲"；activity 面转而复用底座既有的 offset。

### 两套游标制，各归其位

模型保留消费游标（`job_output` 语义不变，本次工作零 prompt/工具改动）；观察者拿任意多读者可共持的绝对 offset。这正是最强的同行范式（Codex：模型用破坏性 drain，基础设施用 seq 游标读取），也是 wire 路径可证明"不偷字节"的原因。

## 曾考虑的替代方案

**持久 `activity/output` 会话事件 + conversation node。** 回放免费，但上述日志膨胀账加上对每个 follower 的保留压力否掉了它；transcript 侧的持久故事仍是生产者的工具结果。

**给 `SessionControlFrame` 加输出。** 少一条流，但整值语义会按 chunk 重发累计缓冲——恰好在会增长的数据上 O(n²)。

**信号帧 + RPC 拉取。** subagent catalog 的形态；因 job 显示 note 记录的权威割裂机制而否决，且它在结算时刻失效得最难看（行还在跑、流已死）。

**在 jobs seam 内做观察。** 一个集成点，但只对 jobs；前台运行、terminal 与 workflow 叙述各需另一套机制，注册表还得在生产者自己的缓冲旁再养一份。

## 测试

单测钉住注册表（offset、淘汰、UTF-8 安全裁尾、lossy 读取、first-wins 结算、owner 清理、scope 投递、监听容错、HMR 可逆、带行配置的 Loader 组合）、泵（节奏、每源游标、lossy `gapBefore`、结算排干、定时器卫生）、controller（baseline/桶帧、锚点/输出/状态排序、续传、帧切分、有栅栏的有主读取、abort）、客户端模型与引用计数流，以及两类生产者接入（bash 用真实子进程输出，含"绝不偷模型游标"断言；pwsh 用脚本化读取器；workflow 用事件驱动镜像，含可选性承诺要求的 throwing-registry 容错）。无钥 web e2e 经完整组合驱动真实 `run_in_background` bash，钉住命令仍在运行时流式面板与注册表 kill 后已结算面板的 ARIA golden。

## 后果

Web 客户端在零模型面改动下获得后台 bash/pwsh 实时输出与 workflow 叙述；任何插件对着一个可选服务用三个调用（`open`/`append`/`end`）即可接入。代价是多一个 seam 家族与每生产者一个接入点；最初的双头部列表重复已折并为[单一任务列表](../../archived/feature/2026-08-25-unified-task-list.md)。暂缓项记录在各包 README：前台流式（需 shell seam 的 run/observe 变体）、terminal `pty-send` 观察（需给 terminal 缓冲加非消费面）、人工 kill 控件（被 jobs `reported` 契约阻塞）、SDK/ACP 消费端、重启后的持久回放。
