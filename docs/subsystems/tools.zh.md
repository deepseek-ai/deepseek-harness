# 工具

[English](tools.md) | 中文

[dsh-tools](../../packages/core/tools) 的工具流水线。[core.md](core.zh.md) 介绍了核心包共用、用于编写流水线的类型 `ToolDefinition`；面向模型的 [`ToolSchema`](llm-streaming.zh.md#the-model-request-and-result) 协议类型与模型请求一起声明。本页记录 `ToolDefinition` 的每个字段、用于构建它的类型化 schema DSL、带守卫的执行类型和 UI 展示类型。

源码：[`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts) · [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)

## `ToolDefinition` — 一个已注册的工具

由一个 `ToolSchema`（面向模型的字段）、必需的规范输出声明、`execute` 函数、仅供宿主使用的调度器元数据、可选的最终内容回调和可选 UI 展示函数组成。注册表持有这些定义，循环通过它们分派调用。`projectToolSchema()` 通过显式允许列表构建每个面向模型的 `ToolSchema`；`output`/`execute`/`projectContent`/`finalizeContent`/`timeoutMs`/`guidance`/`isConcurrencySafe`/`presentCall`/`presentResult` 绝不能泄漏到模型请求中。

```ts type-equiv
/** Tool-owned canonical output contract used after the body returns a JSON value. */
interface ToolOutputDefinition {
  /** Raw supported JSON Schema enforced against every successful canonical value. */
  readonly schema: JsonSchemaNode
  /** Pure projection from validated arguments and value to Native/model content. */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** Pure replayable presentation projection for native and nested calls. */
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}
```

```ts type-equiv
/** A registered tool: its schema plus the execution function. */
interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
  /**
   * Run one accepted call and return only its canonical lossless-JSON value.
   * Async work must observe or forward `exec.signal` and settle only after its
   * owned work reaches quiescence. The executor preserves caller cancellation
   * through around-dispatch signal replacement and does not abandon this
   * promise, but it cannot hard-kill same-process code.
   * @param args - losslessly snapshotted, frozen model arguments.
   * @param exec - execution identity, cancellation signal, and context deferral.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  /**
   * Install execution-prepared content before `tools/post-execute` policies.
   * The callback is captured when the call starts and runs once for a
   * normalized outcome entering post-execute. Policy replacements remain
   * authoritative; pipeline failures that bypass post-execute skip projection.
   * @param exec - immutable execution identity and arguments.
   * @param result - normalized result before post-execute policy.
   * @returns replacement content, or undefined to preserve the renderer output.
   */
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Synchronous last-mile transform for model-facing content. The executor
   * snapshots this callback when execution starts and invokes it exactly once
   * for every normalized outcome, including pipeline failures that bypass
   * `tools/post-execute`, immediately before lossless materialization.
   * Returning `undefined` preserves the content; every other result field
   * remains executor-owned. The callback must be total and must not throw.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `projectToolSchema()` keeps only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
  /**
   * Existing system prompt guidance that `ctx.tools.register()` shows only
   * while the viewing scope's registrations resolve this definition; not for
   * new tools, which describe themselves in their schema. Registries other
   * than `ctx.tools` ignore it.
   */
  readonly guidance?: ToolGuidance
  /**
   * Pure synchronous classifier for overlap with sibling tool calls. Only
   * `true` opts in; omission, exceptions, non-`true` returns, and invalid
   * `defineTool` arguments are exclusive. This metadata is never model-visible.
   *
   * Opted-in executions must not mutate parent-owned state. Shared state must
   * tolerate concurrent dispatch; recorder races are permitted only when they
   * commute or fail closed. See the
   * [parallel-tool-call Agent Note](../../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)
   * for the full contract.
   * @param args - parsed arguments; `defineTool` validates before calling.
   * @returns Whether this call may join a parallel group.
   */
  isConcurrencySafe?(args: unknown): boolean
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived from
   * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
   * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
   * or `undefined` (or omit the method) to fall back to a generic presentation
   * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
   * call it during live streaming AND a session-log replay, so it must depend
   * only on `args`.
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * durable result projection (`content`, failure state, and optional `meta`). Returns a
   * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
   * pending title and render the raw result content. Pure and side-effect-free
   * for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

```ts type-equiv
/**
 * Literal system prompt section that `ctx.tools.register()` registers with a
 * tool and renders only while the viewing scope's registrations resolve the
 * tool's definition. Under the shipped Native and PTC roots that is while the
 * scope can call the tool directly or in programs, so a restriction or a
 * nearer same-name definition hides it. It keeps the prompt text that existing
 * tools had; adding guidance is discouraged, and a new tool puts what the
 * model needs into its description and parameter descriptions
 * ([rationale](../../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.md)).
 */
interface ToolGuidance {
  /**
   * Section name, `tool:<name>` by default. Tools naming the same section
   * share one section and must declare the same guidance; otherwise the
   * latest registration in the nearest registering scope decides it.
   */
  readonly section?: string
  /** Named section placement. */
  readonly order: PromptSectionOrderName
  /**
   * Section text, or a provider called with the names of the section's tools
   * whose definitions the viewing scope's registrations resolve, in name order.
   */
  readonly text: string | ((available: readonly string[]) => string)
  /** Notice for Sessions that saw the section once no registration of it remains. */
  readonly retirement?: string
}
```

`execute` 接收 `args: unknown`——原始的 `ToolDefinition` 自行校验输入。第一方工具不需要手写校验；它们使用 `defineTool`，由后者代为校验并收窄参数类型、根据 `output.schema` 推导函数体返回类型，并为两个输出投影器提供类型约束。`finalizeContent` 特意接收不可变的执行对象而非类型化参数，因为无效输入和外层流水线失败也会到达该回调；它可以施加工具自有的内容限制，同时保留 `isError`、规范值、结构化错误身份、延迟上下文与展示元数据。

## 统一的 JSON 值 schema DSL

插件作者使用同一套词汇描述类型化参数和类型化输出值。`ValueSchemaSpec` 支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、仅作者侧可用的 `json`，以及要求恰好命中一个分支的 `oneOf`；标量 `enum` 和 `const` 值必须与节点类型匹配。显式对象节点始终声明 `additionalProperties: true | false`。参数定义仍是隐式的开放对象属性映射，每个必填属性都附带 `required: true`。

源码：[`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts)

```ts type-equiv
/** One author-facing schema for any lossless JSON value root. */
type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec
```

```ts type-equiv
/** One implicit parameter-root property, optionally required. */
type ParameterPropertySpec = ValueSchemaSpec & { required?: true }
```

```ts type-equiv
/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}
```

`{ type: 'json' }` 推导为 `JsonValue`，并编译成仅含注解、不施加约束的原始 schema。输出根可以是对象、数组、标量或 null。`InferValue<S>` 在 16 层容器内保留字面量约束与对象开放性，之后回退为 `JsonValue`，避免耗尽 TypeScript 的类型实例化栈。`InferArgs<P>` 依据逐属性的必填标记生成必填和可选的字符串键：

```ts type-equiv
/**
 * Infer the TypeScript value accepted by an author-facing value schema. Exact
 * inference is bounded to 16 container levels, then falls back to `JsonValue`.
 */
type InferValue<S> = InferValueAt<S, []>
```

```ts type-equiv
/** Infer the TypeScript argument object for an implicit parameter schema. */
type InferArgs<S> = InferProperties<S, []>
```

`defineTool({ name, description, parameters, output, execute, … })` 将参数推导与 `parameterSchemaSpecToJsonSchema()` 和 `validateArgs()` 绑定，并将 `execute`/`render`/`presentationMeta` 与 `InferValue<OutputSchema>` 绑定。schema 记录只包含自有且可枚举的字符串键，schema 数组是稠密的内建数组，因此推导、编译与校验观察到的是同一份声明。精确推导保持到 16 层容器，之后放宽为 `JsonValue`；运行时校验仍会继续遍历完整 schema。`valueSchemaSpecToJsonSchema()` 通过同一套已强制执行的原始子集编译输出声明。参数不匹配时抛出 `ToolArgsError`（`INVALID_ARGS`）；函数体或后置策略产生的值无效时抛出 `ToolOutputError`（`INVALID_TOOL_OUTPUT`）。两者都经由常规工具错误路径处理。原始 JSON Schema 默认保持开放；不支持的关键字会被拒绝，而不会在未强制执行的情况下获准进入。

注册是一项受信任的同进程约定。注册表以 readonly 输入借用已类型化定义，要求它声明 `output`，校验其原始 schema，并检查 `timeoutMs` 必须为正有限值等语义要求；`projectToolSchema()` 在构建请求时生成面向模型的投影，使执行和展示共享同一份已解析定义，而不会将回调泄漏到协议上。

## `ToolRestriction` — 单个作用域对其继承内容的实时过滤器

`ToolRestriction` 作用于该作用域继承来的工具：部署全局层，加上其链上的每个祖先作用域，包括这些作用域从其他注册表引入的条目。注册表将 readonly 名称编译为私有集合，对多个限制取交集，再叠加该作用域**自身**的注册和引入——后者不受约束，因此被委派的子 agent 会保留其回报所依赖的工具。仅 deny 的过滤器允许后续未列出的继承工具通过，而 allow 列表则排除它们。`allow` 中的名称必须是该作用域继承的工具名，包括无作用域视图已列出、但 Agent 尚未看到的工具，因此提供方可以之后在该限制下添加该工具；`deny` 接受任何名称，因此作用域可以在尚无任何来源提供某个工具时就拒绝它。

```ts type-equiv
/**
 * Per-scope filter over inherited tools: global and ancestor registrations,
 * including entries an ancestor includes from another registry. Restrictions
 * intersect and do not affect the restricting scope's own contributions.
 */
interface ToolRestriction {
  /** Inherited tool names that stay visible; every other inherited tool is removed. */
  readonly allow?: readonly string[]
  /** Inherited tool names removed from visibility; a name nothing offers is accepted. */
  readonly deny?: readonly string[]
}
```

<a id="tool-registries-roots-and-model-steps"></a>

## 工具注册表、根注册表与模型步骤

`ToolRegistry` 是一组可直接调用的条目。引入一个注册表会在每次查询时读取其条目，因此源注册表仍拥有其定义。注册表不负责执行批次；所有批次都由 `ctx.tools.execute()` 运行。

```ts type-equiv
/**
 * A set of directly callable entries. Native registries expose their tools as
 * entries; a PTC registry exposes one program entry and calls its other tools
 * from programs. Registrations and inclusions return their exact disposers.
 * `ctx.tools.execute()` runs the entries of the selected root, so a registry
 * owns no batch execution of its entries.
 */
interface ToolRegistry {
  /**
   * Add one tool. A registry without scopes ignores the caller's scope.
   * @param tool - validated definition; duplicate names in the same place fail.
   * @returns the disposer that removes exactly this registration.
   */
  register(tool: ToolDefinition): () => void
  /**
   * Read another registry's entries at every query. The source keeps ownership
   * of its definitions; its later additions and removals appear in the next query.
   * @param registry - source whose `get()` and `getAll()` entries this registry includes.
   * @returns the disposer that removes exactly this inclusion.
   */
  include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void
  /**
   * Resolve one entry as a scope sees it.
   * @param name - entry name.
   * @param scope - viewing Agent or preset; omission selects the unscoped view.
   * @returns the entry, or undefined when the scope has none with that name.
   * @throws ToolCompositionError when the deciding scope has several candidates for the name or an inclusion cycles.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined
  /**
   * List the entries a scope sees. A registry lists every definition of a name
   * that has several, so a registry that includes it decides that name in its
   * own place. `get()` throws for such a name; `ctx.tools.getAll()` resolves
   * its root's listing and throws when a name still has several.
   * @param scope - viewing Agent or preset; omission selects the unscoped view.
   * @returns entries in registration order.
   * @throws ToolCompositionError when an inclusion cycles, or, for `ctx.tools`, when a name has several definitions.
   */
  getAll(scope?: ScopeKey): readonly ToolDefinition[]
}
```

每个作用域通过 `ctx.tools.setRoot()` 选择一个**根**注册表，`ctx.tools` 以该根注册表为送达目标。`ctx.tools.register()` 与 `include()` 为调用方作用域添加贡献；贡献会送达该作用域选中的根注册表，以及其下级作用域选中的每个根注册表，稍后加载的根注册表也会收到在它之前做出的贡献。某个名称由提供该名称的最近作用域决定，作用域的限制作用于它继承的内容；同一作用域以同一名称提供两个不同定义，或出现引入环时，以 `ToolCompositionError`（`INVALID_TOOL_COMPOSITION`）失败。注册表会列出冲突名称的每一个定义，只有决定该名称的位置才会因冲突而失败：提供该名称的较近作用域会遮蔽这一冲突，注册或引入也只会因其新增的名称而失败。`ctx.tools.get()` 与 `getAll()` 按查看方作用域返回选中的根注册表的条目。原生根注册表把该作用域看到的每个工具作为条目提供；PTC 根注册表在程序中绑定这些工具，并提供一个条目 `run_code`，因此在它之下 `ctx.tools.getAll()` 的结果是 `[run_code]`。最近的根注册表胜出，已卸载的根注册表仍保持选中，因此查找与调用以 `ToolRegistryUnavailableError`（`TOOL_REGISTRY_UNAVAILABLE`）失败，而不会转到另一个根注册表；没有任何根注册表的作用域也以同样方式失败。根注册表不得引入或读取 `ctx.tools`：`setRoot()` 会以 `INVALID_TOOL_COMPOSITION` 拒绝这样的根注册表；之后才读取 `ctx.tools` 的根注册表或根注册表所引入的注册表，会使触及该读取的查找或调用以同样方式失败，而引入到 `ctx.tools` 中的注册表读取 `ctx.tools` 时，该读取视为引入环并失败；再次被选中的根注册表仍只保留对注册项的一次引入，选中或卸载根注册表都会发出 `tools/change`。注册表也可以作为单个工具被引入：Standard 引入 CUA 的私有 PTC 注册表，其 `cua_run_code` 条目只绑定 `cua`。

只在工具可用时显示的工具段就是其定义中的 `guidance`；文件系统、搜索、`apply_patch`、schedule、按需加载 MCP 目录与委派段都是如此。`ctx.tools.register()` 在注册工具的同一个 effect 中注册该段，并且只有当查看方作用域的注册项解析出该定义时才渲染它；在随附的 Native 与 PTC 根注册表下，这意味着该作用域可以直接或在程序中调用该工具，因此限制或更近的同名定义会隐藏它。以同一 `section` 命名的多个工具共享该段，并且必须声明相同的使用指引，因为由最近的注册作用域中最新的注册决定它。其他工具段（例如 `tool:bash`）在其工具受限时仍会保留（[限制](../../packages/core/tools/README.zh.md#known-limitations-and-deferred-work)）。新增使用指引不被鼓励；工具在自身的 schema 中描述自己（[理由](../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.zh.md)）。使用指引可以提及另一个插件的工具，而无需检查该工具是否已注册。

每个模型步骤之前，AgentLoop 把 `ctx.tools.getAll(agent)` 捕获为一个 `ToolStep`。该步骤的提示词声明这些条目；其批次与嵌套程序调用只执行这些条目，PTC 根注册表还会为该步骤固定它所声明的绑定。因此在下一步骤之前，对同名替换后的工具或模型响应期间添加的工具的调用都以 `UNKNOWN_TOOL` 失败；对已声明、但其提供方已将其移除或为该 Agent 撤下的工具的调用也是如此。模型直接调用根注册表只在程序中绑定的工具时，该调用会在 `tools/pre-execute`、审批、守卫和执行包装层之前以 `UNKNOWN_TOOL` 失败，其消息会列出该步骤可以调用的条目，因此模型会看到程序条目。分发恰好运行准备该调用时捕获的定义。按 Agent 提供工具的提供方引入一个 `AgentToolRegistry`，并在该 Agent 的状态变化时调用 `set(agent, names)`；步骤捕获的是它开始之前已设置的工具。Web 工具在该 Agent 的模型路由、某个凭据或 Web 提供方变化时更新；Plan、Office 与 Team 在各自的状态变化时更新。

`ctx.tools.execute()` 针对 Agent 选中的根注册表的条目运行完整的原始模型调用批次；独立调用则针对部署根注册表运行。已接纳的批次通过它开始时所用的根注册表结算，即使该根注册表随后卸载也是如此。每条执行记录都携带其调用解析出的 `definition`，因此策略直接读取该定义，无需再次按名称查找。组合失败只会让它所属的调用失败。在准备调用时遇到的组合失败会在策略之前让调用失败；派发时会再次查找，因此首次在派发时遇到的组合失败会在 `tools/pre-execute`、审批、守卫和 `tools/execute` 包装层之后让调用失败，`tools/post-execute` 也会看到这一失败。两种情况下，结果都告诉模型该工具配置错误，部署日志记录失败的消息；失败是歧义时，该消息会点名相互冲突的定义。`agent` 在独立服务调用中不存在；`log` 在模型步骤之外的程序调用（例如初始化钩子）中不存在。有 Agent 而没有 `log` 时，调用仍受该 Agent 的工具作用域约束，但不记录根调用／结果事件。工具自身的事件仍可使用 Agent 的 Session。

```ts type-equiv
/** Raw model calls, with optional Agent ownership and model-step logging. */
interface ToolBatchInput {
  readonly calls: readonly ToolCallBlock[]
  readonly signal: AbortSignal
  /**
   * Positive integer limiting how many concurrency-safe calls of this batch run
   * at once; program call limits remain separate. Undefined allows
   * `DEFAULT_MAX_PARALLEL_TOOL_CALLS` from `@deepseek-ai/dsh-tools/pipeline`.
   */
  readonly maxParallelToolCalls?: number
  /**
   * Owning Agent supplies scoped tools and execution context, including outside a turn.
   * Undefined for standalone calls outside an Agent, such as a service invocation.
   */
  readonly agent?: Agent
  /**
   * Model step whose declarations admit the calls, including program calls.
   * A call whose current entry differs from the declared one fails as `UNKNOWN_TOOL`.
   * Undefined resolves the root's current entries.
   */
  readonly toolStep?: ToolStep
  /**
   * Committed model step receiving root call/result events; requires `agent`.
   * Undefined when `agent` is absent or for calls outside a model response, such
   * as session initialization hooks. Without `log`, root call/result events are
   * omitted while `agent`, when provided, still supplies scope and execution context.
   */
  readonly log?: {
    readonly turn: number
    readonly step: number
  }
}
```

```ts type-equiv
/** One settled result correlated with its original model call. */
interface ToolCallResult {
  readonly callId: ToolCallId
  readonly result: ToolExecutionResult
}
```

```ts type-equiv
/** Model-ordered outcomes and context accepted for the next step. */
interface ToolBatchResult {
  readonly results: readonly ToolCallResult[]
  readonly additionalContexts: readonly UserMessage[]
  readonly concluded: boolean
}
```

## 执行：可扩展的 waterfall（瀑布式事件）加单调策略

`ctx.tools.execute()` 与 PTC 注册表的程序调用把解析后的 `ToolExecutionInput` 交给共享 `ToolExecutionPipeline`。流水线负责参数快照、执行身份、策略瀑布、工具分发和最终结果通知，每次返回一个 `ToolExecutionResult`。公开的 `ToolRegistry` 不负责执行批次：`ctx.tools.execute()` 通过选中的根注册表的条目运行模型直接调用的批次，PTC 注册表则通过自己的流水线运行其程序中的调用。

```ts type-equiv
/** Opaque call identity that permits correlation without exposing mutable execution state. */
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
```

```ts type-equiv
/**
 * Parsed input to the shared invocation pipeline. The pipeline
 * adds its own token to form a {@link ToolExecution};
 * callers do not choose that token.
 */
interface ToolExecutionInput {
  readonly callId: ToolCallId
  /**
   * Root model-requested call owning this execution tree. Callers omit it for
   * a root execution; nested dispatchers propagate the enclosing value.
   */
  readonly rootCallId?: ToolCallId
  readonly name: string
  /** Binding-time tool schema for a PTC inner call; frozen by its producer and never logged. */
  readonly schema?: ToolSchema
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /**
   * Model step whose declarations admit this call and its nested program calls.
   * A call outside a model step omits it and resolves the registry's current entries.
   */
  readonly toolStep?: ToolStep
  /**
   * Opaque token of the enclosing program execution, when one exists. A PTC
   * registry sets this on program calls so commit-style observers can wait for
   * the outer program outcome without receiving its live mutable execution.
   * The token also marks the call as a program call rather than a model-direct
   * call: `ctx.tools.execute()` runs only model-direct calls, and one naming a
   * tool that the selected root offers only inside programs fails as
   * `UNKNOWN_TOOL` before the policy pipeline.
   */
  readonly parent?: ToolExecutionToken
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}
```

工具函数体接收运行时扩展。`deferContext()` 把上下文附着到本次执行自己的结果上——既是组合工具转运嵌套分派上下文的通道，也可供叶子工具铸造插件来源指令——而不会在外层调用尚未结束时注入这些上下文。

```ts type-equiv
/**
 * Runtime context handed to a tool implementation after the executor has
 * accepted a {@link ToolExecution}. {@link deferContext} attaches context to
 * this execution's own result — a composite tool ferries nested-dispatch
 * context back to the outer result, and a leaf tool may mint a fresh
 * plugin-sourced instruction; the loop appends it only after the
 * `tool/result`.
 */
interface ToolRunContext extends ToolExecution {
  /**
   * Defer one context — typically a nested-dispatch context ferried by a
   * composite tool, or a fresh plugin-sourced instruction — until this tool's
   * final result reaches the agent loop. Contexts retain their individual
   * source and metadata and are emitted in call order.
   */
  deferContext(context: UserMessage): void
  /**
   * Mark a successful final result as terminal for the current agent turn.
   * The marker rides this execution's own result (`concludesTurn` exists only
   * on {@link ToolExecutionSuccess}); a composite that dispatches nested
   * calls forwards it from the nested result, exactly like
   * `additionalContexts`, so only an authoritative nested success can
   * conclude the enclosing run.
   */
  concludeTurn(): void
}
```

agent loop（智能体循环）向注册表查询每个待处理调用的执行模式，并据此形成独占屏障和滚动池并行执行：

```ts type-equiv
/**
 * Scheduling mode for one pending call. `parallel` may overlap with siblings;
 * `exclusive` runs alone and forms an ordering barrier.
 */
type ToolExecutionMode =
  | { kind: 'parallel' }
  | { kind: 'exclusive' }
```

PTC 绑定在构造时冻结 ToolSchema，经由调度器传入 `ToolExecution.schema`；它只是临时执行元数据。每个实际开始的子分派在策略之前只记录配对 id、名称与规范化参数。开始和结算事件都不序列化描述、参数 schema 或 schema 字段。桥接层随后把已结算调用交给 `tools/ptc-dispatch-log` waterfall；它可以改变持久内容副本，但会保留程序取得的值、模型可见的外层结果和结构化失败身份：

```ts type-equiv
/**
 * One settled `run_code` sub-dispatch about to be logged, as seen by the
 * `tools/ptc-dispatch-log` waterfall: the parent execution (session owner,
 * outer call identity), the sub-call identity, and the outcome whose durable
 * copy a listener may reshape. `content` is the RENDERED result projection
 * (what a native `tool/result` would carry) — the program itself received
 * the structured `value` (or just the error message on failure); only the
 * `tool/ptc-dispatch` event's copy changes.
 */
interface PtcDispatchLog {
  /** The outer `run_code` execution. */
  readonly exec: ToolExecution
  /** The calling agent (the scope routing key and the spill owner), when the outer call has one. */
  readonly agent?: Agent
  /** Opaque sub-call id; new calls use `<parent>:ptc:<n>`. */
  readonly subCallId: ToolCallId
  /** The dispatched sub-tool name. */
  readonly name: string
  /** Whether the sub-call settled as an error. */
  readonly isError: boolean
  /** The sub-call's complete model-facing content (the settle event's default payload). */
  readonly content: ContentBlock[]
}
```

```ts type-equiv
/**
 * One pending tool call inside the executor pipeline. Parsed arguments cross
 * one lossless-JSON materialization boundary before policy and are deep-frozen;
 * call identity, the caller signal, and the executor-assigned {@link token} are
 * readonly. The executor freezes the complete object before `tools/result`
 * observers run.
 */
interface ToolExecution extends ToolExecutionInput {
  /** Root model-requested call, resolved for every root and nested execution. */
  readonly rootCallId: ToolCallId
  /** Executor-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
  /**
   * The definition the registry resolved for this call, captured before policy
   * runs. Absent when no visible definition has the name or when the call's
   * model step declared a different definition; that call fails as
   * `UNKNOWN_TOOL`. Dispatch runs exactly this definition: when the registry
   * no longer offers it as dispatch starts, the call fails as `UNKNOWN_TOOL`.
   */
  readonly definition?: ToolDefinition
}
```

```ts type-equiv
/**
 * Around-dispatch view of a {@link ToolExecution}. A `tools/execute` wrapper
 * may replace the signal for its delegated lifetime, but it cannot remove it.
 * The executor fuses every replacement with the captured caller signal.
 */
interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  /** Cancellation signal visible to the next wrapper or tool body. */
  signal: AbortSignal
}
```

`ToolExecutionToken` 是不透明的运行时 `Symbol`，仅用于身份比较。策略执行前，`execute()` 会物化并冻结参数、拒绝非 JSON 输入并分配 token。身份字段、调用方必需的 signal 和可选的 parent token 均保持 readonly。`ToolDispatchExecution` 包装层可以替换 signal 但不能移除；注册表会在调用工具函数体前重新融合调用方的 signal。最终观察者接收冻结的执行身份。

`ToolGuard` 是感知作用域的最终预分派策略。其返回类型有意不包含 allow 结果：`undefined` 保留 waterfall 的决策，而返回的 reason 或 `ToolGuardDenial` 只能缩减权限，因此后续监听器无法撤销它。拒绝中可选的 `info` 会成为失败结果的结构化错误身份。

```ts type-equiv
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, a denial with structured error identity, or `undefined` to leave the call allowed.
 */
type ToolGuard = (execution: Readonly<ToolExecution>) => string | ToolGuardDenial | undefined
```

```ts type-equiv
/** A guard denial: the model-facing reason and optional structured error identity recorded on the result. */
interface ToolGuardDenial {
  /** Model-facing reason rendered as the failed call's content. */
  readonly reason: string
  /** Structured error identity persisted beside the reason. */
  readonly info?: ToolErrorInfo
}
```

```ts type-equiv
/** Canonical failure detail; internal routing information remains optional. */
interface ToolFailure {
  /** Human-readable failure message without the Native `Error: ` envelope. */
  message: string
  /** Internal error class/code used by policy and durable diagnostics. */
  info?: ToolErrorInfo
}
```

```ts type-equiv
/** Successful canonical tool execution, including its Native/model projection. */
interface ToolExecutionSuccess {
  readonly isError: false
  /** Execution-local canonical value; deliberately omitted from durable events. */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  /** The agent loop stops after committing this successful result batch. */
  readonly concludesTurn?: true
}
```

```ts type-equiv
/** Failed canonical tool execution; failures never carry a successful value. */
interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}
```

```ts type-equiv
/** The discriminated, execution-local outcome of one tool call. */
type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

