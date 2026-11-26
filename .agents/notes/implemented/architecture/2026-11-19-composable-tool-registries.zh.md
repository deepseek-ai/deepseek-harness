# Agent Note: 在按作用域选择的根注册表下组合工具注册表

Status: implemented

[English](2026-11-19-composable-tool-registries.md) | 中文

## 问题

`ctx.tools` 原先保存按作用域注册的工具定义，而由 `setExecutor()` 选中的独立 `ToolExecutor` 决定模型以何种方式触达这些定义：原生执行器声明每个可见定义，PTC 执行器则声明 `run_code` 和一份生成的 SDK。第二个程序入口无法复用这套组合。CUA 用 `createRunCodeTool()` 构建 `cua_run_code`；这个工厂把一份固定的定义列表复制成私有绑定，因此 PTC 执行器与 CUA 程序工具各自拥有不同的绑定来源。入口名称、辅助函数或输出不同的程序风格（例如 Pi 与 Codex 的 code mode）都会各自需要另一个工厂或执行器。

可用性取决于 Agent 状态的工具原先使用 `register(tool, { when })`。每个步骤之前，循环通过 `resolve()` 等待所有条件，得到的 `ResolvedToolSet` 必须传到提示词组装、调用批次和每个 PTC 子调用。因此注册表的每个消费方都要接收一个步骤工具集合，而且即使条件读取的状态没有变化，条件也会针对每个 Agent 和每个步骤运行。提示词段原先通过 `ctx.tools.get()` 询问其工具是否可见来隐藏使用指引，因此除了该作用域的模型能调用什么之外，注册表还要另行回答作用域拥有哪些工具。

## 决策

`ToolRegistry` 是一组可直接调用的入口，提供 `register()`、`include()`、`get()` 和 `getAll()`。`include(registry)` 在每次查询时读取另一个注册表的入口，因此来源注册表保留所有权，其后续变化无需重新发布即可出现。注册表不负责执行批次：所有批次都由 `ctx.tools.execute()` 运行。

每个作用域用 `setRoot()` 选择一个根注册表，`ctx.tools` 以该根注册表为送达目标。在某个作用域中注册或引入的工具会送达该作用域选中的根注册表，以及其下级作用域选中的根注册表：`setRoot()` 让根注册表引入一个私有注册视图，该视图按最近作用域遮蔽规则和查看方作用域自身的限制，解析每个查看方作用域的工具；引入或读取 `ctx.tools` 的根注册表会在被选中时，或在之后触及该读取的查找或批次中，以 `ToolCompositionError` 失败；`setRoot()` 对再次选中的根注册表只引入一次该视图，并在根注册表被选中或卸载时发出 `tools/change`。祖先作用域中的引入算作继承内容，因此子作用域的 `restrict()` 对它们生效；决定某个名称的作用域为该名称提供两个不同的定义时，注册即以 `INVALID_TOOL_COMPOSITION` 失败。`ctx.tools.get()` 与 `getAll()` 返回选中的根注册表的入口，`ctx.tools.execute()` 则通过批次开始时选中的根注册表解析每个调用；没有可用的根注册表时，三者都抛出 `ToolRegistryUnavailableError`。`NativeToolRegistry` 把作用域看到的每个注册项都作为入口提供。`PtcToolRegistry` 提供一个程序入口，并在程序中绑定这些注册项，因此在 PTC 根注册表下，`getAll()` 的结果是 `[run_code]`。CUA 引入一个名为 `cua_run_code` 的私有 `PtcToolRegistry`，其唯一绑定是 `cua`，因此 PTC 根注册表与 CUA 工具共用同一实现。

只在工具可用时显示的工具段以 `guidance` 的形式随定义一同携带，文件系统、搜索、`apply_patch`、schedule、按需加载 MCP 目录与委派段都是如此：`ctx.tools.register()` 在注册工具的同一个 effect 中注册该段，并且只有当查看方作用域的注册项解析出这个确切的定义时才渲染它，这覆盖了原生声明、PTC 程序绑定、限制以及更近的同名定义，而无需查询注册表。共享使用指引的多个工具共用一个 `section` 并声明相同的使用指引，系统提示词只渲染它一次，并带上查看方作用域解析出的工具名称；委派工具就以这种方式共享 `tool:subagent`。其他工具段（例如 bash 的段）与工具分开注册，在其插件加载期间一直保留。使用指引可以提及另一个插件的工具，而无需检查该工具是否存在。新增使用指引不被鼓励：模型需要了解的关于某个工具的信息属于该工具的描述与参数描述，每个根注册表都会随工具一起送达这些内容；而一个段会在每个步骤中占用提示词空间，并成为第二个需要保持同步的地方。`guidance` 的存在是为了让早于这条规则的各工具的提示词文本保持逐字节不变。按 Agent 提供工具的提供方把工具注册到 `AgentToolRegistry` 中，`ctx.tools` 看不到其中的单个工具，因此该提供方依据自己的注册表为每个 Agent 决定段的文本。

