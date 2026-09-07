# Agent Note: 仓库命名约定与预发布重命名清单

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-repository-naming-contract-and-rename-ledger.md) | 中文

## 问题

仓库的发展速度曾超过部分名称的演进速度。一些包名描述的是最初的实现，而非所提供的能力。若干类即使实际承担注册表、运行时、引擎、控制器或解析器的职责，名称仍使用 `Service`。部分 `ctx` 键以单数命名注册表，却以复数命名单个引擎。还有一些提供方明明通过可替换的文件系统或子进程服务工作，可以在另一执行环境中运行，名称却使用 `local`。

这些名称并非无关紧要。名称会告诉贡献者一项职责从哪里开始、到哪里结束。`Store` 表示数据访问。`Registry` 表示注册与查找。`Runtime` 表示实时执行和生命周期。如果同一个词同时表示这三者，调用方就必须阅读实现，才能判断哪个对象拥有策略、工作或状态。

仓库还曾在两种含义下使用 `SDK`。受支持的 Python 和 TypeScript 客户端使用 JSON-RPC SDK 协议。项目整体是 DeepSeek Harness，而不是 SDK 项目。已移除的 SDK 项目工具链使宽泛的含义失去依据，但文案和名称仍保留了部分旧用法。

首次发布带标签版本之前的最后一个窗口，使仓库级重命名仍可低成本完成。若继续保留含义不清的名称，偶然形成的词汇就会变成兼容性约定。

## 决策

仓库使用本清单中的全部当前名称。本决策只更改名称；包职责、服务边界、行为、默认值和数据模型保持不变。如果某个名称暴露出不合理的边界，需要另写一份 proposed Agent Note，专门提议边界变更。

每个已重命名系列只有一套词汇。清单点名某一接口时，其目录、NPM 包名、导入、Cordis 插件名称、`ctx` 键、公开类型、直接耦合的事件或工具标识符、配置、测试、fixture（测试前置数据）、示例、生成的参考资料以及当前文档都使用当前名称。仓库不保留别名、兼容包、重复的服务键、双重事件名称或回退解析器，并拒绝旧名称。

同一系列不会公开两套词汇。

### `SDK` 只表示一件事

`SDK` 表示受支持的 Python 和 TypeScript SDK 所使用、基于 JSON-RPC 的客户端／服务器协议。仓库保留 `@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh-sdk-protocol` 和协议身份 `deepseek-harness-sdk-runtime`；JSON-RPC 服务器属于同一系列。DeepSeek Harness 本身不是 SDK，已移除的项目生成器、启动器、辅助工具和启动器遥测包继续保持不存在。

本决策部分取代三项现行决策。它替换[包重新分组决策](2026-07-29-package-regrouping.zh.md)中保留的 `bash/`、`pty/` 和 `self-modification/` 组名，以及两项暂定包名。它只替换[移除 SDK 项目工具链](../simplification/2026-08-11-remove-sdk-project-toolchain.zh.md)中将整个仓库称为 SDK 的说法；后者仍负责说明删除范围和保留的运行时 SDK。它只替换[工具调用超时策略](2026-07-07-tool-call-timeout-policy.zh.md)中的包名理由；超时机制及其 `guard/timeout-policy/` 归属保持不变。

如果其他已实现说明中的包、路径或类型被重命名，而其边界和理由保持不变，则本决策不会取代这些说明。这些说明使用已实现的事实名称。三项被部分取代的决策都链接回本决策。

### 按实际职责命名

使用常见且具体的名词。名称应描述稳定职责，而不是最初的实现、当前目录或未来可能出现的扩展。不得添加不传递任何信息的词。不得为了缩短名称而删除用于限定作用域的词。

接口包以能力命名。实现包增加机制、协议、环境或供应商限定词，以区分不同实现。只有同主机执行属于约定时，才能使用 `local`。如果提供方只是通过可替换的 `ctx.fs` 读取看似本地的路径，或通过可替换的 `ctx.subprocess` 启动工作，就不得使用该词。

如果对象是单个引擎、运行时、策略、控制器、解析器、存储或当前配置，使用单数 `ctx` 键。如果对象是注册表，或服务拥有多个具名成员，使用复数键。类的职责和键的单复数必须一致。复数键本身不能证明对象是注册表；应由其操作和所有权决定。不得让不兼容的 host 与 client 声明复用同一个 Cordis `Context` 键。即使二者使用独立的运行时上下文，TypeScript 声明合并仍会同时看到两种类型。如果自然复数已经属于另一个端面，就增加职责后缀。

仅当没有更精确的职责词能够如实描述对象时，才使用 `Service`。`GoalService` 和 `SessionTitleService` 是保留的有效名称，因为它们各自拥有领域服务，其工作无法准确归约为存储、注册或单一执行机制。

### 职责词即约定

| 词 | 适用场景 | 不适用场景 |
|---|---|---|
| `Controller` | 对象接受命令或用户意图，并更改一项已有的领域状态或呈现状态。它协调有界的状态转换。 | 对象执行任意工作、管理一组提供方，或仅将值转换为显示形式。 |
| `Store` | 对象拥有一组数据，主要对这些数据提供创建、读取、更新、删除、快照或订阅操作。 | 对象验证状态机、行使裁决权、分派工作、决定提供方优先级，或协调多个领域。类内部存在映射并不会让该类成为存储。 |
| `Directory` | 对象公开条目，供发现或选择。消费方会查询有哪些选项，并读取其元数据。 | 生产方可向其中注册任意实现，或调用方通过它执行工作。目录可以由注册表支撑，但两者的对外职责并不相同。 |
| `Presenter` | 对象只负责将领域值或工具参数转换为渲染意图。它不拥有 I/O、订阅、变更或生命周期。 | 对象读取服务、更改状态或控制工作运行时机。这些职责属于控制器或运行时。 |
| `Registry` | 对象拥有一组动态的具名注册项。它定义查找规则、重复项或优先级规则、注册生命周期和资源释放。 | 调用方的主要约定是分派、执行、取消、策略执行或编排。运行时可以在内部包含注册表。 |
| `Runtime` | 对象运行实时工作。它跨调用拥有分派、取消、提供方协调或操作生命周期。 | 对象只存储记录、返回目录、解析单个值或保存配置。`Runtime` 不是 `Service` 的通用替代词。 |
| `Resolver` | 对象根据所提供的输入计算或定位一个答案，通常不拥有答案的生命周期。 | 对象拥有可变集合或长时间运行的执行生命周期。 |
| `Binder` | 对象将一个已声明接口附加到调用方的上下文或生命周期，并返回绑定后的值。 | 对象以集合形式拥有绑定值、控制其领域状态，或仅转换数据。 |
| `Engine` | 对象实现领域算法或有状态执行模型，例如工作流、压缩或查询求值。 | 对象只选择提供方，或跨协议边界转发请求。 |
| `Policy` | 对象决定允许、选择、限制或观察什么。 | 对象执行决策所允许的机制。策略和执行器必须分别命名。 |
| `Executor` | 对象在一项能力内运行明确的请求或已解析的规范。 | 对象拥有宽泛的应用生命周期或提供方目录。 |
| `Gateway` | 对象适配进程、网络、RPC 或 API 边界，并在两侧之间转换。 | 对象只注册同进程服务或存储元数据。 |
| `Provider` | 对象为一项能力定义提供一种实现。如果可以存在多个提供方，应增加机制或供应商限定词。 | 对象是能力定义、提供方注册表或面向消费方的运行时。 |
| `Backend` | 对象在已定义接口之后，实现可替换的底层持久化、传输或执行后端。 | 对象是面向用户的服务，或只是对某个实时对象返回的引用。 |
| `Handle` | 该值是对一个实时资源的引用，并控制或观察该资源。 | 对象创建并管理整个资源池。不得使用 `Owner` 或含义模糊的 `Resource`；如果 `Handle` 或更精确的管理职责合适，就应采用后者。 |
| `Config` | 对象拥有一个已解析的配置值，或一份边界严格受限的配置记录及其更新约定。 | 对象存储通用集合、执行工作或公开不相关的设置。 |
| `Service` | 对象拥有一项职责内聚的领域服务，且以上更精确的职责词都无法如实描述其职责范围。 | 仅因为类继承自 Cordis `Service` 而使用该名称，或因为确定真正的职责需要进一步思考。 |

