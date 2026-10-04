# 工具

[English](tools.md) | 中文

[dsh-tools](../../packages/core/tools) 的工具流水线。[core.md](core.zh.md) 介绍了核心包共用、用于编写流水线的类型 `ToolDefinition`；面向模型的 [`ToolSchema`](llm-streaming.zh.md#the-model-request-and-result) 协议类型与模型请求一起声明。本页记录 `ToolDefinition` 的每个字段、用于构建它的类型化 schema DSL、带守卫的执行类型和 UI 展示类型。

源码：[`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts) · [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)

## `ToolDefinition` — 一个已注册的工具

由一个 `ToolSchema`（面向模型的字段）、必需的规范输出声明、`execute` 函数、仅供宿主使用的调度器元数据、可选的最终内容回调和可选 UI 展示函数组成。注册表持有这些定义，循环通过它们分派调用。注册表的 `schemas()` 通过显式允许列表构建面向模型的 `ToolSchema[]`；`output`/`execute`/`projectContent`/`finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` 绝不能泄漏到模型请求中。

```ts type-equiv
/** Tool-owned canonical output contract used after the body returns a JSON value. */
interface ToolOutputDefinition {
  /** Raw supported JSON Schema enforced against every successful canonical value. */
  readonly schema: JsonSchemaNode
  /** Pure projection from validated arguments and value to Native/model content. */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** Pure replayable presentation projection, computed only for top-level calls. */
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
   * owned work reaches quiescence. The registry preserves caller cancellation
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
   * Synchronous last-mile transform for model-facing content. The registry
   * snapshots this callback when execution starts and invokes it exactly once
   * for every normalized outcome, including pipeline failures that bypass
   * `tools/post-execute`, immediately before lossless materialization.
   * Returning `undefined` preserves the content; every other result field
   * remains registry-owned. The callback must be total and must not throw.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `schemas()` whitelists only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
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

注册是一项受信任的同进程约定。注册表以 readonly 输入借用已类型化定义，要求它声明 `output`，校验其原始 schema，并检查 `timeoutMs` 必须为正有限值等语义要求；`schemas()` 在构建请求时生成面向模型的投影，使执行和展示共享同一份已解析定义，而不会将回调泄漏到协议上。

## `ToolRestriction` — 单个作用域对其继承内容的实时过滤器

`ToolRestriction` 作用于该作用域继承来的工具：部署全局层，加上其链上的每个祖先作用域。注册表将 readonly 名称编译为私有集合，对多个限制取交集，再叠加该作用域**自身**的注册——后者不受约束，因此被委派的子 agent 会保留其回报所依赖的工具。仅 deny 的过滤器允许后续未列出的继承工具通过，而 allow 列表则排除它们。

```ts type-equiv
/**
 * Per-scope filter over global tools. Restrictions intersect and do not affect
 * scoped registrations or the reserved PTC mode transport.
 */
interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}
```

## 执行：可扩展的 waterfall（瀑布式事件）加单调策略

`ctx.tools.execute()` 接受由调用方拥有且包含必需 readonly `signal` 的 `ToolExecutionInput`，将其解析后的 JSON 参数一次性物化为流水线拥有的 `ToolExecution`，然后让调用依次经过 `tools/pre-execute`（可重排的 allow/deny/ask waterfall）→ 已注册的单调 guard → `tools/execute`（环绕分派包装层）→ `projectContent` → `tools/post-execute`（检查/替换结果）→ 可选且由定义拥有的 `finalizeContent` → `tools/result`（不可变的权威结果）。只有 `tools/execute` 视图可以替换必需的 signal。最终产出为 `ToolExecutionResult`。

```ts type-equiv
/** Opaque call identity that permits correlation without exposing mutable execution state. */
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
```

```ts type-equiv
/**
 * Caller-supplied description of one tool call. {@link ToolRuntime.execute}
 * adds the registry-owned token to form a pipeline {@link ToolExecution};
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
   * Opaque token of the enclosing transport execution, when one exists. PTC
   * mode sets this on SDK sub-dispatches so commit-style observers can wait for
   * the outer `run_code` outcome without receiving its live mutable execution.
   * The token also marks the call as a transport sub-dispatch rather than a
   * model-direct call: under `mode: 'ptc'`, only calls WITH a parent may
   * execute a native tool name — a model-direct call (no parent) is denied as
   * `UNKNOWN_TOOL` before the policy pipeline. See {@link ToolRuntime.execute}.
   */
  readonly parent?: ToolExecutionToken
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}
```

工具函数体接收运行时扩展。`deferContext()` 把上下文附着到本次执行自己的结果上——既是组合工具转运嵌套分派上下文的通道，也可供叶子工具铸造插件来源指令——而不会在外层调用尚未结束时注入这些上下文。

```ts type-equiv
/**
 * Runtime context handed to a tool implementation after the registry has
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
 * One pending tool call inside the registry pipeline. Parsed arguments cross
 * one lossless-JSON materialization boundary before policy and are deep-frozen;
 * call identity, the caller signal, and the registry-assigned {@link token} are
 * readonly. The registry freezes the complete object before `tools/result`
 * observers run.
 */
interface ToolExecution extends ToolExecutionInput {
  /** Root model-requested call, resolved for every root and nested execution. */
  readonly rootCallId: ToolCallId
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
}
```

```ts type-equiv
/**
 * Around-dispatch view of a {@link ToolExecution}. A `tools/execute` wrapper
 * may replace the signal for its delegated lifetime, but it cannot remove it.
 * The registry fuses every replacement with the captured caller signal.
 */
interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  /** Cancellation signal visible to the next wrapper or tool body. */
  signal: AbortSignal
}
```

`ToolExecutionToken` 是不透明的运行时 `Symbol`，仅用于身份比较。策略执行前，`execute()` 会物化并冻结参数、拒绝非 JSON 输入并分配 token。身份字段、调用方必需的 signal 和可选的 parent token 均保持 readonly。`ToolDispatchExecution` 包装层可以替换 signal 但不能移除；注册表会在调用工具函数体前重新融合调用方的 signal。最终观察者接收冻结的执行身份。

`ToolGuard` 是感知作用域的最终预分派策略。其返回类型有意不包含 allow 结果：`undefined` 保留 waterfall 的决策，而返回的 reason 只能缩减权限，因此后续监听器无法撤销它。

```ts type-equiv
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
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

结果仅承载产出。调用身份保留在不可变的 `ToolExecution` 上，后者伴随结果经过每个钩子，并出现在持久化的 `tool/call` / `tool/result` 会话事件上，因此包装层无法创建第二个相互矛盾的身份。规范的 `value` 仅存在于执行期间：循环只持久化 `content`、`error` 和 `meta`，`tool/ptc-dispatch` 则存储子调用渲染后的 `content`、`isError` 与可选结构化 `error`。回放可以重现展示，却无法重建规范的中间值。可选的 `ToolErrorInfo.reason` 保留面向用户的原始详情，不将其加入模型可见内容。

成功时，注册表会快照并校验函数体返回值，将其冻结，然后调用纯渲染器；对于直接的外层调用，还会调用可选的元数据投影器。注册表会在 `tools/result` 之前另行物化持久展示字段；无效值、渲染器/投影器失败或非 JSON 展示都会转为 JSON 安全的 `isError`。因此，最终实时观察者能看到精确的执行期值，以及可安全用于后续持久追加的字段。

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
 * next request, or block by turning corrective feedback into an error result.
 */
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

调用 `next()` 获取默认决策，或直接返回一个决策以短路。前置策略可以 deny 或 ask；只有 `allowed-once` 才继续执行，而未授权、缺少审批通道或服务、或无 agent 的请求都会变为拒绝。拒绝可以附带结构化身份与用户可见详情，而不改变其模型可见原因。Guard 仍可施加最终拒绝。参数不可被改写，因为历史记录、审计、UI 和执行必须保持一致。

后置策略可以替换内容或值，但不能同时替换两者。替换内容会保留规范值和现有元数据；替换值会重新校验并重新计算内容/元数据；阻止会移除值，并转为包含纠正反馈的 `isError`。内容替换是展示策略，而非保密策略；需要隐藏程序化值的监听器必须阻止或替换该值。`tools/result` 在归一化后接收冻结的执行和结果；观察者无法对其进行变换，观察者的失败也会被隔离。未知工具和抛出异常的工具都会变为结构化错误（`ToolNotFoundError` 映射为 `UNKNOWN_TOOL`），调用失败但不终止当前轮次。

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

<a id="ctxtools--toolruntime"></a>

### `ctx.tools` — `ToolRuntime`

Tool registry and execution pipeline. Scoped registrations shadow globals; one visibility resolver feeds presentation, lookup, and dispatch.

```ts cordis-catalog
/**
 * Present the calling scope's tools in `mode` instead of the deployment
 * default. Nearest scope on the chain wins, so a preset's standing
 * declaration covers every agent joined under it.
 *
 * Scoped only, and one declaration per scope: this is how an agent preset
 * composes PTC mode agents beside native ones in the same process, and a
 * process-global override would be the `mode` config field instead.
 * @param mode - the presentation the covered agents' models see.
 * @returns the exact disposer that restores the deployment default.
 */
presentAs(mode: ToolPresentationMode): () => void

/**
 * Register globally or in the calling agent scope. Scoped tools shadow
 * globals; duplicates within one layer and the reserved `run_code` name fail.
 * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
 * @returns the exact disposer that unregisters the tool.
 */
register(definition: ToolDefinition): () => void

/**
 * Restrict global tools for the calling agent scope. Empty filters, unknown
 * names, scope-local names, and reserved transport names fail. Restrictions
 * intersect; scoped registrations remain visible.
 * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
 * @returns the exact disposer that lifts this restriction.
 */
restrict(filter: ToolRestriction): () => void

/**
 * Register a monotonic guard after the extensible `tools/pre-execute`
 * waterfall. A plain-context guard applies globally; one registered through
 * `agent.ctx` applies only to that agent. Any matching guard may deny by
 * returning a reason, while no guard can force-allow a call another guard
 * denied. The exact effect disposer is returned for ordered ownership and
 * HMR cleanup.
 * @param guard - synchronous check; a returned string denies the execution.
 * @returns the exact disposer that unregisters the guard.
 */
guard(guard: ToolGuard): () => void

/**
 * Look up a tool as one scope sees it (scoped
 * shadows global; a restricted-away global reads as absent). Presenters pass
 * the calling agent so the rendered card matches the definition that
 * actually executed.
 * @param name - the tool name as registered.
 * @param scope - the viewing scope (the agent); omitted = the global view.
 * @returns the definition the scope resolves, or undefined when none is visible.
 */
get(name: string, scope?: ScopeKey): ToolDefinition | undefined

/**
 * Project visible definitions onto the allowlisted model-facing schema fields,
 * excluding execution and presentation callbacks.
 * @param scope - the viewing scope (the agent); omitted = the global view.
 * @returns one deep-cloned schema per visible tool.
 */
schemas(scope?: ScopeKey): ToolSchema[]

/**
 * Classify a pending call through the caller's visible tool definition. Only
 * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
 * throwing classifiers are exclusive.
 * @param exec - call name, parsed arguments, and optional agent scope.
 * @returns the fail-closed scheduling mode.
 */
executionMode(exec: ToolExecutionInput): ToolExecutionMode

/**
 * Execute through pre-policy, guards, around-dispatch, post-policy,
 * definition-owned content finalization, and final notification. Tool and
 * listener failures resolve as materialized error results; an invisible tool
 * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
 * snapshot final observers receive. Cancellation
 * arriving after entry and before final result materialization skips a
 * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
 * successful started outcome with `ABORTED`; already-started work is still
 * drained and may retain a tool-owned structured error.
 * @param exec - the typed same-process call input. The registry assigns its
 *   correlation token before policy begins.
 * @returns the materialized final result.
 */
async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
```

Types: [ScopeKey](scope.zh.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

<a id="tools-events"></a>

### `tools/*` events

<a id="toolschange--emit"></a>

#### `tools/change` — emit

A tool was registered or unregistered, or a scoped restriction changed (the available tool set changed — possibly for one scope only). An UNFILTERED registry-subject notification, deliberately not scope-filtered dispatch: a global change concerns every agent's next assembly, so a scoped listener subscribing here sees every change, not just its own scope's.

```ts cordis-catalog
/**
 * A tool was registered or unregistered, or a scoped restriction changed
 * (the available tool set changed — possibly for one scope only). An
 * UNFILTERED registry-subject notification, deliberately not scope-filtered
 * dispatch: a global change concerns every agent's next assembly, so a
 * scoped listener subscribing here sees every change, not just its own
 * scope's.
 * @mode emit
 */
'tools/change'(): void
```

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

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
'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

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
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

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
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

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
'tools/ptc-dispatch-log'(this: Scoped<ToolRuntime>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
```

Types: [ContentBlock](llm-streaming.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)

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
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts)
<!-- END GENERATED cordis-surface -->
