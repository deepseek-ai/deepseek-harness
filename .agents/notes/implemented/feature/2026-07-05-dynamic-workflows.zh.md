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

### 引擎（dsh-workflow-worker-thread）：每次运行一个 worker 线程

**信任前提**：工作流脚本与模型的 bash 访问具有相同的信任级别。引擎会约束有缺陷脚本的影响，并保证结果已 settled、值可安全表示为 JSON、取消后完全停稳；它不防御恶意代码。vm 上下文和 worker 线程不是安全边界：脚本可以逃逸到具有进程级权限的 Node API。沙箱化需要在此 seam 背后使用独立进程或 isolated-vm 引擎。

**为何选择 `node:worker_threads`**：每次运行获得一个非池化的 worker。vm 上下文限定了文档中说明的脚本 API，而消息端口 RPC 将 `agent()` 桥接到宿主侧的子循环。worker 防止脚本的同步工作阻塞宿主，提供序列化边界，并允许取消后强制终止。`isolated-vm` 因其维护状态和部署要求被否决。

宿主在发布前校验元数据并解析正文。私有枚举键 payload 映射定义协议格式；待启动记录、已发布子记录、单一取消信号、worker 死亡回收、结果优先级与 dispose（资源释放）时的完全停稳，在此协议上保持 subagent run 约定。这些竞态算法由 [agent 作用域运行时设计 Agent Note](../architecture/2026-07-12-agent-scope-runtime-design.zh.md#workflow-children-are-pending-starts-or-published-records) 定义。

引擎暴露一条进程内 `MessageChannel` 测试路径，因为主进程 V8 覆盖率无法观测 worker 执行。

**Meta 是数据**：经 schema 校验的 `meta` 字段以 JSON 形式到达 seam，仅做形状校验。宿主从不执行元数据字面量，否则脚本控制的访问器可以在 worker 隔离之外运行。

**值边界**：`materializeFromRealm` 复制出站值，并拒绝函数、symbol、嵌套 `undefined`、异域原型、循环引用、稀疏数组和非有限数字。数据属性复制使 `"__proto__"` 安全；getter 正常读取，抛出异常的 getter 会明确报错。`args` 通过 `workerData` 传入，暴露前再次克隆。realm 函数被调用而非复制，抛出的值使用对所有输入均有定义的渲染器，因此 `result` 不会 reject。钩子错误是宿主 realm 的 `WorkflowError`，脚本应基于 `name` 或 `code` 分支而非 `instanceof Error`，如引擎 README 所述。并发、total-agent、item、超时和宽限限制均为经校验的配置。

### Consumer（`dsh-tool-workflow`）

一个 `workflow` 工具，镜像 `dsh-tool-subagent` 的同步形态：启动、await、`try/finally` dispose、abort 桥接 `exec.signal`、非 `completed` → `isError`。渲染意图：一张以调用的 `meta.name` 参数为标题的 `generic` 卡片（展示是参数的纯函数）。工具描述即面向模型的编写规范。使用策略以工具自身的 `tool:<toolName>` 提示词段落随工具发布（显式请求才使用的引导——工具引导存在于工具插件中，从不在部署 persona 中）；harness 没有 ultracode 风格的 effort 门控。

对于顶层工具执行，同一消费方还会把运行及实际成员生命周期写入调用方父 Session，形成四类 log-only `tool-workflow/*` 事件。记录路径只观察、不控制执行：第一次 append 失败会禁用本运行后续写入并留下合法前缀，不改变工具结果。[`ui-workflow-run`](../../../../packages/client/ui-workflow-run/README.zh.md) 通过 Conversation Node 引擎重建这些事实，形成独立 keyed Chat 行；现有 generic 工具行继续拥有自己的展示。持久化、回放、展开/收起与实时导航的详细决策见 [Chat 中的持久工作流运行](../../archived/feature/2026-08-10-durable-workflow-runs-in-chat.md)。

### 基础：subagent seam 上的结构化输出

`SubagentStartRequest.outputSchema` 由 `dsh-subagent-in-process-driver` 为两个进程内后端实现。每个结构化子 agent 在 `child.ctx` 上获得自己的作用域捕获工具、指令和强制注册；并发子 agent 可以使用不同的 schema 而不共享可变策略，dispose 子 agent 时移除整个附件。

输出 schema 使一次 schema 有效的已提交捕获成为子 agent 成功完成的必要条件。作用域运行时呈现捕获工具和指令，仅提交成功的最终结果（包括 SDK 调用时外层 `run_code` 的结果），在捕获变为 pending 后拒绝后续副作用，并在提交后不再进行模型步骤即停止子 agent。校验失败仍是可重试的工具错误；没有已提交捕获的正常完成以错误结算。

`ObjectJsonSchema` 是 `dsh-tools` 统一且可强制执行的原始 JSON Schema 子集所提供的对象根消费方视图；不支持的关键字会明确报错，因为该协议数据会逐字成为捕获工具的 parameters。[统一 JSON 值 schema Agent Note](../architecture/2026-07-20-unified-json-value-schema-dsl.zh.md)定义词汇与校验语义，[agent 作用域运行时设计 Agent Note](../architecture/2026-07-12-agent-scope-runtime-design.zh.md#structured-output-commits-only-authoritative-outcomes)则定义组装、提交、守卫和终止停止算法。

## 测试

worker 侧逻辑通过进程内 `MessageChannel` 运行，使 V8 覆盖率能够度量它。单元测试覆盖脚本辅助函数、fatal 与 nullable 失败、JSON 边界、上限、取消、子 agent 所有权和通过真实循环的结构化输出。构建后二进制文件的冒烟测试在纯 Node 下运行单独打包的 `lib/worker.cjs`，带密钥的 e2e 驱动真实子 agent，面向模型的工作流行为通过其所属示例进行快照覆盖。

## 延迟（明确的非目标）

- **后台收集**（启动工具 → run id → 完成通知 → 收集），与 shell/subagent 后台统一一起设计。
- **日志化 + 恢复**（`resumeFromRunId`、缓存的 agent() 前缀）：实现它会以脚本约定收紧的形式重新引入 CC 的确定性禁令（脚本可以读取时钟）。
- **保存／打包的工作流**（`.deepseek/workflows/` 注册表、斜杠命令 API）和**脚本持久化到运行目录**（工具调用事件已经持久记录了脚本）。
- **嵌套 `workflow()`**、**token `budget`**，以及 `effort`/`isolation`/`agentType` agent 选项（每个都会明确拒绝，并在消息中注明其已延迟实现）。
- **整体运行的挂钟超时**：取消总能释放调用方（result 在宽限期内 settle），因此总运行时间上限是后台重设计的策略旋钮，不是此处的正确性需求。
- **超越 worker 线程的引擎加固**：在同一 seam 背后使用 isolated-vm 或独立进程引擎（真正的沙箱化；内存限制）。
- **ACP（Agent Client Protocol）后端结构化输出**和 **`toolFilter`**（两者仍以能力标志 `false` 门控）。

## 曾考虑的替代方案

- **宿主侧的恶意值防护**（无 trap 代理拒绝、从不调用访问器的描述符遍历、realm 侧预渲染抛出值、realm 构建的 promise/array/error 克隆加结构化 fatal 识别）：否决。每项防御针对的都是信任前提所接受的作者，而线程的序列化边界已经从构造上保证跨 realm 值的处理对所有输入都有确定结果。
- **进程内 `node:vm` 执行**：机械上最简——无 RPC、无线程——但 `start()` 会在脚本的初始同步切片期间阻塞调用方，第一个 await 之后的同步自旋无法在进程内终止（vm `timeout` 仅覆盖第一个切片），且 `dispose()` 只能在宿主循环上放弃一个未 settle 的脚本。worker 线程引擎保持相同的 vm 上下文脚本 API，同时解除宿主阻塞并使终止成为现实。
- **后台执行作为默认**（CC 的形态）：延迟。前台同步与 `dsh-tool-subagent` 的当前形态一致，后台语义应在 bash、subagent 和工作流之间统一设计一次，而非逐工具设计。
- **工作流层为 `agent({schema})` 做 JSON 解析**：在一个消费方重复 seam 关注点，而 seam 的能力标志仍不诚实地为 `false`。
- **Meta 嵌入脚本中作为 `export const meta = {...}`**（CC 的确切格式）：保持脚本自包含且 CC 脚本可直接使用，但获取 meta 需要在宿主上执行模型编写的文本。即使一个空的限时 vm 上下文也无法约束脚本控制的 getter（当宿主读取结果对象时）。JSON 参数消除了扫描器、执行和宿主自旋漏洞；代价是 CC 脚本的 meta 头必须移入参数（正文保持可直接使用）。
- **`ValueSchemaSpec` 作为 `outputSchema` 协议类型**：面向作者的形式如今具有等价词汇，但工作流提供的是来自其他 realm 的原始 JSON Schema 数据；将这类运行时数据假装成可信的作者声明，会跳过原始 schema 断言边界。
- **schema 对象库（zod 或本仓库的 schemastery）用于结构化输出子集**：schema 是协议数据——纯 JSON，跨越 `agent({schema})` 中的 vm realm 边界并逐字落入强制工具的 parameters——正是活 schema 对象无法存在的位置；在运行时消费原始 JSON Schema 需要在其上加一个第三方转换器（zod core 只输出 JSON Schema，不能反向），且会在 schemastery 的配置角色旁边放置第二种 schema 语言。
- **ajv 用于值校验**：它校验完整 JSON Schema，因此子集门控——模块的真正要点，因为每个被接受的关键字都必须是 harness 强制执行的——无论如何仍需手写；它通过 `new Function` 编译校验器；且它将成为 dsh-tools 的第一个运行时依赖，仅为替换约 70 行的值遍历器，而带路径且逐一报告所有违规的错误报告无论如何都是自定义的。
- **提供方 JSON 模式代替捕获工具**：它保证 JSON 有效，但不保证其符合 schema，且它与工具调用的交互不明确。捕获工具保留了轮次内的校验重试。提供方侧的严格工具 schema 后续可以在不改变本设计的情况下收窄接受的子集。

## 后果

扇出计划现在存在于可重运行的脚本中，`outputSchema` 提供权威的结构化子 agent 结果。每次运行付出 worker 启动和消息端口 RPC 成本，但宿主启动保持非阻塞，取消可以终止 worker，序列化强制执行值边界。worker 线程不是安全边界。无效选项会失败而非退化为 Claude Code 的 `null`；消费方通过 run handle 保持控制权，观察者仅接收快照。顶层 Web 用户还会得到持久、可回放的工作流记录，同时不扩宽执行 seam，也不把原工具卡耦合到工作流专属 UI。
