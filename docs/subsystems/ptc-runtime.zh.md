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
   * follows the provider's programFormat: an async function body supports
   * top-level `await` and `return`; REPL (`repl`, `scoped-repl`) and Script programs support top-level
   * declarations, `await`, and a final expression, but not top-level `return`.
   * The Script provider lowers top-level await; its executionInstructions and
   * documentation define retained-binding semantics. The completion value
   * becomes {@link PtcRunResult.value}.
   */
  program: string
  /** Discard the completion without JSON validation when true; omission preserves the completion value. */
  discardCompletion?: boolean
  /**
   * Object-identity owner for optional in-memory state. Omission requests a fresh
   * environment. Consumers must await runtime.release(owner) when the owner ends.
   * Stateless providers ignore this field; retained state is never durable.
   */
  stateOwner?: object
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
   * The program's completion value (a return or final REPL/Script expression), when it ran to
   * completion and the value crossed the runtime's lossless-JSON boundary.
   * Invalid or over-limit completions fail the run instead of substituting a
   * rendered string; a failed or value-less run leaves this absent.
   */
  value?: PtcJsonValue
  /**
   * Captured text fragments retain their emitted line breaks. Concatenate adjacent text without separators.
   * Each source channel preserves emission order; interleaving
   * across independent channels is backend-dependent. Bounded only as part of
   * the outer result.
   */
  output: PtcOutput[]
  /** Present iff the run failed; see {@link PtcRunFailure} for the taxonomy. */
  error?: PtcRunFailure
}
```

```ts type-equiv
/** Source evaluation form, independent of retained program state. */
type PtcProgramFormat = 'function-body' | 'repl' | 'script' | 'scoped-repl'
```

`programFormat` 区分异步函数体、REPL 语句、scoped REPL 语句与脚本。REPL、scoped REPL 与 Script 程序接受顶层 `await`、声明和末尾表达式，不支持顶层 `return`。保留状态的 REPL 各次调用共用一个作用域；scoped REPL 每次调用开始时拿到之前调用留下的顶层绑定的拷贝，因此可以再次声明这些名字，而不改变之前的代码。Node Script 提供方转换顶层 await 并等待完成值；其[声明限制](../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#known-limitations-and-deferred-work)适用于转换后的程序。`retainsState` 独立于源码语法报告是否保留内存。`stateOwner` 是标识可选保留内存的进程内对象身份；不同对象相互隔离。消费者在所有者结束时等待 `release(owner)`；清理失败时该调用拒绝。省略所有者时仅执行一次，无状态提供方忽略所有权。[持久 Node 提供方](../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#persistent-repl)定义重置和恢复行为；保留对象不会进入持久 Session 格式。

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
  /** Constructor global and resulting `Error.name`; same identifier rule as {@link PtcBindingNamespace.global}. */
  name: string
  /**
   * Non-empty own property for the member name, excluding `name`, `message`,
   * and `stack` (`RESERVED_ERROR_MEMBERS`). Other property names are accepted.
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
   * The global identifier the program sees. Must match `[A-Za-z_$][A-Za-z0-9_$]*`
   * and exclude ECMAScript keywords and strict-mode names (`RESERVED_BINDING_WORDS`).
   * Runtime output globals (`console`, `inspect`, `Image` in `RESERVED_BINDING_GLOBALS`)
   * are also refused.
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
 * `args` must be lossless JSON; resolutions also support host-issued PtcImage values. A runtime rejects a
 * lossy or non-cloneable value with a descriptive error rather than corrupting
 * the run. No seam-level byte cap applies to a binding resolution. A rejection
 * of this function surfaces inside the program as a rejection of the
 * corresponding call.
 */
type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>
```

## 捕获的输出与失败分类体系

`output` 按发出顺序保存文本和图片条目：文本使用 `{ type: 'text', text }`，图片使用 `{ type: 'image', attachment }`。文本条目保留实际输出的换行，相邻文本直接拼接，不额外插入分隔符。每个来源通道都保留发出顺序；独立通道之间的交错顺序由后端决定。宿主绑定返回 `PtcImage` 描述符，包含附件引用和可在执行环境读取的 `path`；程序收到带有该路径和存储像素尺寸的 `Image`。Node 提供方对序列化文本、图片描述符、完成值或诊断一起计量；超限会显式失败。