```ts type-equiv
/** Structured error metadata for a failed tool call (alongside the model-facing text). */
interface ToolErrorInfo {
  name: string
  code: string
  /** Optional raw user-facing detail; durable projections preserve it but model-facing content does not include it. */
  reason?: string
}
```

结果仅承载产出。调用身份保留在不可变的 `ToolExecution` 上，后者伴随结果经过每个钩子，并出现在持久化的 `tool/call` / `tool/result` 会话事件上，因此包装层无法创建第二个相互矛盾的身份。规范的 `value` 仅存在于执行期间：循环只持久化 `content`、`error` 和 `meta`，`tool/ptc-dispatch` 则存储子调用渲染后的 `content`、`isError`、可选结构化 `error` 和展示 `meta`。回放可以重现展示，却无法重建规范的中间值。可选的 `ToolErrorInfo.reason` 保留面向用户的原始详情，不将其加入模型可见内容。注册表会在以下情况设置 `info`：抛出的是 `HarnessError`（取其 `name` 和 `code`）、pre-execute 的 `deny` 自带 `info`，以及注册表自己生成的取消结果（`AbortError`，code 为 `ABORTED` 或 `ABORTED_BEFORE_DISPATCH`）；已开始的工具主体在取消后抛出 signal 的 reason 或 name 为 `AbortError` 的 `Error` 时，结果保留其 message，并带上 `AbortError` 与 `ABORTED`，`tools/execute` 包装器在调用方取消后抛出这类值时也得到同样的标识，工具主体尚未开始时为 `ABORTED_BEFORE_DISPATCH`；`tools/execute` 包装器也可能返回带 `info` 的结果，例如超时策略的 `TOOL_TIMEOUT`。审批未授予的 `ask` 会变成 name 为 `ApprovalError` 的拒绝（该 name 标识注册表的拒绝，并不对应可抛出的类），code 为 `APPROVAL_REJECTED`、`APPROVAL_CANCELLED` 或 `APPROVAL_UNAVAILABLE`。guard 拒绝或 post-execute block 只有自带 `info` 时才会携带它；其他抛出值产生的 `error` 不含 `info`。

