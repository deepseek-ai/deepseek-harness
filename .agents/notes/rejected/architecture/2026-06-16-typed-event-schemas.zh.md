# Agent Note: 事件词汇的运行时 schema（Zod 与 merge-extensible-map 模式之辩）

Status: rejected — runtime event-schema registry declined; event maps stay compile-time, Zod validates projection state, migrations validate durable payloads

[English](2026-06-16-typed-event-schemas.md) | 中文

## 问题

harness 将其核心词汇——内容块、消息来源、结束原因、轮次触发器、轮次结束原因与会话事件——建模为 **merge-extensible map**：一个 TypeScript `interface`（如 `SessionEventMap`、`ContentBlockMap`），插件通过声明合并对其扩展，公开联合类型则以 `Map[keyof Map]` 派生。这是本仓库的通用扩展模式，记录在 [docs/architecture.md](../../../../docs/architecture.zh.md) 中（「The same merge-extensible-map pattern is used for `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`」），`defineTool` 的 `InferArgs` DSL 和 `assertNever` 穷举约定都依赖于它。

该模式**仅存在于编译期**。类型在运行时消失：没有 schema 对象可供校验传入值、解析不可信输入或在运行时枚举变体。[会话持久化约定](../../implemented/architecture/2026-06-14-session-persistence.zh.md)暴露了两个后果：

1. **持久化将 `event.data` 视为不透明 JSON。** JSONL provider 对每个事件原样执行 `JSON.stringify`/`JSON.parse`；唯一的运行时守卫是 `isJsonValue`（往返可序列化性检查：拒绝 BigInt、函数、循环引用、非有限数等），而非结构校验。一个损坏但仍为合法 JSON 的事件数据（字段类型错误、字段缺失）会静默往返，只有在后续消费方的 `switch` 中才可能被捕获。
2. **插件新增变体没有运行时约定。** 一个通过声明合并添加新 `SessionEventMap` 键的插件，在自身代码中获得了编译期类型，但没有任何机制校验它产出的值是否符合它所声明的形状——无论是在生产者处、持久化边界处还是重新加载时。

由此引出问题：事件词汇是否应迁移到 **Zod** 或其他运行时 schema 库，使持久化边界和插件边界拥有运行时 schema 而非被擦除的类型。

## 为什么这不是一个持久化层的改动

很容易把「用 Zod 做序列化」理解为对 `dsh-session-persistence-jsonl/src/format.ts` 的局部修改。但它不是，原因在于一个结构性事实：**插件无法对 Zod schema 进行声明合并。** 声明合并是 TypeScript 编译期机制；Zod schema 是运行时值。要用 Zod 校验事件，就需要一个**运行时注册表**，每个产出事件的包向其贡献自己的 schema（如 `ctx.sessionEvents.register('compaction/marker', z.object({…}))`），每个消费方从中读取。这个注册表——而非持久化后端——将成为词汇的真源，取代 merge-extensible 接口。

因此，真正的提案是：**用运行时 schema 注册表替换编译期的 merge-extensible-map 模式，范围覆盖整个仓库。** 这是一次核心词汇的重新设计。

## 影响范围（已度量）

将事件/词汇接口迁移到运行时 schema，至少涉及：

- **六个 merge-extensible map**（约 370 行核心类型）：`ContentBlockMap`、`MessageSourceMap`、`FinishReasonMap`（位于 `dsh-llm`）；`TurnTriggerMap`、`TurnEndReasonMap`、`SessionEventMap`（位于 `dsh-session`）。
- **约 10 处 `declare module` 声明增补位置**，分布在 `dsh-agent`、`dsh-agent-loop`、`dsh-shell`、`dsh-llm`、`dsh-session`、`dsh-session-persistence`、`dsh-system-prompt`、`dsh-tools` 各包中——每处都将从声明合并改为运行时 `register()` 调用。
- **事件生产者**——agent loop（智能体循环）中 16 处 `session.append(...)` 调用——形状不变，但现在在边界处被校验。
- **约 7 个 switch 消费方**，对这些联合类型进行分支：`deriveMessages` 与包自有的不变式 companion（`dsh-session`）、`BlockAssembler`（`dsh-llm`）、两个 LLM（大语言模型）适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）以及工具 schema 层（`dsh-tools`）。`assertNever` 对封闭联合类型的穷举 vs 对可扩展联合类型的 fall-through 约定（一条已记录的 lint 规则）需要重新考量——运行时变体在静态层面不可穷举。
- **`defineTool` 的 `InferArgs` DSL**（`dsh-tools`），它从编译期 schema 规范派生出零类型转换的 `execute` 参数类型——这是当前方案的标杆用例。
- **文档**：architecture.md（该模式被描述为基础性的）、[开发模式不变式](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.zh.md)，以及所有引用该模式的 Agent Note。

