# Agent Note: Claude Code 与 Codex subagent 后端

Status: implemented

[English](2026-08-04-claude-code-and-codex-subagent-backends.md) | 中文

## 问题

命名的 [`ctx.subagents`](2026-06-21-subagent-capability-seam.zh.md) 注册表让父 agent（智能体）无需了解子 agent 的运行方式即可委派工作，但 harness 需要通往真实 Codex 与 Claude Code 产品的第一方路径。每条路径都必须向产品交付一项自包含任务，让它在父会话的工作区中执行，返回最终回答或明确的失败或取消结果，并且不留下任何受管的产品进程。

产品集成不得成为任务文本、cwd、取消、结果结算或进程树的第二责任方。因此，所需证据要区分三个事实：无密钥真实产品测试证明官方集成、原生身份验证形态、确定性答案与资源清理；Loader 组合测试证明公开包和文档所示的工具配置无需启动产品即可加载；带密钥 e2e 证明生产提供方与真实产品能够从真实 DeepSeek 服务取得唯一答案。直接发起模型 HTTP 请求或使用产品替身无法取代上述任一产品运行层级；手工挂载插件无法取代 Loader 层级。

## 决策

harness 交付两个同级的一次性提供方包，其默认注册名称分别为 `codex` 与 `claude-code`。本说明负责它们的产品协议、结果映射和进程生命周期；[命名实例决策](../../archived/feature/2026-08-18-product-subagent-named-instances.md)负责 Profile 选择的提供方身份、可选实例模型与静态工具绑定；[生产安装排除决策](../../archived/simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md)负责各自独立的可选 Bundle 与 host plane（宿主平面）放置；[tool-subagent README](../../../../packages/subagent/tool-subagent/README.zh.md) 负责模型可见的调度选择；[非交互权限决策](2026-08-15-product-subagent-noninteractive-permissions.zh.md)负责各产品提供方的 Profile 模式选择与安全权限决定；[最小诊断决策](../../archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md)负责粗粒度产品行动类别。两个包都接受多个命名实例。加载任一提供方都不会启动产品进程，而且每个工具只接受独立文本任务；产品与实例选择仍属于部署配置。

这两个提供方都报告 `inheritsParentContext: false`，不声明任何可选的启动能力，并传递父会话 cwd，但不会复制父级对话。文档所示的工具使用 `backgroundMode: 'one-shot'` 与 `maxDepth: 'provider-managed'`：消费方默认在前台收集结果，也可把同一次运行放入通用 Job 运行时，而递归策略仍由进程外产品负责。每次调用都会创建一个全新的产品进程和一次不可续接的产品对话。`ctx.subagents` 负责具名请求解析与成对生命周期事件；`dsh-tool-subagent` 负责模型可见的调度以及前台与 Job 适配；`ctx.jobs` 和 `dsh-tool-jobs` 负责 Job id、状态、输出、控制、通知与父级 owner 取消；各产品提供方负责原生结果映射，`dsh-subprocess` 则负责凭证清洗、进程树终止以及整棵进程树的退出观测。

```text
configured tool -> dsh-tool-subagent -> ctx.subagents -> product provider -> product process
  foreground <- final product outcome
  background -> ctx.jobs / dsh-tool-jobs -> Job id / state / notice / controls
  both -> provider disposal -> dsh-subprocess -> whole-tree exit
```

### 归属与生命周期

| 层级 | 责任方 | 职责 | 可观察结果 |
| --- | --- | --- | --- |
| 委派生命周期 | `ctx.subagents` | 解析具名提供方请求，并为已发布的 `SubagentRun` 配对生命周期事件 | 不受支持的上下文或格式错误的输入会在发布运行前报错；启动与终态事件保持成对 |
| 调度与适配 | `dsh-tool-subagent` | 解释 `run_in_background`，选择前台收集或 one-shot Job 登记，并映射共享停止原因 | 前台返回产品结果；后台在登记完成后返回 Job id |
| Job 状态与控制 | `ctx.jobs` 与 `dsh-tool-jobs` | 负责 Job 状态、输出、取消、owner 清理、完成通知与面向模型的控制工具 | 准确父级可以收集、列出或停止后台工作，并收到完成通知 |
| 原生运行与清理 | 产品提供方与 `dsh-subprocess` | 产生一个原生结果、关闭产品协议、请求尽力而为的原生取消，并证明进程树退出 | 前台返回与 Job 结算都会等待幂等资源释放和整棵进程树退出 |