有一个问题无法从根注册表的视图中得到答案：多个 Timeline 安装实例中哪一个离某个 Agent 最近。`dsh-timeline` 通过作用域过滤的包内事件 `timeline/installation` 提问，每个安装实例都以自己的记录作答；提问方通过该 Agent 的载体分发事件，并取作用域链中最近的记录。这些监听器属于各实例自己的上下文，因此实例卸载时会撤下它们，彼此独立的应用绝不会看到对方的实例，而同一组合中同一个包的多份副本也以相同方式作答。

提供方负责按 Agent 决定工具的可用性。引入到 `ctx.tools` 中的 `AgentToolRegistry` 向每个 Agent 展示其提供方通过 `set(agent, names)` 为它添加的工具；它不限作用域的视图列出每个已注册工具，因此限制、`toolOrder` 与工具目录可以在 Agent 看到某个工具之前就点名它。不带 Agent 的调用解析该视图并到达工具主体，工具主体在需要 Agent 时检查 `exec.agent`；Plan、Office、Team 与 Web 工具拒绝这类调用。提供方在其状态变化时调用 `set()`：Agent 创建时、提供方自身状态变化时、收到 `agent-preset/selected` 且空白会话的预设变化把活跃 Agent 移入该提供方所属预设时，以及加载时对已存在 Agent 的一次遍历中。Web 工具的可用性取决于该 Agent 的模型路由与凭据，因此 Web 工具还会在 `model/selection`、点名另一提供方的 `request/header`、凭据变化以及 `web/providers-changed` 时再次检查。

AgentLoop 在组装每个步骤之前把 `ctx.tools.getAll(agent)` 捕获为一个 `ToolStep`。提示词恰好声明这些入口，该步骤的调用批次与程序调用也只执行同样的定义；PTC 注册表还会固定它为该步骤声明的绑定。模型响应期间发生的替换或新增从下一个步骤开始生效；移除工具，或提供方为该 Agent 撤下工具，则立即生效，因此该步骤中对该工具尚未开始的调用以 `UNKNOWN_TOOL` 失败。模型直接调用根注册表只在程序中绑定的工具时，该调用会在 `tools/pre-execute`、审批、守卫和执行包装层之前失败，其消息会列出该步骤可以调用的入口，因此模型会被引导到程序入口。分发恰好运行准备该调用时捕获的定义；根注册表不再提供该定义时，调用以 `UNKNOWN_TOOL` 失败。

## 考虑过的替代方案

**保留 `ToolExecutor`，为每种程序风格增加一个工厂。** 每个工厂都会像 `createRunCodeTool()` 那样把定义复制成私有绑定，因此限制、作用域遮蔽和实时注册变化都要按风格重新实现。引入这些注册项的注册表直接复用这些机制。

**保留 `ctx.tools` 作为存储，由其 `get()` 列出作用域拥有的内容，并让每个根注册表引入 `ctx.tools`。** 这样查找回答的问题就与模型的工具列表不同：在 PTC 根注册表下，`ctx.tools.get('read')` 会找到模型无法调用的工具；步骤捕获需要另一个隐藏查询来获取根注册表的入口；每个根注册表都要通过循环防护回读 `ctx.tools`。改为送达根注册表后只有一个答案，即根注册表提供的入口。

**把每个注册项复制到每个根注册表。** 每个根注册表实现都需要一个带遮蔽和限制的作用域存储、`register()` 上的作用域参数，以及在根注册表加载、重新加载或随预设切换而变化时重放每个注册项。私有注册视图只用一个存储就实现了同样的送达。

**依据工具是否存在来决定是否提供使用指引。** 每个段都要询问注册表其工具是否可见，而在 PTC 根注册表下，这一询问必须把程序绑定计算在内，于是注册表要为每个插件回答第二个问题。`guidance` 在 `ctx.tools` 内部、依据它已经持有的注册项做出同样的判断。

**让施加限制的插件隐藏使用指引。** 调用 `restrict()` 的插件会为受限作用域注册一个空的同名段。它需要知道哪个段属于哪个工具，包括共享的 `tool:subagent` 段，而每个新增的限制位置都要重复这项工作。

**保留步骤时的 `when` 条件。** 条件让每个消费方都要接收步骤工具集合，并在每个步骤评估所有条件。提供方本来就知道自己的状态何时变化。

**在每个步骤捕获工具之前发出一个需等待完成的事件。** 这样 Web 路由检查就能读取该步骤确切的模型选择，Plan 与 Team 也能在每个步骤依据日志对账。但这为一个消费方在 agent loop（智能体循环）中保留了一个逐步骤扩展点，而且尽管输入很少变化，它仍对每个 Agent 的每个步骤运行所有监听器；大多数输入通过事件变化，没有对应事件的输入列在「后果」一节中。Web 工具改为在路由、某个凭据或提供方变化时再次检查；在检查运行期间开始的步骤使用先前的回答。

