# Agent Note: TypeScript SDK 客户端与 SDK subagent 后端

Status: implemented
Archived: 2026-09-04

[English](2026-07-27-typescript-sdk-and-sdk-subagent-backend.md) | 中文

## 问题

stdio JSON-RPC 对外服务接口（`@deepseek-ai/dsh-sdk-jsonrpc-server`，见[单文件可执行 Agent Note](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)）当时只有一个客户端：Python SDK。想要同样「把 harness 作为子进程驱动」能力的 TypeScript 消费方——仓库测试、自动化，尤其是一个其子进程是*完整 harness 运行时*（而非通用 ACP agent（智能体））的 subagent 后端——没有可导入的内容：请求/通知载荷形状只以匿名对象字面量存在于服务器内部，传输类也躺在服务器插件包里。

## 决策

三个包，分层与既有 Python 栈完全一致，外加一个 Service Provider 注册：

- **`@deepseek-ai/dsh-sdk-protocol`**（`packages/sdk/protocol/`）—— 把协议格式做成共享且具名。`JsonRpcLineTransport` 位于此处，`types.ts` 为服务器所说的每个载荷命名：`InitializeParams/Result`、`SessionPromptParams/Result`、四个通知载荷，以及 `HarnessSdkRequestMap`/`HarnessSdkNotificationMap` 索引。`InitializeParams` 携带提供方、模型、可选且由适配器持有的推理强度，以及可选输出上限。该包根显式导出完整接口，且不提供指向源模块的深层导入。服务器的 `notify()` 调用点以这些具名载荷标注类型，服务器漂移会先破坏编译而不是破坏客户端。错误响应以携带协议 `code`/`data` 的 `JsonRpcResponseError` 拒绝，与 Python 客户端一致。
- **`@deepseek-ai/dsh-sdk-client`**（`packages/sdk/client/`）—— `python/sdk` 的 TypeScript 孪生：`HarnessClient`（spawn、分帧、通知扇出、有类型的错误表面、经共享 dispose（资源释放）阶梯关闭至完全停稳）之上是 `DeepSeekHarness`/`HarnessSession`（惰性启动、记忆化 `initialize`，以及让一次 `run()` 与其自有 `session/prompt` 活动配对）。其包根消费方接口显式导出两层客户端、面向调用方的类型，以及协议包所拥有的 `JsonRpcResponseError`；源模块、规范化辅助函数和通知投递端都保留为内部实现。`RunResult.events` 只包含根会话的类型化事件，而 `notifications` 则保留根会话及从 `subagent.started` 发现的后代各自的会话 id；会话树范围限定在客户端完成，镜像 `client.py`。结果携带根会话最终的助手文本，但不包含提示词级状态或轮次原因。启动接口解析同版本 `@deepseek-ai/dsh` 依赖并选择具名 profile，可选配置包括 `dshBin`、有序 patch、显式 Harness home、进程 cwd、环境和超时；任意 command/argv 启动只作为内部 fake-runtime 适配器。`initialize` 携带提供方、模型、可选推理强度与可选输出上限。干净 checkout 中若不存在 `lib/bin.js`，client 会通过绝对 `tsx/esm` loader 使用该包的源码入口，并应用一个省略构建期生成 Typert 贡献加载的内部 patch；SDK 协议不消费这些贡献。`env` 整体替换而非合并，并在 `start()` spawn 时读取，因此凭据策略归调用方，且调用方可在首次使用前完成环境准备。握手失败但清理成功时，实例会换入全新 client，使后续调用通过新进程重试；若初始化与 SDK 自有清理均失败，`start()` 会以有序 `AggregateError` 拒绝并保留失败的 client，而不会在尚未证明原进程退出时并排 spawn 新进程。拆除走私有的 stdin-EOF → SIGTERM → SIGKILL 阶梯直到真正退出，因为 client 运行在任何 harness 上下文之外。
- **`@deepseek-ai/dsh-subagent-dsh-sdk`**（`packages/subagent/subagent-dsh-sdk/`）—— 第二个进程外 `SubagentProvider`，采用与 `subagent-acp` 对等的结构，但声明 `agentOptions: true`：每次运行都会把提供方／模型／推理强度／maxTokens 合并到实例默认值之上，并且只把这些字段送入子进程 `initialize`。其他启动能力保持 false，`inheritsParentContext: false`。提供方保留握手后发布所有权事务、通过 `onError` sink 将结果归一为绝不拒绝，以及父命名空间 run id。子答案从流式 `session.event` 读取——最后一条完整 `assistant/message`，否则累积的 `text-delta` 块，部分答案在取消时得以保留。停止原因由子进程的结构化 `TurnEndReason` 映射：`completed`、`max-tokens` 与普通 `aborted` 直通，`blocked` 变为 `refusal`，其他非完成值变为 `error`。可达子失败与 SDK 错误会附加[进程外诊断决策](2026-08-21-out-of-process-subagent-minimal-diagnostics.zh.md)定义的有界安全诊断，只使用一个 category 和当前提供方 stage。其 `dshBin`／profile／patch／home 配置选择隔离的 SDK 应用，`env` 则提供子进程专用的显式值，例如其 API key。
- **subagent seam 新增 `out-of-process.ts`**：两个进程外后端共享的 provider 侧词汇——`NO_START_CAPABILITIES`、时限校验、子进程 cwd 解析（配置覆盖、否则发起委托的父会话工作区）、绝不拒绝的 `settleRunResult`、以及 `subprocessRunHandle` 发布。进程机制（spawn、环境清理、进程树清理）属于 `dsh-subprocess` seam；`subagent-acp` 经 `ctx.subprocess` spawn 子进程，本后端则经 SDK 客户端 spawn 子进程（subprocess README 记载的 SDK 托管传输例外）并自行应用该 seam 的 `scrubbedParentEnv()`。

