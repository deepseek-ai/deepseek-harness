# 术语表

[English](glossary.md) | 中文

DeepSeek Harness 的领域词汇为每个概念规定一个规范术语。各术语通过标准 Markdown 锚点链接到相应条目；实现细节留在各包的 README 与 Agent Note 中。

## capability-seam

- **seam**：一种包含三种角色的*可替换能力*：**Service Definition**（拥有自身 `ctx.<key>` 和词汇类型的 Cordis `Service`——可以是 `ShellExecutor` 这样的抽象类，也可以是 `WebRuntime` 这样的具体注册表，绝不是 TypeScript `interface`）、一个或多个 **Service Provider**，以及一个或多个注入该服务的 **Consumer**。`packages/shell` 是规范范例：`dsh-shell`（Service Definition）、`dsh-bash-local` / `dsh-bash-sandbox`（提供方），以及 `dsh-tool-bash`（Consumer）。角色需要独立演进时通常位于不同包，但属于同一关注点时，一个包也可以承担多个角色（`dsh-user-approval` 在同一个包中承担 approval seam 的 Service Definition 与其具体实现）。seam 是完整能力，绝不是其中一个角色；该术语仅保留此义，能力成员应按其角色、类、服务、约定或扩展点命名。

## agent-scope

- **scope**：按 agent（智能体）划分的注册单位。一项贡献（工具、提示词段、变量、限制、监听器）要么是*全局的*（对所有 agent 可见），要么是*带作用域的*（归属于恰好一个 [scope key](#scope-key)）。只有两层，采用扁平结构：带作用域的注册不会向下继承给 subagent；子树行为通过 [lineage](#lineage) 数据表达，从不通过 scope 结构。
- **scope key**：scope 的不透明标识，按对象同一性比较。harness 约定：一个活跃的 agent 就是其自身 scope 的 key。<a id="scope-key"></a>
- **agent 上下文（`agent.ctx`）**：agent 的带作用域上下文；通过它进行的注册既具有 scope 可见性，其生命周期也绑定到该 scope（同一事实决定两者），其上的监听器参与该 agent 的 scope 过滤分发。注册表主体事件可以根据各自的事件约定有意保持不过滤。
- **scope carrier**：scope 过滤分发所携带的 `thisArg`（由 `scopeTarget` 构建）；其过滤器放行无标签监听器加上主体自身的监听器。*无主体*的 carrier（没有 key）只放行无标签监听器。
- **scoped dispatch**：规则是：关于某个 agent 的活动的事件以该 agent 的 carrier 进行分发。关于注册表本身的事件（如「一个工具被添加了」）属于*注册表主体*事件，保持不过滤。
- **shadowing**：最具体者胜出的名称解析：一个带作用域的工具／片段／变量仅在该 scope 内替换同名的全局对应项。这是按 agent 定制 persona 和按 agent 定制工具变体的机制。
- **restriction / scope-local 注册**：restriction（`tools.restrict`）为单个 scope 过滤全局工具集合（多个 restriction 取交集组合）；scope-local 注册在过滤之后合并。被过滤掉的全局工具既不出现在提示词中，也拒绝执行，与不存在的工具无法区分。
- **setup window**：创建者组装 agent 作用域环境的创建时隙（`CreateAgentOptions.setup`）：此时 scope 和 agent 对象已存在，但 agent 或会话尚未发布，`agent/created` 尚未触发，首次提示词尚未组装。setup 只做注册，从不驱动 agent。
- **lineage**：以数据形式携带的父子关系事实（`parentSession`、持久的 `delegationDepth`、运行时 `subagentDepth`）；从不影响可见性。<a id="lineage"></a>

## 目标

- **目标**：附着在现有会话上的单个持久完成目标，带有按修订号演进的 `active` / `paused` / `blocked` / `complete` 阶段和 Goal Round 上限；`blocked` 保留策略代码与说明。目标是一种状态，不是调度器，也不是一段独立对话；会话日志仍是其真源。
- **Goal Round**：为当前目标接纳的一次续行周期。同会话驱动器将 Goal Round 具体化为一个由目标触发的[轮次](#turn)，其中可包含零个或多个步骤；同一会话中无关的人类轮次不消耗 Goal Round 上限。<a id="goal-round"></a>
- **目标激活**：续行消费方接纳下一个 Goal Round 的进程本地权限。激活态为 `armed` 或 `disarmed`；它有意不参与持久回放，因此在恢复或 fork 后，只有随后通过 `/goal` 或模型工具执行一次经人类授权的恢复变更，自动工作才能开始。

## 人类命令

- **人类命令**：以斜杠开头的指令，由面向人类的适配器通过 `ctx.commands` 解释并执行，不会成为模型消息。它既不同于面向模型的工具，也不同于通过 `ctx.shell` 执行 shell 命令。
- **命令平面**：由 UI 适配器和命令插件负责的发现、解析、分发、取消与结果渲染机制。除非处理器另行改变持久领域，否则命令输出属于 UI 状态。
- **目标命令**：`/goal` 是由 `dsh-command-goal` 提供的人类命令；它直接观察或更改当前目标，而目标领域拥有每条持久且模型可见的记录。

## 循环层级

- **轮次**：会话中一次对已接纳输入的排空过程，在模型及其工具停止工作或终止策略介入后结束。<a id="turn"></a>
- **步骤**：一次模型请求，以及由模型响应引发的工具执行；一个轮次包含零个或多个步骤。<a id="step"></a>
- **Round**：承载一个轮次的外层策略迭代，例如一个 [Goal Round](#goal-round) 或一次使用全新 agent 的 Ralph 尝试。Round 计数器归该策略所有，并不统计会话中的每个轮次。<a id="round"></a>

## Ralph

- **Ralph 循环**：一次面向不可变目标的前台全新 agent 工作流运行。它是由工作流和 subagent 原语组合而成的面向模型的工具策略，不是同会话目标、agent loop（智能体循环）模式、调度器或通用工作流脚本功能。<a id="ralph-loop"></a>
- **Ralph Round**：[Ralph 循环](#ralph-loop)中的一个全新子会话。子会话不接收父会话或此前子会话的对话种子；共享工作区和一份有界的 [Ralph 交接](#ralph-handoff)承载跨 Round 的状态。<a id="ralph-round"></a>
- **Ralph 交接**：从一个仍需继续的 Ralph Round 传给下一个 Ralph Round 的规范化、有界结构化报告，包含状态、摘要、证据、后续步骤和阻塞说明。它补充共享工作区，而不取代工作区的权威地位。<a id="ralph-handoff"></a>