## Codex 提供方

`@deepseek-ai/dsh-subagent-codex` 注册由 Profile 选择、默认值为 `codex` 的提供方名称，解析锁定的 `@openai/codex@0.149.1` 包所声明的 `codex` bin，并使用当前 Node 可执行文件加 `app-server --stdio` 启动该 wrapper。Wrapper 会选择私有原生平台载荷；提供方既不解析也不回退宿主 `codex`。其公开配置包含非空的 `providerName`、可选的非空 `model`、显式的 `env` 覆盖项、须为正有限值且不得大于仓库共享 `MAX_TIMER_DELAY_MS` 的 `disposeGraceMs`，以及默认使用 `never` 的三值原生 `permissionMode`。每个命名实例会为自己的运行保留这些已解析值。显式模型会原样传给每个临时 `thread/start`；省略时仍以 Codex 原生设置为权威。安装、登录、`CODEX_HOME`、模型发现或 fallback、基础 URL 和产品会话设置仍由 Codex 原生机制或部署环境负责；所选模式只拥有非交互权限决策中描述的线程 approval／reviewer／sandbox 字段。

发布前，提供方会验证非空的纯文本任务，在父级工作区中启动受管的 app-server，完成 `initialize` → `initialized` 握手，把可选模型与已解析模式映射为官方 `thread/start` 字段，并创建一个 `ephemeral: true` 线程。固定 app-server argv 不包含模型、模式或任务文本。已发布的运行只拥有一次 `turn/start`；其线程 ID 与轮次 ID 保持私有，绝不会持久化到父会话。

`turn/completed` 是权威的远端终止事实。以最后一条带有 `phase: "final_answer"` 的 `agentMessage` 为准，且选中的消息必须包含非空白文本。若产品没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退，该消息也必须包含非空白文本；过程说明绝不会取代上述任一答案。[最小诊断决策](../../archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md)负责 Codex 行动类别、HTTP status、生命周期阶段、进程结果与终止原因保持。本地取消仍是 `aborted` 且不附带失败诊断。

对于命令与文件审批，无人值守的协议连接会从请求给出的决策选项中选择一项不予批准的决策，并优先选择 `cancel`；稳定的 0.149.1 请求形态没有决策选项列表，因此回退到 `decline`。它不授予该轮次请求的任何权限，不向用户输入请求提供任何答案，并拒绝 MCP elicitation。它会记录这些请求、被拒绝的命令／文件 item 与结构化 `sandboxError` 终态的安全类别。产品 stderr 会原样转发给 Host，但既不会被分类，也不会复制进诊断。若请求在无人值守模式下没有合法响应，或是未知服务器请求，此次运行就会失败，而不会等待本提供方没有提供的用户界面。

若启动在发布前失败，提供方会关闭协议连接、终止已获取的进程树、等待其退出、移除 stderr observer，然后用固定操作阶段拒绝 `start()`。对已发布的运行执行资源释放时，提供方会尽力中断已知轮次、关闭协议连接、结束标准输入、调用共享的逐级终止机制，等待整棵进程树退出，并移除 observer。独立清理失败会报告 `teardown`；启动与回滚同时失败时，聚合的顶层消息会保留两条安全阶段说明，而底层 cause 仍只在内部可见。

