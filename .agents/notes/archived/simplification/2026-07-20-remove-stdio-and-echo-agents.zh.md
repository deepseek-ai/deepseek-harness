# Agent Note: 移除 stdio 和 Echo agent

Status: implemented
Archived: 2026-09-04

[English](2026-07-20-remove-stdio-and-echo-agents.md) | 中文

## 问题

DeepSeek Harness 在 TUI 和 Headless coding agent 之外，还提供了两个重复的产品 agent（智能体）。面向行的 stdio agent 使用混合的提示符/输出协议，同时重复实现终端交互与非交互执行。Echo 则以无需联网的 mock 模型加一个教学工具重复实现 Headless，把测试 fixture（测试前置数据）变成面向用户的 agent 和默认快速上手路径。

两个 agent 的配套实现都不止叶节点配置。stdio 拥有 UI 插件、app 包（package）、SDK 接口、REPL 叶节点、提示符协议和 Loader 测试。Echo 拥有可运行命令、mock 适配器、工具、CI 演示门禁、图谱条目、教学引用和共享测试 fixture。保留其中任何产品路径，都会间接保留这个重复的 agent。

标准输入输出仍是 ACP、JSON-RPC、MCP 和子进程的协议边界。确定性模型适配器也仍可用于测试。这些机制不足以成为保留面向行或仅使用 mock 的产品 agent 的理由。

## 决策

彻底移除 stdio 和 Echo agent，不提供兼容包、模式、命令或别名。删除 stdio UI 包与 app 包、`examples/repl-agent`、`examples/echo-agent`、`demo:repl`、`demo:echo`、各自的专属测试，以及相关的 manifest（元数据清单）、门禁、图谱和文档条目。

保留的应用角色均有明确归属：

- `@deepseek-ai/dsh-tui` 负责终端交互式执行。它会在 Loader 启动前拒绝非 TTY 流；`apps/cli/config/base.cordis.yml` 与 `tui.cordis.yml` overlay 拥有完整 coding 组装，PTY 与终端快照覆盖则位于 `apps/cli/tests/`。
- [`dsh --profile headless`](../../../../apps/cli/README.zh.md)负责非交互式执行。其 `headless` profile 是产品组装；录制会话位于 `snapshots/session/`，profile 集成测试位于 `apps/cli/tests/profiles/headless/`，共享 Loader driver 位于 `packages/test-support/loader-smoke/tests/fixtures/`。
- [`dsh --profile acp`](../../../../apps/cli/README.zh.md) 和 `@deepseek-ai/dsh-sdk-jsonrpc-server` 负责各自的分帧协议集成。

承载 `stdio` 运行接口选项的 SDK 项目模型已由 [SDK 项目工具链移除决策](2026-08-11-remove-sdk-project-toolchain.zh.md)删除。仓库中的演示文档要求 DeepSeek API key，并优先引导到当前可运行的产品。

无密钥验证由测试负责。Headless Loader 冒烟测试使用 fixture 适配器验证真实工具往返；`dsh` built-bin 测试套件固定已发布的一次性入口和输出；产品 Headless 快照固定持久化；Headless PTY 关闭 e2e 固定信号升级。各包专属的 Loader 测试则将确定性适配器放在对应场景旁。其中任何一项都不会作为可运行的 mock agent 对外暴露。

## 验证

TUI 与 Headless 的 Loader 覆盖以源码和构建产物两种模式运行真实 app 包。由 PTY 驱动的子进程覆盖仅用于 TUI 生命周期；其他入口冒烟测试使用单次管道协议。Headless 验证任务/结果约定和工具调用约定。生成图谱与仓库搜索会拒绝陈旧的包、命令、叶节点、SDK 接口、`createStdioChat` 和 `StdioRuntime` 引用。

构建后的 `dsh` 可执行文件会在 Loader 启动前拒绝通过管道启动 TUI，并指向 `dsh --profile headless`；`apps/cli/tests/built-bin.e2e.ts` 在普通 Node 下固定产品的一次性入口，包括输出和无效参数。`apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` 固定产品持久化，`apps/cli/tests/headless-shutdown.e2e.ts` 则负责有界信号升级。headless 预期输出测试保留组装后的规范事件，而不会创建第二套 CLI（命令行界面）约定。PTC mode 通过 headless profile 的 `DSH_TOOLS_MODE=ptc` 组合运行。时间上下文集成通过包自有 Loader 组合执行两个有序轮次，而更细粒度的耗时行为由时间上下文的包级测试负责。

## 曾考虑的替代方案

- **仅为 pipe 保留面向行 agent**：不予采纳，因为 Headless 已提供有界任务约定、格式纯净的 stdout、持久完成边界和进程退出状态。
- **将 readline helper 作为包保留、折叠或提升**：不予采纳，因为它只有一个 app 消费方，并不存在可独立替换的约定。将它折叠进 stdio app 虽然移除了没有正当理由的支撑包边界，却仍保留了重复产品；将来要重新引入这个包，独立的面向行 UI 必须先有真正的第二个消费方。
- **保留 Echo 作为无密钥快速上手路径**：不予采纳，因为首次产品体验应使用真实模型和受支持的 coding agent，而不是带专用工具的脚本化适配器。
- **只为 CI 演示命令保留 Echo**：不予采纳，因为由测试持有的 Headless fixture 可以覆盖相同的 Loader 和构建产物边界，无需保留 mock 产品叶节点。
- **移除所有 stdio 或 mock 机制**：不予采纳，因为分帧协议、进程 I/O 和确定性测试适配器是独立基础设施，并不是被移除的 agent。

## 后果

- 交互式与非交互式产品执行分别只有一个归属方和一个可运行的 coding 叶节点。
- 仓库没有面向用户的无密钥 agent 演示；本地 agent 演示需要 `DEEPSEEK_API_KEY`。
- CI 通过测试 fixture 保留针对真实入口的无密钥覆盖，而不是依赖产品命令。
- 既有 stdio agent 配置和 Echo 命令会直接失败，不会被转换。
- 有意移除了单进程内基于管道的多轮交互，以及面向非 TTY `ask_user_question` 的 readline 提供方；恢复会话可以满足持久多轮工作，非 TTY 组装则必须自行提供交互提供方。