**直接在 `agent.ctx` 中注册按 Agent 提供的工具。** 该注册会属于 Agent 自己的作用域，而 `restrict()` 不过滤这个作用域，因此子级的 `toolFilter` 将无法再隐藏该工具。被引入的 `AgentToolRegistry` 让该工具仍属于继承内容。

**为每个 PTC 注册表保存一张绑定表，而不是引入这些注册项。** 这张表需要为每次注册、限制和 preset 变化维护自己的更新路径，并且可能与原生根注册表提供的内容不一致。

## 后果

同一个注册表接口服务于原生根注册表、PTC 根注册表以及 `cua_run_code` 等程序工具，因此新的程序风格是注册表而不是执行器，自定义根注册表则实现四个方法。工具查找不接收步骤参数，只有 agent loop 和注册表处理 `ToolStep`。执行记录携带每个调用解析出的定义，因此策略直接读取它，无需再按名称查找一次。读取 `ctx.tools` 的代码（包括测试）需要一个选中的根注册表，而处于 PTC 根注册表下的 Agent 在那里只能看到 `run_code`：Cordis Inspect、Claude Code 模组的 `$.tool.list`，以及 Cordis host 沙箱的 `ctx.tools.schemas()` 与 `get()` 都只列出程序入口，没有根注册表时则抛出 `ToolRegistryUnavailableError`；部署根注册表不提供 `read` 时，LiveShare 查看者的 fork 会以 `tool-unavailable` 被拒绝；被阻止的浏览器 MCP 客户端所继承的工具仍保持绑定，但对它们的调用仍会被拒绝。`restrict({ deny })` 接受尚无任何来源提供的名称，因此 Timeline 会对它管理的每个 Agent 拒绝 `todo_write`。

受限制的工具，其 `guidance` 对该受限作用域停止渲染。其他工具提示词文本在其工具受限时仍会保留（[限制](../../../../packages/core/tools/README.zh.md#known-limitations-and-deferred-work)）：与工具分开注册的段，例如 bash 的段；按 Agent 提供工具的提供方（Web、Plan、Office、Team）和 CUA 的段；委派深度上下文；subagent 身份上下文中的 `send_message` 与 `list_agents` 两行；以及 skill（技能）目录消息。只有当前进程见过的来源才会被检测为退役，因此在没有该来源（例如没有 MCP 加载器或委派工具）的进程中恢复的会话会保留它见过的使用指引，且不会收到通知（[来源生命周期](../../../../packages/core/system-prompt/README.zh.md#known-limitations-and-deferred-work)）。按 Agent 提供工具的提供方必须在加载时初始化已存在的 Agent；对于恢复或 fork 出的会话，它们从该会话的日志恢复会话状态。漏掉某次状态变化的提供方会让该工具保持陈旧，直到它下一次更新，步骤时条件原本会纠正这种情况。没有变化事件的就绪状态输入在该 Agent 的下一次检查时生效：编辑过的 Web 提供方设置，以及跟随默认模型的空白 Web 会话的路由；后者在另一个会话保存新的默认模型时变化。该会话的第一个步骤使用针对旧路由检查得到的回答；该步骤自身的 `request/header` 会启动一次检查，如果新路由未就绪，该工具会在模型回答期间被撤下，因此已声明的 `web_search` 调用以 `UNKNOWN_TOOL` 失败；若该调用在检查结算之前开始，则以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。模型响应期间被撤下的工具会使该步骤中对它的调用以 `UNKNOWN_TOOL` 失败；而步骤时条件曾在该步骤内保留该工具，交由工具主体报告当前状态，例如 `TEAM_DISABLED`。调用过 `setExecutor()`、`resolve()`、`schemas()` 或 `register(tool, { when })` 的插件、实现过 `execute()` 的根注册表，以及通过 `ctx.tools.get()` 读取已注册工具的代码，按[升级指南](../../../../docs/upgrade-guide/v0.2.3-alpha.2/tool-registry-roots/guide.zh.md)迁移。

[registry-composition.spec.ts](../../../../packages/core/tools/tests/registry-composition.spec.ts) 覆盖根注册表选择、向稍后加载的根注册表送达、不可用的根注册表、实时引入、继承的限制、歧义、引入循环、按 Agent 提供的工具以及步骤准入；[guidance.spec.ts](../../../../packages/core/tools/tests/guidance.spec.ts) 覆盖限制下的使用指引、遮蔽、共享段以及退役。提供方测试覆盖每种按 Agent 更新工具的触发时机，包括晚于其 Agent 加载的提供方。