实用判断方式很直接。如果调用方主要调用 `register()` 并收到资源释放函数，应使用 `Registry`。如果调用方主要调用 `run()`、`dispatch()`、`cancel()` 或 `execute()`，应使用 `Runtime`、`Engine` 或 `Executor`。如果调用方主要浏览选项，应使用 `Directory`。如果对象主要将一份规范绑定到调用方拥有的上下文和生命周期，应使用 `Binder`。如果对象只将领域数据映射为 UI 数据，应使用 `Presenter`。如果它还会更改状态，就不是呈现器。

### 使用能够补充信息的限定词

如果协议或方言名称能够区分实现，就应保留。实现依赖相应机制时，保留 `Bash`、`Pwsh`、`JSON-RPC`、`SQLite`、`JSONL`、`OpenTelemetry`、`Claude Code` 和 `E2B`。每个当前后端都已使用 LLM（大语言模型）seam 时，不要在压缩后端名称中加入 `LLM`；在出现更具体的算法名称之前，`basic` 才是如实且中性的名称。

不得虚构 `process sandbox` 概念。当前 `sandbox` 系列已经准确命名其产品职责。本决策不改变该职责。

PascalCase 标识符中的首字母缩略词使用首字母大写格式：`Ui`、`Llm`、`JsonRpc` 和 `ApiProxy`。在文案和适用的包名中使用惯例规定的全大写形式：UI、LLM、JSON-RPC 和 API。`Typert` 是标识符和文案中的唯一准确产品拼写；不得写成 `TypeRT`、`TypeRt`，也不得对 `Typert` 作其他内部拆分。

不得为了避免重复而删除有意保留的供应商限定词。`dsh-subagent-dsh-sdk` 表示 DeepSeek Harness SDK 提供方，可避免与其他 SDK 混淆。其私有类改名为 `SdkSubagentProvider`，因为类名还需要说明它提供什么。

### 将规则写入项目文档

配对的包创建指南 `docs/cookbook/adding-a-package.md` 包含完整的职责词约定，`packages/AGENTS.md` 链接到该约定。术语表和根项目说明使 `SDK` 和 `Typert` 各自只有一种含义。本 Agent Note 负责记录理由和被否决的替代方案；指南负责记录贡献者应遵循的规则。

## 重命名清单

以下表格记录公开名称和仓库级名称的变更。`当前名称` 栏记录当前名称。引用相同职责的私有局部变量也使用相同词汇。若宽泛替换并不正确，清单会明确指出保留的底层名称或产品可见名称。

### 运行时 SDK

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `@deepseek-ai/dsh-jsonrpc` | `@deepseek-ai/dsh-sdk-jsonrpc-server` | 它是 SDK 协议的服务器端。单独使用 `jsonrpc` 只说明编码；`sdk-jsonrpc-server` 则同时说明所属系列、机制和职责。 |
| `HarnessSdkServer` | `HarnessSdkJsonRpcServer` | 该类是 JSON-RPC 服务器的一种实现，并不代表所有可能的 SDK 服务器。 |

保留 `@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh-sdk-protocol` 和 `deepseek-harness-sdk-runtime`。排除 `@deepseek-ai/create-sdk`、`@deepseek-ai/dsh-scripts`、`@deepseek-ai/dsh-helper` 和 `@deepseek-ai/dsh-telemetry`；单独的移除决策负责删除这些包及其支撑依赖图。

### Shell 与终端

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `packages/bash/` | `packages/shell/` | 该组包含方言无关的执行器 seam、Bash 和 PowerShell 实现、环境支持以及 shell 工具。 |
| `@deepseek-ai/dsh-bash`, `ctx.bash` | `@deepseek-ai/dsh-shell`, `ctx.shell` | PowerShell 已经实现该 seam。此项能力是 shell 执行，而不是 Bash。 |
| 方言无关的 `BashExecutor`、`BashExecRequest`、`BashExecSpec`、`BashProcess`、`BashRunResult`、`BashSandboxInfo`、`BashProcessRead` 和 `BashProcessStatus` 名称 | 对应的 `Shell*` 名称 | 这些类型横跨 Bash 和 PowerShell 实现。描述 Bash 语法或行为的叶层类型保留 `Bash`。 |
| `BASH_SETTINGS_NAMESPACE`，设置命名空间 `bash` | `SHELL_SETTINGS_NAMESPACE`，设置命名空间 `shell` | 两个 shell 提供方都注册这项由能力拥有的设置分区。常量和持久化命名空间必须使用能力名称。 |
| `@deepseek-ai/dsh-bash-env`, `ctx.bashEnv`, `BashEnvRegistry` | `@deepseek-ai/dsh-shell-env`, `ctx.shellEnv`, `ShellEnvRegistry` | Bash 和 PowerShell 工具共享该环境注册表。 |
| `docs/subsystems/bash.md` | `docs/subsystems/shell.md` | 该子系统页面记录方言无关的能力。 |
| `packages/pty/` | `packages/terminal/` | 该包系列负责持久终端会话。原始 PTY 分配仍位于子进程层。 |
| `@deepseek-ai/dsh-pty`, `ctx.pty`, `PtyService` | `@deepseek-ai/dsh-terminal`, `ctx.terminals`, `TerminalSessionService` | 调用方管理多个具名终端会话，而不是通过该服务分配原始 PTY。 |
| 公开的高层 `Pty*` 会话和后端名称 | `Terminal*` 名称 | 公开抽象是终端会话。保留底层 `SubprocessTerminal*` 名称，因为它们已经说明底层机制。 |
| `@deepseek-ai/dsh-pty-local`, `LocalPtyBackend` | `@deepseek-ai/dsh-terminal-bash`, `BashTerminalBackend` | 该提供方依赖 Bash 提示符和 shell 行为。`local` 隐藏了实际方言。 |
| `@deepseek-ai/dsh-tool-pty` | `@deepseek-ai/dsh-tool-terminal` | 面向模型的工具已使用 `terminal_*`；包应采用相同的产品名词。 |
| 原 PTY 系列中的 `tool-bash-persistent` | `shell/tool-bash-persistent/` | 该工具是 Bash 工具，应与 shell 工具放在一起。保留其 NPM 名称：`persistent` 将它与一次性 `bash` 区分开来，而 `bash-terminal` 会混淆产品工具与终端会话系列。 |
| `docs/subsystems/pty.md` | `docs/subsystems/terminal.md` | 该页面记录终端会话，而不是原始 PTY 分配。 |

保留 Bash 和 PowerShell 专用的叶层包、插件 id、类型和工具。这些方言名称准确无误。

