# 子进程

[English](subprocess.md) | 中文

子进程 seam 分为 Service Definition（[dsh-subprocess](../../packages/subprocess/subprocess)，`ctx.subprocess`）与 Service Provider（[dsh-subprocess-local](../../packages/subprocess/subprocess-local)）；它的 Consumer 是其他能力 seam 与进程外后端：[bash 执行器家族](shell.zh.md)使用收集模式的批量输出，LSP 使用原始协议管道，PTY 后端使用终端原语，ACP（Agent Client Protocol）subagent 后端则使用通过管道传输的 ndjson，并让 stderr 采用 inherit。该 seam 拥有受管的 `DSH_*` 环境命名空间、共享的凭据清除（`scrubbedParentEnv`）与 `CollectedOutput` 形状；[dsh-shell](../../packages/shell/shell) 重导出这套词汇，使 bash 消费方保持单一导入入口。

源码：[`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts) 与 [`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts)

## 可执行文件查找

一个提供方的 spawn 工作目录、可执行文件路径、普通进程与终端会话，和挂载的文件系统提供方处于同一路径与进程命名空间。`resolveExecutable(command, env?, signal?)` 验证绝对可执行文件路径，或通过提供方清理后的 `PATH` 加有意覆盖来解析裸名称。

## 受管环境命名空间与捕获的输出

`DSH_*` 变量是归 Harness 所有的子进程事实；实现会在合并调用方显式 `env` 之前丢弃环境中已有的 `DSH_*` 名称，因此当前事实只会以有意提供的字符串条目形式到达，而显式的 `undefined` tombstone 会删除普通环境中已有的值。每条被收集的流都通过 `CollectedOutput` 报告自身的截断与 spill 恢复状态。

```ts type-equiv
/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`
```

```ts type-equiv
/** Trusted DeepSeek Harness variables for one child-process execution. */
type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>
```

```ts type-equiv
/** One captured stream: the (possibly truncated) text plus recovery info. */
interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}
```

## Node 风格的 stdio 处置方式（disposition）

每条流的处置方式都显式给出，由各消费方自行选择：原始管道用于协议分帧（LSP JSON-RPC、ACP ndjson），inherit 用于直通的诊断输出，收集模式用于有界的批量输出；其中 spill 文件是可选的，因此诊断尾部（语言服务器的 stderr）可以只在内存中缓冲，不留下任何文件。

```ts type-equiv
/**
 * stdin disposition. `'ignore'` leaves fd 0 on `/dev/null`; `'pipe'` exposes
 * {@link SubprocessHandle.stdin} for the caller's ongoing protocol writes;
 * `{ data }` writes the bytes and closes (the batch shape).
 */
type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
```

```ts type-equiv
/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape (a language server's stderr); including it makes
 * the complete stream recoverable up to its cap (the bash tool shape).
 */
interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}
```

```ts type-equiv
/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through (child diagnostics land on the harness's own stream); a
 * {@link SubprocessCollect} object buffers boundedly with offset-based reads.
 */
type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
```

```ts type-equiv
/** Per-stream stdio dispositions, all explicit — this seam applies no defaults. */
interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}
```

## 完全显式的 spawn spec

该 seam 不应用任何默认值：每项处置方式、限制与目录都在 spec 上显式给出，因此由调用方自己的配置决定它们，而不是由某个隐藏的子进程服务默认值决定。`argv` 绝不经过 shell 解释。

```ts type-equiv
/**
 * A fully-specified spawn request. This seam applies no defaults: every
 * disposition, limit, and directory is explicit, so the caller's own config —
 * not a hidden subprocess-service default — decides them (the `dsh-shell`
 * request/spec split is the owning template).
 */
interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Per-stream stdio dispositions. */
  stdio: SubprocessStdio
  /**
   * Positive finite grace period in milliseconds, no greater than
   * `MAX_TIMER_DELAY_MS`, available to the provider's termination procedure
   * and used for draining still-open collected pipes after the process exits
   * (an inherited descriptor held by a survivor cannot hold the outcome open
   * indefinitely). Providers document whether range termination is staged or
   * immediate.
   */
  graceMs: number
  /**
   * Abort signal — starts the terminate escalation on the managed range when
   * it fires. The caller owns deadlines and cause classification; this seam
   * only reacts to the abort.
   */
  signal?: AbortSignal | undefined
  /**
   * Explicit environment entries merged onto the implementation's scrubbed
   * parent base (see `scrubbedParentEnv`), with no namespace validation. A
   * string is a deliberate caller opt-in, so a forwarded credential-shaped
   * entry or current `DSH_*` fact survives the scrub; `undefined` is a
   * tombstone that removes an ordinary ambient entry from the child.
   */
  env?: NodeJS.ProcessEnv | undefined
}
```

## 句柄：流、读取器与 managed-range 终止

spawn 会同步返回活动句柄，目标与受管范围标识则保留在 provider 内部。收集模式的读取器接受全流字节偏移量且从不消费，因此独立读取器不会抢走彼此的增量；管道化的流归调用方所有。`terminate()` 启动 provider 记录的终止过程，`waitForExit()` 观察同一个 provider-managed range；分阶段 provider 可以使用 `graceMs`，立即终止的 provider 不会等待。消费方可以在这两项操作上构建自己的分级清理流程；ACP 后端先关闭 stdin 的 `disposeAcpChild` 是参考实现。

```ts type-equiv
/**
 * A live subprocess and its provider-managed process range. Collected output
 * remains readable after exit; piped streams belong to the caller.
 *
 * Termination and {@link SubprocessHandle.waitForExit} use the same managed
 * range. Each provider documents the range it can observe and its signalling
 * and observation limits.
 */
interface SubprocessHandle {
  /** The child's stdin, present iff spawned with `stdin: 'pipe'`. */
  readonly stdin: Writable | undefined
  /** The child's raw stdout, present iff spawned with `stdout: 'pipe'`. */
  readonly stdout: Readable | undefined
  /** The child's raw stderr, present iff spawned with `stderr: 'pipe'`. */
  readonly stderr: Readable | undefined
  /** Offset-based readers for collect-mode streams (also readable after exit). */
  readonly collected: SubprocessCollectedOutputs
  /** Resolves with spawned-command exit facts; rejects for spawn or provider failures. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Begin the provider's documented termination procedure on the managed range
   * — the seam's only termination verb. Idempotent, a no-op once that range is
   * gone, and also triggered by the spec's abort signal.
   */
  terminate(): void
  /**
   * Wait until the same managed range is empty — not just until the spawned
   * command reports its outcome, so surviving work remains observable.
   * @param signal - optional bound for the wait.
   * @returns `true` when the managed range is empty, `false` when the signal aborted first.
   * @throws when the selected provider can no longer observe its managed range.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
```

```ts type-equiv
/**
 * Cursor-free incremental access to one collected output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output; `readFrom(0)` after settlement is the
 * batch result (`lossy` then means the in-memory tail lost its head — the
 * {@link CollectedOutput.truncated} fact).
 */
interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): SubprocessOutputRead
}
```

```ts type-equiv
/** One incremental {@link SubprocessOutputReader.readFrom} read. */
interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}
```

```ts type-equiv
/** Offset-based readers for the streams spawned in collect mode. */
interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}
```


## 结果只承载退出事实

`done` 报告 Node close 事件的词汇，不携带原因分类：服务会在中止时终止进程，但绝不判定原因（调用方读取归自己所有的 deadline 信号，例如 bash 执行器的 `timedOut`/`aborted` 拆分）。收集到的输出在结算后仍可经 `handle.collected` 读取，因此批量与流式调用方共用一条访问路径。

```ts type-equiv
/**
 * Exit facts of one closed process — Node's `close`-event vocabulary.
 * Deliberately carries NO timeout or cancellation classification (the caller
 * reads the signal it owns to classify causes) and NO output: collected
 * streams stay readable through {@link SubprocessHandle.collected} after
 * settlement, so batch and streaming callers share one access path.
 */
interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}
```

## 终端进程原语

`spawnTerminal(spec)` 是非管道进程原语。提供方分配控制终端，并负责 UTF-8 文本传输、前台进程组检查与信号发送，以及一项须等待的 TERM→KILL 操作；该操作会使提供方仍可观察到的每个会话成员完全停稳，提供方则会记录执行基底特有的可观察性限制。PTY 后端仍负责提示符检测、就绪推断、scrollback、沙箱策略和持久会话所有权；普通 `spawn()` 无法重建控制终端语义。

终端 spec 完全指定 argv、cwd、环境覆盖、尺寸、清理宽限期与可选的分配取消。其句柄公开 `pid`、有序输出、`done`、`write`、`inspectForeground`、`signalForeground` 和须等待的 `terminate`；确切的公共形状生成到 [`ctx.subprocess` 服务目录](#ctxsubprocess--subprocessruntime-abstract-seam)中。

## 服务行为

抽象的 [`SubprocessRuntime`](../../packages/subprocess/subprocess/src/index.ts) Service Definition 规定执行世界坐标、可执行文件查找、普通 `spawn` 与 `spawnTerminal`。[`LocalSubprocessRuntime`](../../packages/subprocess/subprocess-local/src/index.ts) 以平台选择的 managed range、按处置方式接线、凭据清除、`node-pty`、平台进程检查，以及先终止再等待退出的资源释放提供这些能力。Service Definition 约定见 [`dsh-subprocess`](../../packages/subprocess/subprocess/README.zh.md)，本地机制见 [`dsh-subprocess-local`](../../packages/subprocess/subprocess-local/README.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxe2b--e2bruntime"></a>

### `ctx.e2b` — `E2BRuntime`

Creates one lazily consumable E2B SDK handle and deletes the sandbox at timeout or disposal. Creation begins at plugin construction; adapters await getSandbox before their first operation.

```ts cordis-catalog
/**
 * Return the shared live SDK handle.
 * @returns the created sandbox after the configured cwd exists.
 * @throws when E2B rejects creation or the service is disposing.
 */
async getSandbox(): Promise<Sandbox>
```

Source: [`packages/e2b/e2b/src/index.ts`](../../packages/e2b/e2b/src/index.ts)

<a id="ctxsubprocess--subprocessruntime-abstract-seam"></a>

### `ctx.subprocess` — `SubprocessRuntime` (abstract seam)

Abstract subprocess service. Subclass, implement spawn, and load the subclass as a plugin — it registers as `ctx.subprocess` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Executable paths belong to one execution world shared with the mounted filesystem provider.
- spawn returns a live handle synchronously. Target identity remains provider-private; `done` resolves with the spawned command's exit facts and may reject for spawn or provider failures.
- Collect-mode readers are offset-based and non-consuming, so independent readers never consume one another's output; lossy reads report truncation and the spill file holding the complete stream when one exists. Piped streams are handed to the caller raw and never buffered here.
- SubprocessHandle.terminate (and the spec's abort signal) starts the provider's documented procedure against its managed range. SubprocessHandle.waitForExit observes that same range so a consumer-owned teardown ladder can hold each tier on real quiescence; each provider documents its signalling and observability limits.
- Disposal of the service terminates all still-running managed processes and awaits their exit.
- spawnTerminal owns terminal allocation, text transport, foreground groups, signalling, and whole-session quiescence behind one awaited termination method; readiness and persistent-shell policy stay in the PTY consumer. Its output stream ends after queued terminal output when the top-level process exits.

```ts cordis-catalog
/**
 * Resolve one configured executable in this provider's execution world.
 * Absolute paths are verified; bare names use the provider's scrubbed PATH
 * plus explicit environment overrides. Relative paths containing separators
 * are rejected: the resolution base is undefined, so providers fail loud
 * instead of guessing.
 * @param command - absolute executable path or bare PATH name.
 * @param env - explicit environment entries used for lookup.
 * @param signal - aborts remote or local lookup.
 * @returns a canonical executable path.
 */
abstract resolveExecutable( command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, ): Promise<string>

/**
 * Start one managed child process from a fully-specified spec; this seam
 * applies no defaults.
 * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
 * @returns the live process handle (streams/readers, signalling, outcome promise).
 * @throws synchronously when pre-aborted or when argv, cwd, environment, or grace is invalid before handle creation.
 */
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle

/**
 * Allocate a real terminal and start one owned process session. This is the
 * only non-pipe process primitive: implementations own terminal byte I/O,
 * foreground groups, signals, and whole-session quiescence.
 * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
 * @returns the live terminal handle after allocation succeeds.
 */
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

Source: [`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts)
<!-- END GENERATED cordis-surface -->
