# PTC 运行时

[English](ptc-runtime.md) | 中文

PTC 执行[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)通过 [dsh-ptc-runtime](../../packages/ptc-runtime/ptc-runtime) 提供 `ctx.ptcRuntime`。它针对 Host 绑定运行一个程序，报告输出、失败与适用的沙箱事实。PTC 执行是可选能力，不属于[智能体循环主干](core.zh.md)。[PTC 基础](../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md)负责注册表呈现，[类型化返回约定](../../.agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.zh.md)负责绑定值，[沙箱 Node 决策](../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md)负责已发布的执行提供方。

源码：[`packages/ptc-runtime/ptc-runtime/src/types.ts`](../../packages/ptc-runtime/ptc-runtime/src/types.ts)

## 运行：请求进，结果出

`PtcRunRequest` 包含程序、绑定、取消和可选执行选择。提供方的 `resolve` 验证支持的选择并应用部署默认值；`run` 接收目录与截止选择明确的 `PtcRunSpec`。省略 timeout 使用提供方默认值，数值请求封顶的经过时间预算，`null` 请求不设经过时间截止。提供方在执行前拒绝不支持的选择：

```ts type-equiv
/**
 * Caller inputs for one program. The provider's resolve method validates supported
 * options and supplies directory, deadline, and authority before execution.
 */
interface PtcRunRequest {
  /**
   * The program source, in the runtime's {@link ../index.ts | language}. It
   * runs as the body of an async function: top-level `await` and `return`
   * are available, and the completion value becomes
   * {@link PtcRunResult.value}.
   */
  program: string
  /** Host functions exposed to the program, one global object per namespace. */
  bindings: PtcBindingNamespace[]
  /** Working directory in the mounted filesystem and subprocess execution world. */
  cwd?: string
  /**
   * Elapsed execution budget in milliseconds. Omission uses provider defaults;
   * null requests no deadline. Providers validate and cap numeric budgets or reject unsupported choices.
   */
  timeoutMs?: number | null
  /** Resolved authority for this execution. Providers without confinement reject an explicit policy. */
  sandboxPolicy?: SandboxExecutionPolicy
  /**
   * Abort the run: the runtime stops the program (hard, even mid-loop) and
   * resolves with a {@link PtcRunFailure} of kind `'abort'`. In-flight
   * binding calls are the CALLER's to settle — the runtime only stops asking.
   */
  signal?: AbortSignal
}
```

```ts type-equiv
/** Fully resolved execution inputs; run never supplies a missing directory or deadline choice. */
interface PtcRunSpec extends PtcRunRequest {
  /** Absolute directory in the provider's execution world. */
  cwd: string
  /** Positive finite elapsed budget in milliseconds after provider capping, or null for no deadline. */
  timeoutMs: number | null
}
```

```ts type-equiv
/** File confinement applied to a program, independently of its terminal outcome. */
interface PtcRunSandbox {
  /** File-effect mode used for this execution. */
  mode: SandboxMode
  /** Program failure text matched backend diagnostics; not enforcement proof or an exhaustive denial record. */
  denied: boolean
  /** Completeness reported by the selected confining backend; absent for full access. */
  enforcement?: SandboxEnforcement
}
```

程序失败通过 `PtcRunResult.error` 返回；无效调用输入可能在执行前拒绝。沙箱模式、观察到的拒绝与强制完整性是独立事实，因此程序成功本身不能证明每项请求限制均已强制执行：

```ts type-equiv
/**
 * The outcome of one run. An error is a FIELD on a resolved result, never a
 * rejection of `run()` — reporting a failed program is the caller's job, not
 * an exception path.
 */
interface PtcRunResult {
  /** Applied file policy and observed denial, when the provider enforces file policy. */
  sandbox?: PtcRunSandbox
  /**
   * The program's completion value (its top-level `return`), when it ran to
   * completion and the value crossed the runtime's lossless-JSON boundary.
   * Invalid or over-limit completions fail the run instead of substituting a
   * rendered string; a failed or value-less run leaves this absent.
   */
  value?: PtcJsonValue
  /**
   * Captured text. Each source channel preserves emission order; interleaving
   * across independent channels is backend-dependent. Bounded only as part of
   * the outer result.
   */
  logs: string[]
  /** Present iff the run failed; see {@link PtcRunFailure} for the taxonomy. */
  error?: PtcRunFailure
}
```

## 绑定：宿主函数作为程序全局变量

每个 `PtcBindingNamespace` 成为一个异步可调用函数的全局对象；PTC 传入 `tools`。参数与返回值必须是无损 JSON。提供方强制各自的传输上限；seam 不设统一的绑定字节上限。可选错误类描述符创建程序可见的类型化拒绝，无需在运行时内点名消费方。绑定名是自有属性，因此 `__proto__` 不能遍历原型：

```ts type-equiv
/**
 * Program-visible typed rejection for one binding namespace. The runtime
 * injects a real error constructor under `name`; rejected member calls become
 * its instances and expose the exact member name through
 * `memberNameProperty`. Both strings are runtime data rather than knowledge
 * of a particular consumer such as PTC mode.
 */
interface PtcBindingErrorClass {
  /** Constructor global and resulting `Error.name`; same portable identifier rule as {@link PtcBindingNamespace.global}. */
  name: string
  /**
   * Non-empty own property for the member name. The portable exclusion set is
   * `RESERVED_ERROR_MEMBERS` plus dunder-form names (`__x__`, non-empty
   * middle), enforced identically by every backend; any other name —
   * identifiers or not — is accepted everywhere.
   */
  memberNameProperty: string
}
```