Codex 0.149.1 使用 Responses 协议，而 DeepSeek 的公开 OpenAI 兼容端点使用 Chat Completions。因此，带密钥 Codex e2e 会采用一个仅限回环、仅供测试内部使用的桥接层来处理一次不使用工具的随机数请求：真实 Codex 将 Responses 发送到桥接层，桥接层把收到的 Bearer 凭据与提取出的任务转发到固定的 DeepSeek 官方端点，再将真实文本包装进最小化的 Responses SSE（Server-Sent Events）生命周期。该桥接层既不是生产代理，也不能作为 Codex 原生连接 DeepSeek Chat Completions 的证据。

## Claude Code 提供方

`@deepseek-ai/dsh-subagent-claude-code` 注册由 Profile 选择、默认值为 `claude-code` 的提供方名称，并调用 `@anthropic-ai/claude-agent-sdk@0.3.241`。提供方会省略 `pathToClaudeCodeExecutable`，因此 SDK 会从自己的 optional dependency 闭包中，按操作系统、CPU 与 Linux libc 选择携带 Claude Code 2.1.241 的匹配平台包。提供方既不会解析也不会回退宿主 `claude`；省略 optional dependency、不受支持的平台，以及缺失或损坏的平台载荷，都会在第一次委派的 SDK 启动边界失败。提供方使用官方 `query()` 入口点，并把 SDK 的 `spawnClaudeCodeProcess` 给出的原生 `claude` 或 `claude.exe` 命令、参数、cwd、环境和转发的信号交给 `dsh-subprocess`；其私有 `SpawnedProcess` 适配器只公开 SDK 所需的流、事件、终止和退出事实。

公开配置包含非空的 `providerName`、可选的非空 `model`、显式的 `env` 覆盖项、须为正有限值且不得大于仓库共享 `MAX_TIMER_DELAY_MS` 的 `disposeGraceMs`，以及默认使用 `dontAsk` 的五值原生 `permissionMode`。每个命名实例会为自己的运行保留这些已解析值。显式模型会原样传入 `Options.model`；省略时不设置该字段，由原生设置选择模型。每次运行都会创建自己的 `AbortController`，设置 `persistSession: false`、禁用 `AskUserQuestion`，并把已解析模式传给 SDK；只有 `bypassPermissions` 会取得 SDK 的显式危险确认。提供方故意省略 `settingSources`，因此 SDK 会相对于父会话 cwd 读取宿主机常规的用户、项目和本地 Claude 设置。它既不复制也不过滤这些设置，也不会创建或修改登录状态。其余权限提示会被拒绝，MCP elicitation 会被拒绝，阻塞对话会快速失败，而不会等待本提供方不负责的用户界面。

只有在 SDK `Query` 与受管的活动 CLI 句柄都已存在后，提供方才会发布运行。它会消费完整的 SDK 流；只有 `result` 消息具有 `subtype: "success"`、`is_error: false` 和非空白 `result`，且迭代器随后正常结束时，运行才会完成。[最小诊断决策](../../archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md)负责所有非成功行动类别、阶段、进程结果，以及它们与参与失败的权限决定之间的顺序。本地取消会胜出并成为 `aborted`，且不附带这两类诊断事实。

启动回滚和已发布运行的资源释放都会关闭 SDK query、中止该次运行的控制器、调用共享的进程树终止机制，并等待整棵进程树退出。`Query.close()` 表达优雅的协议关闭意图，但不能取代子进程责任方的退出证明。未发布失败只公开固定的 `query-start` 事实；已发布进程失败可以分别公开退出码与信号；独立清理拒绝则公开 `teardown`。原始 SDK、Host 与清理错误只保留在内部 cause 链和日志中，不进入诊断。

带密钥 Claude Code e2e 直接使用官方 DeepSeek Claude Code 约定：仅在运行时提供的 DeepSeek 密钥会映射为 `ANTHROPIC_AUTH_TOKEN`，固定的官方基础 URL 会追加 `/anthropic`，主模型与 subagent 模型变量会选择文档所示的 DeepSeek 模型。该测试会启动生产提供方与真实 SDK 和 CLI，要求一个随机数作为完整答案，不会把任何凭据持久化到设置中，并等待所有受管句柄退出。

