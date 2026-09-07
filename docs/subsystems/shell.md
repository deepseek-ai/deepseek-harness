# Bash Executor

English | [中文](shell.zh.md)

The bash execution seam is split across a Service Definition ([dsh-shell](../../packages/shell/shell), `ctx.shell`), Service Providers ([dsh-bash-local](../../packages/shell/bash-local) and [dsh-bash-sandbox](../../packages/shell/bash-sandbox)), and Consumer ([dsh-tool-bash](../../packages/shell/tool-bash), the `bash` schema). Generic background-job ids, ownership, and controls live in [jobs.md](jobs.md); this seam returns a task-free process handle. Managed-range mechanics live behind the [subprocess seam](subprocess.md).

Source: [`packages/shell/shell/src/types.ts`](../../packages/shell/shell/src/types.ts)

## Managed shell environment namespace

`DSH_*` variables are Harness-owned child-process facts. The model-facing bash tool collects them through `ctx.shellEnv` and passes them through `ShellExecRequest.dshEnv`; the subprocess service removes inherited `DSH_*` names before merging the current snapshot. The `DshEnvironmentKey`/`DshEnvironment` vocabulary is owned by the [subprocess seam](subprocess.md) and re-exported by `dsh-shell`.

## Request vs. spec: the `resolve()` split

The seam separates the **model-/plugin-facing request** (optional `workdir`/`timeoutMs`/`stdoutMaxBytes`, filled from config or request policy) from the **fully-resolved spec** the executor acts on (those fields required). The tool layer calls `ctx.shell.resolve(request)` between them (the repo's "explicit > implicit at package boundaries" rule); a `ShellExecSpec` carries resolved values.

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

`stdin` and `env` are trusted in-process plugin inputs and are not exposed by `dsh-tool-bash`. The local executor scrubs ambient credentials before merging explicit caller-supplied env.

`stdoutMaxBytes` is also trusted-plugin-only. It lets a foreground consumer request complete stdout up to a bounded parser budget without changing stderr, background jobs, or the model-facing bash tool's ordinary output cap.

## Foreground runs: `ShellRunResult`

The outcome of one completed (or killed) foreground run. Orthogonal outcomes are reported **independently** — a process can both time out AND exit 0 because it trapped the signal — so `timedOut`, `aborted`, `signal`, and `exitCode` are each their own field; a caller never reads a cut-short run as a clean success.

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

Each stream is a `CollectedOutput` — the (possibly truncated) text plus recovery info; when truncated, `text` is the **tail** and the complete stream spills to a private file. The fields are owned by the [subprocess seam](subprocess.md) and re-exported by `dsh-shell`.

## File sandbox: `ShellSandboxInfo`

A sandbox-consuming executor exposes its configured mode fallback through `ShellExecutor.sandboxMode`. The tool layer asks [`@deepseek-ai/dsh-sandbox-policy`](../../packages/sandbox/sandbox-policy/README.md) to resolve each calling session's durable `sandbox/mode` override and immutable cwd into `ShellExecRequest.sandboxPolicy`; a user-approved strictly wider call replaces only the mode. The mode/root/enforcement vocabulary is owned by the [`@deepseek-ai/dsh-sandbox` seam](sandbox.md); modes govern file effects only.

A sandboxed run reports its mode, conservative denial classification, and enforcement completeness. `runnerFailed` marks a sandbox runner failure before the command ran; foreground execution throws `SANDBOX_UNAVAILABLE`, while a settled background process has only its facts channel.

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

The `SANDBOX_UNAVAILABLE` error code (owned by the [sandbox seam](sandbox.md)) is what the `ctx.sandbox` provider throws — and the executor propagates — when a confined mode has no usable backend. A selected runner refusing its profile reaches the same fail-closed foreground error; a settled background job records `runnerFailed`. The model receives denial/runner facts in results, learns the effective mode only when a denial marker names it, and can request a one-shot strictly wider retry through `sandbox_permissions` plus `justification`; `ctx.approval` must grant that exact call before anything executes. The complete policy and switching design is the [sandbox Agent Note](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md).

## Background processes: `ShellProcess`

`start()` returns a handle with no id or owner. `dsh-tool-bash` adapts it into `ctx.jobs.start()` hooks; the generic runtime then owns job identity and lifecycle. `done` resolves when the underlying process settles and never rejects; a subprocess provider rejection becomes a `killed` process with a stage-neutral error on stderr. Reads remain valid after settlement, and sandbox facts are stamped before `done` resolves.

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

`readOutput()` returns the incremental delta and spill recovery facts:

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

## The service

`ShellExecutor` owns `resolve`, foreground `run`, background-process `start`, and the `sandboxMode` capability fact. `dsh-bash-local` owns command defaulting, timeout/abort classification, the terminal environment, and the background read merge; managed-range termination, bounded collectors, spill files, credential scrubbing, and disposal quiescence are the [subprocess service](subprocess.md)'s. `dsh-tool-bash` owns model-facing rendering and adapts background handles into the [generic job runtime](jobs.md). `dsh-shell` owns the shell tools' shared exit-status contract: the exported `parseExitStatus`/`ParsedExitStatus` inverts the `[exit code: N]` / `[killed by signal: X]` markers `dsh-tool-bash`'s `renderResult` and `dsh-tool-pwsh`'s `renderPwshResult` append, and both tools' `presentResult` use it to split the rendered text into the terminal card's output body and its exit-status pill.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [DshEnvironment](subprocess.md) · [ToolExecution](tools.md)

Source: [`packages/shell/shell-env/src/index.ts`](../../packages/shell/shell-env/src/index.ts)
<!-- END GENERATED cordis-surface -->