这是一次仓库级别的词汇重新设计，而非持久化的实现细节。

## 曾考虑的替代方案

### A. 维持现状——merge-extensible 类型 + 持久化边界处 `isJsonValue`
保留编译期模式。持久化继续使用不透明 JSON + 可序列化性守卫。插件通过声明合并扩展；事件 *形状*的正确性由生产者负责，并由 TypeScript 在编译期保证。启用包自有的不变式 companion 后，它们会检查选定的跨记录关系，但不提供通用运行时形状 schema。

- **优点**：零变动；插件扩展只需一行 `interface` 增补，享有完整类型推断，无需运行时注册仪式；无新运行时依赖；`defineTool` DSL 与 `assertNever` 穷举继续工作。
- **缺点**：持久化边界和插件边界处无运行时结构校验；格式错误但仍为合法 JSON 的数据被延迟捕获。

### B. 仅对头部/封闭形状做校验（schemastery），事件仍为不透明
仅对那些已有手写类型守卫的真正封闭形状加以收紧——例如 JSONL 的 `HeaderLine` 守卫（`isHeaderLine`）——使用 **schemastery**（仓库现有的 schema 库，已用于每个插件的 `static Config`）。merge-extensible 事件联合类型保持不变。

- **优点**：改动小，契合现有约定（schemastery，而非新库）；用声明式 schema 替换封闭形状上的手写守卫；无核心重新设计。
- **缺点**：不解决事件数据校验问题；仅固定的元数据记录得到改善。

### C. 为整个词汇建立运行时 schema 注册表（Zod 或 schemastery）
用运行时注册表替换 merge-extensible map，生产者向其贡献 schema，持久化/消费路径据此校验。

- **优点**：持久化边界和插件边界处获得真正的运行时校验；单一真源；可支撑通用工具（自动生成文档、模糊测试、协议格式（wire format）检查）。
- **缺点**：上述全部影响范围；**Zod 目前不是直接依赖**（仅作为 `@earendil-works/pi-ai` 的传递依赖），仓库选定的 schema 库是 **schemastery**——广泛引入 Zod 本身就是一个依赖决策；声明合并的易用性（一行插件扩展、完整推断）被运行时注册 + 手动类型接线取代；`assertNever` 穷举保证弱化（运行时变体在静态层面不可穷举）。

## 提案

推迟。如果需要在持久化边界做运行时校验，**方案 B**（对封闭的头部和元数据形状使用 schemastery）是现有约定下的适度步骤。**方案 C** 是一个架构决策，需要自己的实现 Agent Note，其中包括 Zod 与 schemastery 之间的选择。

## 验收标准

- 方案 C 只能通过自己的实现 Agent Note 推进，绝不能作为持久化的附带改动。
- 如果采纳方案 B，封闭的头部/元数据形状（JSONL 的 `isHeaderLine` 守卫及同类）改用 schemastery 校验，替代手写守卫，merge-extensible map 保持不动。

## 风险

- 推迟意味着事件 `data` 在持久化边界处仍无结构校验：格式错误但仍为合法 JSON 的数据被延迟捕获，由消费方的 `switch` 兜底——这是现状的代价，有意接受。
- 如果方案 C 最终被采纳，易用性的损失是真实的：一行声明合并变为运行时注册加手动类型接线，`assertNever` 的静态穷举保证弱化。

## 待解问题

- 如果采用注册表，库选 **schemastery**（已在仓库中，已作为配置 schema 库）还是 **Zod**（生态更丰富，目前仅为传递依赖）？同时维护两个 schema 库本身就是一种成本。
- 能否采用混合方案：保留编译期推断（使 `defineTool` 和插件开发体验不受影响），同时为每个变体添加*可选*的运行时 schema，仅在持久化/协议边界校验，而非每次进程内 append 都校验？
- `ctx.invariants` 服务启用后是否已覆盖了足够多的运行时形状缺口，使得边界校验仅在面对真正不可信输入（重新加载外部修改过的日志）时才有必要？
