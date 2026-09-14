# Agent Note: 动态工作流——脚本驱动的多 agent 编排 seam

Status: implemented

[English](2026-07-05-dynamic-workflows.md) | 中文

## 问题

harness 可以通过 `dsh-tool-subagent` 将一个任务委派给一个子 agent（智能体），但需要扇出到多个独立部分的工作——跨多文件审计、迁移、多角度调研、对抗式验证——迫使模型逐轮次编排：每个中间结果都落入父上下文，计划无处持久存储，每一步的协调都要消耗一次模型往返。Claude Code 以[动态工作流](https://code.claude.com/docs/en/workflows)的形式提供了这一能力：模型编写一段 JavaScript 编排脚本，运行时执行它，由脚本（而非对话）持有循环、分支和中间结果。

## 决策

在 `packages/workflow/` 下以 bash seam 的形态（Service Definition／Service Provider／Consumer）提供一组工作流能力，以及它在 subagent seam 上所需的结构化输出基础。

### 脚本约定（兼容 Claude Code）

一次工作流调用包含 JSON `meta`（`name`、`description`，以及可选的 `whenToUse`/`phases`）和一段支持顶层 `await` 并返回 JSON 值的 JavaScript `script` 正文。元数据作为数据校验，从不被执行。正文接收 `agent(prompt, options)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`phase(title)`、`log(message)` 和 `args`。流水线各阶段接收 `(prev, item, index)`，阶段之间无屏障；失败的子 agent 和普通阶段错误将受影响的 item 结算为 `null` 并跳过其剩余阶段。Claude Code 的确定性限制随日志机制一并延后实现，因此兼容的脚本正文在将 meta 头移入参数后可以使用时钟和随机数。

与 CC 有一处刻意的严格性差异：钩子误用——未知或延迟的选项（`effort`/`isolation`/`agentType`）、格式错误的参数、超出支持子集的 schema、触发上限、seam 启动失败——会抛出带 `fatal: true` 的 `WorkflowError`，组合器会重新抛出 fatal 错误而非将 item 置为 null。如果不这样做，一个拼错的选项会悄然变成一个与子 agent 失败无法区分的 `null`——这正是本仓库禁止的「被接受后被忽略」的失败模式。另有一处新增：工具的 `args` 参数是一个 JSON 对象（裸列表被包装为一个字段），使协议格式（wire format）保持诚实。

### seam（dsh-workflow）

`ctx.workflowEngine` 是 bash 形态的抽象 `WorkflowEngine`——每个上下文一个引擎，无命名提供方注册表（引擎是部署级替换，不是共存者）。`start(request)` 对无法启动的脚本同步抛出；返回的 `WorkflowRun` 的 `result` 永不 reject（失败时结算为 `stopReason: 'error' | 'cancelled'`）。`workflow/*` 事件是仅观察的 emit，携带数据快照（id + meta；`workflow/end` 省略 result 值），按监听器隔离，与 `subagent/start`/`subagent/end` 对称——控制权留在 run 的持有者手中。词汇详情见 [subsystems/workflow.md](../../../../docs/subsystems/workflow.zh.md)。

### 引擎（dsh-workflow-ptc）：共享 Node 进程执行

[工作流沙箱复用决策](../architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md)取代 worker-thread 执行与信任实现。引擎在沙箱化 PTC Node 进程中保留 VM 与辅助函数。VM 定义脚本 API；OS 文件策略和受管进程清理由共享执行提供方负责。

宿主在发布前校验元数据并解析正文。Host 绑定将 guest 连接到 subagent 和工作流观察器。待启动与已发布子记录共享取消信号；[agent 作用域运行时设计 Agent Note](../architecture/2026-07-12-agent-scope-runtime-design.zh.md#workflow-children-are-pending-starts-or-published-records)负责其生命周期规则。

**Meta 是数据**：Host 从不执行元数据字面量。**值是无损 JSON**：guest 侧 realm 物化在 PTC 传输前拒绝不支持的值。getter 在受限进程内运行，钩子错误跨 realm 保留稳定的 `name` 与 `code` 字段。保留协作式辅助函数上限与最初同步片段超时；不增加整体工作流经过时间定时器。

### Consumer（`dsh-tool-workflow`）

一个 `workflow` 工具，镜像 `dsh-tool-subagent` 的同步形态：启动、await、`try/finally` dispose、abort 桥接 `exec.signal`、非 `completed` → `isError`。渲染意图：一张以调用的 `meta.name` 参数为标题的 `generic` 卡片（展示是参数的纯函数）。工具描述即面向模型的编写规范。使用策略以工具自身的 `tool:<toolName>` 提示词段落随工具发布（显式请求才使用的引导——工具引导存在于工具插件中，从不在部署 persona 中）；harness 没有 ultracode 风格的 effort 门控。

对于顶层工具执行，同一消费方还会把运行及实际成员生命周期写入调用方父 Session，形成四类 log-only `tool-workflow/*` 事件。记录路径只观察、不控制执行：第一次 append 失败会禁用本运行后续写入并留下合法前缀，不改变工具结果。[`ui-workflow-run`](../../../../packages/client/ui-workflow-run/README.zh.md) 通过 Conversation Node 引擎重建这些事实，形成独立 keyed Chat 行；现有 generic 工具行继续拥有自己的展示。持久化、回放、展开/收起与实时导航的详细决策见 [Chat 中的持久工作流运行](../../archived/feature/2026-08-10-durable-workflow-runs-in-chat.md)。

### 基础：subagent seam 上的结构化输出

`SubagentStartRequest.outputSchema` 由 `dsh-subagent-in-process-driver` 为两个进程内后端实现。每个结构化子 agent 在 `child.ctx` 上获得自己的作用域捕获工具、指令和强制注册；并发子 agent 可以使用不同的 schema 而不共享可变策略，dispose 子 agent 时移除整个附件。

输出 schema 使一次 schema 有效的已提交捕获成为子 agent 成功完成的必要条件。作用域运行时呈现捕获工具和指令，仅提交成功的最终结果（包括 SDK 调用时外层 `run_code` 的结果），在捕获变为 pending 后拒绝后续副作用，并在提交后不再进行模型步骤即停止子 agent。校验失败仍是可重试的工具错误；没有已提交捕获的正常完成以错误结算。

`ObjectJsonSchema` 是 `dsh-tools` 统一且可强制执行的原始 JSON Schema 子集所提供的对象根消费方视图；不支持的关键字会明确报错，因为该协议数据会逐字成为捕获工具的 parameters。[统一 JSON 值 schema Agent Note](../architecture/2026-07-20-unified-json-value-schema-dsl.zh.md)定义词汇与校验语义，[agent 作用域运行时设计 Agent Note](../architecture/2026-07-12-agent-scope-runtime-design.zh.md#structured-output-commits-only-authoritative-outcomes)则定义组装、提交、守卫和终止停止算法。

## 测试

验证由工作流辅助函数和 Host 生命周期测试、共享 Node PTC 约束测试，以及通过已发布 profile 的源码／构建后工作流执行负责。已记录工作流与显式启用的 Ralph 场景负责组装后的模型转录；使用 passthrough 沙箱的回放配置不能证明 OS 强制能力。

## 延迟（明确的非目标）

- **后台收集**（启动工具 → run id → 完成通知 → 收集），与 shell/subagent 后台统一一起设计。
- **日志化 + 恢复**（`resumeFromRunId`、缓存的 agent() 前缀）：实现它会以脚本约定收紧的形式重新引入 CC 的确定性禁令（脚本可以读取时钟）。
- **保存／打包的工作流**（`.deepseek/workflows/` 注册表、斜杠命令 API）和**脚本持久化到运行目录**（工具调用事件已经持久记录了脚本）。
- **嵌套 `workflow()`**、**token `budget`**，以及 `effort`/`isolation`/`agentType` agent 选项（每个都会明确拒绝，并在消息中注明其已延迟实现）。
- **整体运行的挂钟超时**：工作流生命周期仍由调用方控制；显式取消停止 PTC 执行并等待子 agent 清理。
- **ACP（Agent Client Protocol）后端结构化输出**和 **`toolFilter`**（两者仍以能力标志 `false` 门控）。

## 曾考虑的替代方案

- **VM 值的 Host 侧防护**（代理拒绝、描述符遍历和跨 realm 克隆）：这些无法强制 OS 文件权限。VM 求值与物化属于受限进程内部；共享 PTC 提供方负责进程传输处的验证。
- **进程内 `node:vm` 执行**：机械上最简——无 RPC、无线程——但 `start()` 会在脚本的初始同步切片期间阻塞调用方，第一个 await 之后的同步自旋无法在进程内终止（vm `timeout` 仅覆盖第一个切片），且 `dispose()` 只能在宿主循环上放弃一个未 settle 的脚本。PTC 进程保持 vm 上下文脚本 API，同时解除宿主阻塞并提供受管终止。
- **`isolated-vm`**：引入另一套 JavaScript 引擎会增加原生依赖与部署要求；共享 PTC 提供方已提供进程约束。
- **后台执行作为默认**（CC 的形态）：延迟。前台同步与 `dsh-tool-subagent` 的当前形态一致，后台语义应在 bash、subagent 和工作流之间统一设计一次，而非逐工具设计。
- **工作流层为 `agent({schema})` 做 JSON 解析**：在一个消费方重复 seam 关注点，而 seam 的能力标志仍不诚实地为 `false`。
- **Meta 嵌入脚本中作为 `export const meta = {...}`**（CC 的确切格式）：保持脚本自包含且 CC 脚本可直接使用，但获取 meta 需要在宿主上执行模型编写的文本。即使一个空的限时 vm 上下文也无法约束脚本控制的 getter（当宿主读取结果对象时）。JSON 参数消除了扫描器、执行和宿主自旋漏洞；代价是 CC 脚本的 meta 头必须移入参数（正文保持可直接使用）。
- **`ValueSchemaSpec` 作为 `outputSchema` 协议类型**：面向作者的形式如今具有等价词汇，但工作流提供的是来自其他 realm 的原始 JSON Schema 数据；将这类运行时数据假装成可信的作者声明，会跳过原始 schema 断言边界。
- **schema 对象库（zod 或本仓库的 schemastery）用于结构化输出子集**：schema 是协议数据——纯 JSON，跨越 `agent({schema})` 中的 vm realm 边界并逐字落入强制工具的 parameters——正是活 schema 对象无法存在的位置；在运行时消费原始 JSON Schema 需要在其上加一个第三方转换器（zod core 只输出 JSON Schema，不能反向），且会在 schemastery 的配置角色旁边放置第二种 schema 语言。
- **ajv 用于值校验**：它校验完整 JSON Schema，因此子集门控——模块的真正要点，因为每个被接受的关键字都必须是 harness 强制执行的——无论如何仍需手写；它通过 `new Function` 编译校验器；且它将成为 dsh-tools 的第一个运行时依赖，仅为替换约 70 行的值遍历器，而带路径且逐一报告所有违规的错误报告无论如何都是自定义的。
- **提供方 JSON 模式代替捕获工具**：它保证 JSON 有效，但不保证其符合 schema，且它与工具调用的交互不明确。捕获工具保留了轮次内的校验重试。提供方侧的严格工具 schema 后续可以在不改变本设计的情况下收窄接受的子集。

## 后果

扇出计划现在存在于可重运行的脚本中，`outputSchema` 提供权威的结构化子 agent 结果。每次运行付出 PTC 进程启动与绑定 RPC 成本。Host 执行保持非阻塞，取消停止受管进程，JSON 序列化将 guest 值与 Host 分开。无效选项会失败而非退化为 Claude Code 的 `null`；消费方通过 run handle 保持控制权，观察者仅接收快照。顶层 Web 用户还会得到持久、可回放的工作流记录，同时不扩宽执行 seam，也不把原工具卡耦合到工作流专属 UI。