成功时，注册表会快照并校验函数体返回值，将其冻结，然后调用纯渲染器，并为原生与嵌套调用执行可选的展示元数据投影器。注册表会在 `tools/result` 之前另行物化持久展示字段；无效值、渲染器/投影器失败或非 JSON 展示都会转为 JSON 安全的 `isError`。因此，最终实时观察者能看到精确的执行期值，以及可安全用于后续持久追加的字段。

在得到最终内容之前，注册表会物化候选结果；若内容、结构化错误、附加上下文或展示元数据无法物化，则会转为仍可到达 `finalizeContent` 的 JSON 安全 `isError` 结果。注册表恰好调用该回调一次，随后在 `tools/result` 之前立即物化并冻结已接受的结果，因此实时观察到的产出可安全用于后续持久化的 `tool/result` 追加。

每个拦截 waterfall 返回一个类型化的 **Decision**（与 `agent/*` waterfall 共享的惯用模式）。`tools/pre-execute` 监听器接收 `(exec, next)` 并返回 `PreToolDecision`；`tools/execute` 包装层返回 `ToolExecutionResult`；`tools/post-execute` 监听器接收 `(exec, result, next)` 并返回 `PostToolDecision`：

```ts type-equiv
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes its
 * model-facing reason and optional structured error identity; `cancel` selects
 * the canonical cancellation result without presenting a policy denial; `ask`
 * runs only after an approval service returns `allowed-once` and otherwise
 * denies; its `reason` is the audited approval reason and its optional
 * `displayReason` is the localized prompt text. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } }
```