```ts public-api
/** A stored image readable from the program's execution environment. */
declare class PtcImage {
  readonly [key: string]: PtcJsonValue;
  /** Absolute attachment file path readable in the execution world. */
  readonly path: string;
  /** Stored image selected when the program inspects this value. */
  readonly attachment: Readonly<ImageAttachmentRef>;
  /**
   * Describe one immutable image file in the execution world.
   * @param path - Absolute path to the stored image.
   * @param attachment - Reference to the immutable stored image.
   */
  constructor(path: string, attachment: ImageAttachmentRef);
}
```

```ts type-equiv
/** Raw text fragments and inspected images in emission order; concatenate adjacent text without separators. */
type PtcOutput = { type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }
```

失败类型是**正交的结果，独立报告**（见 [defensive-patterns](../defensive-patterns/general.zh.md)）：预算耗尽不是异常，中止不是超时，基底崩溃（如 OOM）也不是二者中的任何一个：

```ts type-equiv
/**
 * Why a run failed. The kinds are orthogonal outcomes reported independently
 * (per docs/defensive-patterns/general.md): a budget expiry is not an exception, an
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

`PtcRuntime` 定义于 [`src/index.ts`](../../packages/ptc-runtime/ptc-runtime/src/index.ts)。`resolve(request)` 返回完整执行输入，`run(spec)` 执行它们。`executionInstructions` 提供由运行时拥有的使用说明，供消费方呈现。支持逐次覆盖时，`timeout` 报告配置的经过时间默认值和上限；每次请求仍由 `resolve` 验证并截断。`language` 标识源码语言，供消费方检查自身要求（参见 [PTC 执行器](../../packages/core/tool-executor-ptc/README.zh.md)）；`isolation` 描述执行基底，不作安全声明。`sandboxMode` 声明文件策略支持，不提供约束的提供方返回 `undefined`。每个实现将各次运行的程序状态分离，并在资源释放期间终止且等待活跃执行。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxptcruntime--ptcruntime-abstract-seam"></a>

### `ctx.ptcRuntime` — `PtcRuntime` (abstract seam)

Registers one `ctx.ptcRuntime` implementation. Program, budget, abort, and substrate failures resolve in PtcRunResult; only Service Definition contract misuse rejects, with PtcRuntimeError. Implementations bridge structured-cloneable bindings, materialize each declared namespace rejection class, treat programs as hostile peers, isolate distinct state owners, and terminate and await in-flight runs during disposal.

```ts cordis-catalog
/**
 * Release an owner's retained environment and await its execution resources.
 * Stateless providers have no retained resources to release.
 * @param owner - The exact object supplied as the request's state owner.
 * @returns Completion after all owned execution resources have been released.
 * @throws When managed resource cleanup fails.
 */
release(owner: object): Promise<void>

/**
 * Register source evaluated once when each execution environment is created.
 * Registration must precede the first run admission; only one initializer may
 * be registered. Current bindings are installed before initialization. Its
 * completion is discarded; logs, timeout, cancellation and output bounds share
 * the first run. Initialization failure discards the environment without
 * executing the user program or rolling back external effects.
 * @param program - Initialization source in the provider's language and format.
 * @returns An idempotent async disposer that stops admission, cancels and drains
 * admitted runs, and releases environments. Failed cleanup blocks execution
 * until the disposer succeeds on retry. The caller owns this disposer.
 * @throws When unsupported, registered twice, registered after admission, or invalid.
 */
registerEnvironmentInitializer(program: string): () => Promise<void>

/**
 * Resolve supported options and provider defaults before execution.
 * @param request - Program, bindings, cancellation and optional execution choices.
 * @returns Complete directory, deadline and supported authority for run.
 * @throws When an explicit choice is invalid or unsupported by this provider; contract misuse throws {@link PtcRuntimeError}.
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