## 分发与证据

每个产品都负责覆盖所有分支的包测试、一项必跑的无密钥真实产品测试、一项 Loader 组合 e2e 和一项带密钥 DeepSeek e2e。无密钥产品层级使用被测的确切官方发行版、非空的伪产品密钥、隔离的临时工作区与产品主目录，以及能返回固定答案的回环模型。产品请求缺失、身份验证错误、任务文本被改动、答案不完全一致、真实产品被跳过或受管句柄仍存活，都会使这项必跑测试失败。Codex Loader fixture 会公开两个命名 Codex 实例与工具；Claude Code Loader fixture 会公开默认 Codex 工具以及两个命名 Claude Code 实例与工具。两个 fixture 都包含通用 Job 控制工具，而且不会启动任何产品进程。带密钥层级会使用仅在运行时提供的密钥启动同一生产提供方与真实产品，要求从固定的 DeepSeek 官方服务取得唯一随机数，并再次证明完全停稳；仅当本地操作者未提供密钥时才会自行跳过，而受信任的 CI 会预检该 secret。

Codex 证据会锁定 `@openai/codex@0.149.1`、`codex-cli 0.149.1` 与六个平台 alias。生成 schema 会证明可选的 `ThreadStartParams.model`；真实产品测试会观测省略模型继承、两个显式实例模型、包内 wrapper argv、确切的 Bearer 密钥、原始任务、逐字节完全一致的最终回答、原生权限模式、测试拥有临时存储中的显式危险绕过写入，以及 wrapper／原生整棵进程树退出。独立 wrapper fixture 会证明载荷缺失时不回退宿主命令，命名实例会保留彼此独立的模型、环境与模式，生产环境也不会从 `PATH` 解析宿主 `codex`。[最小诊断决策](../../archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md)负责失败、进程结果与最终呈现证据。

带密钥 Codex e2e 会注册生产提供方，启动同样的真实 app-server，并通过上述测试专用桥接层请求一个随机数。该测试固定外部端点与模型，不存储任何凭据或请求载荷，要求上游恰好完成一次响应，将去除首尾空白后的产品答案与该随机数逐字节比较，并等待所有受管句柄退出。

Claude Code 证据会锁定 Agent SDK 0.3.241、Claude Code 2.1.241 与八个 SDK 平台包。真实产品测试会让 SDK 选择已安装载荷，断言共享子进程 argv 以该包的原生 CLI 开头，并观测省略模型继承、两个显式实例模型、确切的 `x-api-key`、原始任务、逐字节完全一致的最终回答、原生权限模式、测试拥有范围内的拒绝写入与 bypass 写入，以及整棵进程树退出。包测试还会证明生产运行从不解析宿主 `PATH`、省略可执行文件覆盖，并直接转发 SDK 所选的 Windows `claude.exe` 而不经过 batch shim。这项证据证明锁定的官方 SDK/CLI 集成，而不证明与独立安装的 Claude 版本兼容；[最小诊断决策](../../archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md)负责失败与进程结果证据。Loader 覆盖会通过各自的可选 Bundle patch 解析两个产品，且不会启动任一产品。

带密钥 Claude Code e2e 仅在提供方的内存环境中映射密钥与固定的官方端点，把模型变量设为文档所示的 `deepseek-v4-pro[1m]` 与 `deepseek-v4-flash`，并实际经过生产提供方、官方 SDK 与真实 CLI。它将去除首尾空白后的结果与一个随机数比较，并证明整棵进程树退出，且测试不会直接调用 Messages API。