```ts type-equiv
/**
 * Post-dispatch decision: accept, replace one projection, attach context for the
 * next request, or block by turning corrective feedback into an error result
 * whose optional `info` is its structured error identity.
 */
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; info?: ToolErrorInfo; additionalContexts?: UserMessage[] }
```

调用 `next()` 获取默认决策，或直接返回一个决策以短路。前置策略可以 deny 或 ask；只有 `allowed-once` 才继续执行，而未授权、缺少审批通道或服务、或无 agent 的请求都会变为拒绝。拒绝可以附带结构化身份与用户可见详情，而不改变其模型可见原因。Guard 仍可施加最终拒绝。参数不可被改写，因为历史记录、审计、UI 和执行必须保持一致。

后置策略可以替换内容或值，但不能同时替换两者。替换内容会保留规范值和现有元数据；替换值会重新校验并重新计算内容/元数据；阻止会移除值，并转为包含纠正反馈的 `isError`。内容替换是展示策略，而非保密策略；需要隐藏程序化值的监听器必须阻止或替换该值。`tools/result` 在归一化后接收冻结的执行和结果；观察者无法对其进行变换，观察者的失败也会被隔离。未知工具和抛出异常的工具都会变为结构化错误（`ToolNotFoundError` 映射为 `UNKNOWN_TOOL`），调用失败但不终止当前轮次。工具主体所需的 Agent、服务或进行中的 turn 不存在时，抛出 `ToolContextUnavailableError`（`TOOL_CONTEXT_UNAVAILABLE`）。

