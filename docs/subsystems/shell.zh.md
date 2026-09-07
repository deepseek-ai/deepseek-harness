# Bash 执行器

[English](shell.md) | 中文

bash 执行 seam 分为 Service Definition（[dsh-shell](../../packages/shell/shell)，`ctx.shell`）、Service Provider（[dsh-bash-local](../../packages/shell/bash-local) 与 [dsh-bash-sandbox](../../packages/shell/bash-sandbox)）和 Consumer（[dsh-tool-bash](../../packages/shell/tool-bash)，即 `bash` schema）。通用后台任务的 job id、所有权与控制位于 [jobs.md](jobs.zh.md)；本 seam 返回一个不含任务概念的进程句柄。managed-range 机制封装在[子进程 seam](subprocess.zh.md)之后。

源码：[`packages/shell/shell/src/types.ts`](../../packages/shell/shell/src/types.ts)

## 受管 shell 环境命名空间

`DSH_*` 变量是归 Harness 所有的子进程事实。面向模型的 bash 工具通过 `ctx.shellEnv` 收集它们，再经由 `ShellExecRequest.dshEnv` 传递；子进程服务在合并当前快照之前会移除继承而来的 `DSH_*` 名称。`DshEnvironmentKey`／`DshEnvironment` 词汇归[子进程 seam](subprocess.zh.md)所有，由 `dsh-shell` 重导出。

## 请求与规格：`resolve()` 拆分

该 seam 将**面向模型/插件的请求**（`workdir`/`timeoutMs`/`stdoutMaxBytes` 可选，由配置或请求策略补全）与执行器实际使用的**完全解析后的 spec**（这些字段均为必填）分开。工具层在二者之间调用 `ctx.shell.resolve(request)`（仓库的「包边界处显式优于隐式」规则）；`ShellExecSpec` 携带的是已解析的值。

```ts type-equiv
/**
 * A caller's execution REQUEST: `workdir` and `timeoutMs` are optional and
 * filled by {@link ShellExecutor.resolve} from the implementation's config.
 * This is the model-/plugin-facing shape; pass it to `resolve()` to obtain a
 * fully-resolved {@link ShellExecSpec}.
 */
interface ShellExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /**
   * Foreground stdout capture budget in bytes. Absent uses the executor's
   * default output cap. Trusted in-process consumers use this when they must
   * parse complete stdout up to their own bounded limit; the model-facing bash
   * tool does not expose it as a parameter.
   */
  stdoutMaxBytes?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the command's stdin, then close it. Absent leaves stdin
   * closed/empty (the default for model-driven tool calls). Set by in-process
   * plugins (e.g. the hooks bridges, which write a hook command's JSON payload
   * to its stdin); the model-facing bash tool does not expose it as a parameter
   * (a model that needs stdin uses shell syntax like a heredoc or a pipe).
   */
  stdin?: string | undefined
  /**
   * Ordinary environment entries for the command, merged after the credential
   * scrub. Managed facts belong in {@link dshEnv}, which merges after this
   * map, so an entry here can never displace one. Set by in-process plugins
   * (the hooks bridges set `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, …); the
   * model-facing bash tool does not expose it as a parameter.
   */
  env?: Record<string, string> | undefined
  /**
   * Harness-owned `DSH_*` variables for this execution (typed to managed
   * keys). Executors discard ambient `DSH_*` entries before merging this
   * snapshot last, so an unavailable current fact cannot inherit a stale
   * value from the harness process and a caller {@link env} entry cannot
   * displace a managed one.
   */
  dshEnv?: DshEnvironment | undefined
  /** Fully resolved per-call sandbox policy; sandboxing executors default it. */
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}
```

```ts type-equiv
/**
 * A resolved execution spec. {@link ShellExecutor.resolve} fills and caps the
 * required fields; {@link ShellExecutor.start} ignores `timeoutMs` because
 * background processes have no executor timeout.
 */
interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /**
   * Resolved foreground stdout capture budget in bytes. `run()` uses it for
   * stdout; background jobs and stderr keep the executor's own output cap.
   */
  stdoutMaxBytes: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /** Bytes to write to stdin before closing it; absent means no stdin. */
  stdin?: string | undefined
  /**
   * Ordinary environment entries carried through from
   * {@link ShellExecRequest.env}; {@link dshEnv} still merges after them.
   * OPTIONAL on the spec for the same reason as `stdin`: absent means no
   * ordinary extra environment.
   */
  env?: Record<string, string> | undefined
  /** Managed `DSH_*` snapshot (typed to managed keys); merges after {@link env}. */
  dshEnv?: DshEnvironment | undefined
  /** Resolved sandbox policy; ignored by executors that do not confine. */
  sandboxPolicy: SandboxExecutionPolicy | undefined
}
```

`stdin` 和 `env` 是受信任的进程内插件输入，不由 `dsh-tool-bash` 暴露。本地执行器会先清除环境中的凭据，再合并调用方显式提供的 env。

`stdoutMaxBytes` 同样仅供受信任插件使用。它让前台消费方能在有界解析预算内请求完整 stdout，而不会改变 stderr、后台任务或面向模型的 bash 工具的常规输出上限。

## 前台运行：`ShellRunResult`

一次已完成（或被终止）的前台运行的结果。正交的结果**独立报告**：一个进程可以同时超时并以退出码 0 退出（因为它捕获了信号），因此 `timedOut`、`aborted`、`signal` 和 `exitCode` 各自独立为一个字段；调用方永远不会把一次被提前中断的运行误读为正常成功。

```ts type-equiv
/** The outcome of one completed (or killed) foreground run. */
interface ShellRunResult {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
  /**
   * True when the executor's own timeout was the FIRST cause to cut the command
   * short. Mutually exclusive with {@link aborted}: one fused deadline drives
   * both the timeout and the caller's cancellation, so a timeout and an abort
   * racing before process close report the single first-abort cause, not both
   * (see the [timeout-library Agent Note](../../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md)).
   */
  timedOut: boolean
  /**
   * True when the caller's `AbortSignal` was the FIRST cause to kill the command
   * (and it was not the executor's own timeout). Mutually exclusive with
   * {@link timedOut} — see there for the first-cause classification.
   */
  aborted: boolean
  /** The effective timeout applied to this run (after defaulting/capping). */
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  /** Sandbox execution facts, absent for an unsandboxed executor. */
  sandbox?: ShellSandboxInfo
}
```

每个流是一个 `CollectedOutput`：（可能被截断的）文本加恢复信息；截断时，`text` 是**尾部**，完整流溢出到一个私有文件。这些字段归[子进程 seam](subprocess.zh.md)所有，由 `dsh-shell` 重导出。

## 文件沙箱：`ShellSandboxInfo`

使用沙箱的执行器通过 `ShellExecutor.sandboxMode` 暴露其已配置的模式回退值。工具层请求 [`@deepseek-ai/dsh-sandbox-policy`](../../packages/sandbox/sandbox-policy/README.zh.md)，把每个调用会话的持久 `sandbox/mode` 覆盖值与不可变 cwd 解析为 `ShellExecRequest.sandboxPolicy`；经用户批准、严格更宽松的调用只替换模式。模式/root/enforcement 词汇归 [`@deepseek-ai/dsh-sandbox` 沙箱 seam](sandbox.zh.md) 所有；模式仅管辖文件效果。

沙箱化运行会报告其模式、保守的拒绝分类与强制执行完整度。`runnerFailed` 标记命令运行前沙箱 runner 已失败；前台执行会抛出 `SANDBOX_UNAVAILABLE`，而已结束的后台进程只能通过其事实通道报告。

```ts type-equiv
/**
 * Sandbox facts for one run, present iff a sandboxing executor handled it.
 * Facts are reported independently of process exit status so callers can
 * distinguish command failures from policy denials and runner failures.
 */
interface ShellSandboxInfo {
  /** The mode the command actually ran under. */
  mode: SandboxMode
  /** Whether the sandbox denied a file operation. */
  denied: boolean
  /** How completely the selected runner enforced the requested mode. */
  enforcement?: SandboxEnforcement
  /** Whether the sandbox runner failed before the command could run. */
  runnerFailed?: boolean
}
```

当受限模式没有可用后端时，`ctx.sandbox` 提供方会抛出、执行器会传播由[沙箱 seam](sandbox.zh.md)所有的 `SANDBOX_UNAVAILABLE` 错误码。选定的 runner 拒绝其 profile 时会触达同一个故障关闭的前台错误；已结束的后台任务则记录 `runnerFailed`。模型会在结果中收到拒绝/runner 事实，仅当拒绝标记指出生效模式时才得知该模式，并可通过 `sandbox_permissions` 加 `justification` 请求一次性、严格更宽松的重试；执行任何操作前，`ctx.approval` 必须批准该次确切调用。完整的策略与切换设计见[沙箱 Agent Note](../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)。

## 后台进程：`ShellProcess`

`start()` 返回不含 id 或所有者的句柄。`dsh-tool-bash` 将它适配为 `ctx.jobs.start()` 钩子；随后由通用运行时拥有任务标识与生命周期。`done` 会在底层进程结算时完成且绝不 reject；subprocess 提供方的 rejection 会生成状态为 `killed` 的进程，并把不声明阶段的错误写入 stderr。进程结算后仍可读取，并且沙箱事实会在 `done` 完成前写入。

```ts type-equiv
/**
 * A background process handle returned by {@link ShellExecutor.start}. It is the
 * only access path; buffered output remains readable after exit. Composition
 * teardown (the subprocess service's disposal) kills running processes and
 * awaits {@link done}; an executor-only reload leaves them running.
 */
