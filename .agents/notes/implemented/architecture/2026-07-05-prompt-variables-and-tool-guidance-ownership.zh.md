# Agent Note: 提示词变量与工具指导归属

Status: implemented

[English](2026-07-05-prompt-variables-and-tool-guidance-ownership.md) | 中文

## 问题

组装后的系统提示词存在四个缺陷，同属一类：harness 已知的事实在别处被手工重述，然后漂移。

**模型无法知道自己的名字。** `AgentOptions.model` 驱动每个请求，但没有任何提示词文本携带它——也不可能携带：`dsh-system-prompt` 中的 section 是上下文全局的，而模型名称因 agent（智能体）而异，`assemble()` 根本不接受任何 per-agent 输入。

**工具指导是 leaf YAML 中的手写行文。** shell/subagent/todo_write 的使用指导存放在 coding-agent 和 ACP（Agent Client Protocol）的 persona 字符串里——两份漂移的副本（ACP 那份已经被删减）——而 `dsh-tool-fs` 和 `dsh-tool-web` 则通过 `ctx.systemPrompt.section()` 贡献各自的指导。加载或卸载一个工具插件意味着手动编辑每个部署的 persona，旧终端欢迎横幅也手动枚举了工具集。

**Persona 渲染在工具指导之后。** agent loop（智能体循环）将 `agent.options.systemPrompt` 字符串拼接在已组装的 section 之后，于是模型先读到「Use the read tool…」再读到「You are a coding agent」——与 identity-first 约定（Claude Code、Codex）相反，且是 section 流水线之外的第二条组合路径。

**Fork 工具的描述是假的。** `dsh-tool-subagent` 硬编码了一段为 spawn 语义编写的描述——「a separate agent that works in its own context … it does not see this conversation」——而 `subagent_fork` 实例（其子 agent 继承父级已完成的轮次）拿到了同样的措辞；YAML 行文在带外纠正了这个谎言。小问题：`PromptSection.name` 文档标注为「(diagnostics / dedup)」，但重复项被静默接受。

## 决策

**一条原则：提示词中的每个事实恰好有一个归属方。** 模型名称和工作区是配置/会话事实 → harness 将它们暴露为变量，persona 引用它们。每个工具的语义和何时使用 → 工具的 `description`。description 无法承载的跨调用习惯 → 包的提示词 section。产品名称和 SDK 身份说明 → 静态的 `harness:identity` section。部署角色与行为 → 部署的 persona。

### 组装上下文

`SystemPrompt.assemble(context)` 接受一个可合并扩展的 `AssembleContext`。`dsh-system-prompt` 声明可选的 `scope` 选择器用于 scoped 路由，而 `dsh-agent` 通过声明合并将可选的类型化 `agent` 字段附加到其上（类型层面的 `agent → system-prompt` 边，无运行时依赖循环）。循环在每个步骤调用 `assembleContextFor(agent)`，使两个字段标识同一个 agent；section 文本提供方可以读取该上下文，`system-prompt/assemble` waterfall（瀑布式事件）也接收它，监听器可据此按 agent 过滤或扩展。

### 提示词变量

插件通过 `ctx.systemPrompt.variable(name, provider)` 注册 `{{name}}` 值。组装过程将它们解析到 waterfall 可见的变量映射中。渲染阶段拒绝以下情况：引用未知的自有属性、已注册的提供方返回 `undefined`、格式错误的完整引用、以及仍包含闭合 `}}` 的不平衡引用；孤立的未匹配 `{{` 保留为行文，替换后的值不会被重新扫描。注册阶段拒绝无效或重复的变量名，section 名称也必须唯一。

`dsh-agent-loop` 注册两个内置变量，均为上下文 agent 的纯投影：`model`（= `options.model`）和 `cwd`（= `session.header.cwd`）。示例 persona 写 `powered by the {{model}} model`——模型名称只在 `model:` 配置键中声明一次。`{{cwd}}` 仅在 ACP 示例中演示：每个 ACP 会话携带客户端的 cwd，而配置预创建的 stdio agent 没有 cwd（在那里声称 `{{cwd}}` 的 persona 会导致该轮次失败——这是有意为之）。变量留在 loop 插件上（不同于下面的 section）：它们是本循环驱动的 agent 的运行时事实，替换循环自行提供自己的变量。

### Persona 作为 order-0 section

`dsh-system-prompt` 拥有 first-party order 为 `-1000` 的 `harness:identity` 和 order 为 0 的配置 `deployment:persona-prefix`，因此两者在循环被替换时仍然存活。提示词渲染只有一条路径 `renderPrompt(assembly)`，已路由请求 header 因此会记录准确的提示词，稍后由 `ctx.tokenMeter` 为压缩（compaction）压力回放。agent 作用域的 `deployment:persona-prefix` 遮蔽全局默认值，允许 subagent 提供方在发布前安装 persona。[`dsh-system-prompt` README](../../../../packages/core/system-prompt/README.zh.md)规定身份、策略、工具指导、生成协议和最终输出义务的稀疏具名位置。