### 语言服务器与作业

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `@deepseek-ai/dsh-lsp-local` | `@deepseek-ai/dsh-lsp-stdio` | 该提供方通过可替换的文件系统和子进程服务，以 stdio 传输 LSP。它不一定在本地运行。 |
| `packages/tasks/` | `packages/jobs/` | 该系列负责脱离前台运行的工具作业。`jobs` 简短，并可避免与用户任务或 todo 概念冲突。 |
| `@deepseek-ai/dsh-tasks`, `ctx.tasks`, `TaskService` | `@deepseek-ai/dsh-jobs`, `ctx.jobs`, `JobRegistry` | 该服务注册、拥有、观察、等待并取消多个后台作业。它是注册表，而不是通用任务服务。 |
| 公开的 `TaskId`、`TaskKindMap`、`TaskStart`、`TaskHooks`、`TaskOutcome`、`TaskSnapshot`、`TaskRead` 和 `TaskDoneListener` 名称 | 对应的 `Job*` 名称 | 这些类型属于重命名后的作业领域。`JobId` 比 `BackgroundTaskId` 或 `BgTaskId` 更短、更清晰。 |
| `@deepseek-ai/dsh-tasks-local`, `LocalTaskService` | `@deepseek-ai/dsh-jobs-local`, `LocalJobRegistry` | 这是作业注册表的进程内提供方。此处的 `local` 有明确含义，因为作业和回调都存在于同一进程。 |
| `@deepseek-ai/dsh-tool-tasks` | `@deepseek-ai/dsh-tool-jobs` | 消费方控制作业注册表，应使用相同的领域名词。 |
| `ToolTasks`、`toolTasks`、`ToolTasksConfigSchema`、`PublicTaskSnapshot`、`publicTask`、`validateTaskId` | 对应的 `*Jobs`、`*Job*` 与 `validateJobId` 名称 | import、转发配置、公开工具值与辅助函数都属于同一个作业领域。包重命名后继续保留 `Task`，会为同一功能制造第二套词汇。 |
| `task_output`, `task_list`, `task_kill` | `job_output`, `job_list`, `job_kill` | 这些模型工具操作的是作业，而不是用户任务。`run_in_background` 返回 `JobId`。 |
| `@deepseek-ai/dsh-client-ui-task`、`client/ui-task/` | `@deepseek-ai/dsh-client-ui-jobs`、`client/ui-jobs/` | 该客户端包呈现后台作业集合，而不是一项用户任务。 |
| `TaskView`、线路帧 `session/tasks`、`tasksBySession` | `JobView`、线路帧 `session/jobs`、`jobsBySession` | 浏览器约定及其镜像应采用与注册表和工具相同的作业领域名称。 |
| `docs/subsystems/tasks.md` | `docs/subsystems/jobs.md` | 该子系统页面必须采用公开的作业词汇。 |

保留基础 LSP 包、`ctx.lsp`、LSP 协议类型和 LSP 工具。该 seam 有意公开语言服务器语义；错误的只有提供方限定词。