## 已强制执行的原始 JSON Schema 子集

subagent、工作流、MCP 和动态注册提供的原始 schema 使用作者侧 DSL 在协议层的对应表示。`assertSupportedJsonSchema()` 接受任意 JSON 根，`validateJsonSchemaValue()` 强制执行该 schema，`JsonSchemaError` 则报告每条不受支持或格式错误的 schema 路径。仅含注解的空节点表示不受约束的无损 JSON。`oneOf` 至少要求两个分支，且一个值必须恰好匹配其中一个。仍要求对象根的消费方调用 `assertObjectJsonSchema()` 并携带 `ObjectJsonSchema`；这样，subagent/工作流中由调用方定义的结构化输出可以继续以对象为根，而不会限制共享词汇。

```ts type-equiv
/** Scalar JSON values supported by `enum` and `const`. */
type JsonSchemaScalar = string | number | boolean | null
```

```ts type-equiv
/** Single-type keywords accepted by the enforced subset. */
type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
```

```ts type-equiv
/**
 * One raw JSON Schema node in the enforced subset. The optional fields express
 * the external wire schema; {@link assertSupportedJsonSchema} rejects invalid
 * combinations before a caller treats the node as trusted.
 */
interface JsonSchemaNode {
  /** Omit with no constraints for any JSON value, or use `oneOf`. */
  type?: JsonSchemaType
  /** Exactly one branch must validate; at least two branches are required. */
  oneOf?: JsonSchemaNode[]
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, JsonSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` follows JSON Schema's open default. */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent accepts any JSON item. */
  items?: JsonSchemaNode
  /** Allowed values for a scalar node. */
  enum?: JsonSchemaScalar[]
  /** The single allowed value for a scalar node. */
  const?: JsonSchemaScalar
  /** Annotation, ignored for validation. */
  description?: string
  /** Annotation, ignored for validation. */
  title?: string
  /** Annotation, ignored for validation but required to be lossless JSON. */
  default?: JsonValue
  /** Annotation, ignored for validation but required to be lossless JSON. */
  examples?: JsonValue
}
```

```ts type-equiv
/** A consumer-constrained object-rooted schema. */
type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }
```

## 工具展示 UI 词汇

工具希望其调用在 UI 中如何呈现（编辑器工具调用卡片、CLI（命令行界面）日志行），提供方无关，使工具在不依赖任何客户端协议的情况下描述自身。`presentCall`/`presentResult` 返回一个 **`card` 标签的渲染意图**——一个可辨识联合类型，UI 桥接层据此分发：

- `ToolCallView`（待执行）：`{ card: 'generic', title, kind?, rawInput?, content?, locations? }`（默认卡片；`locations` 是 `{ path, line? }[]`，表示调用读取/修改的文件，供编辑器跟随）、`{ card: 'terminal', title, description?, cwd? }`（shell 命令→终端卡片）、或 `{ card: 'diff', title, diffs, locations? }`（文件创建/修改→行内 diff 卡片；`diffs` 是 `{ path, oldText, newText }[]`，新文件时 `oldText: null`）。
- `ToolResultView`（已完成）：`{ card: 'generic', title?, content? }`、`{ card: 'terminal', title?, output?, exitCode?, signal? }`（捕获的运行输出 + 退出状态；有能力的 UI 显示退出状态标签，其他 UI 可以派生围栏 ` ```console ` 回退）、`{ card: 'diff', title?, diffs }`（已完成的文件变更→要展示的变更，通常是从变更前后内容计算出带上下文行的已应用 hunk，或在没有前像时的整文件 diff）、`{ card: 'search', shape, title?, truncated, total, … }`（已完成的发现型搜索→`shape: 'matches'`（grep）为按文件分组的匹配，`shape: 'paths'`（glob）为扁平路径列表；`truncated`/`total` 报告内联结果是否被截断，使 UI 永不把部分结果当作完整结果呈现；该视图不携带结果文本——无 search 卡片的 UI 回退到原始结果内容）、`{ card: 'read', title?, path, offset, lines, totalLines, lang?, content? }`（已完成的文件读取→带行号、可选语法高亮的代码视图；`offset` 是窗口请求的 1-based 起始行，即使 `lines` 为空也保留；`lang` 是从扩展名推得的语言提示，`content` 是无读取能力的 UI 回退时使用的去信封文本）、或 `{ card: 'web', kind: 'search' | 'fetch', title?, … }`（已完成的 web 检索；`kind: 'search'` 携带结构化的 `sources`/`answer?`/`truncated`，`kind: 'fetch'` 携带 `url`/`statusCode`/`truncated`，不具备 `web` 能力的 UI 回退到原始结果内容——正文不会重复进视图）。已完成视图会替换待执行视图，因此变更工具即使与调用时的片段重复也要返回 diff 结果；搜索和 web 检索都没有 `card` 的调用时对应视图（其 pending 状态保持为 generic 卡片，因为结构化结果只在 `execute` 之后才存在）。