项目所有者的分发授权范围限定为官方 `@anthropic-ai/claude-agent-sdk` 身份，以及每个 SDK 版本通过 `optionalDependencies` 声明的官方 Claude Code CLI 与平台载荷。[`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) 会推导并披露当前载荷集合，但不会将其声明条款重新归类为宽松条款。版本、许可证字段和载荷集合发生变化时，仍须经过常规的依赖、锁文件、兼容性、条款和声明评审；无关的非宽松运行时包继续以默认拒绝方式失败。

## 曾考虑的替代方案

**直接模型 HTTP、`codex exec` 或手写的 Claude CLI 协议。** 这些路径会绕过产品的官方可扩展集成接口，无法证明原生配置、工具、审批、结果语义或资源清理。每个提供方都改用相应的官方产品集成。

**共享产品进程辅助包。** 现有 subagent 与子进程 seam 已负责围绕任务、结果、环境和进程树的全部共享职责。新辅助包无法删除任一私有产品适配器，只会造成责任重复，因此每个适配器都会直接调用现有 seam。

**面向模型的产品选择器。** 产品可用性、实例配置和身份验证属于部署事实。由 Profile 绑定的工具使各自的 schema 与提供方绑定保持明确，也避免在通用服务中添加动态选择状态。

**以产品替身作为强制证据。** 替身可以穷尽覆盖私有协议分支，但无法证明包导出、官方发行版、身份验证或真实进程行为。强制证据会驱动每个官方产品连接回环模型 fixture。

**由插件管理登录、产品主目录、模型发现或 fallback、设置、沙箱规则或细粒度权限策略。** 这些选择会在每个产品的原生配置之外建立另一套权威来源，并将一次性提供方扩张为账户管理功能。官方产品支持时，提供方可以传入一个不透明的 Profile 模型覆盖，但不会发现、校验、解释别名或在模型间 fallback。任一提供方都不会镜像产品规则或增加人工交互通道。

**续接、进度、产品原生后台状态和共享父级上下文。** 提供方载荷仍是一项自包含任务的一个最终回答。通用 Job 层可以额外提供 id、状态、通知、收集与取消结果，但产品会话、恢复、后续交互、中间消息、父级 transcript（文本记录）传递、结构化输出和提供方专属后台状态都需要独立的用户约定，当前实现不会预先构建这些功能。

## 后果

用户通过由 Profile 配置、并由官方产品集成支持的一次性工具进行委派。显式 Profile 安装与 host plane 提供方放置由[生产安装排除决策](../../archived/simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md)负责；命名实例身份与工具绑定由[命名实例决策](../../archived/feature/2026-08-18-product-subagent-named-instances.md)负责；按 Preset 暴露工具以及默认前台且可选通用 Job 的调度方式由 [tool-subagent README](../../../../packages/subagent/tool-subagent/README.zh.md) 负责。本说明规定的提供方生命周期会保留原生设置与行为，而共享服务继续独占作业结算与进程树完全停稳的责任。

每次委派都要承担新建产品进程和独立模型上下文的开销。成功的产品载荷仍只有最终 assistant 文本；失败的产品运行可以另行公开共享安全诊断，其中包含由提供方拥有的权限事实与安全产品失败类别。后台调度还会额外公开通用 Job id、状态、完成通知以及收集或取消结果。两个产品都使用 Bundle 锁定的平台 CLI，并保留原生账户与工作区设置以及所选提供方权限模式；受支持的可选实例模型只覆盖该次运行的原生模型选择。带密钥 e2e 运行还会消耗外部 API 配额，并依赖 DeepSeek 官方端点；对协议、失败、取消与审批的确定性覆盖仍由无密钥层级承担。提供方不会恢复会话、以流式方式传送进度、接受新的人工交互、回滚工具或文件副作用，也不会施加按实际经过时间触发的超时。

兼容性由包级单元测试覆盖率、无密钥真实产品回环测试、带密钥 DeepSeek 随机数测试、公开 Loader 组合、已构建包与 NodeNext 消费方检查、生成的文档与声明以及仓库 CI 矩阵共同锁定。更改受支持的产品基线或 DeepSeek 端点／模型基线时必须刷新这些事实；生产环境不会另行执行运行时版本探测。