`dsh-sdk-jsonrpc-server` 会在 `initialize` 期间校验确切的提供方／模型／推理强度路由，只保存显式提供的推理强度与 token 值，并使用这条固定的进程级路由创建每个 SDK 根 Agent。由于 JSON-RPC 请求可能并发分派，它会在一次初始化成功完成前拒绝 `session/prompt`，避免待定或非法路由回退到构造期默认值。TypeScript 与 Python 客户端都通过 `dsh --profile sdk` 公开同一组初始化字段；Python wheel 会打包该 CLI 及其封闭依赖树。

## 测试

四层，依[测试政策](../../../../docs/testing.zh.md)：

- **免密钥单元**——`sdk-client` 通过真实 stdio 驱动脚本化伪运行时（`tests/fake-runtime.ts`，环境变量脚本化、纯协议——即 Python `test_client.py` 的模式）；`subagent-dsh-sdk` 经真实提供方驱动同一伪运行时，覆盖逐次路由覆盖、可达子原因、typed 错误，以及 initialize/session-run/shutdown 诊断。三个包全部 100% 逐文件覆盖。
- **免密钥 Loader 组合**——`subagent-dsh-sdk/tests/loader-composition.e2e.ts` 启动包自有测试组合（`packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/`），其中子进程是真实的第二个 `dsh --profile sdk` 运行时，拥有独立 home 与有序 patch；工具结果与持久化请求 header 会证明提供方、模型、推理强度、maxTokens 与父会话 cwd，失败场景则固定与部分输出分离的模型可见子错误诊断。
- **免密钥快照**——`snapshots/sdk/sdk.snapshot.ts` 通过真实 `dsh-sdk-client` 驱动真实 `dsh --profile sdk` 运行时，并通过有序 `llm-replay` patch 回放已录制 fixture（测试前置数据）。一个 DSH SDK 场景把模型选择的路由固定在委派工具、第二个 SDK 运行时及子级持久化请求 header 中；另一个场景固定安全诊断的规范化通知流、SDK 结果、持久日志与前台/后台失败文本。
- **带密钥 e2e**——快照套件的 `DSH_SNAPSHOT=record` 模式即真实 API 路径（已提交 fixture 由它产出）；组合 e2e 设计上无需密钥。

## 考虑过的替代方案

**从 `dsh-sdk-jsonrpc-server` 导入协议类型而不是提取协议包。** 会让每个 SDK 消费方（包括绝不能提供 JSON-RPC 服务的 `subagent-dsh-sdk`）依赖服务器插件及其 `dsh-agent`/`dsh-llm-deepseek` peer 集合，且通知载荷仍然匿名。能力 seam 规则（Service Definition/Service Provider/Consumer 三个包分立）已经点名了这种形态；这个传输是货真价实的双边物。

**让 `subagent-dsh-sdk` 直说裸 JSON-RPC、绕开客户端 SDK。** 会复制 SDK 存在意义所在的请求/通知配对、订阅扇出、超时与拆除逻辑；用户的要求明确是一个*使用* SDK 的后端，分层的回报是后端成为可复用客户端之上约 200 行的纯策略。

**把 SDK 后端折进 `subagent-acp`、用传输开关区分。** 两个后端共享子进程生命周期，但协议（ACP SDK 连接 vs harness JSON-RPC）、子进程约定（任意 ACP agent vs harness 运行时）、结果提取（`agent_message_chunk` 累积 vs 会话事件读取）毫无共享。配置判别字段会把两个协议埋进一个包；真正共享的提供方侧部分移入 subagent seam 的 `out-of-process.ts`，进程机制则住在 `dsh-subprocess` seam。

**只从 `PATH` 解析 `dsh`。** 拒绝：Node 消费方不一定继承项目本地 `.bin` 目录。同版本包依赖为已安装消费方提供构建后 CLI，并为干净 checkout 提供源码入口。

**导出源模块、规范化辅助函数和订阅投递端操作。** 这些都是调用方不需要的实现细节；暴露它们会让调用方不得不理解客户端如何校验与分发协议输入。各包根转而枚举受支持的客户端接口与协议接口，客户端则只重新导出调用方必须区分的那一种协议错误。

**复用 `dsh-session-snapshot` 的 ACP `runScenario` 做 SDK 快照。** 该适配器说 ACP（`ClientSideConnection`、`InputStep` 脚本）。SDK 套件的全部意义就是以 *SDK 客户端*为入口；它复用 normalize/refresh 库层（`normalizeSessionLog`、`refreshFixtureReplacements`……），不动 ACP 适配器。

## 后果

**收益**：SDK 运行时协议拥有服务器与两个客户端 SDK 共享的、编译器校验的具名类型；TypeScript 消费方获得与 Python 相同的子进程驱动能力，且带类型化错误与结构化轮次原因，包根也只暴露归调用方所有的操作；subagent seam 拥有一个 harness 原生的进程外后端，其子进程是完整对等体（自有配置、持久化、工具），父 agent 还能经同一 SDK 路径收到最小安全的子轮次/SDK 失败事实；SDK profile 通过 SDK 路径本身同时固定成功与失败的委派行为。

**代价**：`sdk/` 组多了第三个包、subagent 多了第四个要保持最新的后端；SDK 后端每个子进程启动完整插件树（单次成本高于 ACP 子进程；池化与 ACP 一样留作未来工作）；协议仍无取消方法，SDK 的 `RequestTimeoutError` 与后端的 dispose 都只在本地结算、服务器侧轮次会继续运行到进程清理为止；快照 fixture 录制于 `deepseek-v4-flash`，与其他录制语料一样随模型行为漂移而重录。