interface ShellProcess {
  /** Process lifecycle state (settled exactly once). */
  status: ShellProcessStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /**
   * Resolves when the underlying process settles (never rejects — provider
   * rejection settles as `killed` with a stage-neutral error on stderr).
   */
  readonly done: Promise<void>
  /** Sandbox facts, stamped once a confined process settles. */
  sandbox?: ShellSandboxInfo
  /**
   * Read output produced since the previous read (consuming — consecutive
   * reads never re-deliver). Reads that lost data flag `lossy` and point at
   * full-stream spill files when available.
   */
  readOutput(): ShellProcessRead
  /**
   * Terminate the provider-managed range. Returns false when it had already finished
   * (no-op); idempotent.
   */
  kill(): boolean
}
```

`readOutput()` 返回增量内容与 spill 恢复信息：

```ts type-equiv
/** One incremental {@link ShellProcess.readOutput} read. */
interface ShellProcessRead {
  /** Output produced since the previous read (stderr in a marked section). */
  delta: string
  /** True when truncation dropped unread bytes the delta cannot include. */
  lossy: boolean
  /** Full stdout spill file, when stdout truncation occurred and a safe path is available. */
  stdoutSpillPath?: string
  /** Full stderr spill file, when stderr truncation occurred and a safe path is available. */
  stderrSpillPath?: string
}
```

## 服务

`ShellExecutor` 拥有 `resolve`、前台 `run`、后台进程 `start` 以及 `sandboxMode` 能力事实。`dsh-bash-local` 拥有命令默认值补全、超时/中止分类、终端环境以及后台读取合并；managed-range 终止、有界收集器、spill 文件、凭据清除与 dispose（资源释放）后完全停稳归[子进程服务](subprocess.zh.md)所有。`dsh-tool-bash` 拥有面向模型的渲染，并将后台句柄适配到[通用任务运行时](jobs.zh.md)。`dsh-shell` 拥有 shell 工具共享的退出状态约定：导出的 `parseExitStatus`/`ParsedExitStatus` 是 `dsh-tool-bash` 的 `renderResult` 与 `dsh-tool-pwsh` 的 `renderPwshResult` 所追加的 `[exit code: N]` / `[killed by signal: X]` 标记的逆解析，两个工具的 `presentResult` 都用它把渲染文本拆分为 terminal 卡的输出正文与退出状态 pill。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxshell--shellexecutor-abstract-seam"></a>

### `ctx.shell` — `ShellExecutor` (abstract seam)

Abstract bash execution service. Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.shell` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- run rejects only for infrastructure failures. Nonzero exits, timeout kills, and abort kills resolve with a ShellRunResult.
- start returns immediately; no timeout applies to background processes. `done` settles at process close and never rejects; spawn failures settle as `killed` with the error on stderr.
- ShellProcess.readOutput is incremental: consecutive reads never repeat output. Lossy reads report truncation and available spill files.
- A still-running background process is stopped and awaited when its owning composition tears down. With the subprocess seam that boundary is `ctx.subprocess` disposal, so a background process survives an executor-only reload.

```ts cordis-catalog
/**
 * Apply implementation-owned defaults and caps to a request before execution.
 * @param request - the caller's request; omitted fields get this
 *   implementation's defaults, capped fields are clamped.
 * @returns the fully-specified spec to hand to {@link run}/{@link start}.
 */
abstract resolve(request: ShellExecRequest): ShellExecSpec

/**
 * Run a command in the foreground; resolves when it finishes.
 * @param spec - a resolved spec from {@link resolve}, never a raw request.
 * @returns the outcome; nonzero exits, timeout kills, and abort kills
 *   resolve with a descriptive result rather than reject.
 */
abstract run(spec: ShellExecSpec): Promise<ShellRunResult>

/**
 * Start a background process and return its handle immediately.
 * @param spec - a resolved spec from {@link resolve}, never a raw request.
 * @returns the live process handle (reads, kill, quiescence promise).
 */
abstract start(spec: ShellExecSpec): ShellProcess
```

Source: [`packages/shell/shell/src/index.ts`](../../packages/shell/shell/src/index.ts)

<a id="ctxshellenv--shellenvregistry"></a>

### `ctx.shellEnv` — `ShellEnvRegistry`

Registry (`ctx.shellEnv`) for trusted, per-execution `DSH_*` variables. The namespace is rebuilt for every model shell call: ambient `DSH_*` values are discarded by the executor, then the registry's current snapshot is injected. Built-in shell facts remain owned by the registry itself while plugins can register additional, enumerable facts with effect-scoped disposal.

```ts cordis-catalog
/**
 * Register one environment contributor. Names and keys are unique; built-in
 * keys are reserved. Registration is disposed with the calling plugin fiber.
 * @param contributor - declared key ownership and per-execution resolver.
 * @returns the disposer that unregisters the contribution.
 */
register(contributor: BashEnvContributor): () => void

/**
 * Build the trusted `DSH_*` snapshot for one shell tool execution.
 * @param execution - the current tool execution.
 * @returns an immutable environment overlay containing built-ins and current contributions.
 */
collect(execution: ToolExecution): DshEnvironment

/**
 * Enumerate plugin-contributed variables without executing their resolvers.
 * @returns declarations sorted by environment variable name.
 */
list(): BashEnvVariableInfo[]
```

Types: [DshEnvironment](subprocess.zh.md) · [ToolExecution](tools.zh.md)

Source: [`packages/shell/shell-env/src/index.ts`](../../packages/shell/shell-env/src/index.ts)
<!-- END GENERATED cordis-surface -->