### 输入触发器、工具呈现、权限预设和用户问题

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-slash`, `ui-slash/` | `@deepseek-ai/dsh-client-ui-input-trigger`, `ui-input-trigger/` | 客户端处理 `/`、`@`、键盘仲裁、候选菜单和程序化启动，并非只处理斜杠命令。 |
| `ctx.slash`、`SlashService`、`SlashController`、`SlashSource` | `ctx.inputTriggers`、`InputTriggerService`、`InputTriggerController`、`InputTriggerSource` | 这些名称覆盖所有受支持的触发器，并保留现有的服务、控制器和来源职责。耦合的区域设置和公开类型名称也改用 `InputTrigger`。 |
| `@deepseek-ai/dsh-agent-tool-mode`，插件 `tool-mode` | `@deepseek-ai/dsh-agent-tool-presentation`，插件 `tool-presentation` | 该插件改变工具向模型呈现的方式，而不改变执行行为。保留局部 `Config.mode` 和 `ToolPresentationMode`。 |
| `packages/interaction/permission/` | `packages/interaction/permission-presets/` | 该包拥有沙箱与审批设置的具名组合，而不负责执行权限。 |
| `@deepseek-ai/dsh-permission`, `ctx.permission`, `PermissionService` | `@deepseek-ai/dsh-permission-presets`, `ctx.permissionPresets`, `PermissionPresetService` | 该服务选择并持久化预设。沙箱和审批服务负责执行结果。 |
| `@deepseek-ai/dsh-client-ui-permission` | `@deepseek-ai/dsh-client-ui-permission-presets` | UI 编辑和选择权限预设。 |
| `docs/subsystems/permission.md` | `docs/subsystems/permission-presets.md` | 该页面记录预设选择，而不是权限执行。 |
| `@deepseek-ai/dsh-user-interaction`, `user-interaction/` | `@deepseek-ai/dsh-user-questions`, `user-questions/` | 该 seam 仅支持批量问题和答案。审批、命令和目录选择属于其他交互 seam。 |
| `ctx.userInteraction`, `UserInteractionService`, `UserInteractionProvider`, `UserInteractionError` | `ctx.userQuestions`, `UserQuestionService`, `UserQuestionProvider`, `UserQuestionError` | 这些名称说明唯一受支持的交互形式。保留 `AskUserQuestion*`、`ask_user_question` 工具和 `@deepseek-ai/dsh-tool-ask-user`。 |
| `docs/subsystems/user-interaction.md` | `docs/subsystems/user-questions.md` | 该页面只记录问题和答案。 |

保留 `/permission`、`permissions` 投影、`permission` 设置命名空间和 `permission/preset`；它们都是准确的产品词汇或持久化词汇。保留完整名称 `PermissionPresetSettingsController`。删除 `Preset` 会去掉限定其权限的词。移除 `both` 工具呈现模式的工作仍推迟到另一份提案；本次重命名不移除行为。

### Typert、API 网关与工具

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `packages/typert/type-meta/`, `@deepseek-ai/dsh-type-meta` | `typert/protocol/`, `@deepseek-ai/dsh-typert-protocol` | 该包拥有 Typert Remote 协议、装饰器、绑定、编解码器、查找逻辑和上下文约定。它不是通用类型元数据。 |
| 协议包中的 `GatewayService` | `TypertRemoteService` | 该基类标记要导出为 Remote 的同进程服务。它不是 API 网关。 |
| `bindTypeRTGateway`、`typertGateway` 绑定 | `bindTypertRemote`、`typertRemote` | 这些绑定公开 Typert Remote 服务，而非具体的 API 网关服务。 |
| 公开的 `TypeRT*` 标识符和小驼峰形式的 `typeRT*` 标识符 | `Typert*` 和 `typert*` | `Typert` 是唯一规范的产品拼写。 |
| 协议接口 `TypeRTService` | `TypertRegistryContract` | 该协议拥有的接口是现有具体类 `TypertRegistry` 所实现的依赖倒置接口。不同的后缀可避免导入和声明冲突。 |
| `ToolRegistry` | `ToolRuntime` | 该类拥有呈现、审批与防护策略、分派、取消、验证、终结和观察。注册只是内部组成部分。 |
| `ToolRegistryScheduler`, `TOOL_REGISTRY_SCHEDULER` | `ToolRuntimeScheduler`, `TOOL_RUNTIME_SCHEDULER` | 调度器控制运行时分派，而不是注册。 |

保留 `@deepseek-ai/dsh-tools` 和 `ctx.tools`。保留 `@deepseek-ai/dsh-api-gateway`、其 `gateway/` 目录、`ctx.typertGateway` 以及 `TypertGatewayService`；该服务是真正的 API 网关。其内部的 `TypeRT*` 标识符仍应遵循 `Typert*` 拼写规则。

### 工作区指令、遥测、身份和启动环境

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| Host `ctx.workspace` | Host `ctx.workspaceRegistry` | `WorkspaceRegistry` 拥有多个工作区，但 Client `ctx.workspaces` 已经使用不兼容的类型。即使二者运行时上下文独立，两份声明仍会在编译时合并进同一个 Cordis `Context` 接口。职责后缀明确指出 host 服务，并避免该冲突。保留 `@deepseek-ai/dsh-workspace`、`WorkspaceRegistry`、`Workspace` 和 `workspace.*` 协议名称。 |
| `@deepseek-ai/dsh-workspace-context`, `context/workspace-context/` | `@deepseek-ai/dsh-agent-instructions`, `context/agent-instructions/` | 该包为 agent（智能体）加载分层的 `AGENTS.md` 和 `CLAUDE.md` 文件。它并非通用工作区上下文。 |
| 插件名称和持久来源名称 `workspace-context` 与 `workspace-instructions` | `agent-instructions` | 记录的来源是一类具体的 agent 指令。以 `AgentInstruction*` 替换公开的 `WorkspaceInstruction*` 名称。该术语不包括系统消息、开发者消息或用户消息。 |
| `ctx.telemetry`、抽象类 `Telemetry` | `ctx.sessionTelemetry`、`SessionTelemetryBackend` | 该服务捕获会话账本遥测，并交给报告后端。它不是仓库级指标或追踪服务。 |
| `TelemetryBackend` | `SessionTelemetrySink` | 该底层接收已发出的记录。`Sink` 用于将它与协调型后端服务区分开。 |
| `TelemetryCoordinator`、`TelemetryRecord`、`TelemetrySeverity`、`TelemetrySharingStatus` 和 `TelemetryCapture` | 对应的 `SessionTelemetry*` 名称 | 这些公开类型只属于会话遥测。 |
| `telemetry/record` | `session-telemetry/record` | 事件名称必须说明所属领域。 |
| `TelemetryOtel`、`TelemetryMode`，插件 `telemetry-otel` | `OpenTelemetrySessionBackend`、`SessionTelemetryMode`，插件 `session-telemetry-otel` | 提供方名称同时说明 OpenTelemetry 机制和会话作用域。保留包名 `dsh-session-telemetry` 和 `dsh-session-telemetry-otel`。 |
| `docs/subsystems/telemetry.md` | `docs/subsystems/session-telemetry.md` | 该页面记录会话遥测，而不是仓库级可观测性。 |
| `session/user-id/`, `@deepseek-ai/dsh-user-id` | `identity/anonymous-user-id/`, `@deepseek-ai/dsh-anonymous-user-id` | 该值是遥测、反馈和 DeepSeek 请求共用的随机关联 id。它既不属于 Session 领域，也不是经过身份验证的用户身份。 |
| `USER_ID_FILE_NAME`、`.userid`，反馈标签 `User` | `ANONYMOUS_USER_ID_FILE_NAME`、`.anonymous-user-id`，反馈标签 `Anonymous user` | 文件和 UI 不得暗示账户身份。保留现有 `AnonymousUserId` 函数和标准 OTel 属性 `user.id`。 |
| `util/environment/`, `@deepseek-ai/dsh-environment` | `util/launch-environment/`, `@deepseek-ai/dsh-launch-environment` | 该包在启动时捕获一份不可变的分层快照。它不是通用环境 API。 |
| 公开的 `Environment*`、`createEnvironmentSnapshot`、`environmentOf`、`DSH_ENVIRONMENT_KEY` | `LaunchEnvironment*`、`createLaunchEnvironmentSnapshot`、`launchEnvironmentOf`、`DSH_LAUNCH_ENVIRONMENT_KEY` | 这些名称说明快照的生命周期和用途。 |
| `ctx.launcherEnvironment` | `ctx.launchEnvironment` | 该值描述应用启动，而不只描述启动器组件。保留来源标签 `process`、`project-env` 和 `user-env`。 |

### 日程、工作流、目标与压缩

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `@deepseek-ai/dsh-tool-schedule`、`schedule/tool-schedule/`、插件 `tool-schedule` | `@deepseek-ai/dsh-schedule`、`schedule/schedule/`、插件 `schedule` | 该包拥有持久 Schedule 领域、持久化屏障、管理工具、定时器、后续轮次和运行时生命周期。`tool-` 只描述其中一部分。 |
| `ScheduleOwner` | `ScheduleRuntime` | 该逐 agent 对象运行实时定时器、持久化投影、分派、空闲等待和资源释放。`Owner` 没有说明这一执行职责。耦合的私有 `owner*` 名称也改用 `runtime*`。 |
| `WorkflowService`, `ctx.workflows` | `WorkflowEngine`, `ctx.workflowEngine` | 一个引擎负责解析并执行工作流程序。复数键错误地暗示这是注册表。保留 `@deepseek-ai/dsh-workflow` 以及工作流事件和工具。 |
| `@deepseek-ai/dsh-workflow-workerthread`, `WorkerWorkflowEngine` | `@deepseek-ai/dsh-workflow-worker-thread`, `WorkerThreadWorkflowEngine` | `worker thread` 是准确的 Node 机制，仓库拼写要求使用完整单词。 |
| `@deepseek-ai/dsh-goal-session`, `goal/goal-session/` | `@deepseek-ai/dsh-goal-round-driver`, `goal/goal-round-driver/` | 该插件驱动同一会话内的 Goal Rounds。它既不存储目标，也不定义会话。保留 `GoalService`、目标来源、事件和约定。 |
| `packages/compact/` | `packages/compaction/` | 该组是以名词命名的领域系列。`compact` 仍作为面向用户的命令动词。 |
| `@deepseek-ai/dsh-compact`, `ctx.compact`, `CompactService` | `@deepseek-ai/dsh-compaction`, `ctx.compaction`, `CompactionEngine` | 该对象运行压缩（compaction）算法和生命周期。它是引擎，而不是通用服务。 |
| `compact/*` 事件和公开领域前缀 | `compaction/*` | 事件和领域类型使用名词形式。保留动词形式的操作，例如 `compactNow`、`compactRegion` 和 `compactIfNeeded`。 |
| `@deepseek-ai/dsh-compact-basic`、`BasicCompactService`、公开的 `BasicCompact*` | `@deepseek-ai/dsh-compaction-basic`、`BasicCompactionEngine`、对应的 `BasicCompaction*` | `basic` 朴素但准确。`compaction-llm` 没有增加信息，因为当前实现系列已使用 LLM。 |
| `@deepseek-ai/dsh-compact-tool-result-prune`, `ToolResultPruneService`, `ctx.toolResultPrune` | `@deepseek-ai/dsh-compaction-tool-result-pruner`, `ToolResultPruner`, `ctx.toolResultPruner` | 该插件是剪除工具结果的执行主体。名词 `pruner` 说明了这一职责。 |

保留 `/compact`、命令包，以及相互独立的压缩定义包和提供方包。合并这些包的提议仍被否决。本次重命名只改变词汇，不改变该包边界。

### 设置、凭据、客户端模块和较小的核心职责

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| 抽象类 `Settings` | `SettingsProvider` | 该类通过可替换能力提供设置。保留包、键和事件。 |
| `@deepseek-ai/dsh-settings-local`, `SettingsLocal` | `@deepseek-ai/dsh-settings-file`, `FileSettingsProvider` | 该实现通过文件系统 seam 以文件为后端。`file` 说明机制，`local` 则不能。 |
| 抽象类 `Credentials` | `CredentialProvider` | 该类解析凭据引用。保留包名、键和事件。 |
| `CredentialsLocal` | `LocalCredentialProvider` | 该提供方读取宿主进程和 `.env` 状态，因此本地执行属于其约定。 |
| `ClientModuleHostService`, `ctx.clientModuleHost` | `ClientModuleRegistry`, `ctx.clientModules` | 该服务拥有多个已注册的客户端模块。保留包和浏览器端的 `ClientModuleLoader`。 |
| `AgentDefaultModelService` | `AgentDefaultModelConfig` | 该对象存储一项默认模型选择。它不运行服务，也不是通用注册表。保留其包、键、设置命名空间和类型。 |
| `SessionReferenceService`, `ctx.sessionReferences` | `SessionReferenceResolver`, `ctx.sessionReferenceResolver` | 它从 URI 或输入解析一个会话引用，并不拥有引用集合。 |
| `SessionQueryService`, `SessionQuerySqlite` | `SessionQueryEngine`, `SqliteSessionQueryEngine` | 这些类执行查询模型及其 SQLite 实现。保留包名、键和工具。 |
| `@deepseek-ai/dsh-session-export`, `session-export/`, Loader id `session-export`, `ctx.sessionExport` | `@deepseek-ai/dsh-session-log-export`, `session-log-export/`, Loader id `session-log-download`, `ctx.sessionLogDownload` | npm 包名使用 Session 日志导出语义，因为 npm 禁止包名包含 `download`。Loader id 与浏览器 API 保留 `download`，因为它们描述浏览器副作用。 |
| `SessionExportDownloadController`, 其他 `SessionExport*` 浏览器类型、`useSessionExport`、`SessionExportHeader` | `SessionLogDownloadController`, 对应的 `SessionLogDownload*` 类型、`useSessionLogDownload`、`SessionLogDownloadHeaderAction` | 该 controller 拥有预检、重复请求合并、弹窗状态和浏览器保存。`ExportDownload` 重复表达同一动作，该组件贡献的是一个 Header action，不是整个 Header。 |
| 宿主命令包中的 `CommandService` | `CommandRuntime` | 该对象跨实时调用注册并执行宿主命令。保留其包、键、类型和事件。 |
| `TokenMeterService` | `TokenMeter` | 该对象测量 token 用量。`Service` 没有补充作用域信息。 |
| `LlmService` | `LlmRuntime` | 该对象选择提供方并运行实时模型请求。保留包、键、适配器和事件。 |

### Host Web 服务器、会话数据与代码执行

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `HttpServerService`, `ctx.httpServer` | `WebServer`, `ctx.webServer` | 该服务器拥有 HTTP 路由和 WebSocket 升级路由。`Web` 可以同时涵盖两者；此处的 `Http` 作用域过窄。保留 `packages/host/webserver`、`@deepseek-ai/dsh-host-webserver`、`WebRoute` 和 `WebUpgradeRoute`。 |
| 文档子系统标签 `http-server` | `web-server` | 子系统标签必须与服务采用相同作用域。 |
| `SessionPersistenceJsonl` | `JsonlSessionPersistence` | 将实现限定词放在前面，同时完整保留能力职责。 |
| `SessionPersistenceSqlite` | `SqliteSessionPersistence` | 采用与 JSONL 相同的提供方命名顺序。 |
| `@deepseek-ai/dsh-session-title-first-message-llm`，触发周期 `first-message` | `@deepseek-ai/dsh-session-title-first-prompt-llm`，触发周期 `first-prompt` | 触发条件是第一条用户提示词，而不是会话日志中的任意消息。 |
| `@deepseek-ai/dsh-session-title-all-messages-llm`，触发周期 `all-user-messages` | `@deepseek-ai/dsh-session-title-all-prompts-llm`，触发周期 `all-prompts` | 后端根据用户提示词刷新。`all messages` 会错误地包含助手消息和工具事件。 |
| `@deepseek-ai/dsh-code-runtime-worker`, `WorkerCodeRuntime` | `@deepseek-ai/dsh-code-runtime-worker-thread`, `WorkerThreadCodeRuntime` | 该实现使用 Node 工作线程。单独的 `worker` 作用域过宽。 |
| `SubprocessService` | `SubprocessRuntime` | 该服务拥有实时子进程的执行和生命周期。保留其包和键。 |
| `LocalSubprocessService` | `LocalSubprocessRuntime` | 该提供方运行同主机进程和进程树。 |
| `E2BSubprocessService` | `E2BSubprocessRuntime` | 该提供方在 E2B 运行时中运行子进程。 |

保留完整的会话投影系列和 `SessionProjection*` 词汇。投影是持续维护的读取模型；`Reducer` 只说明其折叠操作，会淡化缓存和查找职责。保留 `SessionTitleService`、检查点策略、持久化包名、时间上下文和 tmux 上下文。

### 文件系统、skill、subagent 和 Web 提供方

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `@deepseek-ai/dsh-fs-policy` | `@deepseek-ai/dsh-fs-observation-policy` | 该包定义哪些文件系统观察可以授权后续操作。它不是完整的文件系统策略或沙箱策略。 |
| `FsPolicyExec` | `FsObservationActor` | 该值表示策略所关联的观察与操作的执行主体。它本身不执行策略。 |
| `SkillService` | `SkillRegistry` | 该服务注册提供方，并从其目录解析 skill（技能）。 |
| `@deepseek-ai/dsh-skill-local`、`LocalSkillProvider`，提供方 id `local` | `@deepseek-ai/dsh-skill-filesystem`、`FileSystemSkillProvider`，提供方 id `filesystem` | 该提供方通过可位于本地或远端的 `ctx.fs` 发现 skill 文件。其机制是文件系统访问，而不是本地性。 |
| `SubagentService` | `SubagentRuntime` | 该服务选择提供方，并拥有实时 spawn、恢复、跟进、取消和结算行为。 |
| `@deepseek-ai/dsh-subagent-spawn`, `SpawnProvider` | `@deepseek-ai/dsh-subagent-spawn-in-process`, `SpawnInProcessProvider` | 该提供方在当前进程内启动子 agent。配置的提供方 id 仍为 `spawn`。 |
| `@deepseek-ai/dsh-subagent-fork`, `ForkProvider` | `@deepseek-ai/dsh-subagent-fork-in-process`, `ForkInProcessProvider` | 该提供方在当前进程内 fork 一个 agent。配置的提供方 id 仍为 `fork`。 |
| `@deepseek-ai/dsh-subagent-inprocess`, `subagent-inprocess/` | `@deepseek-ai/dsh-subagent-in-process-driver`, `subagent-in-process-driver/` | 该包包含通用的进程内驱动逻辑，而不是第三个提供方。 |
| 私有的 `SdkProvider`，位于 `dsh-subagent-dsh-sdk` 中 | `SdkSubagentProvider` | 重复的包限定词是有意保留的，类名还必须说明它通过 SDK 提供 subagent。 |
| `WebService`, `WebServiceConfig` | `WebRuntime`, `WebRuntimeConfig` | 该对象选择提供方并运行实时搜索和抓取操作。保留包、键、提供方包和模型工具。 |
| `@deepseek-ai/dsh-web-fetch-local`、`LocalFetchProvider`、`LocalFetchLimits`，提供方 id `local-http` | `@deepseek-ai/dsh-web-fetch-http`、`HttpFetchProvider`、`HttpFetchLimits`，提供方 id `http` | 该提供方执行直接 HTTP 抓取。`local` 只说明代码恰好在哪里运行，并未说明它提供哪种机制。 |

保留 `@deepseek-ai/dsh-subagent-dsh-sdk`、其提供方 id `dsh-sdk`、外部 ACP（Agent Client Protocol）、Codex 和 Claude Code 提供方系列、subagent 工具包名、主文件系统包和后端、文件系统工具和事件，以及 skill 徽章和工具包。

### 钩子、防护、Plan Mode、扩展与诊断

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `@deepseek-ai/dsh-hooks-claude`、`ClaudeHookConfig`、`parseClaudeConfig`，方言 `claude` | `@deepseek-ai/dsh-hooks-claude-code`、`ClaudeCodeHookConfig`、`parseClaudeCodeConfig`，方言 `claude-code` | 该钩子桥接面向 Claude Code，而非所有 Anthropic 或 Claude 产品。 |
| `@deepseek-ai/dsh-repeat-tool-guard`，插件／来源 `repeat-tool-guard` | `@deepseek-ai/dsh-repeat-tool-reminder`，插件／来源 `repeat-tool-reminder` | 该插件向模型添加提醒，并不阻止工具调用，也不执行防护决策。 |
| `@deepseek-ai/dsh-timeout-policy` | `@deepseek-ai/dsh-tool-call-timeout-policy` | 完整的 `tool-call` 限定词说明该策略限制的对象，而不会把插件称为面向模型的工具。保留其 `guard/timeout-policy/` 目录和插件 id `timeout-policy`；`packages/*/tool-*` 目录约定仍只适用于注册工具的包。 |
| `PlanModeService` | `PlanModeController` | 该对象控制进入和退出计划模式的状态转换，而不是通用执行运行时。 |
| `packages/self-modification/` | `packages/extensions/` | 该组包含仓库插件检查和挂载工具。`extensions` 说明稳定的包职责，但不声称 agent 会修改自身。保留包名 `tool-cordis` 和仓库插件名称。 |
| `packages/support/` | `packages/test-support/` | 该组仅包含测试基础设施，其路径必须明确说明这一点。 |
| 原 support 系列中的 `invariants/` | `runtime-diagnostics/invariants/` | 尽管交付预设未包含不变量检查，它们仍可在生产诊断中运行，因此不属于测试支持。 |
| `InvariantService` | `InvariantRegistry` | 该对象拥有已注册的不变量检查。保留 `@deepseek-ai/dsh-invariants` 和 `ctx.invariants`。 |
| `packages/client/test-runtime/` | `packages/test-support/client-runtime/` | 该包是客户端测试基础设施。如果现有 NPM 名称已经说明这一约定，则予以保留。 |

保留 MCP、Todo、Plan Mode 包、键、事件和工具名称。本决策重命名控制器类，而不是产品功能。

### 实用工具、E2B、Host、组合包、示例与应用

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `util/paths/`, `@deepseek-ai/dsh-paths` | `util/home-paths/`, `@deepseek-ai/dsh-home-paths` | 这些辅助函数解析 Harness 主目录下的路径，并非通用路径库。已准确说明返回路径的函数名保持不变。 |
| `util/retention/`, `@deepseek-ai/dsh-retention` | `util/output-retention/`, `@deepseek-ai/dsh-output-retention` | 该策略保留命令和工具输出，而不是通用数据保留框架。 |
| `E2BSandboxService` | `E2BRuntime` | 该类创建、复用和释放文件系统与子进程适配器所使用的 E2B 执行环境。它比单个沙箱句柄的职责更广，又比通用所有者更具体。保留 `@deepseek-ai/dsh-e2b`、`ctx.e2b` 和 `e2b/` 组。 |
| `@deepseek-ai/dsh-frontend-static` | `@deepseek-ai/dsh-host-frontend-static` | 该包是提供前端资源的 Host 插件。此前缀可将它与前端应用代码区分开。 |
| `PluginInventoryService` | `PluginInventoryGateway` | 该类只负责把实时 Loader 树适配到 `pluginInventory/list` RPC。它不拥有同进程服务、缓存、历史或修改路径。`Gateway` 准确说明现有角色。 |
| `@deepseek-ai/dsh-jsonrpc-demo`、`@deepseek-ai/dsh-sdk-jsonrpc-demo`、`@deepseek-ai/dsh-sdk-python-runtime` | 已删除 | Python 运行时打包现有 `@deepseek-ai/dsh` CLI 与其 `sdk` profile；私有应用包会重新产生第二个启动器。 |
| `packages/examples/jsonrpc-demo/`、`packages/sdk/python-runtime/` | 已删除 | Python 运行时 wheel 的闭包 manifest 负责打包，无需独立应用包。 |
| `examples/jsonrpc-agent/` | `python/sdk/examples/` | 该示例演示 Python 使用 `sdk` profile 与有序 patch。 |
| `@deepseek-ai/dsh-acp-demo` | `@deepseek-ai/dsh-acp-app` | 该包是 ACP profile 的应用组合包，不是独立 demo bin。 |
| 部署根 manifest `dsh-jsonrpc-agent-pkg`、`dsh-sdk-python-runtime-closure` | `dsh-python-runtime-closure` | 该零代码 manifest 定义 Python 运行时 wheel 的完整 `dsh` 依赖闭包，不再命名独立 SDK 应用。 |
| `@deepseek-ai/dsh-frontend` | `@deepseek-ai/dsh-web-frontend` | 该应用是 Web 前端。保留其物理目录 `apps/web/`。 |

保留 atomic-write、brand、native-command、timeout 实用工具、目录选择器、`dsh-base`、`dsh-web-app`、`dsh-sdk-app`、`dsh-acp-app`、应用启动、CLI（命令行界面）名称，以及 `headless` 包、组合包和示例身份。`headless` 是预期的产品本质，未来也可以支持不止一次性执行。

### 客户端运行时与 UI

| 旧名称 | 当前名称 | 理由 |
|---|---|---|
| `SlotsService` | `SlotRegistry` | 该对象拥有具名 slot 声明和注册项。 |
| `SessionsService` | `SessionRuntime` | 该对象拥有实时客户端会话协调职责，而不是被动的会话列表。 |
| `WorkspacesService` | `WorkspaceRuntime` | 该客户端对象协调实时工作区选择和操作。如果清单未点名更改某个现有 `ctx` 键，则该键保持不变。 |
| `WorkspaceGroupBy`、`WorkspaceOrderBy`、`workspaceExpansion`、`setWorkspaceExpanded`、`expandedProjects`、`projectLabel`、`recentSessionOrder`、`recentSessionUpdatedAt`、`syncRecentSessions`、`setRecentSessionOrder`、`retainWorkspaceKeys`、`workspaceKey` | `SessionGroupBy`、`SessionOrderBy`、`groupExpansion`、`setGroupExpanded`、`expandedGroups`、`workspaceLabel`、`sessionOrderByAccount`、`sessionUpdatedAtByAccount`、`syncSessionOrderAccount`、`setSessionOrder`、`retainAccountKeys`、`accountKey` | 这些名称描述的是会话列表查看状态。其 account 包括真实工作区、未分组项和平铺列表。因此，`Workspace`、`project` 和 `recent` 指向了错误的对象或机制。保留 `WorkspaceViewState`；该存储仍属于工作区浏览器。 |
| `LocaleService` | `LocaleRuntime` | 该对象协调区域设置定义、选择、持久化和变更发布。 |
| `ThemeService` | `ThemeRuntime` | 该对象协调主题、偏好解析、系统感知和变更发布。 |
| `LayoutService` | `LayoutController` | 该对象控制当前 UI 布局状态。 |
| `@deepseek-ai/dsh-client-ui-model` | `@deepseek-ai/dsh-client-ui-model-selection` | 该包控制会话的模型选择。单数 `model` 名称作用域过宽。 |
| `ModelService`, `ctx.models` | `ModelDirectoryResolver`, `ctx.modelDirectories` | 它唯一的公开操作 `directoryFor(sessionId)` 为每个实时会话解析并保留一个目录。它没有注册 API，因此使用 `Registry` 并不准确。每个 `ModelDirectory` 仍是面向消费方的可选模型目录。 |
| `SettingsScopeService` | `SettingsScopeBinder` | 它唯一的操作把一份命名空间规范绑定到调用方的传输层和生命周期，并返回 `SettingsScopeController`。保留 `ctx.settingsScope`；它命名的是单一绑定能力，而不是 scope 集合。 |
| `@deepseek-ai/dsh-client-ui-models` | `@deepseek-ai/dsh-client-ui-settings-models` | 该包拥有 Models 设置面板。保留 `ModelsSettingsStore`；它保存一个具有数据操作和订阅能力的设置视图模型，确实是存储。 |
| `@deepseek-ai/dsh-client-ui-plugin-config`、`client/ui-plugin-config/` | `@deepseek-ai/dsh-client-ui-settings-plugins`、`client/ui-settings-plugins/` | 该包拥有 Plugins 设置分区，而不是通用的插件配置系统。目标名称归入 `ui-settings-*` 系列，并采用该分区的复数产品名。 |
| `PluginConfigSection`、`PluginConfigSectionProps`、`PluginConfigSectionInjected`、`PluginSettingsTabRow`、`PluginConfigKey`、`settings.pluginConfig` | `PluginsSettingsSection`、`PluginsSettingsSectionProps`、`PluginsSettingsSectionInjected`、`PluginsSettingsTabEntry`、`PluginsSettingsLocaleKey`、`settings.plugins` | 该分区拥有 Plugins 设置呈现和 tab 清单。元数据值表示一项 slot entry，而不是一条渲染行。每张卡片仍编辑一个插件的配置。 |
| `@deepseek-ai/dsh-client-ui-plugins`、`client/ui-plugins/`、Loader id `ui-plugins`、`client-ui-plugins-invariant` | `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`、`client/ui-settings-plugin-inventory/`、Loader id `ui-settings-plugin-inventory`、`client-ui-settings-plugin-inventory-invariant` | 这个后来加入的包拥有 Plugins 设置分区中的只读 Plugin Inventory tab。`ui-plugins` 作用域过宽，也无法将该清单与可编辑插件设置区分开。 |
| 原 `ui-plugins` 包中的 `PluginSettingsSection`、`PluginSettingsSectionProps`、`PluginSettingsSectionInjected`、`PluginsKey`、`settings.plugins` | `PluginInventorySettingsTab`、`PluginInventorySettingsTabProps`、`PluginInventorySettingsTabInjected`、`PluginInventoryLocaleKey`、`settings.pluginInventory` | 该组件现在贡献一个 tab，而不是设置分区。其余名称明确说明清单主题，并避免与 `PluginsSettingsSection` 及其 `settings.plugins` 区域设置命名空间冲突。保留共享的 `settings.plugins.tab` slot 名；两个 tab 都通过该 slot 向 Plugins 分区贡献内容。 |
| `@deepseek-ai/dsh-client-ui-feedback`、`client/ui-feedback/`、Loader id `ui-feedback`、`client-ui-feedback-invariant` | `@deepseek-ai/dsh-client-ui-message-feedback`、`client/ui-message-feedback/`、Loader id `ui-message-feedback`、`client-ui-message-feedback-invariant` | 这个包通过 `messageFeedback` Remote 展示 assistant 消息的评分和说明。旧名称看起来还涵盖 command feedback 和以后可能出现的其他反馈界面，但实际并非如此。 |
| 原 `ui-feedback` 包中的 `FeedbackController`、`FeedbackStatus`、`FeedbackView`、`FeedbackActionResult`、`FeedbackInjected`、`FeedbackActionProps`、`FeedbackActions`、`FeedbackKey` | `MessageFeedbackController`、`MessageFeedbackStatus`、`MessageFeedbackView`、`MessageFeedbackActionResult`、`MessageFeedbackInjected`、`MessageFeedbackActionProps`、`MessageFeedbackActions`、`MessageFeedbackKey` | 这些名称会从 Client 包导出。增加 `Message` 限定词，避免它们声称代表所有反馈领域。保留 `Controller`：该对象接受评分和说明操作，并协调一个 Session 的加载、修改、冲突、重连和释放状态。 |
| `agent-loop-store.ts`、`bash-store.ts`、`web-search-store.ts` | `agent-loop-card-controller.ts`、`bash-card-controller.ts`、`web-search-card-controller.ts` | 每个模块都导出一个卡片控制器。私有 `SnapshotStore` 字段不会让模块成为存储。 |
| `card-store.ts` | `card-form.ts` | 该模块拥有暂存表单、字段转换和表单操作。它返回的快照存储是呈现适配器，而不是模块的主要职责。 |
| `@deepseek-ai/dsh-client-ui-question` | `@deepseek-ai/dsh-client-ui-user-questions` | UI 呈现用户问题 seam，而不是任意问题领域。 |
| `@deepseek-ai/dsh-client-ui-command`, `ui-command/` | `@deepseek-ai/dsh-client-ui-commands`, `ui-commands/` | 该包呈现并运行一组命令。 |
| `@deepseek-ai/dsh-client-ui-directory-picker`、`client/ui-directory-picker/`、Loader id `ui-directory-picker`、`client-ui-directory-picker-invariant` | `@deepseek-ai/dsh-client-ui-directory-picker-browse`、`client/ui-directory-picker-browse/`、Loader id `ui-directory-picker-browse`、`client-ui-directory-picker-browse-invariant` | 客户端包现已拆成 `browse` 和 `native` 两种目录选择器呈现。未加限定词的包实际只是 browse 实现，并非两者的共同定义。目标名称与 Host 后端系列一致，不改变边界。 |
| 客户端 `ctx.command`、`CommandService`、`CommandServiceContract` | `ctx.commandUi`、`CommandUiRuntime`、`CommandUiContract` | Host 已拥有 `ctx.commands`。该客户端服务是命令发现和执行的 UI 运行时。现有 `CommandUiSpec` 确立了 `Ui` 大小写格式。 |
| `ConversationService` | `ConversationController` | 该对象控制当前对话状态和用户操作。 |
| `InputService` | `SessionInputResolver` | 该接口为一个会话作用域解析输入外观。它既不是全局输入注册表，也不是执行服务。保留 `InputHub` 作为具体中枢，并保留 `ctx.conversation.input` 作为对外接口。 |

PascalCase 标识符内部使用 `Ui`，不要使用 `UI`。除非清单明确要求重命名，否则保留其余客户端包名。在 API 平面移除相关表层之前，保留已弃用的客户端连接与 Host `ApiProxy` 词汇；提前重命名只会增加改动量，不会建立持久名称。

## 明确保留的名称

以下经过讨论的名称保持不变，因为当前作用域准确，或重命名会制造虚假概念：

- 保留完整的 sandbox 系列和 `ctx.sandbox`。不得引入 `processSandbox`。
- 保留 `@deepseek-ai/dsh-api-gateway`、`ctx.typertGateway` 和 `TypertGatewayService`。
- 保留会话投影名称。投影并不只是归约函数。
- 保留 `@deepseek-ai/dsh-session-stats`、`sessionStats` 和 `SessionStatsProjection`。这些名称准确表示全会话统计数据及承载它们的持续维护读模型。
- 保留 `GoalService`；它拥有目标状态机、裁决权、比较并设置行为、事件和远程操作，不只是存储。
- 保留 `SessionTitleService`；它的职责是由多个标题提供方共享的领域服务。
- 保留 `PermissionPresetSettingsController`，即使它很长。每个词都在限定其职责。
- 保留 `ModelsSettingsStore`；其主要约定是一个具有存储操作的设置数据模型。
- 保留 `InputHub`；它是支撑 `SessionInputResolver` 的具体中枢。
- 保留 `dsh-subagent-dsh-sdk` 和提供方 id `dsh-sdk`；重复的限定词可避免歧义。
- 保留 `headless`；即使运行时以后支持不止一次性使用，该产品身份仍然准确。
- 保留已弃用的 Host `ApiProxy` 和客户端连接名称，直至 API 替代方案将其移除。
- Host 服务器和提供方无关的 Web 能力都保留 `Web`。仅直接抓取提供方使用 `HTTP`。
- 保留 `E2B` 作为包名和上下文名称，不改为 `E2B sandbox`。
- 保留 MCP、Todo、应用启动、基础组合包、web-app 组合包和 CLI 名称。保留目录选择器能力和 Host 后端名称；只重命名未加限定词的 Client `browse` 呈现。
- 保留 `@deepseek-ai/dsh-client-ui-directory-picker-native`；其后缀说明它是在重命名后的 `-browse` 变体旁使用原生选择器的呈现。保留 `SURFACE_PACKAGES`；在目录选择器自动选择器中，它是客户端呈现端面的包映射，并与 `BACKEND_PACKAGES` 对照。
- 保留 `@deepseek-ai/dsh-host-plugin-inventory`、`ctx.pluginInventory`、`pluginInventory/list` Remote 以及 `PluginInventory*` 载荷类型。它们准确命名由 Host 拥有的只读清单；只有适配器类和作用域过宽的客户端呈现名称需要修改。
- 保留 `ConfigurablePluginsTab`。该 tab 渲染具有可编辑配置的插件，不拥有完整的 Plugins 设置分区。
- 保留共享的 `settings.plugins.tab` slot。它属于 Plugins 设置分区。清单包只把自己的 locale namespace 改为 `settings.pluginInventory`，不会创建独立的 tab slot。
- 保留 `@deepseek-ai/dsh-message-feedback` 能力、`messageFeedback` Remote、assistant-action entry id `feedback`、hook key `feedback` 和 locale namespace `feedback`。它们所在的接口已经把作用域限定为消息反馈或本地 assistant-message slot。只修改作用域过宽的 Client 包名和导出的 UI 名称。
- 保留 `RemoteFailure`、`RemoteResult` 和 `SessionRemotes`。前两者是 Typert 载体结果值，后者是客户端 Session 集群使用的一组 Remote 命名空间。它们都不是 store、controller、registry 或 runtime。
- 保留用户命令 `/export`、Host 路由 `/api/session.export`、`DownloadsApi` 及其 `sessionLog` 操作。命令说明用户动作，Host 路由导出归档，API 则归类直接 HTTP 下载。重命名的 Client controller 拥有独立的浏览器下载步骤。
- 测试文件名保留 `.client` 和 `.host`。它们标识测试进入的编译端面，不声称产品职责。

## 考虑过的替代方案

**保留现有名称并添加词汇表。**不予采纳。词汇表无法让由 PowerShell 实现的 `BashExecutor` 名副其实，也无法让 `ToolRegistry` 表明它会执行并强制实施工具策略。标识符本身必须承载有用的区别。

**为每个 NPM 包添加所属组前缀。**不予采纳。扁平的 NPM 名称不需要复刻目录树。机械添加前缀只会增加长度，无法解释包的职责。

**将整个仓库称为 SDK。**不予采纳。该项目是 agent harness（智能体框架）。SDK 是 Python 和 TypeScript 客户端使用的、受支持的 JSON-RPC 客户端／服务器栈。一词两义会使包名和产品文案产生歧义。

**所有 Cordis 服务类都使用 `Service`。**不予采纳。Cordis 继承只是实现事实。类名必须告诉调用方该对象负责注册、存储、解析、控制还是运行工作。

**统一使用 `Runtime` 替换 `Service`。**不予采纳。只有对象拥有实时执行或生命周期时，`Runtime` 才正确。注册表、存储、目录、控制器、解析器、引擎和配置对象都应保留更精确的职责名。

**优先使用最短的名称。**不予采纳。只有作用域明确之后，简短才有价值。`PermissionPresetSettingsController` 保留 `Preset`；`JobId` 简短，是因为 `Job` 已经表明领域；`BgTaskId` 虽短，却晦涩难懂。

**为未来可能出现的功能使用宽泛名称。**不予采纳。应按稳定的当前职责命名。未来若要改变边界，可以在发布前再次重命名对象，或在发布后另写提案。含义模糊的名称会让每位当前读者为尚未构建的未来付出理解成本。

**将 `dsh-compact-basic` 重命名为 `dsh-compaction-llm`。**不予采纳。`LLM` 没有在当前后端系列中增加区别。`basic` 意图更克制，也不会声称存在一个实际并不存在的算法。

**将会话投影重命名为归约器。**不予采纳。归约只是构建投影的方式。该包还拥有读取模型值、缓存和查找约定。

**将持久 Bash 工具重命名为 `bash-terminal`。**不予采纳。该名称与终端会话系列冲突。将 `tool-bash-persistent` 移到 `shell/` 可以纠正其归属位置，同时现有名称仍能将其与一次性 Bash 工具区分开。

**应用清单时一并重命名或拆分边界。**不予采纳。评审人必须能够确认行为没有改变。真正的边界缺陷需要独立提案、测试和后果分析。

**为旧名称保留别名。**不予采纳。没有已发布的消费方需要这些别名。别名会保留两套词汇，使首次发布携带一项从未有用户需要的迁移。

## 验证

- 清单中的每项映射都出现在仓库中。每个系列只有一套公开词汇；同一个 Cordis 上下文中没有兼容包、重新导出别名、重复的 `ctx` 键、双重插件 id、双重事件 id、旧工具别名或回退解析器。
- 运行时行为、包边界、默认值、策略、持久化语义和模型行为保持等价，只有标识符本身可见时除外。
- 包目录、NPM 名称、导入、manifest（元数据清单）、TypeScript 引用和路径、Cordis 配置、插件 id、服务键、事件、工具、RPC 名称、清单点名的持久化名称、fixture、快照、示例、生成的目录和当前文案都使用已实现词汇。
- 当前处于 implemented 状态的 Agent Note 使用事实名称和路径。包重新分组说明记录分组清单和包名目标，SDK 移除说明将 `SDK` 限定为运行时协议，超时策略说明记录包名理由。
- 配对的包创建指南包含职责词约定，`packages/AGENTS.md` 链接到该约定，术语表记录选定用词和 `Typert` 拼写，根项目文案将产品称为 DeepSeek Harness，而不是 DeepSeek Harness SDK。
- 已移除的 SDK 项目工具链继续保持不存在。
- `pnpm run check:ci` 覆盖源代码平面的类型检查、构建、包卫生检查、生成参考资料检查、受影响的快照、翻译配对、`doc-sync` 和 lint。发布形态的 Python 运行时冒烟测试和必需 CI 覆盖打包运行时与平台路径。

## 后果

仓库为每个重命名系列保留一套词汇。清单点名的旧磁盘名称、协议值、工具名称和配置项不再工作。能够识别陈旧配置的所属解析器会明确报错，而不是同时接受两种形式。

一些名称更长。额外增加的词只有在防止误述权限或机制时才有意义。如果名称中的词不能全部限定职责，长名称仍然错误。

职责后缀不能替代对行为的检查。包创建指南保留本决策中的直接判断方式：检查调用方执行什么操作、对象拥有什么生命周期，以及对象控制什么失败或策略。

基于旧路径和旧符号的分支需要解决冲突。这是发布前移除旧词汇且不保留兼容别名的一次性成本。
