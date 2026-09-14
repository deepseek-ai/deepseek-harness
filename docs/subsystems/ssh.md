# SSH

English | [中文](ssh.zh.md)

The [SSH provider family](../../packages/ssh/README.md) supplies one remote filesystem/process world through a deployment-owned OpenSSH connection. The Harness, model transport and Session storage remain on the host. The family implements the existing filesystem, subprocess and sandbox APIs; it introduces no SSH-specific model tools.

## Execution coordinates

Filesystem identities, executable lookup, process cwd, sandbox workspace roots and language-server file URLs refer to the SSH host. Providers canonicalize paths where the files exist, preserving filesystem interpretation of `symlink/..`. The policy resolver carries absolute execution-world spelling without trying to resolve remote paths on the Harness host.

`processPath()` supplies a path usable by the paired subprocess provider. `processPathFromHostPath()` remains unavailable for SSH; installing a remote artifact does not make an arbitrary host path portable. [`NodePtcRuntime`](../../packages/ptc-runtime/ptc-runtime-node/README.md) therefore takes an explicitly installed, digest-verified remote bootstrap.

## Transport and trust

Administrative RPC uses the helper’s SSH exec streams. Ordinary stdin, stdout, stderr, terminal output and optional fd 7 control traffic use separately authenticated forwarded Unix sockets. Each forwarded stream has its own SSH channel window; paused program output does not share the control or administrative window. All channels still share connection bandwidth and transport failure.

Deployment authentication, installed artifact verification and per-stream TLS authentication belong to [`dsh-ssh`](../../packages/ssh/ssh/README.md). The helper executes filesystem and process requests with trusted local providers on the remote machine. SSH is a transport; the selected remote sandbox provider enforces file effects.

## Process lifetime and cancellation

A process is reserved before its streams are connected, and launch is accepted at most once. `done` reports the direct result; `waitForExit` observes the remote managed range. Terminal operations retain the asynchronous shared API. Preparation cancellation, launched-process termination and provider disposal release their owned resources through the helper.

Administrative deadlines bound individual RPC observations; they do not replace the execution deadline chosen by a Bash or ptc-runtime consumer. Remote waits can remain pending while other requests progress. SSH loss invalidates pending operations; helper EOF, signals and lease expiry start remote cleanup. The client reports unconfirmed outcomes honestly and never reconnects to replay a possibly executed action.

## Composition scope

Headless records and checks Session cwd through the mounted filesystem provider. Remote FS, Bash, terminal, LSP and PTC consumers can therefore share those coordinates. Web workspace views that assume host filesystem access need separate integration; replacing providers alone does not make those views remote-aware.

See the [decision record](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) for the alternatives and verification obligations.

## Connection API

```ts type-equiv
/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Absolute remote Node executable. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}
```

```ts public-api
/** One non-reconnecting SSH session; loss invalidates all active operations. */
declare class SshConnection extends Service {
  static Config: schema<Config>;
  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>;
  constructor(ctx: Context, config: Config);
  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void>;
  /** Verified remote Node executable for the paired PTC runtime. */
  get nodeExecutable(): string;
  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string;
  /**
     * Send a helper operation; cancellation never replays an ambiguous mutation.
     * @param method - the private helper operation.
     * @param params - JSON request fields validated by the helper.
     * @param result - response validation before returning provider-visible data.
     * @param signal - cancellation, which does not undo completed remote effects.
     * @param wait - allow a process observation to outlast the administrative deadline.
     * @returns the validated remote result.
     */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>;
  /**
     * Forward one authenticated stream through an independent SSH channel.
     * @param endpoint - private coordinates issued by this connection's helper.
     * @param signal - cancellation of allocation and the resulting socket.
     * @returns a paused socket; attach a consumer before resuming it.
     */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>;
  /** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
  dispose(): Promise<void>;
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxssh--sshconnection"></a>

### `ctx.ssh` — `SshConnection`

One non-reconnecting SSH session; loss invalidates all active operations.

```ts cordis-catalog
/**
 * Send a helper operation; cancellation never replays an ambiguous mutation.
 * @param method - the private helper operation.
 * @param params - JSON request fields validated by the helper.
 * @param result - response validation before returning provider-visible data.
 * @param signal - cancellation, which does not undo completed remote effects.
 * @param wait - allow a process observation to outlast the administrative deadline.
 * @returns the validated remote result.
 */
async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>

/**
 * Forward one authenticated stream through an independent SSH channel.
 * @param endpoint - private coordinates issued by this connection's helper.
 * @param signal - cancellation of allocation and the resulting socket.
 * @returns a paused socket; attach a consumer before resuming it.
 */
async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>

/** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
dispose(): Promise<void>
```

Source: [`packages/ssh/ssh/src/index.ts`](../../packages/ssh/ssh/src/index.ts)
<!-- END GENERATED cordis-surface -->
