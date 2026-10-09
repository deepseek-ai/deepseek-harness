# Agent Note: Pi 插件兼容——分级支持

Status: proposed

[English](2026-10-03-pi-plugins-compatibility.md) | 中文

## 问题

Pi 1.0.0 有两套相互独立、用于运行定制代码的机制。扩展是进程内的 TypeScript 工厂函数，API 已发布，由 [Pi 扩展桥接 Agent Note](2026-10-03-pi-extensions-bridge.zh.md) 负责。插件是较新的机制，构建在 Pi 的 Chord 组合运行时之上：一个插件包贡献若干 facet，每个 facet 运行在其名称选定的进程里。本 Agent Note 只讨论插件。

现在还不值得为 Pi 插件构建兼容层，上游资料自己给出了两条理由。

- **API 未发布且不稳定。** 插件栈只在 `PI_EXPERIMENTAL=1` 下运行。`@earendil-works/pi-coding-agent` 的 `./experimental/plugin` 导出只有 `source` 条件，npm tarball 不包含它的构建产物。Chord 的规划文档称它“is not a stable public API contract yet”（[PLANNING.md](https://github.com/earendil-works/pi/blob/v1.0.0/packages/chord/PLANNING.md)）；Session worker 所基于的 pi-durable 称其“API changes without notice between releases”（[README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)）。[services README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/experimental/services/README.md) 把 `AgentController.navigate()`、`nextRun()` 与 `resume()` 列为已移除。
- **插件能做的事比扩展少。** Session worker 自行构建工具、钩子与提示词注册表，不把它暴露为服务，因此 facet 无法注册模型工具、拦截工具调用或修改提示词。Pi 只附带一个示例插件。

如果不留记录就搁置这项工作，会丢失调研得到的两项结果：Pi 插件服务到 DSH 服务的映射，它决定每一级支持的成本；以及 DSH 运行时与 Chord 的差异，这些差异与 Pi 无关，对 DSH 自身同样重要。

## 提案

把 Pi 插件兼容划分为六个级别。每一级说明插件作者能得到什么、哪项上游变化使它值得构建，以及需要哪些 DSH 工作。在更高级别的触发条件出现之前，DSH 停留在 0 级。每一级包含其下各级，唯一例外是 4 级取代 2 级在 Host 侧的 presentation 实现。

| 级别 | 支持内容 | 上游触发条件 | DSH 工作 |
|---|---|---|---|
| 0 | 无。本 Agent Note 是唯一产物。 | — | Pi 发版时重新核对上游状态。 |
| 1 | `session` facet 运行在每个 DSH Session 各自的 Chord host 中。`AgentController`、`Models` 与 `SessionPlugins` 由 DSH 服务提供。 | Pi 在 npm 包中发布插件 API，或取消 `PI_EXPERIMENTAL` 要求。 | 一个实验性 Host 包。不改核心。 |
| 2 | `tui` facet 运行在 Host 上。它们的斜杠命令成为 DSH 命令，`select` 成为用户提问，`showStatus` 成为状态行。Pi 的示例插件原样运行。 | 同 1 级。 | 适配器，以及 Pi 扩展桥接的 Web 状态显示。 |
| 3 | 提供 `Transcript`，并把 Session 的插件选择随 Session 保存。 | 出现消费 `Transcript` 的插件，或 pi-durable 宣布 `ConversationView` 稳定。 | 从 Session 日志到 `ConversationView` 的投影，以及按 Session 保存的选择记录。 |
| 4 | `tui` facet 运行在浏览器中，经通用 Chord 桥访问 Session 服务。 | Chord 承诺支持浏览器，且 Pi 定义了不依赖终端的 presentation facet。 | 一个通用 JSON Remote 端点、一个浏览器 facet loader，以及 Client 命令的参数文本。 |
| 5 | 对等：每个 Session 一个 worker，插件可注册模型工具与钩子。 | Pi 把工具与钩子注册表暴露给 facet。 | 按 Session 的进程隔离，以及 Pi 扩展桥接已有的工具与钩子映射。 |

## Pi 插件是什么

插件是一个包目录。它的 `package.json` 可以带 `chord.facets`，把 facet 名称映射到入口文件或将其禁用；没有该字段时，Pi 在 `src/session.ts` 与 `src/tui.ts` 存在的情况下使用它们。入口默认导出 `{ id, setup(env) }`。`setup` 是同步的，只做声明：`env.use` 与 `env.observe` 获取服务，`env.provide` 与 `env.provideMany` 发布服务，`env.replicatedState` 创建共享状态，`env.own`、`env.onActivate` 与 `env.onDeactivate` 挂接生命周期工作。Chord host 校验完整的依赖图，先激活提供方再激活消费方，并且能在消费方保留服务句柄的同时替换所声明服务不变的 facet。

服务器用 Chord 的 esbuild 打包器把每个入口构建为内容寻址的 CommonJS 文件，并登记在 `chord-facets.json` 中。Session worker 校验 SHA-256 摘要后用 `node:vm` 加载 `session` 入口，`require` 只解析该入口声明过的外部依赖。`tui` 入口作为 JSON 制品随服务响应到达各客户端，并以同样方式加载。该 loader 不是沙箱：插件代码以进程的全部权限运行。

`pi server -e <package>` 设置服务器的默认插件，`pi client -e <package>` 为单个 Session 选择插件。Pi 保存 Session 的选择，并在该 Session 的 worker 运行期间拒绝不同的选择。

Pi 向 facet 提供以下服务：

| 作用域 | 服务 | 成员 |
|---|---|---|
| server | `SessionDirectory`、`SessionManagement`、`PresentationPlugins` | Session 列表状态；创建、删除、attach、detach；presentation 制品的构建与重载 |
| session | `AgentController` | `prompt`、`steer`、`followUp`、`cancelQueued`、`abort`、`compact`、`waitForPrompt` |
| session | `Models` | 可复制的目录与选择状态；`select`、`selectThinking`、`cycleThinking`、`getThinkingLevels`、`refresh` |
| session | `Transcript` | 根对话的 pi-durable `ConversationView`，以可复制状态提供 |
| session | `SessionPlugins` | `reload` |
| presentation，进程内 | `SlashCommands` | `register`、`replace`、`list`、`subscribe`；命令包含名称、描述、参数提示、可选的参数补全，以及 `run(args, context)` |
| presentation，进程内 | `PresentationUI` | `select(title, items, selected, context)`、`showStatus(message, context)` |

非进程内的服务只能包含可复制的 JSON 状态，以及参数与结果均为 JSON、最后一个参数为 Chord `Context` 的方法。

## 1 级：session facet

该包依赖某一精确版本的 `@earendil-works/chord`。它用 `bundleFacetPackage` 把每个选中的包构建到 Harness 主目录下的缓存，并用 `createFacetBundleLoader` 加载 `session` 入口。Chord 既不安装依赖也不运行生命周期脚本，因此包到达时必须已装好依赖。

loader 自行解析两个外部依赖。`@earendil-works/chord` 解析为该包自己的 Chord 实例，因为 Chord 通过模块实例持有的注册表识别可复制状态。`@earendil-works/pi-coding-agent/experimental/plugin` 解析为一个模块，它用 Pi 的 ID（`pi.agent-controller`、`pi.local.presentation-ui`、`pi.local.slash-commands`）定义服务 token；Chord 按 ID 字符串匹配服务，因此在 Pi 之外定义的 token 可以绑定到按 Pi 的 token 编译的 facet。

该包在 `agent/created` 中为每个 Agent 创建一个 Chord host，并随 Agent 的上下文一同释放。内置 facet 提供 Pi 的 Session 服务：

| Pi 成员 | DSH 机制 | 差异 |
|---|---|---|
| `AgentController.prompt` | `agent.followup()` | 以 `busy` 拒绝的行为由 `agent.status` 推导。 |
| `steer`、`followUp` | `agent.steer()`、`agent.followup()` | 无。 |
| `cancelQueued` | `agent.inbox.remove()` | 区分 `already_consumed` 与 `not_found` 需要读取 Session 日志。 |
| `abort` | `agent.cancel()` | 无。 |
| `compact` | `ctx.compaction.compactNow()` | 拒绝非空的 `customInstructions`；DSH 压缩不接受指令。 |
| `waitForPrompt` | 对 Session 事件做 fold，从入队消息到它的 `turn/end` | DSH 不关联提示词与其回答；由该 fold 完成关联。 |
| `Models` | `session-controller` 的模型目录与模型选择 | 以推理强度标识符代替 Pi 的 thinking level。 |
| `SessionPlugins.reload` | 重新构建、调用 `FacetHost.reload()`，再释放退役的 generation | 无。 |

本级不提供 `Transcript`。Chord 会拒绝含有“所需服务无人提供”的 facet 的 host，因此使用 `Transcript` 的插件加载失败，错误信息会指出该服务。

## 2 级：Host 上的 presentation facet

Pi 的 `tui` facet 不使用任何终端 API。它们消费 `SlashCommands`、`PresentationUI` 与 Session 服务，因此可以运行在 DSH Host 上每个 Agent 的第二个 Chord host 中，并在进程内绑定到 Session host。

注册的斜杠命令成为 Agent 作用域的 `ctx.commands` 注册，其 handler 把原始输入作为 `args` 传入。在 Host 上运行的命令会记录为 `command/run` 与 `command/done`；Pi 不记录 presentation 命令。`getArgumentCompletions` 在 DSH 中没有对应物，不会被调用。`PresentationUI.select` 映射到 `ctx.userQuestions.ask()`，需要已连接的 Web Client；`showStatus` 映射到 Pi 扩展桥接为 Web Client 增加的状态显示。

## 3 级：transcript 与保存的选择

`Transcript` 需要从 DSH Session 事件到 pi-durable `ConversationView` 的投影：按 pi-durable 条目类型组织的条目，加上它的 live、inbox、agent 与 usage 文档。DSH 记录了 Pi 没有对应条目的事件，在这些地方投影是有损的；它还把 DSH 绑定到一个被 pi-durable 声明为不稳定的类型上。

Session 的插件选择保存为带 `plugin:` 前缀的 ignorable Session 记录，即 Pi 扩展桥接保存扩展状态所用的机制；与 Pi 一样，存活 Agent 的选择固定不变。

## 4 级：浏览器中的 presentation facet

在页面中运行 `tui` facet 与 Pi 对 presentation 代码的放置一致。它需要三项新增。浏览器 loader 负责求值 CommonJS 制品，因为 Chord 的制品 loader 使用文件系统与 `node:vm`。一个通用 Remote 端点以 JSON 在页面与 Host 之间承载 Chord 的服务调用、快照与更新，因为 DSH 在构建时生成 Remote 方法，Client 不在运行时发现 Host 服务。Client 命令需要接受参数文本，目前 `ui-commands` 的 action 收不到它。

## 5 级：对等

Pi 把每个 Session 隔离在一个 worker 进程中，并计划通过其注册表向插件提供工具与钩子。要达到这一点，DSH Session 需要运行在自己的进程或 worker 线程中，并让 Chord 的服务协议跨越进程边界；在 Pi 暴露注册表之后，还需要 Pi 扩展桥接已经定义的工具、钩子与提示词映射。

## 插件模型暴露出的运行时差异

| 属性 | Chord 与 Pi | DSH | 受影响的级别 |
|---|---|---|---|
| 提供方替换 | 消费方持有句柄，每次访问时解析当前提供方；重载在句柄背后替换实现。 | 所注入服务发生变化的 fiber 会被卸载并重新运行。 | 1：Chord host 对 facet 之间的服务保持 Chord 的行为；映射进 Chord 的 DSH 服务仍会重启其适配器。 |
| 故障隔离 | 每个 Session 一个 worker 进程。 | 所有 Session 共享 Host 进程，未捕获的异常或未处理的 rejection 会释放整个应用（[app-boot](../../../../packages/boot/app-boot/README.zh.md)）。 | 1–4 在 Host 中运行插件代码；5 消除这一差异。 |
| Remote 声明 | host 根据运行时拿到的对象发布服务的远程成员。 | Remote 方法在构建时生成，Client 不在运行时发现 Host 服务（[remotes](../../../../packages/api/remotes/README.zh.md)）。 | 4 |
| 共享状态 | 可复制的 JSON 状态，带操作批次、hydration 与缺口恢复，本地与远程通过同一 API 读取。 | 每个领域定义自己的快照与增量类型，或发布完整的投影值。 | 3、4 |
| 运行时加载 | 每个 facet 一个 bundle，经完整性校验后在模块缓存之外加载。 | 包提前构建；已构建的安装不转译 TypeScript。 | 1 把 Chord 的打包器加为插件包的依赖。 |

## 值得为 DSH 评估的 Chord 机制

有四项 Chord 机制针对的是 DSH 自身存在、与 Pi 无关的限制。每一项都需要单独的提案；本 Agent Note 只做记录。

- **稳定的服务句柄。** 提供方被替换时消费方保留句柄，因此插件重载不会重启其依赖方并丢失它们的状态。
- **先声明后激活。** setup 同步声明全部依赖，host 在任何 facet 激活之前拒绝缺失的提供方、重复的提供方或循环依赖。Cordis 随服务出现逐步解析依赖，因此缺少提供方的 fiber 会一直挂起，直到启动后的审计报告它。
- **可复制的 JSON 状态。** 一个原语为本地与远程消费方提供完整的不可变值，线上传输操作批次，订阅方落后时做一次完整重置。
- **经过校验的插件制品。** 带 manifest 摘要的内容寻址 bundle 让 host 在模块缓存之外加载某一代插件，并在其退役后释放。

## 考虑过的替代方案

**现在就把 1、2 级做成原型。** 该 API 未发布，只有一个示例插件，其 services README 已把三个 `AgentController` 方法列为已移除。原型需要跟随 Pi 的每次发版维护，却没有用户。上文的服务映射保留了设计结论，而不必付出这项成本。

**不留记录，等 Pi 稳定后再决定。** 服务映射与运行时对比来自对 Chord 以及 Pi 实验性 server、worker 与 client 的完整阅读。这些运行时差异同样适用于与 Pi 无关的 DSH 工作。

**不用 Chord，直接在 Cordis 上实现 Pi 的插件服务。** facet 直接调用 Chord 的 API：`env.use`、`env.provide` 与 `replicatedState`。不用 Chord 而提供这套 API，意味着重新实现依赖图校验、稳定句柄、keyed 服务与可复制状态。Chord 采用 MIT 许可，只有一个运行时依赖，而且插件正是针对它编译的。

**把插件并入 Pi 扩展桥接包。** 两套机制没有共同的 API，稳定性也不同。分成独立的包，才能各自启用、定版与移除。

**只在浏览器中运行 presentation facet。** 2 级原样复用 Pi 的 Node 制品，不需要浏览器 loader。浏览器支持在 Chord 的规划中仍是未决事项，Pi 也没有不依赖终端的 presentation facet。

## 验收标准

- **0 级：** 本 Agent Note 已合并，Pi 扩展兼容性页面在插件机制处链接到它。
- **1 级：** Pi 示例插件的 `session` facet 从未修改的包目录加载。测试在使用 mock 模型的真实 agent loop 上调用它的问候服务以及每个已提供的 `AgentController` 成员。`SessionPlugins.reload` 替换 facet generation 而不重建 Chord host，释放 Agent 时 host 随之释放。
- **2 级：** Pi 示例插件的 `/hello <name>` 经 `ctx.commands` 运行，在 Web Client 中显示其状态文本，并提交其提示词。
- **3 级：** 订阅 `Transcript` 的 facet 在 hydration 之后以及每个已提交的步骤之后收到根对话，恢复的 Session 加载其创建时所用的插件。
- **4 级：** Pi 示例插件的 `tui` facet 在浏览器中运行，其服务调用经通用端点到达 Host。
- **每一级：** 兼容性页面列出与 Pi 的每一处差异，包的 README 说明插件代码以 Host 的全部权限运行。

## 风险

- 在任何一级构建之前，上游 API 都可能变化或被撤回。服务映射描述的是 Pi 1.0.0，需要对照触发这项工作的发行版重新核对。
- 1 至 4 级在 Host 进程中运行插件代码，一个未捕获的错误会中止所有 Session。
- 3 级依赖一个被上游声明为不稳定的 pi-durable 类型。
- 4 级增加的 Remote 端点由 Chord 的 wire 解析器校验载荷，而不是由按方法生成的编解码器校验。
- 插件包经由 Chord 的打包器引入 esbuild 作为运行时依赖。
