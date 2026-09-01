# 代码运行时

[English](code-runtime.md) | 中文

代码执行 seam 是一个[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)：其 Service Definition（[dsh-code-runtime](../../packages/code-runtime/code-runtime)，`ctx.codeRuntime`）使用宿主提供的异步绑定运行一段模型编写的程序，并报告其打印内容与返回值。代码执行是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.zh.md) 中。各后端的执行基底与源语言不同，这两项均为服务上的只读描述符；worker-thread Service Provider 与工具注册表 Consumer 的约定见 [PTC mode 基础设计](../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md) 和[类型化返回约定](../../.agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.zh.md)。

源码：[`packages/code-runtime/code-runtime/src/types.ts`](../../packages/code-runtime/code-runtime/src/types.ts)

## 运行：请求进，结果出

`CodeRunRequest` 携带**运行时要处理的一切内容**。按照「包边界处显式优于隐式」的规则，默认值（时间预算、输出上限）来自实现的已校验配置，绝不是 `run()` 内部隐藏的 `??`：

```ts type-equiv
/**
 * One run: the program source plus everything the runtime acts on. Per the
 * explicit-over-implicit convention, defaulting (time budgets, output caps)
 * is the implementation's validated config — a request carries no optional
 * tuning knobs for a hidden `??` to fill in.
 */
interface CodeRunRequest {
  /**
   * The program source, in the runtime's {@link ../index.ts | language}. It
   * runs as the body of an async function: top-level `await` and `return`
   * are available, and the completion value becomes
   * {@link CodeRunResult.value}.
   */
  program: string
  /** Host functions exposed to the program, one global object per namespace. */
  bindings: CodeBindingNamespace[]
  /**
   * Abort the run: the runtime stops the program (hard, even mid-loop) and
   * resolves with a {@link CodeRunFailure} of kind `'abort'`. In-flight
   * binding calls are the CALLER's to settle — the runtime only stops asking.
   */
  signal?: AbortSignal
}
```

结果将错误报告为一个**字段**，而不是让 `run()` 返回被拒绝的 Promise。报告程序失败是调用方的职责，不走异常路径（与 `ShellExecutor.run` 失败时仍正常完成的约定一致）：

```ts type-equiv
/**
 * The outcome of one run. An error is a FIELD on a resolved result, never a
 * rejection of `run()` — reporting a failed program is the caller's job, not
 * an exception path.
 */
interface CodeRunResult {
  /**
   * The program's completion value (its top-level `return`), when it ran to
   * completion and the value crossed the runtime's lossless-JSON boundary.
   * Invalid or over-limit completions fail the run instead of substituting a
   * rendered string; a failed or value-less run leaves this absent.
   */
  value?: CodeJsonValue
  /**
   * Captured text. Each source channel preserves emission order; interleaving
   * across independent channels is backend-dependent. Bounded only as part of
   * the outer result.
   */
  logs: string[]
  /** Present iff the run failed; see {@link CodeRunFailure} for the taxonomy. */
  error?: CodeRunFailure
}
```

## 绑定：宿主函数作为程序全局变量

每个 `CodeBindingNamespace` 在程序内成为一个由异步可调用函数组成的全局对象（PTC mode Consumer 传入一个：`tools`）。参数与返回值必须是无损 JSON，且跨越边界时不受 seam 层字节上限约束；运行时可以通过结构化克隆桥接它们。命名空间可以声明程序可见的错误类，而无需让运行时知道 Consumer 的名称：运行时会注入真实构造函数，并将被拒绝的调用转为该类的实例。运行时也将绑定名视为不可信输入（`__proto__` 是普通自有属性，绝不会发生原型碰撞）：

```ts type-equiv
/**
 * Program-visible typed rejection for one binding namespace. The runtime
 * injects a real error constructor under `name`; rejected member calls become
 * its instances and expose the exact member name through
 * `memberNameProperty`. Both strings are runtime data rather than knowledge
 * of a particular consumer such as PTC mode.
 */
interface CodeBindingErrorClass {
  /** Constructor global and resulting `Error.name`; same portable identifier rule as {@link CodeBindingNamespace.global}. */
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
 * A named group of {@link CodeBindingFunction}s the runtime exposes to the
 * program as one global object (e.g. `tools`). Function names are arbitrary
 * strings — a runtime must treat names like `__proto__` or `constructor` as
 * ordinary own properties (null-prototype construction), never as prototype
 * collisions.
 */
interface CodeBindingNamespace {
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
  functions: Record<string, CodeBindingFunction>
  /** Optional program-visible typed rejection contract for this namespace. */
  errorClass?: CodeBindingErrorClass
}
```

```ts type-equiv
/** A lossless JSON value transferable through the dependency-light Service Definition. */
type CodeJsonValue = null | boolean | number | string | CodeJsonValue[] | { [key: string]: CodeJsonValue }
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
type CodeBindingFunction = (args: unknown) => Promise<CodeJsonValue>
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
 * - `'abort'` — {@link CodeRunRequest.signal} fired.
 * - `'worker-exit'` — the execution substrate died without settling (e.g. OOM).
 * - `'invalid-output'` — the completion value was not lossless JSON.
 * - `'output-limit'` — the serialized outer logs/value/diagnostic exceeded the configured cap.
 */
interface CodeRunFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}
```

## 服务

`CodeRuntime`（`ctx.codeRuntime`，抽象服务，定义于 [`packages/code-runtime/code-runtime/src/index.ts`](../../packages/code-runtime/code-runtime/src/index.ts)）由 `run(request)` 加两个只读描述符组成：`language`（程序必须使用的语言，已知值为 `'typescript'` 与 `'python'`，即 `dsh-tools` 能呈现的那些，TypeScript 后端已发布、Python 后端为实验性且私有（未发布）；生成语言相关展示的 Consumer 据此切换，遇到无法展示的语言时应显式报错）和 `isolation`（执行基底，`'worker-thread'`、`'process'`、`'container'`；仅为诊断标签，**不构成安全承诺**）。实现必须保证各次运行彼此隔离（无跨运行状态），并在 dispose（资源释放）时等待系统完全停稳：teardown 要等到所有进行中的运行均已终止并结算后才完成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcoderuntime--coderuntime-abstract-seam"></a>

### `ctx.codeRuntime` — `CodeRuntime` (abstract seam)

Registers one `ctx.codeRuntime` implementation. Program, budget, abort, and substrate failures resolve in CodeRunResult; only Service Definition contract misuse rejects. Implementations bridge structured-cloneable bindings, materialize each declared namespace rejection class, treat programs as hostile peers, isolate runs from one another, and terminate and await in-flight runs during disposal.

```ts cordis-catalog
/**
 * Execute one program against the request's bindings and capture what it
 * emitted. See the class doc for the resolution contract (error is a result
 * field; rejection means Service Definition contract misuse only).
 * @param request - the program, its bindings, and the abort signal; the
 *   request carries everything the runtime acts on, with no hidden defaults.
 * @returns the run's outcome: completion value (when transferable), the
 *   ordered log capture, and the failure (if any).
 */
abstract run(request: CodeRunRequest): Promise<CodeRunResult>
```

Source: [`packages/code-runtime/code-runtime/src/index.ts`](../../packages/code-runtime/code-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
