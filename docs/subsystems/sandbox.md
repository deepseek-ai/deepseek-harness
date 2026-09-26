# Process Sandbox

English | [中文](sandbox.zh.md)

The process-sandbox seam of [dsh-sandbox](../../packages/sandbox/sandbox) wraps a same-world subprocess argv in a file-effect policy without coupling consumers to a platform runner. [dsh-sandbox-local](../../packages/sandbox/sandbox-local) supplies Linux bwrap/Landlock, macOS Seatbelt, and the Windows ACL restricted-token backend; [dsh-bash-sandbox](../../packages/shell/bash-sandbox) and [dsh-pwsh-sandbox](../../packages/shell/pwsh-sandbox) consume it. [dsh-sandbox-ssh](../../packages/ssh/sandbox-ssh/README.md) applies the same policy through a remote backend paired with the SSH filesystem and subprocess providers.

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

## Modes and enforcement

`SandboxMode` governs filesystem effects only. `read-only` asks the backend to deny writes — the POSIX runners additionally grant the `/dev/null` sink their shells require, while the Windows ACL runner grants no explicit writable root and reports partial enforcement for its ambient ACL gaps; `workspace-write` permits writes under the workspace root and the backend's promised temp area; `danger-full-access` bypasses confinement. Network and process visibility are outside this vocabulary.

```ts type-equiv
/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace and a
 * backend-defined temp area; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

Only the first two modes can be sent to a provider. A `danger-full-access` consumer spawns its original argv and does not call `ctx.sandbox`.

```ts type-equiv
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

Enforcement is a reported fact. `full` means the backend governs every file effect promised by the mode; `partial` means an active backend or older kernel ABI governs only a subset, so consumers that require the absolute promise must reject or surface that distinction. Older Landlock ABIs and the Windows ACL runner's hard-link, unconfined-read, and AppContainer-ACL boundaries are current partial cases.

```ts type-equiv
/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
type SandboxEnforcement = 'full' | 'partial'
```

## Per-call policy

The complete execution policy is resolved and carried per capability call. It includes `danger-full-access` so a consumer can resolve policy once before deciding whether to bypass confinement. Normal tool calls derive `workspaceRoot` from the calling session's immutable cwd; deployment configuration is the agentless fallback. The resolver preserves absolute execution-world spelling. Enforcing providers canonicalize the root where the files exist, so a cwd containing `symlink/..` identifies the directory where the paired subprocess provider actually runs.

```ts type-equiv
/**
 * The complete file-effect policy resolved for one capability call. The root
 * is carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
  /**
   * Opaque identity of the calling session (the branded `dsh-session`
   * SessionId). Backends key per-session state off it (e.g. windows-acl gives
   * each live session/workspace pair a random private temp directory and SID,
   * while the workspace SID and standing grant remain per-workspace); absent
   * for agentless calls, which fall back to per-call backend state.
   */
  sessionId?: SessionId
}
```

`ctx.sandboxPolicy.resolve()` accepts the active session and, for an approved retry, an explicit mode. The service owns precedence and root fallback so bash and fs do not repeat it.

```ts type-equiv
/** Inputs that select the sandbox policy for one capability call. */
interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}
```

Only a confined execution reaches `ctx.sandbox`; its provider policy narrows the mode while retaining the same root. This permits concurrent sessions, consumers, and one-shot escalated retries to ask the same provider for different boundaries without mutating provider state.

```ts type-equiv
/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}
```

<a id="wrapped-argv-and-classification-dialects"></a>

## Wrapped argv and classification dialects

`RunnerFailureRule` combines evidence that a runner failed before executing the command. A consumer requires a nonzero exit, the optional allowed-exit-code gate, and a case-insensitive fatal signature within one remaining stderr line. Case-insensitive exact full-line informational exclusions are removed first, so a benign runner notice cannot prove failure by itself. The matched line remains available as error detail; classification does not rewrite stderr.

```ts type-equiv
/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}
```

`ConfinedArgv` is what the consumer spawns. Besides the replacement argv, it carries the backend's enforcement fact and two orthogonal stderr classifiers. `denialSignatures` identify the confined command being blocked while the sandbox works correctly. `runnerFailureRules` identify the sandbox runner refusing or failing before it executes the command; consumers check these first and surface a sandbox infrastructure failure, never an ordinary task failure.

```ts type-equiv
/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * Structured runner-failure evidence rules. Consumers require a matching
   * fatal stderr line (after informational exclusions) and any rule-specific
   * exit-code gate before checking denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}
```

The [local provider](../../packages/sandbox/sandbox-local/README.md) owns operator configuration and maps its runner dialect into these rules. The [sandboxed bash consumer](../../packages/shell/bash-sandbox/README.md) owns spawn and result attribution.

## Provider and fail-closed errors

`await ctx.sandbox.confine(argv, policy, signal)` resolves policy paths and returns a `ConfinedArgv` from the execution world, or rejects with `SandboxUnavailableError` and code `SANDBOX_UNAVAILABLE` when no usable backend exists. The optional signal cancels resolution before launch. Consumers may also classify a failure while spawning or observing the returned argv; that attribution belongs to the consumer contract. Silent unconfined passthrough is never legal for a confined policy.

Provider selection, probing, caching, and backend-specific enforcement reports belong to the [local provider](../../packages/sandbox/sandbox-local/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsandbox--sandboxprovider-abstract-seam"></a>

### `ctx.sandbox` — `SandboxProvider` (abstract seam)

Abstract process-sandbox service. confine must return enforcing argv or fail closed at wrap or runner-execution time; silent unconfined passthrough is forbidden. Functional probes arbitrate multi-runner chains and may be skipped for a sole candidate, whose own refusal remains the fail-closed end.

```ts cordis-catalog
/**
 * Wrap `argv` so it executes confined under `policy` on this host; the
 * caller spawns the returned argv in place of its own.
 * @param argv - the exact argv the caller is about to spawn (program plus
 *   arguments), NOT a shell string — a shell-shaped consumer passes
 *   `['bash', '-c', command]`.
 * @param policy - the file-effect policy this execution runs under,
 *   carried per call (see {@link SandboxPolicy}).
 * @param signal - cancellation while the provider resolves the policy and runner.
 * @returns the argv to spawn instead, plus the enforcement completeness
 *   the selected backend achieves for it.
 */
abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
```

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

<a id="ctxsandboxpolicy--sandboxpolicyservice"></a>

### `ctx.sandboxPolicy` — `SandboxPolicyService`

The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment default mode, fallback workspace root, and current request-time policy section. Tool layers call resolve for each execution so a session's mode log and immutable cwd travel together to every enforcing capability.

```ts cordis-catalog
/**
 * Resolve the complete policy for one capability call. An approved explicit
 * mode outranks the session's last `sandbox/mode` event, which outranks the
 * deployment default. A session cwd is its workspace-write boundary; the
 * configured root is the fallback for agentless calls and sessions without a
 * cwd.
 * @param request - optional session and approved mode override.
 * @returns the fully resolved per-call mode and absolute workspace root.
 */
resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy

/**
 * Read the session override without applying the deployment default.
 * @param session - session whose log supplies the override.
 * @returns the last logged mode, or `undefined` without one.
 */
overrideOf(session: Session): SandboxMode | undefined
```

Types: [Session](session.md)

Source: [`packages/sandbox/sandbox-policy/src/index.ts`](../../packages/sandbox/sandbox-policy/src/index.ts)
<!-- END GENERATED cordis-surface -->