`ToolCallKind`（`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`）用于为通用卡片选择图标。`FileLocation`（`{ path, line? }`）、`FileDiff`（`{ path, oldText, newText }`）与 `ReadFileLine`（`{ number, text }`，读取窗口中一行带 1-based 行号的内容）是共享的文件卡片词汇。该设计由[渲染意图联合类型 Agent Note](../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.zh.md)固定；host/client 运行时将这套中性词汇投影为各自的视图。

完整的展示字段文档见 [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)。`bash` schema 与执行器见 [shell.md](shell.zh.md)；通用后台控制见 [jobs.md](jobs.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtools--toolsservice"></a>

### `ctx.tools` — `ToolsService`

`ctx.tools`: routes scoped tool contributions to the root registry each scope selects, answers lookups and dispatch from that root, and applies scoped restrictions and guards. A root receives the registrations its scope sees when it is selected; a native root offers them as model entries, and a PTC root binds them in programs.

```ts cordis-catalog
/**
 * Register in the calling scope. The tool reaches the root the scope
 * selects and the roots its descendant scopes select: a native root offers
 * it as an entry, a PTC root binds it in programs. Nearer scopes shadow
 * farther ones; duplicates within one scope, a name an inclusion in the
 * scope already offers, and the reserved `run_code` name fail. A tool's
 * `guidance` registers its system prompt section in the same effect; the
 * section renders while the viewing scope's registrations resolve the tool.
 * @param tool - tool schema, execution, and optional finalization, presentation, or guidance.
 * @returns the exact disposer that unregisters the tool and its guidance.
 * @throws ToolCompositionError when the scope's inclusions already offer another definition with the name.
 */
register(tool: ToolDefinition): () => void

/**
 * Include another registry's entries in the calling scope; they reach roots
 * as registrations do. Each query reads the source for the viewing scope.
 * Descendant scopes inherit the entries, so their restrictions apply; the
 * including scope's own restrictions do not.
 * @param registry - source that keeps ownership of its definitions.
 * @returns the exact disposer that removes this inclusion.
 * @throws ToolCompositionError when the scope already offers another definition under one of the source's names,
 * when the source itself offers several definitions under one of them, or when the source includes this service.
 */
include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void

/**
 * Restrict inherited tools for the calling scope. Restrictions intersect;
 * the scope's own registrations and inclusions stay visible. `allow` names
 * must be ones an inherited registration or inclusion can offer; an
 * inclusion contributes its unscoped entries, so a tool a provider adds to
 * Agents later can be allowed in advance. `deny` accepts any name, so a
 * scope can deny a tool before anything offers it.
 * @param filter - inherited-tool mask: `allow` (keep only) and/or `deny` (remove).
 * @returns the exact disposer that lifts this restriction.
 * @throws Error when the context is unscoped, the filter is empty, a name is `run_code`, or an `allow` name is not inherited.
 */
restrict(filter: ToolRestriction): () => void

/**
 * Resolve one entry of the root a scope selects: a native root resolves the
 * scope's registrations, a PTC root only its program entry.
 * @param name - entry name.
 * @param scope - the viewing scope (the agent); omitted reads the root the unscoped context selects.
 * @returns the root's entry, or undefined when the root has none with that name.
 * @throws ToolRegistryUnavailableError when the scope's selected root is missing or unloaded.
 * @throws ToolCompositionError when the deciding scope offers several definitions, or when the root
 * or an included registry reads `ctx.tools`.
 */
get(name: string, scope?: ScopeKey): ToolDefinition | undefined

/**
 * List the entries of the root a scope selects, which its model steps
 * declare: a native root lists the scope's registrations after shadowing and
 * restrictions, a PTC root only its program entry.
 * @param scope - the viewing scope (the agent); omitted reads the root the unscoped context selects.
 * @returns the root's entries.
 * @throws ToolRegistryUnavailableError when the scope's selected root is missing or unloaded.
 * @throws ToolCompositionError when a visible name has several definitions in its deciding scope, or
 * when the root or an included registry reads `ctx.tools`.
 */
getAll(scope?: ScopeKey): readonly ToolDefinition[]

/**
 * Select the root registry for the calling scope; an unscoped call selects
 * the root for every scope without its own. Agents use the nearest selected root. The
 * root includes the registrations each viewing scope sees, and keeps them
 * after unloading so accepted batches settle their calls; selecting the
 * same registry again does not include them twice. A root must not include
 * or read `ctx.tools`: such a read fails with `ToolCompositionError` when
 * the root is selected or, for a root that reads it later, in the lookup or
 * batch that reaches it. Register tools through `ctx.tools`: a tool
 * registered directly in a root skips the scope's conflict check, so another
 * definition registered under its name through `ctx.tools` is accepted and
 * the next `ctx.tools.getAll()` throws. Selecting or unloading a root emits
 * `tools/change`; an observer that throws fails the selection, which
 * restores the scope's earlier selection, or none, and emits `tools/change`
 * again.
 * @param registry - initialized root owned by the contributing plugin.
 * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
 * @throws Error when the calling scope already has a live root.
 * @throws ToolCompositionError when the root's own entries conflict with the registrations, or when the root reads `ctx.tools`.
 * @throws the error a `tools/change` observer throws for the selection.
 */
setRoot(registry: ToolRegistry): () => void

/**
 * Execute a complete batch of calls to the entries of the root the Agent
 * selects, or the unscoped context's root for a standalone call. Each call runs the entry the root
 * resolves for the Agent; with a model step, only the exact entry the step
 * declared, and any other call fails as `UNKNOWN_TOOL`. A call naming a
 * tool the Agent can reach only from the root's entries, such as a program
 * binding, fails as `UNKNOWN_TOOL` before `tools/pre-execute`, approval,
 * guards, and execution wrappers, and its message names the entries the
 * Agent can call directly. An accepted batch settles through the root it
 * started with even if that root unloads. With log, root call/result events are committed to
 * the Agent's Session; without log, they are omitted. One outcome is
 * returned per input call in input order, including skipped calls on abort,
 * and the batch never settles while started work is still running.
 * Internal failures reject with ToolBatchExecutionError after draining,
 * preserving committed outcomes and context; callers must stop dependent
 * work and repair missing log results.
 * @param input - original calls, cancellation, optional concurrency override, Agent, model step, and logging step.
 * @returns settled results, deferred context, and whether a success concludes the turn.
 * @throws ToolRegistryUnavailableError when the Agent's selected root is missing or unloaded.
 */
async execute(input: ToolBatchInput): Promise<ToolBatchResult>

/**
 * Register a monotonic denial in the calling scope.
 * @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
 * @returns the effect disposer that removes this guard.
 */
guard(guard: ToolGuard): () => void

/**
 * Check global and inherited guards after pre-execute policy and approval resolve.
 * @param exec - invocation whose guards are checked before dispatch.
 * @returns the first denial with its optional structured identity, or undefined when no guard denies.
 */
checkGuards(exec: ToolExecution): ToolGuardDenial | undefined
```

Types: [ScopeKey](scope.zh.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

<a id="tools-events"></a>

### `tools/*` events

<a id="toolschange--emit"></a>

#### `tools/change` — emit

A tool was registered or unregistered, a registry inclusion changed, a scoped restriction changed, or a root registry was selected or unloaded. Entries an included registry adds or removes later do not emit this event. When `ctx.tools` emits it for a registration, inclusion, restriction, or root selection, a listener that throws fails that contribution, which is undone and emits this event again; a removal is not undone. Another producer may handle a listener failure differently, for example by logging it. Unfiltered registry notification: scoped listeners receive changes from every scope because a global contribution can affect every agent's next assembly.

```ts cordis-catalog
/**
 * A tool was registered or unregistered, a registry inclusion changed, a
 * scoped restriction changed, or a root registry was selected or unloaded.
 * Entries an included registry adds or removes later do not emit this
 * event. When `ctx.tools` emits it for a registration, inclusion,
 * restriction, or root selection, a listener that throws fails that
 * contribution, which is undone and emits this event again; a removal is
 * not undone. Another producer may handle a listener failure differently,
 * for example by logging it. Unfiltered
 * registry notification: scoped listeners receive changes from every scope
 * because a global contribution can affect every agent's next assembly.
 * @mode emit
 */
'tools/change'(): void
```

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolsexecute--waterfall"></a>

#### `tools/execute` — waterfall

Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns a normalized result; wrappers may change only `exec.signal`, while call identity remains immutable. The registry re-fuses the original caller signal before the body, so replacement cannot detach caller cancellation; wrappers must still restore their signal and reach quiescence. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.

```ts cordis-catalog
/**
 * Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns
 * a normalized result; wrappers may change only `exec.signal`, while call
 * identity remains immutable. The registry re-fuses the original caller
 * signal before the body, so replacement cannot detach caller cancellation;
 * wrappers must still restore their signal and reach quiescence.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
 * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
 * @mode waterfall
 */
'tools/execute'(this: Scoped<ToolsService>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolspost-execute--waterfall"></a>

#### `tools/post-execute` — waterfall

Accept, replace, enrich, or block a normalized dispatch result. `next()` accepts it unchanged; thrown tools still reach this waterfall as errors. Async listeners must observe `exec.signal`; after they settle, caller cancellation replaces only a successful accepted outcome with the code selected by whether the tool body was invoked. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.

```ts cordis-catalog
/**
 * Accept, replace, enrich, or block a normalized dispatch result. `next()`
 * accepts it unchanged; thrown tools still reach this waterfall as errors. Async
 * listeners must observe `exec.signal`; after they settle, caller
 * cancellation replaces only a successful accepted outcome with the code
 * selected by whether the tool body was invoked.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
 * @param exec - the call that just ran (name, parsed arguments, caller agent).
 * @param result - the dispatch outcome a listener may accept, replace, or block.
 * @mode waterfall
 */
'tools/post-execute'(this: Scoped<ToolsService>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolspre-execute--waterfall"></a>

#### `tools/pre-execute` — waterfall

Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow; `cancel` selects the canonical pre-dispatch cancellation result, and missing approval support turns `ask` into denial. Async gates must observe `exec.signal`; the registry rechecks cancellation after they settle but never abandons their promise. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.

```ts cordis-catalog
/**
 * Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow;
 * `cancel` selects the canonical pre-dispatch cancellation result, and missing
 * approval support turns `ask` into denial. Async gates must observe
 * `exec.signal`; the registry rechecks cancellation after they settle but
 * never abandons their promise.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
 * @param exec - the pending call (name, parsed arguments, caller agent).
 * @mode waterfall
 */
'tools/pre-execute'(this: Scoped<ToolsService>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)

<a id="toolsptc-dispatch-log--waterfall"></a>

#### `tools/ptc-dispatch-log` — waterfall

Allow a listener to replace content in the DURABLE LOG COPY of one `run_code` sub-dispatch outcome before the bridge appends its `tool/ptc-dispatch` event. `next()` keeps the content unchanged; a listener may return replacement blocks (e.g. the spill policy's preview + locator for an oversized text result). Only the logged copy is affected — the program already received the complete value, and the model sees neither. A throwing listener is contained: the bridge falls back to logging the original settled content. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's dispatches.

```ts cordis-catalog
/**
 * Allow a listener to replace content in the DURABLE LOG COPY of one
 * `run_code` sub-dispatch outcome before the bridge appends its
 * `tool/ptc-dispatch` event. `next()` keeps the
 * content unchanged; a listener may return replacement blocks (e.g. the
 * spill policy's preview + locator for an oversized text result). Only the
 * logged copy is affected — the program already received the complete
 * value, and the model sees neither. A throwing listener is contained:
 * the bridge falls back to logging the original settled content.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's dispatches.
 * @param dispatch - the parent execution, sub-call identity, and the settled content to log.
 * @mode waterfall
 */
'tools/ptc-dispatch-log'(this: Scoped<ToolsService>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
```

Types: [ContentBlock](llm-streaming.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/core/tool-registry-ptc/src/runtime-types.ts`](../../packages/core/tool-registry-ptc/src/runtime-types.ts)

<a id="toolsresult--emit"></a>

#### `tools/result` — emit

Observe the frozen, lossless-JSON final outcome. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by `exec.agent`.

```ts cordis-catalog
/**
 * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by `exec.agent`.
 * @param exec - the execution object that traversed the pipeline.
 * @param result - a deep-frozen snapshot of the final returned result.
 * @mode emit
 */
'tools/result'(this: Scoped<ToolsService>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/events.ts`](../../packages/core/tools/src/events.ts)
<!-- END GENERATED cordis-surface -->