```ts type-equiv
/**
 * A named group of {@link PtcBindingFunction}s the runtime exposes to the
 * program as one global object (e.g. `tools`). Function names are arbitrary
 * strings — a runtime must treat names like `__proto__` or `constructor` as
 * ordinary own properties (null-prototype construction), never as prototype
 * collisions.
 */
interface PtcBindingNamespace {
  /**
   * The global identifier the program sees. Must match the LANGUAGE-PORTABLE
   * identifier subset `[A-Za-z_][A-Za-z0-9_]*` and no language's reserved
   * words, so the same namespace list works against every backend regardless
   * of `language` — a JS-only spelling like `$tools` is rejected by design,
   * not just by the Python backend. Names that satisfy the identifier rule but
   * name a backend-owned slot (`RESERVED_BINDING_GLOBALS`, e.g. `console`,
   * `__dsh_main__`) are also refused everywhere; see its declaration for the
   * exact set and why each entry is reserved.
   */
  global: string
  /** The callable members, keyed by the exact name the program calls. */
  functions: Record<string, PtcBindingFunction>
  /** Optional program-visible typed rejection contract for this namespace. */
  errorClass?: PtcBindingErrorClass
}
```

```ts type-equiv
/** A lossless JSON value transferable through the dependency-light Service Definition. */
type PtcJsonValue = null | boolean | number | string | PtcJsonValue[] | { [key: string]: PtcJsonValue }
```

```ts type-equiv
/**
 * One host-side function exposed to the program as an async callable. The
 * runtime bridges calls to it (possibly across a serialization boundary), so
 * `args` and the resolution value MUST be lossless JSON. A runtime rejects a
 * lossy or non-cloneable value with a descriptive error rather than corrupting
 * the run. No seam-level byte cap applies to a binding resolution. A rejection
 * of this function surfaces inside the program as a rejection of the
 * corresponding call.
 */
type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>
```

## 捕获的输出与失败分类体系

日志是纯字符串。每个来源通道保留自身的发出顺序；由于通道元数据不属于 seam，相互独立的通道如何交错由后端决定。运行时捕获程序的 console 与流输出，Consumer 只渲染文本。实现会对序列化后的外层日志数组，以及完成值或失败消息的组合载荷设置上限；固定的结果封装语法与 Consumer 展示空白不计入这份可变载荷计量。超限会显式失败，而不会在值中插入替代内容。

失败类型是**正交的结果，独立报告**（见 [defensive-patterns](../defensive-patterns.zh.md)）：预算耗尽不是异常，中止不是超时，基底崩溃（如 OOM）也不是二者中的任何一个：

```ts type-equiv
/**
 * Why a run failed. The kinds are orthogonal outcomes reported independently
 * (per docs/defensive-patterns.md): a budget expiry is not an exception, an
 * abort is not a timeout, and a substrate death is neither.
 *
 * - `'exception'` — the program threw or failed to parse/transform.
 * - `'timeout'` — an implementation-owned budget expired; the message says which.
 * - `'abort'` — {@link PtcRunRequest.signal} fired.
 * - `'worker-exit'` — the execution substrate died without settling (e.g. OOM).
 * - `'invalid-output'` — the completion value was not lossless JSON.
 * - `'output-limit'` — the serialized outer logs/value/diagnostic exceeded the configured cap.
 * - `'protocol'` — the program sent invalid or over-budget control traffic.
 * - `'sandbox-unavailable'` — required confinement could not be established.
 */
interface PtcRunFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}
```

## 服务

`PtcRuntime` 定义于 [`src/index.ts`](../../packages/ptc-runtime/ptc-runtime/src/index.ts)。`resolve(request)` 返回完整执行输入，`run(spec)` 执行它们。`executionInstructions` 提供由运行时拥有的使用说明，供消费方呈现。支持逐次覆盖时，`timeout` 报告配置的经过时间默认值和上限；每次请求仍由 `resolve` 验证并截断。`language` 选择支持的程序呈现；`isolation` 描述执行基底，不作安全声明。`sandboxMode` 声明文件策略支持，不提供约束的提供方返回 `undefined`。每个实现将各次运行的程序状态分离，并在资源释放期间终止且等待活跃执行。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxptcruntime--ptcruntime-abstract-seam"></a>

### `ctx.ptcRuntime` — `PtcRuntime` (abstract seam)

Registers one `ctx.ptcRuntime` implementation. Program, budget, abort, and substrate failures resolve in PtcRunResult; only Service Definition contract misuse rejects. Implementations bridge structured-cloneable bindings, materialize each declared namespace rejection class, treat programs as hostile peers, isolate runs from one another, and terminate and await in-flight runs during disposal.

```ts cordis-catalog
/**
 * Resolve supported options and provider defaults before execution.
 * @param request - Program, bindings, cancellation and optional execution choices.
 * @returns Complete directory, deadline and supported authority for run.
 * @throws When an explicit choice is invalid or unsupported by this provider.
 */
abstract resolve(request: PtcRunRequest): PtcRunSpec

/**
 * Execute resolved inputs; program outcomes resolve as result fields.
 * @param spec - directory, deadline, program, bindings, cancellation and supported policy.
 * @returns Captured output and the execution outcome.
 */
abstract run(spec: PtcRunSpec): Promise<PtcRunResult>
```

Source: [`packages/ptc-runtime/ptc-runtime/src/index.ts`](../../packages/ptc-runtime/ptc-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