### 工具指导归属

每个工具的语义和选择指导放在工具 description 中。提示词 section 只承载跨调用习惯，例如检查 bash 退出标记或优先使用文件系统工具而非 shell 命令。`todo_write` 和 subagent 工具不需要 section，因为它们的 description 包含完整约定。部署 persona 只包含角色和行为。

### Subagent 对话历史描述符

`SubagentProvider.inheritsParentContext` 描述的是对话历史初始化，而非作用域、服务、工具或权限。spawn 和 ACP 将其设为 `false`；fork 设为 `true`。`dsh-tool-subagent` 根据该标志派生工具描述和提示词参数描述，包括 fork 继承已完成轮次但不继承进行中轮次这一点。提供方生命周期事件使该措辞与响应式提供方注册保持同步；其设计动机见[提供方生命周期事件 Agent Note](../../archived/architecture/2026-07-05-subagent-provider-lifecycle-events.md)。

## 曾考虑的替代方案

- **循环自行组合一行 identity 文本**：在必须保持精简的那个包（「用插件，不改循环」）中硬编码面向模型的行文，且在 section 流水线之外构成第二条组合路径。（identity 确实以代码字面量交付——但作为 `dsh-system-prompt` 注册的普通 section，其 `system-prompt/assemble` waterfall 仍是部署需要移除它时的逃生阀。）
- **通过 `agent/request` waterfall 注入模型名称**：提示词文本会在两处组合，更早渲染的 persona 也可能与最终已路由 header 不一致。拥有延迟路由的请求插件还必须拥有该模型在提示词中更早出现的声明。
- **在每个 persona 中手写模型名称**：与上方一行的 `model:` 键重复，配置修改后静默失实；正是本决策要治愈的病症。
- **宽松插值（未知引用保留原样或替换为空）**：一个拼写错误 `{{modle}}`（或一个空洞）会被发送给模型，直到 transcript（文本记录）审查时才会被发现。
- **在配置中为每个 subagent 实例编写措辞**：面向模型的行文回到每个部署 × 实例中，重蹈在 leaf YAML 中手写指导的漂移。**根据提供方名称选择措辞**：`providerName` 本身是配置，重命名提供方后会静默获得错误的措辞。
- **在 `apply` 时解析提供方（加载顺序要求）**与**仅用 section 承载 subagent 措辞（在 assemble 时惰性解析）**：提供方生命周期事件的替代方案；两者均在[提供方生命周期事件 Agent Note](../../archived/architecture/2026-07-05-subagent-provider-lifecycle-events.md)中被否决。

## 不在范围内

- 更多变量（`date`、platform、git 状态）：注册表使每个变量成为拥有该事实的插件的一行贡献；本 Agent Note 不认领任何一个。
- 为预创建的 stdio agent 提供配置 `cwd`（可让 stdio persona 使用 `{{cwd}}` 并按真实路径分区持久化）：推迟到会话 cwd 方案重新讨论时。

## 交付的不变式

- tui-agent 的提示词通过一条组装路径依次渲染 identity、带插值模型名的 persona，然后是 fs/shell/web 指导。
- fork 和 fresh subagent 的描述反映提供方是否继承已完成的对话轮次；工具随提供方生命周期变化而出现、消失和重新措辞。
- 未知、无值、格式错误或不平衡的变量引用会指明 section 名称并抛出异常；重复的 section、变量和工具注册同样抛出异常。
- 快照回放与提示词无关：它按轮次和步骤索引已记录的分片流，不比较发出的请求。

## 后果

- 组装后的提示词中每个事实现在恰好有一个归属方，leaf YAML 中手工维护的工具行文已消除：加载或卸载一个工具插件不再需要编辑任何部署的 persona。
- `{{model}}` 在组装时反映 `AgentOptions.model`。如果一个插件在 `agent/request` waterfall 中切换模型，提示词对该步骤的声明就会过时；如果一个插件在那里提供模型（options.model 未设置——循环文档中记载的回退路径），变量在渲染时无值，包含 `{{model}}` 的 persona 会在 waterfall 运行前失败。两者的补救方式相同，就是归属规则本身：拥有延迟绑定模型事实的插件在 `system-prompt/assemble` waterfall 上提前声明它（`assembly.variables['model'] = …`）——一个归属方，两处声明；一个循环测试端到端固定了 supply 路径。已接受。
- 当一个已绑定的提供方不存在时（尚未激活、已卸载、HMR（热模块替换）重载中），subagent 工具不存在，该窗口内的模型请求中不会包含它。这是诚实的状态——替代方案是注册一个 description 或执行都不可信的工具。
- 严格性意味着 persona 可能在渲染时导致轮次失败（例如在无 cwd 的会话上使用 `{{cwd}}`）。失败是受控的——该轮次以 `error` 结束，循环存活——且这是一个我们希望明确暴露的撰写错误。
- 目前没有在提示词行文中转义字面 `{{name}}` 的语法；如果真实提示词确实需要，再行添加。
