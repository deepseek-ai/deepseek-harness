<!-- 由 scripts/gen-config-catalog.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-config-catalog` 重新生成。 -->

# 插件配置目录

[English](config-catalog.md) | 中文

每个 `config:` 块均可由 `cordis.yml` 条目设置：针对每个可加载的 harness 包，原样列出其 `apply` 函数或服务构造函数接收的配置声明（包括 JSDoc），并附上所有引用类型——包内类型直接粘贴，其他类型则提供链接。粘贴的内容是插件声明的完整配置类型——运行时 schema 有意排除的字段是仅供运行时使用的 seam（其自身的 JSDoc 会如此说明），不能通过 `cordis.yml` 设置。这是以**部署**为轴的参考文档——插件作者所依据的连接方式请参阅各[子系统页面](subsystems/core.zh.md)中的生成 `cordis-surface` 区域，面向模型的工具 schema 请参阅[工具目录](tool-catalog.zh.md)，而 [subsystems/](subsystems/core.zh.md) 则记录了这些声明所引用的类型。

本文件的两种语言版本都由源代码（`scripts/gen-config-catalog.ts`）生成，并通过 `pnpm run verify-config-catalog`（`doc-sync` 的一部分）验证新鲜度——请勿手工编辑。声明块使用 `ts config-catalog` 围栏（doc-typecheck 会跳过它，因为单独引用导入项的声明无法独立编译）。生成器还会将运行时 schemastery schema 与粘贴的声明进行交叉核对——每个经 schema 验证的键（包括嵌套键）都必须能在声明的配置类型中找到——因此，粘贴内容无法隐藏加载器接受的字段。

每个包的条目用三个标识符标注：`inject` 列出插件注入的服务键，其 `cordis.yml` 树还必须加载这些服务的提供者；`refs` 列出声明引用、但未粘贴在此处的类型；`source` 链接到声明配置的源文件。范围限定为 harness 层级（`packages/`）；配置树还可能加载的 vendored cordis 插件（控制台日志记录器等）固定为上游源代码（参见 [vendoring policy](../vendor/README.md)），未收录于此目录。

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-acp -->
<a id="deepseek-aidsh-acp"></a>

## `@deepseek-ai/dsh-acp`

- `inject`: `agents` · `llm` · `sessionPersistence` · `sessions`
- `refs`: `Stream` (`@agentclientprotocol/sdk`)
- `source`: [`packages/acp/acp/src/index.ts:74`](../packages/acp/acp/src/index.ts)

```ts config-catalog
/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-acp -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-action-cards -->
<a id="deepseek-aidsh-action-cards"></a>

## `@deepseek-ai/dsh-action-cards`

- `inject`: `tools` · `agents` · `sessionProjections` · `remoteAccess`
- `refs`: `z` (`zod`)
- `source`: [`packages/experimental/action-cards/src/index.ts:23`](../packages/experimental/action-cards/src/index.ts)

```ts config-catalog
/** Validated card limits after schema defaults. */
export type Config = z.infer<typeof Config>
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-action-cards -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-agent-default-model -->
<a id="deepseek-aidsh-agent-default-model"></a>

## `@deepseek-ai/dsh-agent-default-model`

- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/core/agent-default-model/src/index.ts:24`](../packages/core/agent-default-model/src/index.ts)

```ts config-catalog
/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-agent-default-model -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-agent-instructions -->
<a id="deepseek-aidsh-agent-instructions"></a>

## `@deepseek-ai/dsh-agent-instructions`

- `inject`: `agents` · `workingDirectory`
- `source`: [`packages/context/agent-instructions/src/config.ts:18`](../packages/context/agent-instructions/src/config.ts)

```ts config-catalog
/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Directory entries that identify the project root while walking upward from the current working directory. */
  projectRootMarkers?: string[]
  /**
   * UTF-8 byte cap for each instruction chain (user-global, project) within one
   * rendered baseline or dynamic batch, so a baseline or batch holding both
   * chains is at most twice this size; non-positive or non-finite disables loading.
   */
  maxBytes: number
  /** Maximum UTF-8 bytes read from one instruction file; larger files are ignored. */
  maxSourceBytes?: number
  /**
   * Ordered same-directory project candidates; every existing file loads, with
   * per-directory trimmed-content duplicates collapsed to the earliest candidate.
   */
  instructionFileCandidates?: string[]
  /**
   * Ordered same-directory local-overlay candidates loaded after the base files
   * under the same per-directory trimmed-content dedup; empty disables the overlay.
   */
  localInstructionFileCandidates?: string[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-agent-instructions -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-agent-loop -->
<a id="deepseek-aidsh-agent-loop"></a>

## `@deepseek-ai/dsh-agent-loop`

- `inject`: `agents` · `sessions` · `llm` · `tools` · `systemPrompt` · `sessionProjections`
- `refs`: [`AgentOptions`](subsystems/core.zh.md) · [`SessionId`](subsystems/core.zh.md) · `Volatile` (`@deepseek-ai/cosmokit`)
- `source`: [`packages/core/agent-loop/src/index.ts:253`](../packages/core/agent-loop/src/index.ts)

```ts config-catalog
/** Agent-loop plugin configuration. */
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  maxParallelToolCalls: Volatile<number>
  /** Agents created or resumed at plugin startup; a resumed agent records its configured route as the Session's model selection. */
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    id: string
    /** Optional stable identity; remounts resume its materialized history, while first use creates it fresh. */
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    resumeSessionId?: SessionId
  })[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-agent-loop -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-agent-preset -->
<a id="deepseek-aidsh-agent-preset"></a>

## `@deepseek-ai/dsh-agent-preset`

- `inject`: `agentPresets`
- `refs`: [`PresetDefinition`](../packages/preset/agent-preset-registry/src/index.ts)
- `source`: [`packages/preset/agent-preset/src/index.ts:9`](../packages/preset/agent-preset/src/index.ts)

```ts config-catalog
/** Definition submitted to the preset registry. */
export type Config = PresetDefinition
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-agent-preset -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-agent-preset-registry -->
<a id="deepseek-aidsh-agent-preset-registry"></a>

## `@deepseek-ai/dsh-agent-preset-registry`

- `inject`: `loader` · `sessionProjections` · `agents`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/preset/agent-preset-registry/src/preset.ts:13`](../packages/preset/agent-preset-registry/src/preset.ts)

```ts config-catalog
/** Registry selection policy. */
export interface Config {
  /** Deployment default when the caller omits a preset. */
  default: string
  /** User-selected default; edited through Settings. */
  selectedDefault: Volatile<string | undefined>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-agent-preset-registry -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-agent-tool-presentation -->
<a id="deepseek-aidsh-agent-tool-presentation"></a>

## `@deepseek-ai/dsh-agent-tool-presentation`

- `inject`: `tools`
- `source`: [`packages/core/agent-tool-presentation/src/index.ts:25`](../packages/core/agent-tool-presentation/src/index.ts)

```ts config-catalog
/**
 * Plugin config.
 * @deprecated Select the native or PTC executor plugin directly instead of configuring a mode.
 */
export interface Config {
  /**
   * The form this agent's model sees. `native` sends every visible schema,
   * `ptc` sends only `run_code` plus a generated SDK.
   * Required rather than defaulted: the deployment default is what a preset
   * without this row already gets, so an omitted value would mean the row was
   * composed for nothing.
   */
  mode: 'native' | 'ptc'
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-agent-tool-presentation -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-api-gateway -->
<a id="deepseek-aidsh-api-gateway"></a>

## `@deepseek-ai/dsh-api-gateway`

- `inject`: `typert` · `remoteAccess`
- `source`: [`packages/api/gateway/src/index.ts:158`](../packages/api/gateway/src/index.ts)

```ts config-catalog
/** Gateway transport configuration. */
export interface Config {
  /** WebSocket Ping interval from 1 through 2,147,483,647 milliseconds. @default 2000 */
  readonly websocketHeartbeatIntervalMs?: number
  /** Buffered uplink frame bytes one logical stream may hold before it fails with `gateway/uplink-overflow`. @default 262144 */
  readonly streamInboxBytes?: number
  /** Per-message compression for the Remote stream WebSocket; `'none'` disables the extension. @default 'deflate' */
  readonly websocketCompression?: 'none' | 'deflate'
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-api-gateway -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-api-job-controller -->
<a id="deepseek-aidsh-api-job-controller"></a>

## `@deepseek-ai/dsh-api-job-controller`

- `inject`: `jobs` · `typert`
- `source`: [`packages/api/job-controller/src/index.ts:35`](../packages/api/job-controller/src/index.ts)

```ts config-catalog
/** Job Controller deployment policy. */
export interface Config {
  /** Coalescing window after a registry commit before the next rows or output read, in milliseconds (default 100). */
  readonly observeFlushMs?: number
  /** Soft byte budget per observation output frame (default 65536); one larger chunk ships whole. */
  readonly observeMaxFrameBytes?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-api-job-controller -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-api-session-controller -->
<a id="deepseek-aidsh-api-session-controller"></a>

## `@deepseek-ai/dsh-api-session-controller`

- `inject`: `agentDefaultModel` · `agents` · `attachments` · `fileUploads` · `fs` · `llm` · `remoteAccess` · `sessions` · `sessionProjections` · `sessionQuery` · `typert` · `typertGateway` · `workspaceRegistry`
- `source`: [`packages/api/session-controller/src/index.ts:110`](../packages/api/session-controller/src/index.ts)

```ts config-catalog
/** Session Controller deployment policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
  /** Positive integral milliseconds of list work before yielding between complete rows. */
  readonly listWorkSliceMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-api-session-controller -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-api-settings-controller -->
<a id="deepseek-aidsh-api-settings-controller"></a>

## `@deepseek-ai/dsh-api-settings-controller`

- `source`: [`packages/api/settings-controller/src/index.ts:35`](../packages/api/settings-controller/src/index.ts)

```ts config-catalog
/** Host integrations replaceable by direct unit tests. */
export interface SettingsControllerInternals {
  /** Host text-editor integration used to open the settings document. */
  readonly openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-api-settings-controller -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-api-terminal-controller -->
<a id="deepseek-aidsh-api-terminal-controller"></a>

## `@deepseek-ai/dsh-api-terminal-controller`

- `inject`: `subprocess` · `sandboxPolicy` · `workingDirectory` · `typert`
- `source`: [`packages/api/terminal-controller/src/index.ts:27`](../packages/api/terminal-controller/src/index.ts)

```ts config-catalog
/** Deployment limits and an optional shell profile. */
export interface Config {
  /** Explicit shell profile; omission uses the execution environment's default shell. */
  readonly shell?: {
    /** Executable path or PATH name, verified by the subprocess provider. */
    path: string
    /** User-visible profile name. */
    name: string
    /** Arguments passed to the interactive shell. */
    args: string[]
  } | undefined
  /** Executable names or paths checked for the new-terminal shell selector. */
  readonly shellCandidates: string[]
  /** Maximum retained terminals and pending allocations per Session. */
  readonly maxTerminals: number
  /** Maximum terminal width in columns. */
  readonly maxCols: number
  /** Maximum terminal height in rows. */
  readonly maxRows: number
  /** Screen history rows retained for reconnecting clients. */
  readonly scrollback: number
  /** Maximum queued UTF-8 frame bytes per output follower and in the Client input buffer. */
  readonly maxBufferedBytes: number
  /** Maximum raw UTF-8 bytes per input command and across unacknowledged Client input. */
  readonly maxInputBytes: number
  /** Provider process-termination grace period in milliseconds. */
  readonly disposeGraceMs: number
  /** Continuous confirmed idle time without window holds before reclamation; zero disables reclamation. */
  readonly unattendedTimeoutMs: number
  /** Interval between unattended shell and process observations. */
  readonly activityPollIntervalMs: number
  /** Delay before retrying failed owned terminal cleanup. */
  readonly cleanupRetryMs: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-api-terminal-controller -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-api-workspace-controller -->
<a id="deepseek-aidsh-api-workspace-controller"></a>

## `@deepseek-ai/dsh-api-workspace-controller`

- `inject`: `remoteAccess` · `typert` · `workspaceRegistry`
- `source`: [`packages/api/workspace-controller/src/index.ts:37`](../packages/api/workspace-controller/src/index.ts)

```ts config-catalog
/** First-use directory policy for the Host account. */
export interface Config {
  /** Override the system Documents directory with a fully qualified path. */
  documentsDirectory?: string
  /** Maximum duration of the operating system's Documents lookup. */
  documentsLookupTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-api-workspace-controller -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-api-workspace-files -->
<a id="deepseek-aidsh-api-workspace-files"></a>

## `@deepseek-ai/dsh-api-workspace-files`

- `inject`: `fs` · `sandboxPolicy` · `sessions` · `typert`
- `source`: [`packages/api/workspace-files/src/index.ts:70`](../packages/api/workspace-files/src/index.ts)

```ts config-catalog
/** Deployment caps on one page or one listing. */
export interface Config {
  /**
   * Inclusive byte cap on one page's text and on one byte window.
   *
   * A page above this fails; it is not shortened, because a silently cut page
   * reads as the whole page. A byte window asking for more is refused the same
   * way. The file itself has no size cap: a caller pages through it.
   */
  readonly maxBytes: number
  /** Inclusive byte cap on a complete-file read; larger files are refused, never truncated. */
  readonly maxFileBytes: number
  /** Default and largest page size in lines; a request asking for more is refused. */
  readonly maxLines: number
  /** Cap on returned directory entries; the rest is dropped and reported cut. */
  readonly maxEntries: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-api-workspace-files -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-attachment-local -->
<a id="deepseek-aidsh-attachment-local"></a>

## `@deepseek-ai/dsh-attachment-local`

- `source`: [`packages/attachment/attachment-local/src/index.ts:65`](../packages/attachment/attachment-local/src/index.ts)

```ts config-catalog
/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one submitted image. Default: 50 MiB. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. Default: 20. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. Default: 200 MiB. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one submitted image. Default: 64,000,000. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one submitted image. Default: 65,535px. */
  maxImageDimension?: number
  /** Total-pixel budget of the stored provider-independent normalized image. */
  normalizedImageMaxPixels?: number
  /** Long-edge pixel cap of the stored provider-independent normalized image, applied after the total-pixel budget. */
  normalizedImageMaxDimension?: number
  /**
   * Encoded-byte target of the stored provider-independent normalized image;
   * the smallest quality-ladder output is kept when no quality fits.
   */
  normalizedImageMaxBytes?: number
  /** Maximum simultaneous normalization or request-image transformations in this service instance. */
  imageCompressionConcurrency?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-attachment-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-bash-local -->
<a id="deepseek-aidsh-bash-local"></a>

## `@deepseek-ai/dsh-bash-local`

- `inject`: `subprocess`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/shell/bash-local/src/index.ts:41`](../packages/shell/bash-local/src/index.ts)

```ts config-catalog
/** Validated plugin configuration with live command budgets. */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd: Volatile<string | undefined>
  /** Default foreground timeout in milliseconds. */
  timeoutMs: Volatile<number>
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs: Volatile<number>
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes: Volatile<number>
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes: Volatile<number>
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs: Volatile<number>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-bash-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-bash-sandbox -->
<a id="deepseek-aidsh-bash-sandbox"></a>

## `@deepseek-ai/dsh-bash-sandbox`

- `inject`: `subprocess` · `sandbox` · `sandboxPolicy`
- `refs`: [`LocalConfig`](#deepseek-aidsh-bash-local)
- `source`: [`packages/shell/bash-sandbox/src/index.ts:36`](../packages/shell/bash-sandbox/src/index.ts)

```ts config-catalog
/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The runner
 * choice is likewise the `ctx.sandbox` provider's config, not this executor's.
 */
export type Config = LocalConfig
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-bash-sandbox -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-connection -->
<a id="deepseek-aidsh-client-connection"></a>

## `@deepseek-ai/dsh-client-connection`

- `inject`: `credentials`
- `source`: [`packages/client/connection/src/index.ts:96`](../packages/client/connection/src/index.ts)

```ts config-catalog
/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The fence accepts loopback and the
   * listener's own bind IP independently; other remote authorities require
   * an entry here. A non-canonical or non-bare authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser and API cookie lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

/** Timing for generation readiness and automatic reconnection. */
export interface ConnectionRecoveryConfig {
  /** First-retry delay cap in ms; actual delay is 50–100% of the cap. Default: 500. */
  backoffBaseMs?: number
  /** Finite growth factor of at least 1 per failed attempt; 1 keeps a fixed cap. Default: 2. */
  backoffFactor?: number
  /** Maximum retry delay cap in ms; retries continue at this cap. Default: 10000. */
  backoffMaxMs?: number
  /**
   * Delay before reporting a slow handshake, without cancelling it. Default: 3000.
   * Omitted when readiness, failure, cancellation, or the hard deadline occurs first.
   */
  generationReadyWarnMs?: number
  /** Deadline in ms for readiness, including physical connection setup. Default: 15000. */
  generationReadyTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-connection -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-hmr -->
<a id="deepseek-aidsh-client-hmr"></a>

## `@deepseek-ai/dsh-client-hmr`

- `inject`: `clientModules` · `webServer`
- `source`: [`packages/client/hmr/src/index.ts:30`](../packages/client/hmr/src/index.ts)

```ts config-catalog
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-hmr -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-product-analytics -->
<a id="deepseek-aidsh-client-product-analytics"></a>

## `@deepseek-ai/dsh-client-product-analytics`

- `inject`: `deepseekAccount` · `productTelemetry`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/client/product-analytics/src/index.ts:15`](../packages/client/product-analytics/src/index.ts)

```ts config-catalog
/** Application-owned collection policy; no user settings surface. */
export interface Config {
  /** Live application collection policy; ordinary Web does not mount this service. */
  enabled: Volatile<boolean>
  /** Running Desktop release, absent when unavailable. */
  appVersion?: string
  /** Maximum execution time per static environment query, in milliseconds. */
  environmentQueryTimeoutMillis: number
  /** Maximum captured bytes per environment query output stream. */
  environmentQueryMaxOutputBytes: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-product-analytics -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-shortcuts -->
<a id="deepseek-aidsh-client-shortcuts"></a>

## `@deepseek-ai/dsh-client-shortcuts`

- `source`: [`packages/client/shortcuts/src/config.ts:5`](../packages/client/shortcuts/src/config.ts)

```ts config-catalog
/** Fixed shortcut sequence settings. */
export interface Config {
  /** Maximum interval between independent Escape presses for stopping a reply, in milliseconds. */
  stopSequenceMs: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-shortcuts -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-ui-plugin-manager -->
<a id="deepseek-aidsh-client-ui-plugin-manager"></a>

## `@deepseek-ai/dsh-client-ui-plugin-manager`

- `source`: [`packages/client/ui-plugin-manager/src/index.ts:15`](../packages/client/ui-plugin-manager/src/index.ts)

```ts config-catalog
/** Registry-probe deadline and process-local cache policy. */
export interface Config {
  /** Whether the dialog can compare the public npm registries. */
  registryProbeEnabled: boolean
  /** Deadline for the parallel HTTPS probes, including response cleanup. */
  registryProbeTimeoutMs: number
  /** Lifetime of a winning registry or unavailable result. */
  registryProbeCacheTtlMs: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-ui-plugin-manager -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-ui-settings-account -->
<a id="deepseek-aidsh-client-ui-settings-account"></a>

## `@deepseek-ai/dsh-client-ui-settings-account`

- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/client/ui-settings-account/src/index.ts:9`](../packages/client/ui-settings-account/src/index.ts)

```ts config-catalog
/** Public contact options and live device-local onboarding progress. */
export interface Config extends ContactConfig {
  /** Onboarding progress format version. */
  version: Volatile<1>
  /** Last accepted onboarding page. */
  step: Volatile<OnboardingStep>
  /** Selected work scenario. */
  purpose?: Volatile<OnboardingPurpose | null | undefined>
  /** Selected transcript detail. */
  process?: Volatile<OnboardingProcess | null | undefined>
  /** Completion reason, absent until completion. */
  completion?: Volatile<'completed' | 'skipped' | 'api-key' | null | undefined>
  /** Selected usage detail. */
  usage: Volatile<'compact' | 'detailed'>
  /** Selected developer-tool visibility. */
  developerTools: Volatile<boolean>
}

/** Questionnaire destination and bonus notice timings shared by Host and Client. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
  /** First delay before retrying a failed bonus acknowledgement. */
  bonusAckRetryDelayMs: number
  /** Ceiling for the acknowledgement retry backoff. */
  bonusAckRetryMaxDelayMs: number
}

/** Persisted steps; a native top-up page leaves the durable step at credit. */
export type OnboardingStep = 'welcome' | 'credit' | 'purpose' | 'process' | 'done'

/** Work scenarios offered by the desktop introduction. */
export type OnboardingPurpose = 'office' | 'development' | 'both'

/** Work-detail mode applied to Chat when onboarding completes. */
export type OnboardingProcess = 'compact' | 'standard' | 'detailed'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-ui-settings-account -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-ui-settings-models -->
<a id="deepseek-aidsh-client-ui-settings-models"></a>

## `@deepseek-ai/dsh-client-ui-settings-models`

- `source`: [`packages/client/ui-settings-models/src/onboarding-config.ts:6`](../packages/client/ui-settings-models/src/onboarding-config.ts)

```ts config-catalog
/** Onboarding options after schema defaults are applied. */
export interface Config {
  /** Offer the browser API-key step when no native shell owns credential onboarding. */
  credentialOnboarding: boolean
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-ui-settings-models -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-ui-sidebar-documentpreview -->
<a id="deepseek-aidsh-client-ui-sidebar-documentpreview"></a>

## `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`

- `source`: [`packages/client/ui-sidebar-documentpreview/src/config.ts:5`](../packages/client/ui-sidebar-documentpreview/src/config.ts)

```ts config-catalog
/** Transient Office conversion reuse within one Client connection. */
export interface Config {
  /** Retained PDF limits; pending conversions share cancellation by reader lifetime. */
  office: {
    /** Maximum retained completed PDFs. */
    maxCachedEntries: number
    /** Maximum retained PDF bytes, counted by each binary buffer's byteLength. */
    maxCachedBytes: number
    /** Maximum unsettled Host conversion RPCs, including cancellation teardown. */
    maxPending: number
    /** Maximum readers including source and renderer metadata lookups. */
    maxReaders: number
  }
  /** Browser spreadsheet parser and dense cell allocation limits. */
  excel: {
    /** Maximum source file bytes. */
    maxBytes: number
    /** Maximum combined rectangular cell area across worksheets. */
    maxCells: number
    /** Maximum parser Worker lifetime in milliseconds. */
    timeoutMs: number
  }
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-ui-sidebar-documentpreview -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-ui-theme -->
<a id="deepseek-aidsh-client-ui-theme"></a>

## `@deepseek-ai/dsh-client-ui-theme`

- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/client/ui-theme/src/index.ts:20`](../packages/client/ui-theme/src/index.ts)

```ts config-catalog
/** Runtime preferences projected to the browser. */
export interface Config {
  /** Browser palette preference. */
  preference: Volatile<ThemePreference>
  /** Browser font size in pixels. */
  fontSize: Volatile<number>
  /** Code-block font size in pixels. */
  codeFontSize: Volatile<number>
  /** Sidebar terminal font size in pixels. */
  terminalFontSize: Volatile<number>
  /** Interface and body text font list; `''` keeps the built-in stack. */
  textFontFamily: Volatile<string>
  /** Code font list; `''` keeps the built-in stack. */
  codeFontFamily: Volatile<string>
  /** Sidebar terminal font list; `''` keeps the built-in stack. */
  terminalFontFamily: Volatile<string>
}

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-ui-theme -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-client-ui-trajectory -->
<a id="deepseek-aidsh-client-ui-trajectory"></a>

## `@deepseek-ai/dsh-client-ui-trajectory`

- `inject`: `sessions` · `typert`
- `source`: [`packages/client/ui-trajectory/src/index.ts:25`](../packages/client/ui-trajectory/src/index.ts)

```ts config-catalog
/** Count limit for each live Session's transient tool results. */
export interface Config {
  /** Maximum retained results per Session, including values awaiting a result event. */
  maxResultsPerSession: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-client-ui-trajectory -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-compaction-basic -->
<a id="deepseek-aidsh-compaction-basic"></a>

## `@deepseek-ai/dsh-compaction-basic`

- `inject`: `llm` · `tokenMeter` · `sessions`
- `source`: [`packages/compaction/compaction-basic/src/types.ts:40`](../packages/compaction/compaction-basic/src/types.ts)

```ts config-catalog
/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Window fraction for pressure; capped at context window minus reserved output and `headroomTokens`. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Additional pressure headroom beyond the routed output reservation. Non-negative integer; defaults to `65536`. */
  headroomTokens?: number
  /** Recent context retained as a fraction of context window minus reserved output tokens. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to the resolved `headroomTokens`; an explicit cap must be positive. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-compaction-basic -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-compaction-tool-result-pruner -->
<a id="deepseek-aidsh-compaction-tool-result-pruner"></a>

## `@deepseek-ai/dsh-compaction-tool-result-pruner`

- `inject`: `tokenMeter`
- `source`: [`packages/compaction/compaction-tool-result-pruner/src/types.ts:5`](../packages/compaction/compaction-tool-result-pruner/src/types.ts)

```ts config-catalog
/** Character-budget policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-compaction-tool-result-pruner -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-cordis-host-runner -->
<a id="deepseek-aidsh-cordis-host-runner"></a>

## `@deepseek-ai/dsh-cordis-host-runner`

- `inject`: `tools`
- `source`: [`packages/extensions/cordis-host-runner/src/index.ts:103`](../packages/extensions/cordis-host-runner/src/index.ts)

```ts config-catalog
/** Runner configuration. */
export interface Config {
  /** Maximum synchronous VM evaluation time in milliseconds. */
  vmTimeoutMs?: number
  /** Maximum wait for a valid Client inspect response in milliseconds. */
  clientInspectTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-cordis-host-runner -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-credentials-local -->
<a id="deepseek-aidsh-credentials-local"></a>

## `@deepseek-ai/dsh-credentials-local`

- `source`: [`packages/credentials/credentials-local/src/index.ts:64`](../packages/credentials/credentials-local/src/index.ts)

```ts config-catalog
/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Credentials document path; defaults to `.credentials.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-credentials-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-deepseek-account-platform -->
<a id="deepseek-aidsh-deepseek-account-platform"></a>

## `@deepseek-ai/dsh-deepseek-account-platform`

- `inject`: `credentials` · `authorization`
- `source`: [`packages/credentials/deepseek-account-platform/src/index.ts:23`](../packages/credentials/deepseek-account-platform/src/index.ts)

```ts config-catalog
/** Deployment-specific platform and request deadlines. */
export interface Config {
  /** Platform origin serving auth-api and browser pages. */
  platformOrigin?: string
  /** Native desktop identity for Host API and embedded Platform requests; null identifies the client as web. */
  desktopPlatform?: 'darwin' | 'win32' | null
  /** Optional frontend deployment selector for embedded Usage and Top-up pages. */
  embeddedPageDist?: string
  /** Exact HTTP(S) origin allowed to receive account tokens for inference and files. */
  inferenceOrigin?: string
  /** Allow HTTP only on loopback for the development Mock. */
  allowLoopbackHttp?: boolean
  /** Map authorization and completion pages to platformOrigin for private development proxies. */
  rewriteBrowserOrigin?: boolean
  /** Host-only headers sent exclusively to platformOrigin; account authorization cannot be overridden. */
  requestHeaders?: Record<string, string>
  /** Overrides for profile, balance and embedded Platform requests; Cookie pairs merge by name. Logout retains requestHeaders. */
  accountRequestHeaders?: Record<string, string>
  /** Deadline for each platform HTTP request. */
  requestTimeoutMs?: number
  /** Deadline for recharge-wallet queries; timeout returns a failed balance outcome. */
  balanceTimeoutMs?: number
  /** Additional logout attempts after the first request fails, at most five. */
  logoutMaxRetries?: number
  /** Delay before the first logout retry; each later delay doubles. */
  logoutRetryDelayMs?: number
  /** Upper bound for the entire local attempt, even if the server advertises a longer TTL. */
  attemptTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-deepseek-account-platform -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-agent-team -->
<a id="deepseek-aidsh-experimental-agent-team"></a>

## `@deepseek-ai/dsh-experimental-agent-team`

- `inject`: `agents` · `sessions` · `sessionPersistence` · `sessionProjections` · `subagents`
- `source`: [`packages/experimental/agent-team/src/types.ts:153`](../packages/experimental/agent-team/src/types.ts)

```ts config-catalog
/** Team-service deployment limits. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds for shared operation settlement and for each Team child drain. */
  readonly disposalTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-agent-team -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-api-speech-to-text -->
<a id="deepseek-aidsh-experimental-api-speech-to-text"></a>

## `@deepseek-ai/dsh-experimental-api-speech-to-text`

- `inject`: `speechToText` · `typert`
- `source`: [`packages/experimental/api-speech-to-text/src/index.ts:20`](../packages/experimental/api-speech-to-text/src/index.ts)

```ts config-catalog
/** Limits applied before decoding or calling a provider. */
export interface Config {
  /** Maximum decoded WAV bytes per request. */
  maxAudioBytes: number
  /** Maximum PCM recording duration in seconds. */
  maxDurationSeconds: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-api-speech-to-text -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp -->
<a id="deepseek-aidsh-experimental-browser-use-chrome-devtools-mcp"></a>

## `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp`

- `inject`: `browserUse` · `agents` · `tools` · `systemPrompt` · `workingDirectory`
- `refs`: `BrowserMcpConfig` (`@deepseek-ai/dsh-experimental-browser-use-runtime/mcp`)
- `source`: [`packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:15`](../packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts)

```ts config-catalog
/** Fixed Chromium launch or existing-browser attachment settings. */
export type Config = BrowserMcpConfig
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-browser-use-playwright-mcp -->
<a id="deepseek-aidsh-experimental-browser-use-playwright-mcp"></a>

## `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`

- `inject`: `browserUse` · `agents` · `tools` · `systemPrompt` · `workingDirectory`
- `refs`: `BrowserMcpConfig` (`@deepseek-ai/dsh-experimental-browser-use-runtime/mcp`)
- `source`: [`packages/experimental/browser-use-playwright-mcp/src/index.ts:16`](../packages/experimental/browser-use-playwright-mcp/src/index.ts)

```ts config-catalog
/** Fixed Chromium launch or existing-browser attachment settings. */
export type Config = BrowserMcpConfig
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-browser-use-playwright-mcp -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-browser-use-stagehand-native -->
<a id="deepseek-aidsh-experimental-browser-use-stagehand-native"></a>

## `@deepseek-ai/dsh-experimental-browser-use-stagehand-native`

- `inject`: `browserUse` · `agents` · `tools` · `systemPrompt`
- `refs`: `ModelConfig` (`@browserbasehq/stagehand`)
- `source`: [`packages/experimental/browser-use-stagehand-native/src/index.ts:28`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

```ts config-catalog
/** Profile-owned browser connection and independent Stagehand model credentials. */
export interface Config {
  /** Native Stagehand model and credentials; independent of the Session model. */
  model: StagehandModelConfig
  /** Launch a fresh browser or attach to the configured existing endpoint. */
  mode: 'launch' | 'attach'
  /** CDP HTTP or WebSocket endpoint, required only for attach mode. */
  cdpEndpoint?: string
  /** Optional Stagehand extension id for an existing browser. */
  extensionId?: string
  /** Installed Chrome/Chromium executable used in launch mode. */
  executablePath?: string
  /** Hide an owned browser's window. */
  headless?: boolean
  /** Deadline for Chromium startup and Stagehand navigation/action operations. */
  operationTimeoutMs?: number
  /** Grace for native SDK cleanup before its connection Worker is terminated. */
  shutdownGraceMs?: number
}

/** Profile-owned model settings accepted by the pinned Stagehand SDK. */
export interface StagehandModelConfig {
  /** Provider-prefixed model name from Stagehand's supported model catalog. */
  modelName: ModelConfig['modelName']
  /** Explicit API key sent to Stagehand's browser extension. */
  apiKey: string
  /** Additional headers sent with the extension's model requests. */
  headers?: Record<string, string>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-browser-use-stagehand-native -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-claude-code-mods -->
<a id="deepseek-aidsh-experimental-claude-code-mods"></a>

## `@deepseek-ai/dsh-experimental-claude-code-mods`

- `inject`: `workingDirectory` · `agents`
- `source`: [`packages/experimental/claude-code-mods/src/index.ts:53`](../packages/experimental/claude-code-mods/src/index.ts)

```ts config-catalog
/** Plugin config: the limits mod hooks run under. */
export interface Config {
  /** A hook's own running-time limit in milliseconds (Claude Code: 10 seconds). */
  hookTimeoutMs?: number
  /** A `.catch` handler's running-time limit in milliseconds (Claude Code: 1 second). */
  catchTimeoutMs?: number
  /** Default `$.process.run` and `$.http.fetch` timeout in milliseconds (Claude Code: 30 seconds). */
  processTimeoutMs?: number
  /** Claude Code tool name → harness tool name entries added to the built-in alias table. */
  toolAliases?: Record<string, string>
  /** Columns the band above the prompt reports to `ui.render` as `bodyColumns` and `viewport.columns`. */
  bandColumns?: number
  /** Rows the band reports as `maxRows`. */
  bandRows?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-claude-code-mods -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-client-ui-cot-translation -->
<a id="deepseek-aidsh-experimental-client-ui-cot-translation"></a>

## `@deepseek-ai/dsh-experimental-client-ui-cot-translation`

- `inject`: `translator` · `typert` · `sessionController`
- `refs`: [`TranslationProvider`](subsystems/translation.zh.md) · `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/experimental/client-ui-cot-translation/src/index.ts:14`](../packages/experimental/client-ui-cot-translation/src/index.ts)

```ts config-catalog
/** Live preferences presented on the bundle's Plugins page. */
export interface Config {
  /** Explicit translation provider, defaulting to Bing. */
  provider: Volatile<CotTranslationPreferences['provider']>
  /** Target language code; auto follows the browser UI locale. */
  targetLanguage: Volatile<string>
}

/** Translation choices; auto targets the active browser UI language. */
export interface CotTranslationPreferences {
  /** Explicit provider selection; requests never fall back to another provider. */
  provider: TranslationProvider
  /** BCP 47 language code, or auto to follow the UI language. */
  targetLanguage: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-client-ui-cot-translation -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-client-ui-forge -->
<a id="deepseek-aidsh-experimental-client-ui-forge"></a>

## `@deepseek-ai/dsh-experimental-client-ui-forge`

- `inject`: `forge` · `forgeSession` · `sessionProjections` · `workingDirectory` · `fs` · `subprocess` · `sandbox` · `sandboxPolicy` · `agents`
- `source`: [`packages/experimental/client-ui-forge/src/types.ts:318`](../packages/experimental/client-ui-forge/src/types.ts)

```ts config-catalog
/** Host settings of the forge panel Remote. */
export interface Config {
  /** Git executable name or absolute path in the Session's execution world. */
  gitCommand?: string
  /** Deadline in milliseconds for one Git command, including confinement. */
  gitTimeoutMs?: number
  /** Termination grace period in milliseconds for each Git process. */
  graceMs?: number
  /** Maximum captured bytes per Git output stream. */
  maxOutputBytes?: number
  /** Deadline in milliseconds for one provider sign-in probe. */
  readinessTimeoutMs?: number
  /** Most local branches listed as worktree bases. */
  maxBranches?: number
  /**
   * Prefix of the branch and checkout directory created for a Session worktree; the first eight
   * hexadecimal digits of the Session id's UUID, a hyphen, and four random hexadecimal digits follow it.
   */
  worktreePrefix?: string
  /** Largest diff, or file read to show unchanged lines, in bytes. */
  maxDiffBytes?: number
  /** Most untracked files a local diff or the local changes card includes. */
  maxUntrackedFiles?: number
  /** Most UTF-8 bytes of change request diffs kept in memory for later reads at the same head commit and base branch. */
  maxCachedDiffBytes?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-client-ui-forge -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp -->
<a id="deepseek-aidsh-experimental-computer-use-cua-driver-mcp"></a>

## `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp`

- `inject`: `computerUse` · `tools`
- `refs`: [`McpClient`](../packages/mcp/mcp-client/src/index.ts)
- `source`: [`packages/experimental/computer-use-cua-driver-mcp/src/index.ts:20`](../packages/experimental/computer-use-cua-driver-mcp/src/index.ts)

```ts config-catalog
/** Installed executable and MCP connection overrides. */
export interface Config {
  /** Executable path or PATH command; defaults to `cua-driver`. */
  command: string
  /** Arguments passed without a shell; defaults to `['mcp']`. */
  args: string[]
  /** Per-call timeout in milliseconds; omission uses the MCP client's default. */
  toolCallTimeoutMs?: number
  /** Reconnection overrides; defaults to the MCP client's policy. */
  reconnect: McpClient.ReconnectConfig
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-cua-macos -->
<a id="deepseek-aidsh-experimental-cua-macos"></a>

## `@deepseek-ai/dsh-experimental-cua-macos`

- `inject`: `computerUse` · `tools` · `systemPrompt` · `subprocess` · `agents`
- `refs`: [`CuaConfig`](../packages/experimental/cua/src/index.ts)
- `source`: [`packages/experimental/cua-macos/src/index.ts:16`](../packages/experimental/cua-macos/src/index.ts)

```ts config-catalog
/** Native preparation, operation bounds, and profile-local application grants. */
export type Config = CuaConfig
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-cua-macos -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-forge -->
<a id="deepseek-aidsh-experimental-forge"></a>

## `@deepseek-ai/dsh-experimental-forge`

- `source`: [`packages/experimental/forge/src/types.ts:205`](../packages/experimental/forge/src/types.ts)

```ts config-catalog
/** Poll cadence and fetch deadline for watched change requests. */
export interface Config {
  /** Poll interval in milliseconds while checks run or mergeability is unknown. */
  activeIntervalMs?: number
  /** Poll interval in milliseconds for a closed request or an open request whose checks have settled. */
  idleIntervalMs?: number
  /** Largest delay in milliseconds between polls after consecutive failures. */
  maxBackoffMs?: number
  /** Deadline in milliseconds for one provider fetch. */
  fetchTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-forge -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-forge-github -->
<a id="deepseek-aidsh-experimental-forge-github"></a>

## `@deepseek-ai/dsh-experimental-forge-github`

- `inject`: `forge`
- `source`: [`packages/experimental/forge-github/src/index.ts:14`](../packages/experimental/forge-github/src/index.ts)

```ts config-catalog
/** GitHub CLI executable, served hosts, and invocation limits. */
export interface Config {
  /** GitHub CLI executable name or absolute host path. */
  ghCommand?: string
  /** Host names this provider serves; list GitHub Enterprise hosts explicitly. */
  hosts?: string[]
  /** Deadline in milliseconds for one `gh` invocation. */
  timeoutMs?: number
  /** Maximum captured bytes per `gh` output stream. */
  maxOutputBytes?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-forge-github -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-forge-session -->
<a id="deepseek-aidsh-experimental-forge-session"></a>

## `@deepseek-ai/dsh-experimental-forge-session`

- `inject`: `forge` · `sessions` · `sessionProjections`
- `source`: [`packages/experimental/forge-session/src/types.ts:91`](../packages/experimental/forge-session/src/types.ts)

```ts config-catalog
/** Deployment settings of `forgeSession`. */
export interface Config {
  /** Deadline in milliseconds for one change request lookup after a push. */
  discoveryTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-forge-session -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-inspector -->
<a id="deepseek-aidsh-experimental-inspector"></a>

## `@deepseek-ai/dsh-experimental-inspector`

- `inject`: `webServer` · `connection`
- `source`: [`packages/experimental/inspector/src/index.ts:66`](../packages/experimental/inspector/src/index.ts)

```ts config-catalog
/** Host plugin configuration. Fetch capture is enabled by default. */
export interface Config extends Omit<InspectorOptions, 'clientOrigins'> {
  /** Browser origins allowed to open the Client ingest WebSocket. */
  clientOrigins?: string[]
}

/** User-facing Host options; every memory and lifecycle bound is configurable. */
export interface InspectorOptions {
  /** Loopback address used by the Worker HTTP and WebSocket endpoint. */
  readonly host?: '127.0.0.1'
  /** First port to bind; occupied ports advance until one is available. */
  readonly port?: number
  /** Additional exact browser origins admitted to the Client ingest socket. */
  readonly clientOrigins?: readonly string[]
  /** Whether to observe calls made through the current global fetch function. */
  readonly captureFetch?: boolean
  /** Maximum request-body prefix retained for one fetch. */
  readonly maxRequestBodyBytes?: number
  /** Maximum response-body prefix retained for one fetch. */
  readonly maxResponseBodyBytes?: number
  /** Maximum raw bytes encoded into one body observation. */
  readonly maxBodyChunkBytes?: number
  /** Maximum total request and response body bytes retained by the Worker. */
  readonly maxJournalBytes?: number
  /** Maximum active and completed fetch requests retained by the Worker. */
  readonly maxRetainedRequests?: number
  /** Maximum encoded bytes accepted in one source transport frame. */
  readonly maxSourceFrameBytes?: number
  /** Maximum observation records accepted in one source batch. */
  readonly maxSourceRecordsPerFrame?: number
  /** Maximum records waiting in one producer queue. */
  readonly maxQueuedRecords?: number
  /** Maximum encoded bytes waiting in one producer queue. */
  readonly maxQueuedBytes?: number
  /** Maximum time allowed for the Worker to become ready. */
  readonly startupTimeoutMs?: number
  /** Grace period before a stopping Worker is terminated. */
  readonly stopTimeoutMs?: number
  /** Initial upper bound for randomized Client reconnect delay. */
  readonly clientReconnectBaseMs?: number
  /** Maximum upper bound for randomized Client reconnect delay. */
  readonly clientReconnectMaxMs?: number
  /** Deadline for one Worker-to-Client Runtime or Sources request. */
  readonly clientRuntimeTimeoutMs?: number
  /** Deadline for one non-CDP semantic query. */
  readonly queryTimeoutMs?: number
  /** Maximum live object handles retained per Client Runtime session. */
  readonly maxClientRuntimeObjects?: number
  /** Maximum descriptors returned by one Client property request. */
  readonly maxClientRuntimeProperties?: number
  /** Maximum encoded bytes read for one Client script or source map. */
  readonly maxClientSourceBytes?: number
  /** Maximum Context and Fiber nodes retained in one realm snapshot. */
  readonly maxCordisNodes?: number
  /** Disconnected Cordis snapshots retained after their live realm closes. */
  readonly maxDisconnectedCordisTrees?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-inspector -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-ptc-runtime-python -->
<a id="deepseek-aidsh-experimental-ptc-runtime-python"></a>

## `@deepseek-ai/dsh-experimental-ptc-runtime-python`

- `inject`: `sandbox` · `sandboxPolicy`
- `source`: [`packages/experimental/ptc-runtime-python/src/index.ts:45`](../packages/experimental/ptc-runtime-python/src/index.ts)

```ts config-catalog
/** Plugin config: every cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /**
   * RLIMIT_CPU in whole seconds (a positive integer — `setrlimit` in the child
   * rejects a float). The child sets the soft limit to `cpuSeconds` and the
   * hard limit to `cpuSeconds + 1`: the kernel delivers SIGXCPU at the soft
   * limit, which the host classifies as a `timeout`; the +1s hard limit is a
   * SIGKILL backstop for a program that traps SIGXCPU. Granularity is whole seconds.
   */
  cpuSeconds?: number
  /** Wall-clock ceiling in milliseconds; backstops CPU time for programs awaiting a promise nobody resolves. */
  maxWallMs?: number
  /**
   * RLIMIT_AS in mebibytes; caps address space so a runaway allocation fails
   * cleanly. Not applied on Darwin, where the dyld shared cache mapped into
   * every process at exec exceeds any practical cap and the kernel rejects
   * the call; `cpuSeconds` and `maxWallMs` still bound the run there. Bounds
   * `maxLogBytes`/`maxValueBytes` at load on EVERY platform (this static check
   * runs on Darwin too, where only the runtime `setrlimit` is skipped): each
   * budget times a worst-case Unicode expansion must fit this byte count minus a
   * fixed interpreter baseline, so a near-budget output cannot breach the address
   * space during the child's build-and-encode.
   */
  addressSpaceMb?: number
  /**
   * Shared byte budget for captured log text (host-side ledger). Bounded at load
   * against `addressSpaceMb`: the child builds and encodes a near-budget entry
   * under RLIMIT_AS with several copies live at once, so this cap times the
   * worst-case Unicode expansion must fit the address space left after the
   * interpreter baseline (see `addressSpaceMb`) — a load-time rejection, not a
   * runtime clamp. Also bounded at load by the host's configured heap like
   * `maxValueBytes` (see its JSDoc): the effective frame cap minus the frame
   * envelope.
   */
  maxLogBytes?: number
  /**
   * Byte cap for the completion value. Bounded at load against `addressSpaceMb`
   * the same way `maxLogBytes` is: the child builds and encodes a near-budget
   * value under RLIMIT_AS with several copies live at once, so this cap times the
   * worst-case Unicode expansion must fit the address space left after the
   * interpreter baseline. Both budgets are ALSO bounded at load by the host's
   * configured heap: the effective frame cap (the protocol cap, or a lower
   * heap-derived ceiling when the host heap cannot safely parse a near-cap
   * frame — see `hostFrameParseCeiling`) minus the frame envelope, so a budget
   * whose honest frame could OOM the host's own JSON.parse is rejected up
   * front.
   */
  maxValueBytes?: number
  /** SIGTERM→SIGKILL grace period on kill, matching bash-local's default. */
  graceMs?: number
  /**
   * Absolute path, relative path, or basename of a CPython 3.10+ interpreter.
   * Resolved and validated once at plugin load under a five-second force-kill
   * deadline; a basename searches `PATH`.
   */
  pythonBin?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-ptc-runtime-python -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-speech-to-text -->
<a id="deepseek-aidsh-experimental-speech-to-text"></a>

## `@deepseek-ai/dsh-experimental-speech-to-text`

- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/experimental/speech-to-text/src/index.ts:20`](../packages/experimental/speech-to-text/src/index.ts)

```ts config-catalog
/** Live selection read before a transcription starts; `configure()` writes it through the profile. */
export interface Config {
  /** Registered provider selected when the caller omits an id. */
  defaultProvider: Volatile<string>
  /** Provider language hint selected when the caller omits one. */
  language: Volatile<string>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-speech-to-text -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-speech-to-text-sensevoice -->
<a id="deepseek-aidsh-experimental-speech-to-text-sensevoice"></a>

## `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`

- `inject`: `speechToText` · `subprocess`
- `source`: [`packages/experimental/speech-to-text-sensevoice/src/config.ts:6`](../packages/experimental/speech-to-text-sensevoice/src/config.ts)

```ts config-catalog
/** Local runtime, inference, and retention settings. */
export interface Config {
  /** Unique registration id; consumers select this exact id. */
  providerId: string
  /** Absolute directory for verified ONNX models. */
  dataRoot: string
  /** Existing directory containing the selected ONNX model and tokens.txt; omission downloads verified files. */
  modelDirectory?: string | undefined
  /** Existing Silero VAD ONNX file; omission downloads the verified model. */
  vadModelPath?: string | undefined
  /** Weight precision; INT8 minimizes first-use download and model storage. */
  precision: 'int8' | 'fp32'
  /** Explicit Hugging Face-compatible origin; bypasses automatic selection and public fallback. */
  modelOrigin?: string | undefined
  /** Hugging Face-compatible origins compared before downloading each missing asset. */
  modelOrigins: string[]
  /** Deadline for concurrent HEAD probes, including redirects to the actual asset. */
  modelProbeTimeoutMs: number
  /** CPU intra-operation thread count. */
  threads: number
  /** Maximum speech segment length passed to the recognizer. */
  segmentSeconds: number
  /** Silero speech probability threshold. */
  vadThreshold: number
  /** Minimum speech duration retained by VAD. */
  minSpeechSeconds: number
  /** Silence separating two speech segments. */
  minSilenceSeconds: number
  /** Recording audio restored ahead of the first VAD segment, which cold start reports late; zero disables it. */
  vadOnsetPaddingSeconds: number
  /** Maximum decoded WAV bytes accepted by the private worker. */
  maxAudioBytes: number
  /** Deadline for runtime preparation and cold model loading. */
  prepareTimeoutMs: number
  /** Deadline for one inference after the worker is ready. */
  inferenceTimeoutMs: number
  /** Idle period before stopping the worker; zero keeps it warm. */
  idleTimeoutMs: number
  /** Maximum accepted running and waiting transcriptions. */
  maxPending: number
  /** Managed process termination grace period. */
  graceMs: number
  /** Maximum retained worker diagnostic bytes. */
  maxLogBytes: number
  /** Maximum transcript response bytes. */
  maxResponseBytes: number
  /** Minimum interval between intermediate download progress notifications. */
  progressIntervalMs: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-speech-to-text-sensevoice -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-subagent-oar -->
<a id="deepseek-aidsh-experimental-subagent-oar"></a>

## `@deepseek-ai/dsh-experimental-subagent-oar`

- `inject`: `subagents`
- `source`: [`packages/experimental/subagent-oar/src/index.ts:25`](../packages/experimental/subagent-oar/src/index.ts)

```ts config-catalog
/** Native runtime selection and deployment settings for one provider instance. */
export interface Config {
  /** OAR default-runtime id; unknown ids fail during plugin activation. */
  runtime: string
  /** Name registered on ctx.subagents (default oar). */
  providerName?: string
  /** Native model id; omission preserves the runtime's model selection. */
  model?: string
  /** Native reasoning effort; unsupported choices fail during startup. */
  effort?: string
  /** Explicit entries applied after ambient credential scrubbing; null removes a value. */
  env?: Record<string, string | null>
  /** Native launch arguments, including permission settings; omission uses OAR defaults. */
  launchArgs?: string[]
  /** Optional turn deadline in milliseconds after startup; omission uses parent cancellation only. */
  timeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-subagent-oar -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-tool-agent-team -->
<a id="deepseek-aidsh-experimental-tool-agent-team"></a>

## `@deepseek-ai/dsh-experimental-tool-agent-team`

- `inject`: `agents` · `agentTeams` · `tools` · `systemPrompt`
- `source`: [`packages/experimental/tool-agent-team/src/index.ts:17`](../packages/experimental/tool-agent-team/src/index.ts)

```ts config-catalog
/** Tool routing configuration. */
export interface Config {
  /** Register `interrupt_agent` and its policy guidance. Defaults to true; false leaves the domain API available. */
  readonly interrupt?: boolean
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-tool-agent-team -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-tool-subagent-oar -->
<a id="deepseek-aidsh-experimental-tool-subagent-oar"></a>

## `@deepseek-ai/dsh-experimental-tool-subagent-oar`

- `inject`: `tools` · `subagents`
- `source`: [`packages/experimental/tool-subagent-oar/src/index.ts:12`](../packages/experimental/tool-subagent-oar/src/index.ts)

```ts config-catalog
/** Deployment-owned runtime choices exposed by the external delegation tool. */
export interface Config {
  /** Model-visible runtime aliases mapped to registered subagent provider names. */
  providers: Record<string, string>
  /** Model-facing tool name (default subagent_oar). */
  toolName?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-tool-subagent-oar -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-translator -->
<a id="deepseek-aidsh-experimental-translator"></a>

## `@deepseek-ai/dsh-experimental-translator`

- `source`: [`packages/experimental/translator/src/index.ts:25`](../packages/experimental/translator/src/index.ts)

```ts config-catalog
/** Routing and bounds for anonymous requests and independent native model translation. */
export interface Config {
  /** Provider selected when a consumer omits it. */
  provider: TranslationProvider
  /** Google-compatible anonymous translation endpoint. */
  googleEndpoint: string
  /** Bing-compatible Microsoft Edge browser translation endpoint. */
  bingEndpoint: string
  /** Deadline covering the request and complete response body, in milliseconds. */
  timeoutMs: number
  /** Maximum UTF-16 code units per request; at least two to admit one supplementary-plane character. */
  maxTextChars: number
  /** Maximum anonymous JSON-body bytes or paid assembled UTF-8 translation bytes. */
  maxResponseBytes: number
  /** Deadline for native admission and complete translation output, in milliseconds. */
  deepseekTimeoutMs: number
  /** Requested output-token cap for independent native Flash translation. */
  deepseekMaxOutputTokens: number
}

/** Explicit anonymous endpoint or native paid model route. */
export type TranslationProvider = AnonymousTranslationProvider | PaidTranslationProvider

/** Anonymous browser endpoint selected for one translation. */
export type AnonymousTranslationProvider = 'google' | 'bing'

/** Explicit native DeepSeek credential route selected for paid translation. */
export type PaidTranslationProvider = 'deepseek-account' | 'deepseek-official'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-translator -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-experimental-worktree -->
<a id="deepseek-aidsh-experimental-worktree"></a>

## `@deepseek-ai/dsh-experimental-worktree`

- `inject`: `workingDirectory` · `fs` · `subprocess` · `sandbox` · `sandboxPolicy`
- `source`: [`packages/experimental/worktree/src/index.ts:21`](../packages/experimental/worktree/src/index.ts)

```ts config-catalog
/** Worktree location, generated names, executables, and subprocess resource limits. */
export interface Config {
  /** Relative checkout pool inside the source repository. */
  directory?: string
  /** Prefix for automatically generated branch and checkout names. */
  namePrefix?: string
  /** Executable name or absolute execution-world path of a Git release that honors `GIT_NO_LAZY_FETCH`. */
  gitCommand?: string
  /** Node executable used for sandboxed directory allocation. */
  nodeCommand?: string
  /** Deadline in milliseconds for one command. */
  timeoutMs?: number
  /** Subprocess termination grace in milliseconds. */
  graceMs?: number
  /** Maximum captured bytes per subprocess output stream. */
  maxOutputBytes?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-experimental-worktree -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-file-reference-local -->
<a id="deepseek-aidsh-file-reference-local"></a>

## `@deepseek-ai/dsh-file-reference-local`

- `inject`: `agents` · `workingDirectory`
- `source`: [`packages/context/file-reference-local/src/index.ts:35`](../packages/context/file-reference-local/src/index.ts)

```ts config-catalog
/** Local file-reference discovery configuration. */
export interface Config {
  /** Maximum ranked candidates returned for one query. */
  maxResults?: number
  /** Maximum indexed files and directories per agent workspace. */
  maxEntries?: number
  /** Directory basenames never traversed or offered. */
  excludedDirectories?: string[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-file-reference-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-fs-local -->
<a id="deepseek-aidsh-fs-local"></a>

## `@deepseek-ai/dsh-fs-local`

- `source`: [`packages/fs/fs-local/src/index.ts:46`](../packages/fs/fs-local/src/index.ts)

```ts config-catalog
/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-fs-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-fs-sandbox -->
<a id="deepseek-aidsh-fs-sandbox"></a>

## `@deepseek-ai/dsh-fs-sandbox`

- `inject`: `sandboxPolicy`
- `refs`: [`LocalConfig`](#deepseek-aidsh-fs-local)
- `source`: [`packages/fs/fs-sandbox/src/index.ts:45`](../packages/fs/fs-sandbox/src/index.ts)

```ts config-catalog
/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound). The sandbox default
 * (mode + `workspace-write` fallback root) is NOT here — `ctx.sandboxPolicy`
 * resolves each calling session for every enforcing capability.
 */
export type Config = LocalConfig
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-fs-sandbox -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-goal -->
<a id="deepseek-aidsh-goal"></a>

## `@deepseek-ai/dsh-goal`

- `inject`: `agents` · `sessionProjections`
- `source`: [`packages/goal/goal/src/index.ts:168`](../packages/goal/goal/src/index.ts)

```ts config-catalog
/** Deployment defaults for goal creation. */
export interface Config {
  /** Total rounds used when a create request omits its own cap. */
  defaultMaxGoalRounds?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-goal -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-headless -->
<a id="deepseek-aidsh-headless"></a>

## `@deepseek-ai/dsh-headless`

- `inject`: `agentDefaultModel` · `agents` · `sessions`
- `refs`: [`ApprovalPolicy`](subsystems/approval.zh.md)
- `source`: [`packages/bundle/headless/src/index.ts:48`](../packages/bundle/headless/src/index.ts)

```ts config-catalog
/** Plugin config: the task and run options resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run; absent when the task arrives on stdin. */
  task?: string
  /** Exact Session identity to adopt; absent for a fresh random identity. An id with no stored Session fails. */
  sessionId?: string
  /** Whether stdout carries the machine-readable event stream instead of final text. */
  json?: boolean
  /** Permission preset applied before the task; an explicit CLI flag takes precedence. Omission keeps current policy. */
  permissionMode?: string
  /** Approval behavior applied after preset selection; an explicit CLI flag takes precedence. Omission keeps current policy. */
  approvalPolicy?: ApprovalPolicy
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-headless -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-hmr -->
<a id="deepseek-aidsh-hmr"></a>

## `@deepseek-ai/dsh-hmr`

- `refs`: `ChokidarOptions` (`chokidar`)
- `source`: [`packages/boot/hmr/src/index.ts:56`](../packages/boot/hmr/src/index.ts)

```ts config-catalog
/** Module roots and watcher timing, with Chokidar deployment options. */
export interface HmrConfig extends ChokidarOptions {
  /** Directory resolved against the owning context's base URL. */
  base?: string
  /** Module watch roots; an empty list leaves only explicit configuration watches. */
  root: string[]
  /** Milliseconds for combining module changes. */
  debounce: number
  /** Glob patterns excluded from module watching. */
  ignored: string[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-hmr -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-hooks-claude-code -->
<a id="deepseek-aidsh-hooks-claude-code"></a>

## `@deepseek-ai/dsh-hooks-claude-code`

- `inject`: `shell` · `agents` · `workingDirectory`
- `source`: [`packages/experimental/hooks-claude-code/src/index.ts:50`](../packages/experimental/hooks-claude-code/src/index.ts)

```ts config-catalog
/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process.
   * TODO(per-session-hook-config): per-session discovery of a project-local
   * `hooks.json` from each `session/new.cwd`.
   */
  configPath: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's current directory (the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-hooks-claude-code -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-hooks-codex -->
<a id="deepseek-aidsh-hooks-codex"></a>

## `@deepseek-ai/dsh-hooks-codex`

- `inject`: `shell` · `agents` · `workingDirectory`
- `source`: [`packages/experimental/hooks-codex/src/index.ts:49`](../packages/experimental/hooks-codex/src/index.ts)

```ts config-catalog
/** Plugin config: where the Codex hooks.json lives + the model name for payloads. */
export interface Config {
  /**
   * Path to a Codex `hooks.json`. Process-level: read once at load, a relative
   * path resolves against the process launch cwd.
   * TODO(per-session-hook-config): per-session project-local discovery from each
   * `session/new.cwd`.
   */
  configPath: string
  /** The model name stamped on every payload (Codex includes `model` on each event). */
  model?: string
  /** Default per-hook timeout in ms when a hook sets none (Codex default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-hooks-codex -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-host-directory-picker-browse -->
<a id="deepseek-aidsh-host-directory-picker-browse"></a>

## `@deepseek-ai/dsh-host-directory-picker-browse`

- `source`: [`packages/host/directory-picker-browse/src/index.ts:181`](../packages/host/directory-picker-browse/src/index.ts)

```ts config-catalog
/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-host-directory-picker-browse -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-host-frontend-static -->
<a id="deepseek-aidsh-host-frontend-static"></a>

## `@deepseek-ai/dsh-host-frontend-static`

- `inject`: `webServer` · `connection`
- `source`: [`packages/host/frontend-static/src/index.ts:34`](../packages/host/frontend-static/src/index.ts)

```ts config-catalog
/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-host-frontend-static -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-host-open-in-app -->
<a id="deepseek-aidsh-host-open-in-app"></a>

## `@deepseek-ai/dsh-host-open-in-app`

- `inject`: `webServer` · `connection` · `subprocess`
- `source`: [`packages/host/open-in-app/src/index.ts:50`](../packages/host/open-in-app/src/index.ts)

```ts config-catalog
/** Open-in-app host configuration. */
export interface Config {
  /**
   * Per-command deadline in milliseconds for catalog-resolution host
   * commands (`xcode-select`, the Windows registry reads).
   */
  readonly probeTimeoutMs: number
  /**
   * Per-command deadline in milliseconds for icon-extraction host commands
   * (`plutil`/`sips` on macOS, the PowerShell extraction on Windows).
   */
  readonly iconTimeoutMs: number
  /**
   * Early-failure watch window per launch, in milliseconds: a launcher still
   * running when the window closes counts as launched and keeps running, so
   * this bounds how long the open route holds a successful launch, not how
   * long an application may live.
   */
  readonly launchWatchMs: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-host-open-in-app -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-host-product-telemetry-otel -->
<a id="deepseek-aidsh-host-product-telemetry-otel"></a>

## `@deepseek-ai/dsh-host-product-telemetry-otel`

- `inject`: `otel`
- `source`: [`packages/host/product-telemetry-otel/src/index.ts:18`](../packages/host/product-telemetry-otel/src/index.ts)

```ts config-catalog
/** Collector routing, application identity, and bounded in-memory batch settings. */
export interface Config {
  /** Full HTTP(S) logs URL. */
  endpoint: string
  /** Collector routing header. */
  channel: string
  /** Resource service.name supplied by the application composition. */
  serviceName: string
  /** Resource service.version supplied by the application composition. */
  serviceVersion: string
  /** Omit to honor OTEL_EXPORTER_OTLP_LOGS_COMPRESSION / OTEL_EXPORTER_OTLP_COMPRESSION. */
  compression?: 'none' | 'gzip'
  /** Maximum records per export; must not exceed maxQueueSize. */
  maxExportBatchSize: number
  /** Maximum queued records; the SDK drops new records when full. */
  maxQueueSize: number
  /** Delay before exporting a partial batch. */
  scheduledDelayMillis: number
  /** Exporter HTTP deadline, including SDK transient-error retries. */
  timeoutMillis: number
  /** Processor deadline for one batch export. */
  exportTimeoutMillis: number
  /** Drain deadline; expiry cancels pending exports before disposal completes. */
  shutdownTimeoutMillis: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-host-product-telemetry-otel -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-host-webserver -->
<a id="deepseek-aidsh-host-webserver"></a>

## `@deepseek-ai/dsh-host-webserver`

- `source`: [`packages/host/webserver/src/index.ts:97`](../packages/host/webserver/src/index.ts)

```ts config-catalog
/** Web server listen, TLS, and response-compression config. */
export interface Config {
  /**
   * Listen address: a concrete IPv4 or IPv6 literal of one local interface,
   * for example the container's own Pod address from `hostname -i`. A loopback
   * literal (any address in 127/8, `::1`, or a mapped form of either) keeps the
   * server on this machine; any other literal serves the network that address
   * belongs to, over plain HTTP unless `tls` is set. The unspecified address —
   * IPv4 any, IPv6 any, and the IPv4-mapped forms of IPv4 any — is rejected at
   * load: it would expose the port on every interface at once.
   */
  host: string
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Serve HTTPS with this certificate and key instead of plain HTTP. Both files
   * are read once, before the listener binds: an unreadable or empty file,
   * invalid PEM, or a key that does not match the certificate rejects
   * initialization rather than falling back to HTTP. The material is never
   * re-read, so replacing a certificate takes a reload. Omitted or null listens
   * over plain HTTP.
   */
  tls?: TlsConfig
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}

/**
 * TLS material for the HTTPS listener: one certificate chain file and the
 * private key file it pairs with. Both hold PEM text and both resolve against
 * the process working directory.
 */
export interface TlsConfig {
  /** Certificate chain file, leaf certificate first, PEM, no passphrase. */
  certFile: string
  /** Private key file for the chain's leaf certificate; unencrypted PEM. */
  keyFile: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-host-webserver -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-jobs-local -->
<a id="deepseek-aidsh-jobs-local"></a>

## `@deepseek-ai/dsh-jobs-local`

- `source`: [`packages/jobs/jobs-local/src/index.ts:46`](../packages/jobs/jobs-local/src/index.ts)

```ts config-catalog
/** Configuration for the process-local job registry. */
export interface Config {
  /**
   * Maximum `running` plus `stopping` jobs per exact owner or in the shared unowned bucket;
   * omission defaults to 10.
   */
  maxConcurrentJobsPerOwner?: number
  /** Live ring retention per job in UTF-8 bytes; omission defaults to 262144. */
  retainBytes?: number
  /**
   * Ring retention kept after a job settles, in UTF-8 bytes; omission defaults to 16384.
   * Settlement keeps every byte the model cursor has not consumed on top of
   * this cap; the first terminal model read then trims to it.
   */
  settledRetainBytes?: number
  /** Poll interval for a job's pull sources, in milliseconds; omission defaults to 150. */
  pumpPollMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-jobs-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-llm-deepseek-account -->
<a id="deepseek-aidsh-llm-deepseek-account"></a>

## `@deepseek-ai/dsh-llm-deepseek-account`

- `inject`: `llm`
- `refs`: [`ModelListingConfig`](../packages/llm/llm-deepseek/src/index.ts) · [`ModelOverride`](../packages/llm/llm-deepseek/src/index.ts) · [`ProtocolConfig`](../packages/llm/llm-deepseek/src/index.ts) · `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/llm/llm-deepseek-account/src/config.ts:15`](../packages/llm/llm-deepseek-account/src/config.ts)

```ts config-catalog
/** Account route configuration; authentication comes exclusively from the account service. */
export interface Config extends Omit<ProtocolConfig, 'models'>, ModelListingConfig {
  /** Field overrides by model id, layered over the account listing and the built-in catalog. */
  modelOverrides: Volatile<Record<string, ModelOverride>>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-llm-deepseek-account -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-llm-deepseek-api-key -->
<a id="deepseek-aidsh-llm-deepseek-api-key"></a>

## `@deepseek-ai/dsh-llm-deepseek-api-key`

- `inject`: `llm`
- `refs`: [`ModelListingConfig`](../packages/llm/llm-deepseek/src/index.ts) · [`ProtocolConfig`](../packages/llm/llm-deepseek/src/index.ts) · `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/llm/llm-deepseek-api-key/src/config.ts:18`](../packages/llm/llm-deepseek-api-key/src/config.ts)

```ts config-catalog
/** Messages configuration with a per-request API-key reference. */
export interface Config extends ProtocolConfig, ModelListingConfig {
  /** Credential reference resolved per request; defaults to DEEPSEEK_API_KEY. */
  apiKeyEnv: Volatile<string>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-llm-deepseek-api-key -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-llm-pi-ai -->
<a id="deepseek-aidsh-llm-pi-ai"></a>

## `@deepseek-ai/dsh-llm-pi-ai`

- `inject`: `llm`
- `refs`: `Api` (`@earendil-works/pi-ai`) · `CacheRetention` (`@earendil-works/pi-ai`) · `Model` (`@earendil-works/pi-ai`) · `ModelThinkingLevel` (`@earendil-works/pi-ai`) · `OpenAICompletionsCompat` (`@earendil-works/pi-ai`) · [`RetryPolicyConfig`](../packages/llm/llm/src/index.ts) · `ThinkingBudgets` (`@earendil-works/pi-ai`) · `Transport` (`@earendil-works/pi-ai`) · `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/llm/llm-pi-ai/src/config.ts:222`](../packages/llm/llm-pi-ai/src/config.ts)

```ts config-catalog
/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /**
   * pi-ai provider routes, keyed by provider. An empty (or omitted) dict is
   * the dormant settings-driven posture: the adapter mounts with no routes
   * and registers them the moment a settings section supplies profiles.
   */
  providers: Volatile<Record<string, PiAiProviderProfile>>
}

/** Configuration for one pi-ai provider route; the `providers` dict key IS the route. */
export interface PiAiProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string
  /**
   * Wire protocol every model on this route speaks. Omission keeps each
   * installed catalog model's own protocol, which is why a catalog route needs
   * no protocol at all; a route the catalog does not ship must name one.
   */
  api?: string
  /** Endpoint for this route's models; defaults to the installed catalog's endpoint. */
  baseURL?: string
  /**
   * This route's model catalog. Omission serves the installed catalog for the
   * route unchanged; an explicit list replaces it, each entry defaulting its
   * unset fields from the installed model of the same id.
   */
  models?: PiAiModelProfile[]
  /**
   * Installed-catalog customizations by model id: each entry reshapes that
   * one model with the same fields a {@link models} entry takes, while the
   * rest of the catalog keeps serving untouched. Only meaningful on a catalog
   * route with no `models` list — `models` already replaces the catalog, so
   * an override beside it, on a route the catalog does not ship, or naming a
   * model the catalog does not describe is refused rather than skipped.
   */
  modelOverrides?: Record<string, PiAiModelOverride>
  /**
   * pi-ai wire-compatibility switches defaulting every model on this route
   * whose protocol declares them; each model's own `compat` overrides per
   * field. What neither sets keeps the installed catalog entry's value, then
   * pi-ai's own detection. A switch no model on the route could read is
   * refused rather than left looking applied.
   */
  compat?: PiAiCompatProfile
  /**
   * Context capacity for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 1,000,000). A guess by construction, so
   * a deployment whose gateway serves smaller models corrects it here.
   */
  defaultContextWindow?: number
  /**
   * Output capability for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 128,000). This sizes the model; it
   * never becomes a per-request cap on its own.
   */
  defaultMaxTokens?: number
  /**
   * Request modalities for a model this route lists that neither its entry's
   * {@link PiAiModelProfile.input} nor the installed catalog declares (default
   * `[text]`). A fallback like the capacities above, not an override: a
   * catalog model keeps the modalities the catalog records for it, and this
   * value never narrows one. A gateway serving vision models the catalog does
   * not describe declares `[text, image]` once here instead of on every entry.
   * Unlike an entry's list, this one may not be empty — nothing sits below it
   * to answer instead.
   */
  defaultInput?: PiAiModality[]
  /** Provider request headers, validated against Fetch when the profile resolves; Harness attribution wins reserved names. */
  headers?: Record<string, string>
  /** Provider-neutral pi-ai reasoning level. */
  reasoning?: ModelThinkingLevel
  /** Token budgets used by reasoning providers that support them. */
  thinkingBudgets?: ThinkingBudgets
  /** Prompt-cache retention preference. */
  cacheRetention?: CacheRetention
  /** Streaming transport preference. */
  transport?: Transport
  /** HTTP/provider SDK timeout in milliseconds. */
  timeoutMs?: number
  /** WebSocket connection timeout in milliseconds. */
  websocketConnectTimeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /**
   * Maximum base64-encoded image payload per request. When a request's
   * accumulated images exceed it, the oldest images are replaced by text
   * placeholders until the request fits, so a long session keeps completing
   * requests instead of being rejected by a request-size cap.
   */
  maxRequestImageBytes?: number
  /** Total-pixel budget for each deterministic inline request version. */
  requestImagePixelBudget?: number
  /**
   * Raw encoded-byte target for each deterministic inline request version;
   * the smallest quality-ladder output is used when no quality fits.
   */
  requestImageMaxBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

/** One configured model entry: an id plus the catalog fields it overrides. */
export interface PiAiModelProfile {
  /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
  id: string
  /** Display name for selectors; defaults to the catalog name, then the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /**
   * Maximum output tokens. Configuring one also makes it this model's
   * per-request default; a value inherited from the installed catalog, or the
   * route's fallback, is the model's capability and never becomes a request
   * default on its own.
   */
  maxTokens?: number
  /**
   * Request modalities this model accepts. Absent — or empty, which describes
   * a model that accepts nothing and so states no answer either — keeps the
   * installed catalog entry's modalities, then the route's `defaultInput`.
   * Declaring images is what makes a hand-declared vision model usable, and
   * declaring text alone corrects a catalog model whose gateway does not serve
   * what the catalog records. This is a claim about the endpoint, not a check
   * of it: nothing interrogates a gateway for what it accepts, so a model
   * claiming images its endpoint refuses is refused by the provider instead,
   * mid-turn.
   */
  input?: PiAiModality[]
  /**
   * Selectable reasoning efforts. Absent inherits the installed catalog
   * entry's capability (a hand-declared model has none and does not reason);
   * `false` declares a non-reasoning model, which is how a profile strips
   * reasoning from a catalog model its gateway cannot serve; a non-empty dict
   * declares the offered levels and their wire spellings.
   */
  reasoningEfforts?: false | PiAiReasoningEfforts
  /** pi-ai wire-compatibility switches for this model, winning over the route's per field; one its protocol does not declare is refused. */
  compat?: PiAiCompatProfile
}

/**
 * Customization of one installed catalog model, keyed by its id in the
 * route's `modelOverrides` dict — the same fields a `models` entry may set,
 * with the id living in the key. Unlike a `models` list, overrides leave the
 * rest of the catalog serving untouched, which is what makes "correct one
 * model, keep the other thirty-seven" a three-line edit.
 */
export type PiAiModelOverride = Omit<PiAiModelProfile, 'id'>

/**
 * pi-ai wire-compatibility switches, set on the route (its models' default) or
 * per model (winning over the route, field by field).
 *
 * pi-ai decides each of these from the provider id and baseURL when no layer
 * sets it, and a private gateway's URL says nothing: for an endpoint it does
 * not recognize the detection answers as though it were OpenAI itself, which
 * is wrong for most OpenAI-compatible gateways. So every field here is one a
 * deployment must be able to state because nothing can infer it, while the
 * fields pi-ai's catalog sets for a named vendor stay withheld.
 *
 * A field belongs to the protocols whose upstream compat type declares it: a
 * model-level switch its protocol does not take fails resolution, and a
 * route-level one skips past models it cannot fit. "The three Responses
 * protocols" below means `openai-responses`, `azure-openai-responses`, and
 * `openai-codex-responses`, which pi-ai gives one shared compat type, so a
 * switch settable on one is settable on all three.
 */
export interface PiAiCompatProfile {
  /** Whether the endpoint accepts `store`; `openai-completions`. */
  supportsStore?: boolean
  /**
   * Whether the endpoint accepts the `developer` role for the system prompt,
   * which pi-ai sends only to a reasoning model; `false` keeps `system`.
   * `openai-completions` and the three Responses protocols.
   */
  supportsDeveloperRole?: boolean
  /** Whether the endpoint accepts `reasoning_effort`; `openai-completions`. */
  supportsReasoningEffort?: boolean
  /** Whether the endpoint accepts `stream_options: {include_usage: true}`; `openai-completions`. */
  supportsUsageInStreaming?: boolean
  /**
   * Whether streams include `finish_reason`; `false` lets pi-ai infer the
   * terminal reason when the stream ends; `openai-completions`.
   */
  supportsFinishReason?: boolean
  /** Which output-cap field the endpoint reads; `openai-completions`. */
  maxTokensField?: NonNullable<OpenAICompletionsCompat['maxTokensField']>
  /** Whether tool results must carry `name`; `openai-completions`. */
  requiresToolResultName?: boolean
  /** Whether a user message after tool results needs an assistant message between; `openai-completions`. */
  requiresAssistantAfterToolResult?: boolean
  /** Whether thinking blocks must travel as text in `<thinking>` delimiters; `openai-completions`. */
  requiresThinkingAsText?: boolean
  /** Whether replayed assistant messages need an empty `reasoning_content` while reasoning is on; `openai-completions`. */
  requiresReasoningContentOnAssistantMessages?: boolean
  /** Reasoning parameter format the endpoint expects; `openai-completions`. */
  thinkingFormat?: PiAiThinkingFormat
  /**
   * Kwargs sent as `chat_template_kwargs`, which pi-ai reads only under the
   * two `chat-template` thinking formats; `openai-completions`. Nothing checks
   * that pairing: the format in force may come from the installed catalog
   * entry or from pi-ai's own baseURL detection, neither of which resolution
   * can read, so kwargs set beside another format are sent nowhere.
   */
  chatTemplateKwargs?: NonNullable<OpenAICompletionsCompat['chatTemplateKwargs']>
  /** Arguments sent as `chat_template_args` under the `baseten` thinking format; `openai-completions`. */
  chatTemplateArgs?: NonNullable<OpenAICompletionsCompat['chatTemplateArgs']>
  /** Alias for `thinkingTokenBudgetField: "thinking_token_budget"`; an explicit field wins. `openai-completions`. */
  supportsThinkingTokenBudget?: boolean
  /** Request field carrying the reasoning budget from `thinkingBudgets`; omitted unless configured. `openai-completions`. */
  thinkingTokenBudgetField?: PiAiThinkingTokenBudgetField
  /** vLLM scheduler `priority`; lower runs earlier, and the server must enable priority scheduling. Omitted unless configured. */
  vllmPriority?: number
  /** Whether `openai-responses` accepts `max_output_tokens`; `false` omits it. Azure and Codex ignore this shared compat field. */
  supportsMaxOutputTokens?: boolean
  /**
   * Whether the endpoint accepts `strict` in tool definitions;
   * `openai-completions`, the three Responses protocols, `bedrock-converse-stream`.
   */
  supportsStrictMode?: boolean
  /** Prompt-cache marker convention; `openai-completions`. */
  cacheControlFormat?: NonNullable<OpenAICompletionsCompat['cacheControlFormat']>
  /**
   * Whether the endpoint accepts long prompt-cache retention;
   * `openai-completions`, the three Responses protocols, `anthropic-messages`.
   */
  supportsLongCacheRetention?: boolean
  /** Whether the endpoint accepts per-tool `eager_input_streaming`; `anthropic-messages`. */
  supportsEagerToolInputStreaming?: boolean
  /** Whether the endpoint accepts `cache_control` on tool definitions; `anthropic-messages`. */
  supportsCacheControlOnTools?: boolean
  /** Whether the endpoint accepts the `temperature` request field; `anthropic-messages`. */
  supportsTemperature?: boolean
  /** Whether to force adaptive thinking regardless of model id; `anthropic-messages`. */
  forceAdaptiveThinking?: boolean
  /** Whether to replay an empty thinking signature instead of converting thinking to text; `anthropic-messages`. */
  allowEmptySignature?: boolean
  /** Whether the endpoint accepts Anthropic strict tool schemas; `anthropic-messages`. */
  supportsStrictTools?: boolean
}

/** One request modality a pi-ai model may accept. */
export type PiAiModality = Model<Api>['input'][number]

/**
 * Selectable reasoning efforts for one model: each key is a level the model
 * offers (and selectors show), and its value is the wire spelling dispatch
 * sends for it. `off` alone may leave its value empty — "supported, send
 * nothing" — because for most providers not thinking is the parameter's
 * absence; every other declared level must name a wire value. A level absent
 * from the dict is not offered.
 */
export type PiAiReasoningEfforts = Partial<Record<ModelThinkingLevel, string | null>>

/** One reasoning-dispatch wire format a profile may name. */
export type PiAiThinkingFormat = NonNullable<OpenAICompletionsCompat['thinkingFormat']>

/** The reasoning-budget field spellings pi-ai accepts. */
export type PiAiThinkingTokenBudgetField = NonNullable<OpenAICompletionsCompat['thinkingTokenBudgetField']>
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-llm-pi-ai -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-llm-replay -->
<a id="deepseek-aidsh-llm-replay"></a>

## `@deepseek-ai/dsh-llm-replay`

- `inject`: `llm`
- `refs`: [`LlmModelBadge`](../packages/llm/llm/src/index.ts) · [`ModelModality`](../packages/llm/llm/src/index.ts) · [`RetryPolicyConfig`](../packages/llm/llm/src/index.ts) · [`SystemPromptUpdate`](../packages/llm/llm/src/index.ts) · [`ToolUpdate`](../packages/llm/llm/src/index.ts)
- `source`: [`packages/test-support/llm-replay/src/index.ts:1135`](../packages/test-support/llm-replay/src/index.ts)

```ts config-catalog
/** Plugin config: the {@link ReplayConfig} inputs, each defaulting to its `DSH_SNAPSHOT_*` env var in `apply`. */
export interface Config {
  /** Override the fixture path; defaults to `$DSH_SNAPSHOT_FILE`. */
  file?: string
  /** Override the sidecar path; defaults to `$DSH_SNAPSHOT_OVERRIDE`. */
  overrideFile?: string
  /**
   * Override the child-log paths; defaults to `$DSH_SNAPSHOT_CHILD_FILES` (a
   * path-separator-delimited list). Each is a recorded subagent session log for
   * a nested-agent scenario; absent/empty for a single-session scenario.
   */
  childFiles?: string[]
  /** Optional replay-only provider catalog; absent or empty selects catch-all waterfall replay. */
  providers?: ReplayProviderConfig[]
  /** Optional per-chunk pacing delay in ms (see {@link ReplayConfig.paceMs}); absent keeps burst yield. */
  paceMs?: number
}

/** One provider route exposed by the replay adapter. */
export interface ReplayProviderConfig {
  /** Provider route used for replay requests. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Advisory models exposed to replay scenarios that exercise discovery. */
  models?: ReplayModelConfig[]
  /** Optional provider-owned retry policy used by assembled recovery snapshots. */
  retryPolicy?: RetryPolicyConfig
}

/** One model exposed by a replay-only provider catalog. */
export interface ReplayModelConfig {
  /** Model id used for replay requests. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector description. */
  description?: string
  /** Optional positive integer context capacity published by the replay adapter. */
  contextWindow?: number
  /** Optional declared input modalities, so a scenario can exercise capability gates (e.g. image-capable `read_image`). */
  inputModalities?: readonly ModelModality[]
  /**
   * Optional per-request output cap the replay route materializes when callers
   * omit one, so replay reconstructs the request header a live catalog produced.
   */
  defaultMaxTokens?: number
  /**
   * Optional flat visual-token price the replay route declares for every
   * retained request image, so keyless scenarios exercise route-priced
   * request pressure; each occurrence is priced at this value plus its
   * request-preview handle text. Requires {@link inputModalities} to include
   * `image` — a text-only route never sends visual tokens. Absent declares
   * no image pricing.
   */
  imageRequestTokens?: number
  /** Optional reasoning-effort ids from least to greatest selectable effort. */
  reasoningEfforts?: string[]
  /**
   * Optional effort materialized when callers omit one; must appear in
   * {@link reasoningEfforts} or call resolution rejects the route.
   */
  defaultReasoningEffort?: string
  /** Optional in-history system prompt replacement for a keyless replay route. */
  systemPromptUpdate?: SystemPromptUpdate
  /** Optional mid-conversation tool declaration mode for a keyless replay route. */
  toolUpdate?: ToolUpdate
  /** Optional selector badge the replay catalog advertises, so keyless Web scenarios render one. */
  badge?: LlmModelBadge
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-llm-replay -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-llm-retry -->
<a id="deepseek-aidsh-llm-retry"></a>

## `@deepseek-ai/dsh-llm-retry`

- `inject`: `agents` · `sessionProjections`
- `source`: [`packages/llm/llm-retry/src/index.ts:25`](../packages/llm/llm-retry/src/index.ts)

```ts config-catalog
/** This policy executor has no config; providers own `retryPolicy`. */
export type Config = Readonly<Record<string, never>>
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-llm-retry -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-lsp-stdio -->
<a id="deepseek-aidsh-lsp-stdio"></a>

## `@deepseek-ai/dsh-lsp-stdio`

- `inject`: `fs` · `lsp` · `subprocess`
- `source`: [`packages/lsp/lsp-stdio/src/index.ts:82`](../packages/lsp/lsp-stdio/src/index.ts)

```ts config-catalog
/** Plugin configuration: provider id → local language-server configuration. */
export interface Config {
  /** Non-empty table of stable provider ids to independent local server configurations. */
  servers: Record<string, LspLocalServerConfig>
}

/** One configured local language server and its host bounds. */
export interface LspLocalServerConfig {
  /** Executable to spawn (absolute, or resolved on PATH at load). */
  command: string
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  extensionToLanguage: Record<string, string>
  /** Arguments passed to the executable (no shell). Default `[]`. */
  args?: string[]
  /** Extra env vars merged on top of the scrubbed ambient env. Default `{}`. */
  env?: Record<string, string>
  /** Static `initialize` options forwarded to the server. Default `null`. */
  initializationOptions?: unknown
  /** Static answer to every `workspace/configuration` item. Default `null`. */
  configuration?: unknown
  /** Largest single framed message accepted from the server (bytes). Default 16000000. */
  maxMessageBytes?: number
  /** Largest stderr tail retained for diagnostics (bytes). Default 1000000. */
  maxStderrBytes?: number
  /** Largest source file this host will open (bytes). Default 4000000. */
  maxDocumentBytes?: number
  /** Graceful `shutdown`/`exit` budget before escalation (ms). Default 5000. */
  shutdownTimeoutMs?: number
  /** Request-cancel and SIGTERM→SIGKILL grace (ms). Default 2000. */
  killGraceMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-lsp-stdio -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-mcp-client -->
<a id="deepseek-aidsh-mcp-client"></a>

## `@deepseek-ai/dsh-mcp-client`

- `inject`: `tools`
- `source`: [`packages/mcp/mcp-client/src/index.ts:104`](../packages/mcp/mcp-client/src/index.ts)

```ts config-catalog
/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-mcp-client -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-message-feedback -->
<a id="deepseek-aidsh-message-feedback"></a>

## `@deepseek-ai/dsh-message-feedback`

- `inject`: `sessionPersistence` · `sessions`
- `source`: [`packages/feedback/message-feedback/src/index.ts:40`](../packages/feedback/message-feedback/src/index.ts)

```ts config-catalog
/** Required deployment policy for optional notes. */
export interface Config {
  /** Maximum UTF-8 byte length accepted for one note. */
  readonly maxNoteBytes: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-message-feedback -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-office-to-pdf -->
<a id="deepseek-aidsh-office-to-pdf"></a>

## `@deepseek-ai/dsh-office-to-pdf`

- `source`: [`packages/document/office-to-pdf/src/index.ts:31`](../packages/document/office-to-pdf/src/index.ts)

```ts config-catalog
/** Provider concurrency and kit rendering/font configuration. */
export interface Config {
  /** Maximum simultaneous conversions; queued callers remain cancellable. */
  maxConcurrentConversions: number
  /** Maximum metadata-only jobs awaiting source admission. */
  maxQueuedJobs: number
  /** Maximum outstanding conversion readers. */
  maxReaders: number
  /** Maximum reserved bytes across admitted source reads and conversions. */
  maxSourceBytes: number
  /** Maximum concurrent background jobs; zero refuses speculative work. */
  maxBackgroundConversions: number
  /** Maximum retained content-addressed PDFs. */
  maxCachedEntries: number
  /** Maximum retained PDF bytes. */
  maxCachedBytes: number
  /** Maximum retained source-version aliases to cached content. */
  maxSourceEntries: number
  /** Conversion deadline in milliseconds; excludes the DSH queue. */
  timeoutMs: number
  /** Maximum authorized source bytes. */
  maxInputBytes: number
  /** Maximum complete PDF bytes. */
  maxOutputBytes: number
  /** Exported raster-image DPI. */
  maxImageResolution: number
  /** Maximum OOXML ZIP entries. */
  maxArchiveEntries: number
  /** Maximum total declared uncompressed OOXML bytes. */
  maxUncompressedBytes: number
  /** Absolute font roots; omission uses the kit's platform defaults. */
  fontDirectories?: string[]
  /** Ordered font-family preference groups; omission retains the kit defaults. */
  fontFallbacks?: string[][]
  /** Maximum physical font files indexed by each converter. */
  maxFontFiles: number
  /** Maximum individual font-file bytes. */
  maxFontFileBytes: number
  /** Maximum original font bytes loaded for a conversion. */
  maxLoadedFontBytes: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-office-to-pdf -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-permission-presets -->
<a id="deepseek-aidsh-permission-presets"></a>

## `@deepseek-ai/dsh-permission-presets`

- `inject`: `shell` · `approval` · `sessions` · `agents` · `sessionProjections`
- `refs`: [`ApprovalPolicy`](subsystems/approval.zh.md) · [`SandboxMode`](subsystems/sandbox.zh.md) · `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/interaction/permission-presets/src/index.ts:153`](../packages/interaction/permission-presets/src/index.ts)

```ts config-catalog
/** The {@link PermissionPresetService} config: preset table and composition default. */
export interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom` and `auto` are reserved for derived state and
   * the Auto review integration respectively.
   */
  presets: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset: Volatile<string | undefined>
}

/** One preset's sandbox/approval bundle and optional client presentation. */
export interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-permission-presets -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-persona -->
<a id="deepseek-aidsh-persona"></a>

## `@deepseek-ai/dsh-persona`

- `inject`: `systemPrompt`
- `source`: [`packages/preset/persona/src/index.ts:30`](../packages/preset/persona/src/index.ts)

```ts config-catalog
/** Plugin config: the persona text this composition contributes. */
export interface Config {
  /**
   * Persona prose rendered as the `deployment:persona-prefix` section. A template:
   * complete `{{…}}` groups interpolate strictly against registered prompt
   * variables. Empty text drops the section at render, matching the registry.
   */
  prefix: string
  /**
   * Persona suffix template rendered after first-party guidance. Omitted or empty
   * text shadows the deployment suffix away; interpolation is strict.
   */
  suffix?: string
  /** Make the prefix the complete system prompt, suppressing the suffix and every other section. */
  complete?: boolean
  /** Suppress dynamic runtime-context snapshots for this persona's agent scope. */
  includeRuntimeContext?: boolean
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-persona -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-plan-mode -->
<a id="deepseek-aidsh-plan-mode"></a>

## `@deepseek-ai/dsh-plan-mode`

- `inject`: `tools` · `systemPrompt` · `sessionProjections` · `agents`
- `source`: [`packages/plan/plan-mode/src/index.ts:67`](../packages/plan/plan-mode/src/index.ts)

```ts config-catalog
/** Deployment-owned plan guidance. */
export interface PlanModeConfig {
  /** Guidance rendered as the `plan:policy` prompt section while plan mode is active. */
  section: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-plan-mode -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-plugin-manager -->
<a id="deepseek-aidsh-plugin-manager"></a>

## `@deepseek-ai/dsh-plugin-manager`

- `inject`: `loader` · `profileContext`
- `refs`: [`NpmFileSource`](subsystems/boot.zh.md)
- `source`: [`packages/boot/plugin-manager/src/index.ts:54`](../packages/boot/plugin-manager/src/index.ts)

```ts config-catalog
/** The pnpm executable, registries, and limits for diagnostics, lookups and connection checks. */
export interface Config {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  pnpmCommand?: string
  /** Maximum retained package-operation diagnostic bytes. */
  outputBytes?: number
  /** Maximum time to wait for another process's profile package operation. */
  lockWaitMs?: number
  /** Bound on one registry lookup an inspection runs, in milliseconds. */
  inspectTimeoutMs?: number
  /** Maximum duration of the GitHub repository connection check before installation, in milliseconds. */
  githubConnectionTimeoutMs?: number
  /** Maximum duration of each HTTP(S) and SSH access probe of a self-hosted Git repository before installation, in milliseconds. */
  gitTransportTimeoutMs?: number
  /** Maximum time one captured package run may print nothing before the manager terminates it, in milliseconds. */
  idleTimeoutMs?: number
  /** The registry lookups and installations ask first, as an http(s) URL; absent, the one pnpm's own configuration names. */
  registry?: string
  /**
   * Registries asked in turn, as http(s) URLs, while the one before is unreachable or holds no copy of the package.
   * A registry outside this set and `registry` is asked alone, and so is the one pnpm's own configuration names
   * unless that is npm's own registry or one of these.
   */
  fallbackRegistries?: string[]
  /** How many of the newest versions above the installed one a version listing reads and returns. */
  versionListLimit?: number
  /** How many single-version registry lookups a version listing runs at once. */
  versionLookupConcurrency?: number
  /** Largest bundle detail document, and largest locale file read for one, in bytes. */
  detailMaxBytes?: number
  /** Largest image served beside a bundle detail document, in bytes. */
  detailImageMaxBytes?: number
  /** Deadline of one npm file CDN request for an offered bundle's detail document. */
  detailFetchTimeoutMs?: number
  /** npm file CDNs that offered bundles are read from, in order; a read's `npmFileSources` moves the CDNs it names first. */
  detailNpmFileSources?: NpmFileSource[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-plugin-manager -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-plugin-market -->
<a id="deepseek-aidsh-plugin-market"></a>

## `@deepseek-ai/dsh-plugin-market`

- `inject`: `pluginManager`
- `refs`: [`NpmFileSource`](subsystems/boot.zh.md) · `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/boot/plugin-market/src/index.ts:43`](../packages/boot/plugin-market/src/index.ts)

```ts config-catalog
/** Index sources and fetch limits. */
export interface Config {
  /** Index URLs in display order; Settings and `setIndexes` write this field without remounting the service. */
  indexes: Volatile<string[]>
  /** Deadline for one index fetch, including the body. */
  fetchTimeoutMs: number
  /** Largest accepted index body in bytes. */
  maxBytes: number
  /** Lifetime of a successfully read index document, a detail read result, and a repository's default-branch commit. */
  cacheTtlMs: number
  /** Largest detail document in bytes. */
  detailMaxBytes: number
  /** Largest image beside a detail document in bytes. */
  detailImageMaxBytes: number
  /** Largest amount in bytes one Git command adds to a partial clone; a repository whose fetch adds more is not read. */
  detailRepositoryMaxBytes: number
  /** Largest total size of the partial clones; least recently used ones are deleted beyond it. */
  detailCacheMaxBytes: number
  /** Directory of the partial clones, relative to the profile directory; absent means `.plugin-market/repositories`. */
  detailCacheDir?: string
  /** Deadline of one Git command of the clone fallback. */
  detailGitTimeoutMs: number
  /** npm file CDNs read in order; a read's `npmFileSources` moves the CDNs it names first. */
  detailNpmFileSources: NpmFileSource[]
  /** Hosts serving the GitLab repository files API. */
  detailGitlabHosts: string[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-plugin-market -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-plugin-package-inventory-deepseek -->
<a id="deepseek-aidsh-plugin-package-inventory-deepseek"></a>

## `@deepseek-ai/dsh-plugin-package-inventory-deepseek`

- `inject`: `agents` · `deepseekLlmApiExtensions` · `loader`
- `source`: [`packages/llm/plugin-package-inventory-deepseek/src/index.ts:32`](../packages/llm/plugin-package-inventory-deepseek/src/index.ts)

```ts config-catalog
/** Plugin-package request contribution configuration. */
export interface Config {
  /** Contribute `dsh_plugin_packages` to official DeepSeek requests. Defaults to `true`. */
  enabled?: boolean
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-plugin-package-inventory-deepseek -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-ptc-runtime-node -->
<a id="deepseek-aidsh-ptc-runtime-node"></a>

## `@deepseek-ai/dsh-ptc-runtime-node`

- `inject`: `fs` · `subprocess` · `sandbox` · `sandboxPolicy`
- `source`: [`packages/ptc-runtime/ptc-runtime-node/src/config.ts:7`](../packages/ptc-runtime/ptc-runtime-node/src/config.ts)

```ts config-catalog
/** Deployment-varying runtime bounds and launch choices. */
export interface Config {
  /** Worker invocation in the subprocess world; omitted selects the local carrier. */
  launch?: LaunchConfig
  /** per-call uses fresh async function bodies; vm-script uses VM contexts; persistent-in-memory retains a REPL per owner. */
  executionMode?: 'per-call' | 'persistent-in-memory' | 'vm-script'
  /** Retain a Script process and context per stateOwner; only supported with executionMode: vm-script. */
  scriptPersistence?: boolean
  /** Default elapsed deadline, including nested tool and approval waits. */
  timeoutMs?: number
  /** Maximum numeric elapsed budget accepted by resolve. */
  maxTimeoutMs?: number
  /** Combined serialized logs, completion and diagnostic byte cap. */
  maxOutputBytes?: number
  /** V8 old-generation heap limit in MiB; native allocations are excluded. */
  maxOldGenerationSizeMb?: number
  /** Maximum control message, outstanding binding-argument and queued control-output bytes. */
  maxMessageBytes?: number
  /** Maximum simultaneous host binding calls accepted from a program. */
  maxPendingCalls?: number
  /** Managed process termination and output-drain grace in milliseconds. */
  graceMs?: number
}

/** Deployment-owned worker invocation in the subprocess execution world. */
export type LaunchConfig = {
  /** Start a separately installed Node executable and JavaScript bootstrap. */
  kind: 'node-script'
  /** Executable name or path resolved by the subprocess provider. */
  executable: string
  /** Absolute preinstalled bootstrap; omitted maps this package's bootstrap into the execution world. */
  bootstrapPath?: string
} | {
  /** Start the private PTC worker embedded in a packaged executable. */
  kind: 'embedded'
  /** Packaged executable name or path resolved by the subprocess provider. */
  executable: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-ptc-runtime-node -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-pwsh-local -->
<a id="deepseek-aidsh-pwsh-local"></a>

## `@deepseek-ai/dsh-pwsh-local`

- `inject`: `subprocess`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/shell/pwsh-local/src/index.ts:58`](../packages/shell/pwsh-local/src/index.ts)

```ts config-catalog
/** Validated plugin configuration with live command budgets. */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd: Volatile<string | undefined>
  /** Default foreground timeout in milliseconds. */
  timeoutMs: Volatile<number>
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs: Volatile<number>
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes: Volatile<number>
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes: Volatile<number>
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs: Volatile<number>
  /**
   * Explicit pwsh executable. When omitted, well-known Windows install
   * locations and PATH entries are probed in order (PowerShell 7 install,
   * PATH entries such as the Microsoft Store install, then Windows
   * PowerShell 5.1), falling back to a bare `pwsh` resolved through PATH.
   */
  pwshPath: Volatile<string | undefined>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-pwsh-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-pwsh-sandbox -->
<a id="deepseek-aidsh-pwsh-sandbox"></a>

## `@deepseek-ai/dsh-pwsh-sandbox`

- `inject`: `subprocess` · `sandbox` · `sandboxPolicy`
- `refs`: [`LocalConfig`](#deepseek-aidsh-pwsh-local)
- `source`: [`packages/shell/pwsh-sandbox/src/index.ts:40`](../packages/shell/pwsh-sandbox/src/index.ts)

```ts config-catalog
/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The
 * runner choice is likewise the `ctx.sandbox` provider's config, not this
 * executor's.
 */
export type Config = LocalConfig
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-pwsh-sandbox -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-repeat-tool-reminder -->
<a id="deepseek-aidsh-repeat-tool-reminder"></a>

## `@deepseek-ai/dsh-repeat-tool-reminder`

- `source`: [`packages/guard/repeat-tool-reminder/src/index.ts:35`](../packages/guard/repeat-tool-reminder/src/index.ts)

```ts config-catalog
/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `thresholds` list, a non-integer, a value below 2, or a duplicate throws at
 * plugin load, never a silent fall-back). `include`/`exclude` entries are
 * `*`-wildcard predicates over tool names at call time, not references to
 * registry entries — a pattern matching no currently registered tool is valid
 * (`exclude: [mcp_*]` must stay legal in a deployment that loads no MCP tools).
 */
export interface Config {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[]
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: string[]
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: string[]
  /**
   * Maximum characters of canonical arguments quoted in the DETAILED reminder
   * (default 500). Large payloads (a `write` body, a long command) would
   * otherwise ride into the next request unbounded — precisely in a loop
   * scenario; the cap bounds the reminder, never the detection (the chain key
   * always compares the FULL canonical string).
   */
  argumentsPreviewChars?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-repeat-tool-reminder -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-sandbox-local -->
<a id="deepseek-aidsh-sandbox-local"></a>

## `@deepseek-ai/dsh-sandbox-local`

- `source`: [`packages/sandbox/sandbox-local/src/index.ts:45`](../packages/sandbox/sandbox-local/src/index.ts)

```ts config-catalog
/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * Override the runner argv; bwrap-compatible profile arguments are appended. A
   * non-empty override asserts full enforcement and skips built-in selection and
   * probing. A runner that starts but refuses its profile must be identifiable by
   * {@link runnerFailureSignatures}. Consumers classify a spawn rejection only after
   * confirming the workdir is usable. `ENOENT` or `EACCES` identifies the runner when
   * `error.path` equals argv[0] and `error.syscall` is `spawn` or `spawn <runner>`, or
   * when `error.path` is absent and `error.syscall` is exactly `spawn <runner>`.
   */
  runnerCommand?: string[]
  /**
   * Case-insensitive stderr substrings emitted when a configured
   * {@link runnerCommand} refuses its profile before executing the wrapped
   * command. Required and non-empty with `runnerCommand`; rejected without
   * it. Each entry is a non-empty, single-line, case-insensitive substring
   * covering the executable runner's own failure dialect.
   */
  runnerFailureSignatures?: string[]
  /** Positive timeout for each functional probe; zero would mean unbounded to Node. */
  probeTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-sandbox-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-sandbox-policy -->
<a id="deepseek-aidsh-sandbox-policy"></a>

## `@deepseek-ai/dsh-sandbox-policy`

- `inject`: `sessionProjections`
- `refs`: [`SandboxMode`](subsystems/sandbox.zh.md)
- `source`: [`packages/sandbox/sandbox-policy/src/index.ts:94`](../packages/sandbox/sandbox-policy/src/index.ts)

```ts config-catalog
/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
  /**
   * Extra physical absolute directories that `workspace-write` may also write under
   * (default: none). The supervisor names them explicitly; there is no
   * automatic repository or gitfile discovery. Entries are execution-world
   * paths: this service validates absoluteness and detaches the list, while
   * the enforcing host rejects missing, non-directory, or symlinked paths. They grant nothing under
   * `read-only`.
   */
  additionalWritableRoots?: string[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-sandbox-policy -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-schedule -->
<a id="deepseek-aidsh-schedule"></a>

## `@deepseek-ai/dsh-schedule`

- `inject`: `agents` · `sessions` · `storageDomain` · `sessionPersistence`
- `source`: [`packages/schedule/schedule/src/index.ts:83`](../packages/schedule/schedule/src/index.ts)

```ts config-catalog
/** Configuration for the Host Schedule domain. */
export interface Config {
  /**
   * Delivery-history window retained per task, in days; omission defaults to 30.
   * Pruning happens when an acknowledgment is appended, and `lastDelivery` is always retained.
   */
  deliveryHistoryDays?: number
  /**
   * Retained delivery records per task; omission defaults to 200. The older of this
   * cap and the window wins, and the newest records survive.
   */
  deliveryHistoryRecords?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-schedule -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-sdk-app -->
<a id="deepseek-aidsh-sdk-app"></a>

## `@deepseek-ai/dsh-sdk-app`

- `inject`: `cmdlineArgs`
- `source`: [`packages/bundle/sdk-app/src/index.ts:23`](../packages/bundle/sdk-app/src/index.ts)

```ts config-catalog
/** SDK stdio startup configuration. */
export interface Config {
  /** Profile name rendered in help and diagnostics (default `sdk`). */
  profile?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-sdk-app -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-sdk-jsonrpc-server -->
<a id="deepseek-aidsh-sdk-jsonrpc-server"></a>

## `@deepseek-ai/dsh-sdk-jsonrpc-server`

- `inject`: `agents` · `workingDirectory`
- `refs`: `Readable` (`node:stream`) · `Writable` (`node:stream`)
- `source`: [`packages/sdk/server/src/index.ts:24`](../packages/sdk/server/src/index.ts)

```ts config-catalog
/** JSON-RPC deployment config plus runtime-only test hooks. */
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-sdk-jsonrpc-server -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-log-deepseek -->
<a id="deepseek-aidsh-session-log-deepseek"></a>

## `@deepseek-ai/dsh-session-log-deepseek`

- `inject`: `deepseekLlmApiExtensions` · `sessions`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/session/session-log-deepseek/src/index.ts:39`](../packages/session/session-log-deepseek/src/index.ts)

```ts config-catalog
/** Session-log request contribution configuration. */
export interface Config {
  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `true`. */
  enabled: Volatile<boolean>
  /**
   * Largest serialized `dsh_session_log` field, in UTF-8 bytes, that one request carries.
   * A request uploads the longest pending event prefix that fits; later requests continue
   * after its acceptance. Defaults to 8 MiB.
   */
  maxBytes: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-log-deepseek -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-log-export -->
<a id="deepseek-aidsh-session-log-export"></a>

## `@deepseek-ai/dsh-session-log-export`

- `inject`: `commands` · `connection`
- `source`: [`packages/session-query/session-log-export/src/index.ts:48`](../packages/session-query/session-log-export/src/index.ts)

```ts config-catalog
/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
}

/** Valid fflate DEFLATE levels accepted by session-log export. */
export type SessionLogCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-log-export -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-persistence-jsonl -->
<a id="deepseek-aidsh-session-persistence-jsonl"></a>

## `@deepseek-ai/dsh-session-persistence-jsonl`

- `source`: [`packages/session/session-persistence-jsonl/src/index.ts:94`](../packages/session/session-persistence-jsonl/src/index.ts)

```ts config-catalog
/** Plugin config for the JSONL backend's root, physical encoding, and listing concurrency. */
export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under human-readable project
   * directories, then per-session directories. An existing root must be a
   * readable directory; an absent root is created on first materialization.
   */
  root: string
  /** Physical encoding; defaults to checksummed Zstandard frames. */
  compression?: JsonlCompression
  /**
   * Maximum directory, header, and stat reads in flight across all concurrent
   * listings of this backend (`list()`, the root encoding check, and historical
   * fingerprints). Defaults to 3.
   */
  listConcurrency?: number
}

/** Physical encoding selected for JSONL session artifacts. */
export type JsonlCompression = 'zstd' | 'none'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-persistence-jsonl -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-projection-cache -->
<a id="deepseek-aidsh-session-projection-cache"></a>

## `@deepseek-ai/dsh-session-projection-cache`

- `inject`: `storageDomain` · `sessionProjections` · `sessions`
- `source`: [`packages/session/session-projection-cache/src/index.ts:76`](../packages/session/session-projection-cache/src/index.ts)

```ts config-catalog
/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the three mandatory write points (session creation,
 * `turn/end`, and session disposal) are policy, not tunables, and always
 * fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-projection-cache -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-query-sqlite -->
<a id="deepseek-aidsh-session-query-sqlite"></a>

## `@deepseek-ai/dsh-session-query-sqlite`

- `inject`: `sessions`
- `refs`: [`SessionQueryConfig`](../packages/session-query/session-query/src/index.ts)
- `source`: [`packages/session-query/session-query-sqlite/src/index.ts:92`](../packages/session-query/session-query-sqlite/src/index.ts)

```ts config-catalog
/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
}

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-query-sqlite -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-reference -->
<a id="deepseek-aidsh-session-reference"></a>

## `@deepseek-ai/dsh-session-reference`

- `inject`: `sessionQuery`
- `source`: [`packages/context/session-reference/src/config.ts:11`](../packages/context/session-reference/src/config.ts)

```ts config-catalog
/** Session-reference service configuration. */
export interface Config {
  /** Maximum distinct source sessions referenced by one message, from one to three. */
  maxReferences?: number
  /** Default host candidate-list limit. */
  candidateLimit?: number
  /** Explicit maximum rendered UTF-8 bytes per source; absent uses the model-relative budget with a 64 KiB floor. */
  maxReferenceBytes?: number
  /** Fraction of the model context window per source, estimated at four bytes per token; between zero and one. */
  referenceContextFraction?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-reference -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-telemetry-otel -->
<a id="deepseek-aidsh-session-telemetry-otel"></a>

## `@deepseek-ai/dsh-session-telemetry-otel`

- `inject`: `sessions` · `otel`
- `refs`: [`LogExporterOptions`](../packages/telemetry/otel/src/index.ts) · [`SessionLogProcessorOptions`](../packages/telemetry/otel/src/index.ts)
- `source`: [`packages/session/session-telemetry-otel/src/index.ts:85`](../packages/session/session-telemetry-otel/src/index.ts)

```ts config-catalog
/**
 * Plugin configuration: sharing policy, SDK transport options, byte/count queue
 * settings, and an overall shutdown bound. Uploading modes validate their endpoint
 * and shutdown deadline at plugin load; `DISABLED` reads neither.
 */
export interface Config {
  /** Defaults to `FEEDBACK_ONLY`: capture session history only when feedback is explicitly submitted. */
  mode?: SessionTelemetryMode
  /**
   * Explicit SDK HTTP transport settings, including optional routing headers.
   * Ambient credentials are not inherited. URL is required while uploading.
   * Exporter self-observability metering is not supported.
   */
  exporter?: Omit<LogExporterOptions, 'url'> & {
    /** Full logs endpoint (e.g. `https://collector.example.com/v1/logs`). Required outside `DISABLED`; validated at load. */
    url?: string
  }
  /**
   * Count, queue, cadence, and per-request watchdog settings for the byte-bounded
   * processor. A watchdog warning never releases an unsettled transport slot.
   * SDK processor self-observability metering is not supported.
   */
  processor?: SessionLogProcessorOptions
  /** Maximum time spent awaiting the SDK provider's complete shutdown path. */
  shutdownTimeoutMillis?: number
  /** Uncompressed OTLP request byte limit, at most 4,000,000. */
  maxRequestBytes?: number
}

/** Session-sharing policy selected by {@link Config.mode}. */
export enum SessionTelemetryMode {
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-telemetry-otel -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-title -->
<a id="deepseek-aidsh-session-title"></a>

## `@deepseek-ai/dsh-session-title`

- `inject`: `sessions` · `sessionProjections` · `agents`
- `source`: [`packages/session/session-title/src/index.ts:56`](../packages/session/session-title/src/index.ts)

```ts config-catalog
/** Required deterministic fallback and accepted-title limits. */
export interface Config {
  /** Maximum whitespace-delimited words in the built-in fallback. */
  readonly fallbackMaxWords: number
  /** Maximum UTF-8 bytes in the built-in fallback. */
  readonly fallbackMaxBytes: number
  /** Maximum UTF-8 bytes in any accepted title. */
  readonly maxTitleBytes: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-title -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-title-all-prompts-llm -->
<a id="deepseek-aidsh-session-title-all-prompts-llm"></a>

## `@deepseek-ai/dsh-session-title-all-prompts-llm`

- `inject`: `sessionTitle` · `llm` · `sessions`
- `refs`: [`SessionTitleLlmConfig`](../packages/session/session-title-llm/src/index.ts)
- `source`: [`packages/experimental/session-title-all-prompts-llm/src/index.ts:28`](../packages/experimental/session-title-all-prompts-llm/src/index.ts)

```ts config-catalog
/** Required execution controls plus this provider's title-length targets; no defaults. */
export interface Config extends SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-title-all-prompts-llm -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-session-title-first-prompt-llm -->
<a id="deepseek-aidsh-session-title-first-prompt-llm"></a>

## `@deepseek-ai/dsh-session-title-first-prompt-llm`

- `inject`: `sessionTitle` · `llm` · `sessions`
- `refs`: [`SessionTitleLlmConfig`](../packages/session/session-title-llm/src/index.ts)
- `source`: [`packages/session/session-title-first-prompt-llm/src/index.ts:28`](../packages/session/session-title-first-prompt-llm/src/index.ts)

```ts config-catalog
/** Required execution controls plus this provider's title-length targets; no defaults. */
export interface Config extends SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-session-title-first-prompt-llm -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-shell-env -->
<a id="deepseek-aidsh-shell-env"></a>

## `@deepseek-ai/dsh-shell-env`

- `source`: [`packages/shell/shell-env/src/index.ts:30`](../packages/shell/shell-env/src/index.ts)

```ts config-catalog
/** Plugin config (all optional — the built-in facts resolve without defaults). */
export interface Config {
  /** DeepSeek Harness home directory exposed as `DSH_HOME`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-shell-env -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-skill -->
<a id="deepseek-aidsh-skill"></a>

## `@deepseek-ai/dsh-skill`

- `source`: [`packages/skill/skill/src/index.ts:278`](../packages/skill/skill/src/index.ts)

```ts config-catalog
/** Skill registry configuration. */
export interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-skill -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-skill-filesystem -->
<a id="deepseek-aidsh-skill-filesystem"></a>

## `@deepseek-ai/dsh-skill-filesystem`

- `inject`: `skills`
- `source`: [`packages/skill/skill-filesystem/src/index.ts:48`](../packages/skill/skill-filesystem/src/index.ts)

```ts config-catalog
/** Local filesystem skill provider configuration. */
export interface Config {
  /** Unique provider name. Defaults to `filesystem`. */
  providerName?: string
  /** Whether project and user roots are included around custom roots. */
  includeDefaultRoots?: boolean
  /** DeepSeek Harness config root. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Shared agent config root. Defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /** Additional skill roots scanned after project roots and before user roots. */
  customSkillDirs?: string[]
  /** Whether host-local skill roots are watched for catalog changes. */
  watch?: boolean
  /** Whether Chokidar uses polling instead of native filesystem events. */
  watchUsePolling?: boolean
  /** Milliseconds a changed skill entry must remain stable before it is observed. */
  watchStabilityThresholdMs?: number
  /** Milliseconds between Chokidar stability or polling probes. */
  watchPollIntervalMs?: number
  /** Maximum distinct project roots whose skill directories remain watched. */
  watchMaxProjects?: number
  /** Whether watched symbolic links follow their target files. */
  watchFollowSymlinks?: boolean
  /** Bundled skill root; defaults to `$DSH_BUNDLED_SKILL_DIR` when default roots are included, otherwise mounts none. */
  bundledSkillDir?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-skill-filesystem -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-skill-office -->
<a id="deepseek-aidsh-skill-office"></a>

## `@deepseek-ai/dsh-skill-office`

- `inject`: `skills`
- `source`: [`packages/skill/skill-office/src/index.ts:16`](../packages/skill/skill-office/src/index.ts)

```ts config-catalog
/** Office skill resource location. */
export interface Config {
  /** Absolute assets directory containing skill folders; defaults to packaged assets. */
  assetRoot?: string
  /** Standalone Node executable; defaults to the current executable outside Electron and SEA. */
  node?: string
  /** Absolute LibreOffice Kit CLI entry; false explicitly disables CLI access. */
  cli?: string | false
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-skill-office -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-spill-local -->
<a id="deepseek-aidsh-spill-local"></a>

## `@deepseek-ai/dsh-spill-local`

- `source`: [`packages/spill/spill-local/src/index.ts:31`](../packages/spill/spill-local/src/index.ts)

```ts config-catalog
/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /**
   * Root directory for spill files. Omitted uses a lazily-created private
   * (0700) per-process directory under the OS temp dir — the safe default for
   * a local deployment. Set it to keep spill files under a known location.
   */
  root?: string
  /**
   * Age in days after which a spill file is eligible for the one-shot startup
   * cleanup sweep. Defaults to `30`; `0` disables cleanup entirely. Files whose
   * `mtime` is strictly older than the cutoff are deleted and emptied
   * directories are pruned; fresh files, symlinks, and unrelated entries are
   * left untouched. On POSIX, cleanup skips roots and session directories that
   * another local user could modify or replace. Retention is deliberate — a
   * resumed or forked session may still reference an older locator until it
   * ages out.
   */
  cleanupPeriodDays?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-spill-local -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-spill-policy -->
<a id="deepseek-aidsh-spill-policy"></a>

## `@deepseek-ai/dsh-spill-policy`

- `inject`: `tools`
- `source`: [`packages/spill/spill-policy/src/index.ts:26`](../packages/spill/spill-policy/src/index.ts)

```ts config-catalog
/** Optional result-retention budget. */
export interface Config {
  /** Maximum estimated tokens in a retained result, including image descriptors and omission notices. Omitted disables retention. */
  maxInlineTokens?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-spill-policy -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-ssh -->
<a id="deepseek-aidsh-ssh"></a>

## `@deepseek-ai/dsh-ssh`

- `source`: [`packages/ssh/ssh/src/index.ts:33`](../packages/ssh/ssh/src/index.ts)

```ts config-catalog
/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Explicit script or self-contained executable invocation. */
  launch: HelperLaunch
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}

/** Installed helper invocation; script deployments may also install a PTC bootstrap. */
export type HelperLaunch = {
  /** Run the installed script with a separately installed Node executable. */
  kind: 'node-script'
  /** Absolute remote Node executable. */
  node: string
  /** Absolute remote PTC bootstrap; requires bootstrapHash. */
  bootstrapPath?: string
  /** Lowercase SHA-256 of bootstrapPath; requires that path. */
  bootstrapHash?: string
} | {
  /** Run the helper executable with its embedded Node and PTC worker. */
  kind: 'executable'
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-ssh -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-storage-domain -->
<a id="deepseek-aidsh-storage-domain"></a>

## `@deepseek-ai/dsh-storage-domain`

- `inject`: `storage`
- `source`: [`packages/storage/storage-domain/src/index.ts:52`](../packages/storage/storage-domain/src/index.ts)

```ts config-catalog
/**
 * Plugin config. Which backend serves which domain is decided here, not
 * globally on the hub: `backend` is the default route and `routes` overrides
 * it per domain name. A route naming an unregistered backend fails loud at
 * `open` with `backend-not-found`.
 */
export interface Config {
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-storage-domain -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-storage-json -->
<a id="deepseek-aidsh-storage-json"></a>

## `@deepseek-ai/dsh-storage-json`

- `inject`: `storage`
- `source`: [`packages/storage/storage-json/src/index.ts:28`](../packages/storage/storage-json/src/index.ts)

```ts config-catalog
/**
 * Plugin configuration.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export interface Config {
  /** Directory holding one `<unit>.json` file (or `<unit>/` tree) per unit. */
  root: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-storage-json -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-storage-sqlite -->
<a id="deepseek-aidsh-storage-sqlite"></a>

## `@deepseek-ai/dsh-storage-sqlite`

- `inject`: `storage`
- `source`: [`packages/storage/storage-sqlite/src/index.ts:24`](../packages/storage/storage-sqlite/src/index.ts)

```ts config-catalog
/** Plugin configuration. */
export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests). On filesystems with POSIX modes,
   * missing directories and databases are created owner-only; existing path
   * modes are preserved. Filesystem setup errors other than an existing
   * database fail the open. The backend does not protect confidentiality or
   * integrity when another principal can replace the database entry in its
   * parent directory.
   */
  path: string
  /**
   * SQLite `journal_mode` pragma. `wal` (the default) suits local disks; pick
   * a rollback-journal mode (`delete`/`truncate`/`persist`) on filesystems
   * where WAL's shared-memory files do not work (network mounts). See
   * {@link JournalMode}.
   */
  journalMode?: JournalMode
}

/**
 * Journal modes the backend will run under. `wal` is the default; the
 * rollback-journal modes (`delete`/`truncate`/`persist`) exist for
 * filesystems where WAL's shared-memory files do not work (network mounts).
 * `memory`/`off` are excluded: dropping journal durability silently
 * contradicts the durability clause of the KV backend contract.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-storage-sqlite -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-subagent -->
<a id="deepseek-aidsh-subagent"></a>

## `@deepseek-ai/dsh-subagent`

- `inject`: `workingDirectory` · `sessionProjections`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/subagent/subagent/src/index.ts:186`](../packages/subagent/subagent/src/index.ts)

```ts config-catalog
/** Host configuration for continuable subagent capacity. */
export interface Config {
  /** Maximum live children sharing uninterrupted continuable parent links; defaults to 8. */
  maxActiveSubagents: Volatile<number>
  /** Default delegation depth for tools without an explicit limit; defaults to 1. */
  maxDepth: Volatile<number>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-subagent -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-subagent-acp -->
<a id="deepseek-aidsh-subagent-acp"></a>

## `@deepseek-ai/dsh-subagent-acp`

- `inject`: `subagents` · `subprocess`
- `source`: [`packages/subagent/subagent-acp/src/index.ts:25`](../packages/subagent/subagent-acp/src/index.ts)

```ts config-catalog
/** Config: how to spawn and drive the child ACP agent process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `acp`). */
  providerName: string
  /** The executable to spawn for each run (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * How to auto-answer the child's `session/request_permission` prompts:
   * `reject` (default — decline every prompt) or `allow` (approve via the first
   * `allow_once` or `allow_always` option). No prompt is surfaced to a human.
   */
  permission: PermissionPolicy
  /**
   * Extra environment variables for the child process — e.g. the child
   * harness's own `DEEPSEEK_API_KEY`. Forwarded on top of a credential-scrubbed
   * copy of the parent env, so an explicit key here reaches the child while
   * ambient secrets do not leak implicitly.
   */
  env: Record<string, string>
  /**
   * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
   * window to flush persistence and tear down its own nested subprocesses
   * before the parent escalates to a signal. Must not exceed
   * `MAX_TIMER_DELAY_MS`.
   */
  disposeEofGraceMs?: number
  /** Failure-observation and termination-escalation grace (ms); must not exceed `MAX_TIMER_DELAY_MS`. */
  disposeGraceMs?: number
}

/** Fixed response to child permission requests: reject by default, or select the first allow option. */
export type PermissionPolicy = 'allow' | 'reject'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-subagent-acp -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-subagent-claude-code -->
<a id="deepseek-aidsh-subagent-claude-code"></a>

## `@deepseek-ai/dsh-subagent-claude-code`

- `inject`: `subagents` · `subprocess`
- `source`: [`packages/subagent/subagent-claude-code/src/index.ts:38`](../packages/subagent/subagent-claude-code/src/index.ts)

```ts config-catalog
/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `claude-code`). */
  providerName?: string
  /** Native Claude model fixed for this instance; omitted to inherit Claude settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `dontAsk`; `acceptEdits` accepts edits, `auto` uses the native classifier,
   * `plan` returns a plan without approving execution, and
   * `bypassPermissions` explicitly skips permission checks.
   */
  permissionMode?: ClaudeCodePermissionMode
  /** Grace in milliseconds between Claude Code managed-range termination tiers. */
  disposeGraceMs?: number
}

/** Profile-selectable non-interactive Claude Code permission mode. */
export type ClaudeCodePermissionMode = typeof CLAUDE_CODE_PERMISSION_MODES[number]
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-subagent-claude-code -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-subagent-codex -->
<a id="deepseek-aidsh-subagent-codex"></a>

## `@deepseek-ai/dsh-subagent-codex`

- `inject`: `subagents` · `subprocess`
- `source`: [`packages/subagent/subagent-codex/src/index.ts:36`](../packages/subagent/subagent-codex/src/index.ts)

```ts config-catalog
/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `codex`). */
  providerName?: string
  /** Native Codex model fixed for this instance; omitted to inherit Codex settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Native non-interactive permission mode fixed for this Provider instance. */
  permissionMode?: CodexPermissionMode
  /** Grace in milliseconds between app-server managed-range termination tiers. */
  disposeGraceMs?: number
}

/** Profile-selectable non-interactive Codex permission mode. */
export type CodexPermissionMode =
  | 'never'
  | 'approve-for-me'
  | 'dangerously-bypass-approvals-and-sandbox'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-subagent-codex -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-subagent-dsh-sdk -->
<a id="deepseek-aidsh-subagent-dsh-sdk"></a>

## `@deepseek-ai/dsh-subagent-dsh-sdk`

- `inject`: `subagents`
- `source`: [`packages/subagent/subagent-dsh-sdk/src/index.ts:34`](../packages/subagent/subagent-dsh-sdk/src/index.ts)

```ts config-catalog
/** Config: how to spawn and drive the child SDK runtime process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `dsh-sdk`). */
  providerName: string
  /** Explicit dsh CLI module, resolved and checked at plugin load; omission uses the SDK dependency. */
  dshBin?: string
  /** Named child profile (default `sdk`). */
  profile: string
  /** Ordered per-launch profile patch files, resolved and checked at plugin load. */
  patches: string[]
  /** Absolute isolated Harness home for every nested child process. */
  dshHome: string
  /** Provider route the child runtime initializes with (default `deepseek-official`). */
  provider: string
  /** Model the child runtime initializes with (default `deepseek-v4-flash`). */
  model: string
  /** Optional per-request output-token cap for the child runtime. */
  maxTokens?: number
  /**
   * Extra environment variables for the child process — e.g. the child
   * runtime's own `DEEPSEEK_API_KEY`. Forwarded on top of a credential-scrubbed copy of the parent
   * env, so an explicit key here reaches the child while ambient secrets do
   * not leak implicitly.
   */
  env: Record<string, string>
  /** Bound (ms) on the protocol `shutdown` exchange during dispose. */
  shutdownTimeoutMs?: number
  /**
   * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
   * window to flush persistence and tear down its own nested subprocesses
   * before the parent escalates to a signal.
   */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms), including forced exit on every platform. */
  disposeGraceMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-subagent-dsh-sdk -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-subagent-fork-in-process -->
<a id="deepseek-aidsh-subagent-fork-in-process"></a>

## `@deepseek-ai/dsh-subagent-fork-in-process`

- `inject`: `subagents`
- `source`: [`packages/subagent/subagent-fork-in-process/src/index.ts:29`](../packages/subagent/subagent-fork-in-process/src/index.ts)

```ts config-catalog
/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `fork`). */
  providerName: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-subagent-fork-in-process -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-subagent-spawn-in-process -->
<a id="deepseek-aidsh-subagent-spawn-in-process"></a>

## `@deepseek-ai/dsh-subagent-spawn-in-process`

- `inject`: `subagents`
- `source`: [`packages/subagent/subagent-spawn-in-process/src/index.ts:23`](../packages/subagent/subagent-spawn-in-process/src/index.ts)

```ts config-catalog
/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `spawn`). */
  providerName: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-subagent-spawn-in-process -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-system-prompt -->
<a id="deepseek-aidsh-system-prompt"></a>

## `@deepseek-ai/dsh-system-prompt`

- `source`: [`packages/core/system-prompt/src/index.ts:263`](../packages/core/system-prompt/src/index.ts)

```ts config-catalog
/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.personaPrefix} for its contract). */
export interface Config {
  /** Include the fixed DeepSeek Harness identity before the deployment persona (default true). */
  includeHarnessIdentity?: boolean
  /** Include optional runtime-context snapshots in model history (default true); required context remains. */
  includeRuntimeContext?: boolean
  /**
   * Deployment-wide persona prefix template before first-party guidance. A scoped section named
   * `deployment:persona-prefix` shadows it; `{{variable}}` references are strict.
   */
  personaPrefix?: string
  /**
   * Persona suffix template after first-party guidance. A scoped `deployment:persona-suffix`
   * section shadows it; `{{variable}}` references are strict. Defaults to empty.
   */
  personaSuffix?: string
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Invalid fields fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-system-prompt -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-terminal-bash -->
<a id="deepseek-aidsh-terminal-bash"></a>

## `@deepseek-ai/dsh-terminal-bash`

- `inject`: `terminals` · `sandboxPolicy` · `subprocess` · `workingDirectory`
- `source`: [`packages/terminal/terminal-bash/src/config.ts:10`](../packages/terminal/terminal-bash/src/config.ts)

```ts config-catalog
/** Public plugin configuration. */
export interface Config {
  /** Backend registry type (default: `shell`). */
  backendType?: string
  /** Interactive shell dialect (default: `bash`); selects the argv/env/startup defaults. */
  shellDialect?: ShellDialect
  /** Interactive shell executable (default per dialect: `/bin/bash`, or the resolved pwsh). */
  shellPath?: string
  /** Shell arguments (default per dialect: bash `--noprofile --norc -i`, pwsh `-NoLogo -NoProfile`). */
  shellArgs?: string[]
  /** Terminal rows. */
  rows?: number
  /** Terminal columns. */
  cols?: number
  /** Maximum retained logical lines. */
  scrollbackLines?: number
  /** Maximum retained UTF-8 bytes. */
  scrollbackMaxBytes?: number
  /** Maximum bytes returned by one read or settled viewport. */
  maxReadBytes?: number
  /** Readiness polling interval. */
  pollIntervalMs?: number
  /** Delay before Linux exact syscall probes. */
  exactProbeAfterMs?: number
  /** Silence duration that yields `inferred_idle`. */
  idleSilenceMs?: number
  /**
   * Extra wait beyond `idleSilenceMs`, once a prompt marker was seen, for the shell to
   * regain the foreground before `inferred_idle` settles; at least one `pollIntervalMs`.
   */
  handoffGraceMs?: number
  /**
   * Extra wait beyond `idleSilenceMs` and `handoffGraceMs`, once a prompt marker was seen but
   * its printable tail has not arrived, before `inferred_idle` settles. The marker is written
   * by the shell's own prompt function and the tail by the same render, so a missing tail is a
   * delivery delay on a contended host rather than an absent prompt. Zero keeps the bound at
   * `idleSilenceMs + handoffGraceMs`; any other value covers at least one `pollIntervalMs`, so a
   * nonzero tolerance always contains a readiness poll.
   */
  promptTailGraceMs?: number
  /** Absolute bound for one send and the complete pwsh startup sequence. */
  timeoutMs?: number
  /** Grace before teardown escalates to `SIGKILL`. */
  disposeGraceMs?: number
}

/** One supported interactive shell dialect. */
export type ShellDialect = 'bash' | 'pwsh'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-terminal-bash -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-time-context -->
<a id="deepseek-aidsh-time-context"></a>

## `@deepseek-ai/dsh-time-context`

- `inject`: `agents` · `sessionProjections`
- `source`: [`packages/context/time-context/src/index.ts:52`](../packages/context/time-context/src/index.ts)

```ts config-catalog
/** Request-preparation clock formatting and append scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Fallback display zone when the open turn has no unique browser zone. Omit to use the process zone. */
  timeZone?: string
  /** Minimum milliseconds between durable injections in one session. Defaults to 600000 (10 minutes); 0 injects at every eligible step. */
  refreshIntervalMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-time-context -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tmux-context -->
<a id="deepseek-aidsh-tmux-context"></a>

## `@deepseek-ai/dsh-tmux-context`

- `inject`: `agents` · `sessionProjections`
- `source`: [`packages/context/tmux-context/src/index.ts:47`](../packages/context/tmux-context/src/index.ts)

```ts config-catalog
/** Per-turn tmux-location scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject on every eligible change. */
  refreshIntervalMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tmux-context -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-token-meter -->
<a id="deepseek-aidsh-token-meter"></a>

## `@deepseek-ai/dsh-token-meter`

- `inject`: `sessionProjections`
- `source`: [`packages/llm/token-meter/src/types.ts:13`](../packages/llm/token-meter/src/types.ts)

```ts config-catalog
/** Token-meter plugin configuration; the fixed estimator has no settings. */
export type TokenMeterConfig = Record<string, never>
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-token-meter -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-ask-user -->
<a id="deepseek-aidsh-tool-ask-user"></a>

## `@deepseek-ai/dsh-tool-ask-user`

- `inject`: `tools` · `userQuestions`
- `source`: [`packages/interaction/tool-ask-user/src/index.ts:16`](../packages/interaction/tool-ask-user/src/index.ts)

```ts config-catalog
/** Cordis row selecting the tool schema and its default foreground wait. */
export interface Config {
  /** Tool definition selected by this Cordis row. Defaults to the blocking legacy tool. */
  mode?: 'legacy' | 'timed'
  /** Foreground wait before automatic continuation. Defaults to 120 seconds. */
  timeout?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-ask-user -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-bash -->
<a id="deepseek-aidsh-tool-bash"></a>

## `@deepseek-ai/dsh-tool-bash`

- `inject`: `tools` · `shell` · `systemPrompt` · `shellEnv` · `workingDirectory`
- `source`: [`packages/shell/tool-bash/src/index.ts:37`](../packages/shell/tool-bash/src/index.ts)

```ts config-catalog
/** Configuration for the bash tool. */
export interface Config {
  /**
   * Expose `run_in_background` while a job registry is composed (default
   * true); disabled calls are also rejected. Without a registry the tool is
   * foreground-only regardless.
   */
  enableRunInBackground?: boolean
  /**
   * Keep a foreground command that reaches its timeout running as a
   * background job instead of killing it (default true). Applies only while
   * background execution is available: with `enableRunInBackground` false or
   * no job registry, the executor's deadline kills the command. A foreground
   * command the registry refuses at its start (admission or a missing
   * controller) also runs under the deadline kill.
   */
  promoteOnTimeout?: boolean
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-bash -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-bash-persistent -->
<a id="deepseek-aidsh-tool-bash-persistent"></a>

## `@deepseek-ai/dsh-tool-bash-persistent`

- `inject`: `tools` · `terminals` · `workingDirectory`
- `source`: [`packages/shell/tool-bash-persistent/src/index.ts:447`](../packages/shell/tool-bash-persistent/src/index.ts)

```ts config-catalog
/** Configuration for the persistent Bash tool. */
export interface Config {
  /** PTY backend used for each owner-isolated persistent shell (default `shell`). */
  backendType?: string
  /** Wall-clock limit for one command (default 300000). */
  timeoutMs?: number
  /** Maximum returned command-output characters before clipping (default 16000). */
  maxOutputChars?: number
  /** Model-facing tool description; deployments may describe their environment. */
  description?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-bash-persistent -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-executor-ptc -->
<a id="deepseek-aidsh-tool-executor-ptc"></a>

## `@deepseek-ai/dsh-tool-executor-ptc`

- `inject`: `tools` · `systemPrompt` · `ptcRuntime`
- `source`: [`packages/core/tool-executor-ptc/src/config.ts:5`](../packages/core/tool-executor-ptc/src/config.ts)

```ts config-catalog
/** Program execution limits. */
export interface Config {
  /** Maximum overlapping concurrency-safe program subcalls. */
  maxParallelSubCalls: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-executor-ptc -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-fs -->
<a id="deepseek-aidsh-tool-fs"></a>

## `@deepseek-ai/dsh-tool-fs`

- `inject`: `tools` · `fs` · `systemPrompt` · `workingDirectory`
- `source`: [`packages/fs/tool-fs/src/index.ts:26`](../packages/fs/tool-fs/src/index.ts)

```ts config-catalog
/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Register `read` and its guidance. Defaults to true. */
  read?: boolean
  /** Register `read_image` while an attachment store is mounted. Defaults to true. */
  readImage?: boolean
  /** Register `write` and its guidance. Defaults to true. */
  write?: boolean
  /** Register `edit` and its guidance. Defaults to true. */
  edit?: boolean
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-fs -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-fs-search -->
<a id="deepseek-aidsh-tool-fs-search"></a>

## `@deepseek-ai/dsh-tool-fs-search`

- `inject`: `tools` · `systemPrompt` · `subprocess` · `workingDirectory`
- `source`: [`packages/fs/tool-fs-search/src/index.ts:74`](../packages/fs/tool-fs-search/src/index.ts)

```ts config-catalog
/** Plugin config; over-cap glob sampling is an explicit deployment choice and the remaining fields have defaults. */
export interface Config {
  /** Whether an over-cap `glob` page is sampled across top-level entries instead of taking the modification-time head. */
  sampleOverCapGlobResults: boolean
  /** Max paths one `glob` call retains inline; later paths go to the formatted spill file. */
  globMaxResults?: number
  /** Max flat matches one `grep` call retains inline; later matches go to the formatted spill file. */
  grepMaxMatches?: number
  /** Max bytes retained for one matched-line preview (the cut preserves UTF-8 boundaries). */
  grepMaxLineBytes?: number
  /** Max bytes of one search's serialized `presentationMeta`; trailing groups/paths drop past it so the persisted card stays bounded. */
  searchMetaMaxBytes?: number
  /** Max complete raw `rg` stdout bytes a search will parse; larger raw output fails with `SEARCH_RAW_OUTPUT_OVERFLOW`. */
  rawOutputMaxBytes?: number
  /** Terminate-escalation grace (ms), handed to the subprocess seam and bounded by `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
  /** Max bytes retained for one search's stderr tail; the excerpt is embedded in `SEARCH_*` error messages, never shown on success. */
  stderrMaxBytes?: number
  /**
   * Cooperative tool-call timeout budget (ms) on both tools, enforced by
   * `@deepseek-ai/dsh-tool-call-timeout-policy` through `exec.signal`.
   */
  timeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-fs-search -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-goal -->
<a id="deepseek-aidsh-tool-goal"></a>

## `@deepseek-ai/dsh-tool-goal`

- `inject`: `agents` · `goals` · `tools` · `systemPrompt`
- `source`: [`packages/goal/tool-goal/src/index.ts:32`](../packages/goal/tool-goal/src/index.ts)

```ts config-catalog
/** Model policy and hard lower bounds for goal-state updates. */
export interface Config {
  /** Minimum admitted goal rounds before the model may self-report `blocked`. */
  blockedAfterConsecutiveRounds?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-goal -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-jobs -->
<a id="deepseek-aidsh-tool-jobs"></a>

## `@deepseek-ai/dsh-tool-jobs`

- `inject`: `tools` · `jobs` · `systemPrompt`
- `source`: [`packages/jobs/tool-jobs/src/index.ts:43`](../packages/jobs/tool-jobs/src/index.ts)

```ts config-catalog
/** Configures bounded `job_output` waits and completion-notice delivery. */
export interface Config {
  /** Wait duration applied when `job_output` sets `wait` without `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
  /** Whether a completion opens a turn on an idle owner (default `wakeup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by completion wakes before the next
   * notice degrades to injection, reset by any user-authored input. Absent by
   * default: every idle completion wakes its owner. Set it to bound the
   * self-exciting chain where a woken turn starts the job whose completion
   * wakes it again, at the cost of notices past the cap waiting silently for
   * the next user input.
   */
  maxConsecutiveWakes?: number
  /**
   * Largest complete completion notice, in UTF-8 bytes, that carries the
   * job's output and final result inline (default 2048); a larger one, or one
   * over the producer's `outputLimitBytes`, leaves them for `job_output`. 0
   * never inlines.
   */
  inlineOutputBytes?: number
}

/**
 * How an uncollected completion reaches an owner that is already idle: `wakeup`
 * opens a turn for it, `quiet` leaves it pending until something else wakes the
 * owner. A busy owner is injected either way.
 */
export type CompletionDelivery = 'quiet' | 'wakeup'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-jobs -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-lsp -->
<a id="deepseek-aidsh-tool-lsp"></a>

## `@deepseek-ai/dsh-tool-lsp`

- `inject`: `tools` · `lsp` · `systemPrompt` · `workingDirectory`
- `source`: [`packages/lsp/tool-lsp/src/index.ts:56`](../packages/lsp/tool-lsp/src/index.ts)

```ts config-catalog
/** Plugin configuration: result caps and the timeout budget. */
export interface Config {
  /** Largest number of rendered locations before an omission marker (default 100). */
  maxLocations?: number
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 60000). */
  timeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-lsp -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-present -->
<a id="deepseek-aidsh-tool-present"></a>

## `@deepseek-ai/dsh-tool-present`

- `inject`: `tools` · `fs` · `agents` · `workingDirectory`
- `source`: [`packages/deliverables/tool-present/src/index.ts:15`](../packages/deliverables/tool-present/src/index.ts)

```ts config-catalog
/** Per-call delivery limit. */
export interface Config {
  /** Maximum number of files in one call. */
  maxFiles: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-present -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-pwsh -->
<a id="deepseek-aidsh-tool-pwsh"></a>

## `@deepseek-ai/dsh-tool-pwsh`

- `inject`: `tools` · `shell` · `systemPrompt` · `shellEnv` · `workingDirectory`
- `source`: [`packages/shell/tool-pwsh/src/index.ts:54`](../packages/shell/tool-pwsh/src/index.ts)

```ts config-catalog
/** Configuration for the pwsh tool. */
export interface Config {
  /**
   * Expose `run_in_background` while a job registry is composed (default
   * true); disabled calls are also rejected. Without a registry the tool is
   * foreground-only regardless.
   */
  enableRunInBackground?: boolean
  /**
   * Keep a foreground command that reaches its timeout running as a
   * background job instead of killing it (default true). Applies only while
   * background execution is available: with `enableRunInBackground` false or
   * no job registry, the executor's deadline kills the command. A foreground
   * command the registry refuses at its start (admission or a missing
   * controller) also runs under the deadline kill.
   */
  promoteOnTimeout?: boolean
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-pwsh -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-pwsh-persistent -->
<a id="deepseek-aidsh-tool-pwsh-persistent"></a>

## `@deepseek-ai/dsh-tool-pwsh-persistent`

- `inject`: `tools` · `terminals` · `workingDirectory`
- `source`: [`packages/shell/tool-pwsh-persistent/src/index.ts:458`](../packages/shell/tool-pwsh-persistent/src/index.ts)

```ts config-catalog
/** Configuration for the persistent pwsh tool. */
export interface Config {
  /** PTY backend used for each owner-isolated persistent shell (default `shell`). */
  backendType?: string
  /** Wall-clock limit for one command (default 300000). */
  timeoutMs?: number
  /** Maximum returned command-output characters before clipping (default 16000). */
  maxOutputChars?: number
  /** Model-facing tool description; deployments may describe their environment. */
  description?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-pwsh-persistent -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-ralph -->
<a id="deepseek-aidsh-tool-ralph"></a>

## `@deepseek-ai/dsh-tool-ralph`

- `inject`: `tools` · `workflowEngine` · `subagents` · `systemPrompt`
- `source`: [`packages/experimental/tool-ralph/src/index.ts:21`](../packages/experimental/tool-ralph/src/index.ts)

```ts config-catalog
/** Deployment policy for the fixed Ralph workflow. */
export interface Config {
  /** Fresh structured-output provider used for every round (default `spawn`). */
  subagentProvider?: string
  /** Default and deployment ceiling for one call's round count (default 256). */
  maxRounds?: number
  /** Maximum serialized characters in one structured handoff (default 16384). */
  maxHandoffChars?: number
  /** Maximum characters in a successful parent-facing terminal text (default 16384). */
  maxResultChars?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-ralph -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-session-query -->
<a id="deepseek-aidsh-tool-session-query"></a>

## `@deepseek-ai/dsh-tool-session-query`

- `inject`: `tools` · `systemPrompt` · `sessionQuery` · `agents`
- `source`: [`packages/experimental/tool-session-query/src/index.ts:28`](../packages/experimental/tool-session-query/src/index.ts)

```ts config-catalog
/** Deployment-owned search count and timeout bounds. */
export interface Config {
  /** Maximum authorized hits returned by one search call. Defaults to 100. */
  maxSearchResults?: number
  /** Cooperative full-text search deadline in milliseconds. Defaults to 30000. */
  searchTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-session-query -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-skill -->
<a id="deepseek-aidsh-tool-skill"></a>

## `@deepseek-ai/dsh-tool-skill`

- `inject`: `agents` · `tools` · `skills` · `workingDirectory`
- `source`: [`packages/skill/tool-skill/src/index.ts:64`](../packages/skill/tool-skill/src/index.ts)

```ts config-catalog
/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-skill -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-str-replace-editor -->
<a id="deepseek-aidsh-tool-str-replace-editor"></a>

## `@deepseek-ai/dsh-tool-str-replace-editor`

- `inject`: `tools` · `fs`
- `source`: [`packages/fs/tool-str-replace-editor/src/index.ts:506`](../packages/fs/tool-str-replace-editor/src/index.ts)

```ts config-catalog
/** Configuration for the string-replacement editor tool. */
export interface Config {
  /** Maximum returned view characters before clipping (default 16000). */
  maxOutputChars?: number
  /** Model-facing tool description. */
  description?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-str-replace-editor -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-subagent -->
<a id="deepseek-aidsh-tool-subagent"></a>

## `@deepseek-ai/dsh-tool-subagent`

- `inject`: `tools` · `subagents` · `systemPrompt` · `sessionProjections`
- `refs`: [`AgentOptions`](subsystems/core.zh.md)
- `source`: [`packages/subagent/tool-subagent/src/index.ts:46`](../packages/subagent/tool-subagent/src/index.ts)

```ts config-catalog
/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config extends PresetSelectionConfig {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Expose optional child `provider`, `model`, and `reasoning_effort` fields.
   * Requires provider `agentOptions` support. Execution enforces the Session
   * policy, or restricts explicit selection to the current parent route.
   */
  modelSelection?: boolean
  /**
   * Register the shared `list_subagent_models` tool for this scope.
   * Enable on only one instance per scope; defaults to false and does not
   * enable model selection. Discovery is removed when this instance unloads.
   */
  modelDiscovery?: boolean
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Maximum child depth: a non-negative safe integer (`0` forbids delegation),
   * or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment. Omission reads
   * the current Host subagent depth setting (default `1`) at each delegation.
   */
  maxDepth?: number | 'provider-managed'
}

/** Optional default and model-selectable preset ids for a spawn tool. */
export interface PresetSelectionConfig {
  /** Default independent preset; omission inherits the parent when the model makes no selection. */
  agentPreset?: string
  /** Non-empty allowlist exposing agent_preset to the model; omission disables model selection. */
  allowedAgentPresets?: string[] | undefined
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-subagent -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-terminal -->
<a id="deepseek-aidsh-tool-terminal"></a>

## `@deepseek-ai/dsh-tool-terminal`

- `inject`: `terminals` · `tools` · `systemPrompt` · `workingDirectory`
- `source`: [`packages/experimental/tool-terminal/src/index.ts:38`](../packages/experimental/tool-terminal/src/index.ts)

```ts config-catalog
/** Model-facing terminal tool configuration. */
export interface Config {
  /** Expose `run_in_background` and accept background sends (default true). */
  enableRunInBackground?: boolean
  /** Maximum UTF-8 bytes in one complete terminal or task-output result. */
  maxResultBytes?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-terminal -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-todo -->
<a id="deepseek-aidsh-tool-todo"></a>

## `@deepseek-ai/dsh-tool-todo`

- `inject`: `tools` · `sessionProjections`
- `source`: [`packages/todo/tool-todo/src/index.ts:29`](../packages/todo/tool-todo/src/index.ts)

```ts config-catalog
/** Model-facing todo tool configuration. */
export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected.
   */
  allowParallelInProgress: boolean
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-todo -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-web -->
<a id="deepseek-aidsh-tool-web"></a>

## `@deepseek-ai/dsh-tool-web`

- `inject`: `tools` · `web` · `systemPrompt`
- `source`: [`packages/web/tool-web/src/index.ts:39`](../packages/web/tool-web/src/index.ts)

```ts config-catalog
/** Plugin config: which web tools to register, search bounds, per-tool budgets, and the fetch output cap. */
export interface Config {
  /** Register `web_search`. Defaults to true. */
  search?: boolean
  /** Register `web_fetch`. Defaults to true. */
  fetch?: boolean
  /** Upper bound on sources returned by one `web_search` call. */
  searchMaxResults?: number
  /** Upper bound on queries accepted by one `web_search` call. */
  searchMaxQueries?: number
  /** Cap on each source summary in `web_search` output, in characters. Defaults to 800. */
  searchSummaryMaxChars?: number
  /** Cooperative timeout budget (ms) for `web_fetch`. Defaults to 30000. */
  fetchTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `web_search`. Defaults to 30000. */
  searchTimeoutMs?: number
  /** Cap on source characters converted and complete `web_fetch` output characters. Defaults to 200000. */
  fetchMaxOutputChars?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-web -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-workflow -->
<a id="deepseek-aidsh-tool-workflow"></a>

## `@deepseek-ai/dsh-tool-workflow`

- `inject`: `tools` · `workflowEngine` · `systemPrompt`
- `source`: [`packages/workflow/tool-workflow/src/index.ts:44`](../packages/workflow/tool-workflow/src/index.ts)

```ts config-catalog
/** Config: the model-facing tool name plus result rendering caps. */
export interface Config {
  /** The model-facing tool name to register (default `workflow`). */
  toolName?: string
  /** Rendered-result ceiling, in characters: a longer JSON value is truncated with a notice (default 50000). */
  maxResultChars?: number
  /**
   * Expose `run_in_background` (default true); disabled calls are also
   * rejected. A background run needs a live `ctx.jobs` registry with a
   * controller serving the caller (`dsh-jobs-local` plus `dsh-tool-jobs` in
   * the shipped composition); without one the call fails with the missing
   * piece named.
   */
  enableRunInBackground?: boolean
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-workflow -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-tool-workspace-dependencies -->
<a id="deepseek-aidsh-tool-workspace-dependencies"></a>

## `@deepseek-ai/dsh-tool-workspace-dependencies`

- `inject`: `tools`
- `source`: [`packages/skill/tool-workspace-dependencies/src/index.ts:15`](../packages/skill/tool-workspace-dependencies/src/index.ts)

```ts config-catalog
/** Payload location and optional installation directory. */
export interface Config {
  /** Payload directory carrying `runtime.json` and `dependencies/`. */
  readonly source: string
  /**
   * Installation directory under the Harness home. When set, the payload is copied there on the
   * first call (the Desktop behavior); when omitted, the payload is used in place without copying,
   * which suits read-only carriers such as container image layers.
   */
  readonly root?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-tool-workspace-dependencies -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-typert-loader -->
<a id="deepseek-aidsh-typert-loader"></a>

## `@deepseek-ai/dsh-typert-loader`

- `inject`: `typert` · `loader`
- `source`: [`packages/typert/loader/src/index.ts:48`](../packages/typert/loader/src/index.ts)

```ts config-catalog
/** Additional package artifacts whose owning plugins are nested behind another Loader entry. */
export interface Config {
  /** Exact npm package names that must resolve and export `./typert`. */
  packages?: string[]
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-typert-loader -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-user-approval -->
<a id="deepseek-aidsh-user-approval"></a>

## `@deepseek-ai/dsh-user-approval`

- `inject`: `sessionProjections`
- `source`: [`packages/interaction/user-approval/src/index.ts:152`](../packages/interaction/user-approval/src/index.ts)

```ts config-catalog
/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * The deployment's default {@link ApprovalPolicy} for sessions without an
   * `approval/policy` override — `'ask'` delegates to the composed answerers
   * (fail-closed with none); `'never'` auto-rejects every ask without
   * prompting (the deterministic CI/unattended stance).
   */
  readonly policy?: ApprovalPolicy
}

/**
 * A session's approval policy — what happens to an {@link ApprovalService}
 * ask BEFORE any interactive answerer sees it:
 *
 * - `'ask'` (the default) — delegate to the composed answerers; with none
 *   composed the chain falls through to the fail-closed `'unavailable'`.
 * - `'never'` — never prompt anyone: every ask resolves `'rejected'`
 *   deterministically. The strict headless stance (CI, unattended runs) and
 *   the policy whose outcome is knowable without asking.
 */
export type ApprovalPolicy = 'ask' | 'never'
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-user-approval -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-web -->
<a id="deepseek-aidsh-web"></a>

## `@deepseek-ai/dsh-web`

- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/web/web/src/index.ts:57`](../packages/web/web/src/index.ts)

```ts config-catalog
/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Each operation reads the current value, so a settings
 * change applies to the next search or fetch without remounting the service.
 * Operational overrides such as environment variables must feed these same
 * fields rather than introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider: Volatile<string | undefined>
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider: Volatile<string | undefined>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-web -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-web-app -->
<a id="deepseek-aidsh-web-app"></a>

## `@deepseek-ai/dsh-web-app`

- `inject`: `webServer`
- `source`: [`packages/bundle/web-app/src/index.ts:55`](../packages/bundle/web-app/src/index.ts)

```ts config-catalog
/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; an SSH launch suppresses it. */
  openBrowser: boolean
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the `DSH_WEB_URL` bash variable naming this GUI. A one-shot
   * non-interactive layer can turn it off when its user is not in the GUI.
   */
  surfaceContext: boolean
  /**
   * Canonical HTTP(S) root to advertise in the printed and opened URL,
   * `DSH_WEB_URL`, and `webApp.getAdvertisedUrl()`, which supplies the Web GUI
   * URL in agent runtime context, e.g. `https://app.example/ui/`, normalized to end in `/`. Configures no routing
   * or authentication; see [public deployments](../README.md#public-deployments).
   * Absent or YAML `null` advertises the bind-address URL.
   */
  publicUrl?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-web-app -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-web-deepseek-api -->
<a id="deepseek-aidsh-web-deepseek-api"></a>

## `@deepseek-ai/dsh-web-deepseek-api`

- `inject`: `web`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/web/web-deepseek-api/src/index.ts:36`](../packages/web/web-deepseek-api/src/index.ts)

```ts config-catalog
/** Settings read by the next search or fetch without re-registering either provider. */
export interface Config {
  /** Literal DeepSeek API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each operation; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** API base including its path prefix; `/search` and `/fetch` are appended. */
  baseURL: Volatile<string>
  /** Search API results per search, from 1 through 50; a smaller request bound wins. Defaults to 10. */
  count: Volatile<number>
  /** Send the triggering user question, bounded to 128 characters, as `ori_question`. Defaults to true. */
  sendOriginalQuestion: Volatile<boolean>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-web-deepseek-api -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-web-fetch-http -->
<a id="deepseek-aidsh-web-fetch-http"></a>

## `@deepseek-ai/dsh-web-fetch-http`

- `inject`: `web`
- `source`: [`packages/web/web-fetch-http/src/index.ts:32`](../packages/web/web-fetch-http/src/index.ts)

```ts config-catalog
/** Plugin config: the provider's transport and size limits plus its `User-Agent` (all defaulted). */
export interface Config {
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-web-fetch-http -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-web-search-deepseek -->
<a id="deepseek-aidsh-web-search-deepseek"></a>

## `@deepseek-ai/dsh-web-search-deepseek`

- `inject`: `web`
- `refs`: `Volatile` (`@deepseek-ai/cordis`)
- `source`: [`packages/web/web-search-deepseek/src/index.ts:51`](../packages/web/web-search-deepseek/src/index.ts)

```ts config-catalog
/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal DeepSeek API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Anthropic-compatible endpoint base; `/messages` is appended. */
  baseURL: Volatile<string | undefined>
  /** Anthropic-format model name. Defaults to `deepseek-v4-flash`. */
  model: Volatile<string>
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion: Volatile<string>
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens: Volatile<number>
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses: Volatile<number>
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-web-search-deepseek -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-web-search-exa -->
<a id="deepseek-aidsh-web-search-exa"></a>

## `@deepseek-ai/dsh-web-search-exa`

- `inject`: `web`
- `source`: [`packages/web/web-search-exa/src/index.ts:35`](../packages/web/web-search-exa/src/index.ts)

```ts config-catalog
/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Exa API key. Falls back to `$EXA_API_KEY`. Empty → provider unavailable. */
  apiKey?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`. Defaults to `auto`. */
  searchType?: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  numResults?: number
  /** Highlight sentences requested per result. Defaults to 1. */
  highlightsPerResult?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-web-search-exa -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-web-search-perplexity -->
<a id="deepseek-aidsh-web-search-perplexity"></a>

## `@deepseek-ai/dsh-web-search-perplexity`

- `inject`: `web`
- `source`: [`packages/web/web-search-perplexity/src/index.ts:30`](../packages/web/web-search-perplexity/src/index.ts)

```ts config-catalog
/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Perplexity API key. Falls back to `$PERPLEXITY_API_KEY`. Empty → unavailable. */
  apiKey?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to the public API. */
  baseURL?: string
  /** Search model name. Defaults to `sonar`. */
  model?: string
  /** Upper bound on generated answer tokens. Defaults to 1024. */
  maxTokens?: number
  /** Recency window sent as `search_recency_filter`. Omitted = no filter. */
  searchRecency?: 'day' | 'week' | 'month' | 'year'
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-web-search-perplexity -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-webhook-github -->
<a id="deepseek-aidsh-webhook-github"></a>

## `@deepseek-ai/dsh-webhook-github`

- `inject`: `webServer` · `webhookRuntime` · `credentials`
- `source`: [`packages/experimental/webhook-github/src/index.ts:17`](../packages/experimental/webhook-github/src/index.ts)

```ts config-catalog
/** Required GitHub ingress configuration. */
export interface Config {
  /** Adapter instance name carried to rules. */
  readonly source: string
  /** Exact absolute route path. */
  readonly path: string
  /** Credential reference containing the shared webhook secret. */
  readonly secretEnv: string
  /** Positive raw body ceiling in bytes. */
  readonly maxBodyBytes: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-webhook-github -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-workflow-ptc -->
<a id="deepseek-aidsh-workflow-ptc"></a>

## `@deepseek-ai/dsh-workflow-ptc`

- `inject`: `subagents` · `ptcRuntime` · `sandboxPolicy` · `workingDirectory`
- `source`: [`packages/workflow/workflow-ptc/src/index.ts:33`](../packages/workflow/workflow-ptc/src/index.ts)

```ts config-catalog
/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** The `ctx.subagents` provider children run on (default `spawn`). */
  provider?: string
  /** Concurrent `agent()` ceiling; `0` (the default) auto-resolves to `min(16, max(1, cores - 2))`. */
  maxConcurrentAgents?: number
  /** Total `agent()` calls one run may start — the runaway-loop backstop (default 1000). */
  maxTotalAgents?: number
  /** Items accepted by a single `parallel()`/`pipeline()` call (default 4096). */
  maxItemsPerCall?: number
  /** VM timeout for the script's initial synchronous slice (default 5000 ms). */
  syncTimeoutMs?: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-workflow-ptc -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-working-directory -->
<a id="deepseek-aidsh-working-directory"></a>

## `@deepseek-ai/dsh-working-directory`

- `inject`: `fs` · `sessionProjections` · `systemPrompt`
- `source`: [`packages/session/working-directory/src/index.ts:51`](../packages/session/working-directory/src/index.ts)

```ts config-catalog
/** Deployment default for Sessions without an original project directory. */
export interface Config {
  /** Absolute execution-world fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-working-directory -->

<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-workspace-changes -->
<a id="deepseek-aidsh-workspace-changes"></a>

## `@deepseek-ai/dsh-workspace-changes`

- `inject`: `subprocess` · `fs`
- `source`: [`packages/deliverables/workspace-changes/src/index.ts:34`](../packages/deliverables/workspace-changes/src/index.ts)

```ts config-catalog
/** Snapshot, capture, and comparison bounds. Invalid values fail plugin load. */
export interface Config {
  /** Milliseconds one git command may run before the turn's record is abandoned. */
  timeoutMs: number
  /** Bytes of git output retained per command; a larger diff listing abandons the record. */
  outputMaxBytes: number
  /** Maximum files carried by one summary; `total` still reports the complete count. */
  maxFiles: number
  /**
   * Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison.
   * A larger file gets no comparison; one captured around a file-tool edit is also listed without counts.
   */
  maxFileBytes: number
  /** Milliseconds a line comparison may run before it degrades to whole-file replacement. */
  diffTimeoutMs: number
}
```
<!-- END GENERATED config-catalog:@deepseek-ai/dsh-workspace-changes -->

## 无配置的可加载插件

这些插件通过 `cordis.yml` 中不含 `config:` 块的条目加载；它们未声明任何配置接口。

<!-- BEGIN GENERATED config-catalog:no-config -->
| `package` | `inject` | `source` |
| --- | --- | --- |
| `@deepseek-ai/dsh-acp-app` | `cmdlineArgs` | [`packages/bundle/acp-app/src/index.ts`](../packages/bundle/acp-app/src/index.ts) |
| `@deepseek-ai/dsh-agent` | `sessionProjections` | [`packages/core/agent/src/index.ts`](../packages/core/agent/src/index.ts) |
| `@deepseek-ai/dsh-api-account-controller` | `deepseekAccount` · `agents` | [`packages/api/account-controller/src/index.ts`](../packages/api/account-controller/src/index.ts) |
| `@deepseek-ai/dsh-api-remote-access` | — | [`packages/api/remote-access/src/index.ts`](../packages/api/remote-access/src/index.ts) |
| `@deepseek-ai/dsh-api-remotes` | `typertGateway` | [`packages/api/remotes/src/index.ts`](../packages/api/remotes/src/index.ts) |
| `@deepseek-ai/dsh-authorization` | `credentials` | [`packages/credentials/authorization/src/index.ts`](../packages/credentials/authorization/src/index.ts) |
| `@deepseek-ai/dsh-browser-use` | — | [`packages/browser-use/browser-use/src/index.ts`](../packages/browser-use/browser-use/src/index.ts) |
| `@deepseek-ai/dsh-client-file-upload` | `agents` · `attachments` · `commands` · `connection` | [`packages/client/file-upload/src/index.ts`](../packages/client/file-upload/src/index.ts) |
| `@deepseek-ai/dsh-client-locale` | — | [`packages/client/locale/src/index.ts`](../packages/client/locale/src/index.ts) |
| `@deepseek-ai/dsh-client-modules` | `loader` | [`packages/client/modules/src/index.ts`](../packages/client/modules/src/index.ts) |
| `@deepseek-ai/dsh-client-resources` | — | [`packages/client/resources/src/index.ts`](../packages/client/resources/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-action-cards` | — | [`packages/experimental/client-ui-action-cards/src/index.ts`](../packages/experimental/client-ui-action-cards/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-agent-preset` | — | [`packages/client/ui-agent-preset/src/index.ts`](../packages/client/ui-agent-preset/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-approval` | — | [`packages/client/ui-approval/src/index.ts`](../packages/client/ui-approval/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-attachment` | — | [`packages/client/ui-attachment/src/index.ts`](../packages/client/ui-attachment/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-brand-official` | — | [`packages/client/ui-brand-official/src/index.ts`](../packages/client/ui-brand-official/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-chat` | — | [`packages/client/ui-chat/src/index.ts`](../packages/client/ui-chat/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-commands` | — | [`packages/client/ui-commands/src/index.ts`](../packages/client/ui-commands/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-conversation` | — | [`packages/client/ui-conversation/src/index.ts`](../packages/client/ui-conversation/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-cordis` | — | [`packages/extensions/ui-cordis/src/index.ts`](../packages/extensions/ui-cordis/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-creation-recommendations` | — | [`packages/experimental/client-ui-creation-recommendations/src/index.ts`](../packages/experimental/client-ui-creation-recommendations/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-deliverables` | `connection` · `sessionQuery` · `sessionController` · `workspaceFiles` · `fs` · `sandboxPolicy` · `workspaceChanges` | [`packages/client/ui-deliverables/src/index.ts`](../packages/client/ui-deliverables/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-directory-picker-browse` | — | [`packages/client/ui-directory-picker-browse/src/index.ts`](../packages/client/ui-directory-picker-browse/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-directory-picker-native` | — | [`packages/client/ui-directory-picker-native/src/index.ts`](../packages/client/ui-directory-picker-native/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-entry-customization` | — | [`packages/client/ui-entry-customization/src/index.ts`](../packages/client/ui-entry-customization/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-file-drag` | — | [`packages/client/ui-file-drag/src/index.ts`](../packages/client/ui-file-drag/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-goal` | — | [`packages/client/ui-goal/src/index.ts`](../packages/client/ui-goal/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-input-trigger` | — | [`packages/client/ui-input-trigger/src/index.ts`](../packages/client/ui-input-trigger/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-jobs` | — | [`packages/client/ui-jobs/src/index.ts`](../packages/client/ui-jobs/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-layout` | — | [`packages/client/ui-layout/src/index.ts`](../packages/client/ui-layout/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-message-feedback` | — | [`packages/client/ui-message-feedback/src/index.ts`](../packages/client/ui-message-feedback/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-model-selection` | — | [`packages/client/ui-model-selection/src/index.ts`](../packages/client/ui-model-selection/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-open-in-app` | — | [`packages/client/ui-open-in-app/src/index.ts`](../packages/client/ui-open-in-app/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-permission-presets` | — | [`packages/client/ui-permission-presets/src/index.ts`](../packages/client/ui-permission-presets/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-plan` | — | [`packages/client/ui-plan/src/index.ts`](../packages/client/ui-plan/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-plugin-market` | — | [`packages/client/ui-plugin-market/src/index.ts`](../packages/client/ui-plugin-market/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-plugin-recommendations` | — | [`packages/experimental/client-ui-plugin-recommendations/src/index.ts`](../packages/experimental/client-ui-plugin-recommendations/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-reference` | — | [`packages/client/ui-reference/src/index.ts`](../packages/client/ui-reference/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-renderer` | — | [`packages/client/ui-renderer/src/index.ts`](../packages/client/ui-renderer/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-schedule` | — | [`packages/client/ui-schedule/src/index.ts`](../packages/client/ui-schedule/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-secret-mask` | — | [`packages/client/ui-secret-mask/src/index.ts`](../packages/client/ui-secret-mask/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-session` | — | [`packages/client/ui-session/src/index.ts`](../packages/client/ui-session/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings` | — | [`packages/client/ui-settings/src/index.ts`](../packages/client/ui-settings/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-agent-loop` | — | [`packages/client/ui-settings-agent-loop/src/index.ts`](../packages/client/ui-settings-agent-loop/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-general` | — | [`packages/client/ui-settings-general/src/index.ts`](../packages/client/ui-settings-general/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` | — | [`packages/client/ui-settings-plugin-inventory/src/index.ts`](../packages/client/ui-settings-plugin-inventory/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | — | [`packages/client/ui-settings-plugins/src/index.ts`](../packages/client/ui-settings-plugins/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-session-log` | — | [`packages/client/ui-settings-session-log/src/index.ts`](../packages/client/ui-settings-session-log/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-shell` | — | [`packages/client/ui-settings-shell/src/index.ts`](../packages/client/ui-settings-shell/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-subagent` | — | [`packages/client/ui-settings-subagent/src/index.ts`](../packages/client/ui-settings-subagent/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-settings-web-search` | — | [`packages/client/ui-settings-web-search/src/index.ts`](../packages/client/ui-settings-web-search/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-shortcuts` | — | [`packages/client/ui-shortcuts/src/index.ts`](../packages/client/ui-shortcuts/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-sidebar` | — | [`packages/client/ui-sidebar/src/index.ts`](../packages/client/ui-sidebar/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | — | [`packages/client/ui-sidebar-browser/src/index.ts`](../packages/client/ui-sidebar-browser/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | — | [`packages/client/ui-sidebar-files/src/index.ts`](../packages/client/ui-sidebar-files/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | — | [`packages/client/ui-sidebar-right/src/index.ts`](../packages/client/ui-sidebar-right/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-sidebar-terminal` | — | [`packages/client/ui-sidebar-terminal/src/index.ts`](../packages/client/ui-sidebar-terminal/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-skill` | — | [`packages/client/ui-skill/src/index.ts`](../packages/client/ui-skill/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-subagent` | — | [`packages/client/ui-subagent/src/index.ts`](../packages/client/ui-subagent/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-tool` | — | [`packages/client/ui-tool/src/index.ts`](../packages/client/ui-tool/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-user-questions` | — | [`packages/client/ui-user-questions/src/index.ts`](../packages/client/ui-user-questions/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-workflow-run` | — | [`packages/client/ui-workflow-run/src/index.ts`](../packages/client/ui-workflow-run/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-workspace` | — | [`packages/client/ui-workspace/src/index.ts`](../packages/client/ui-workspace/src/index.ts) |
| `@deepseek-ai/dsh-command-compact` | `commands` · `compaction` | [`packages/compaction/command-compact/src/index.ts`](../packages/compaction/command-compact/src/index.ts) |
| `@deepseek-ai/dsh-command-feedback` | `commands` | [`packages/feedback/command-feedback/src/index.ts`](../packages/feedback/command-feedback/src/index.ts) |
| `@deepseek-ai/dsh-command-goal` | `commands` · `goals` | [`packages/goal/command-goal/src/index.ts`](../packages/goal/command-goal/src/index.ts) |
| `@deepseek-ai/dsh-commands` | — | [`packages/interaction/commands/src/index.ts`](../packages/interaction/commands/src/index.ts) |
| `@deepseek-ai/dsh-compaction-image-offload` | `agents` · `sessions` | [`packages/compaction/compaction-image-offload/src/index.ts`](../packages/compaction/compaction-image-offload/src/index.ts) |
| `@deepseek-ai/dsh-computer-use` | — | [`packages/computer-use/computer-use/src/index.ts`](../packages/computer-use/computer-use/src/index.ts) |
| `@deepseek-ai/dsh-config-editor` | `loader` · `profileContext` | [`packages/boot/config-editor/src/index.ts`](../packages/boot/config-editor/src/index.ts) |
| `@deepseek-ai/dsh-cordis-client-runner` | — | [`packages/extensions/cordis-client-runner/src/index.ts`](../packages/extensions/cordis-client-runner/src/index.ts) |
| `@deepseek-ai/dsh-creation-recommendations` | `tools` · `pluginManager` · `agents` · `subagents` · `profileContext` · `skills` · `actionCards` | [`packages/experimental/creation-recommendations/src/index.ts`](../packages/experimental/creation-recommendations/src/index.ts) |
| `@deepseek-ai/dsh-cua` | — | [`packages/experimental/cua/src/index.ts`](../packages/experimental/cua/src/index.ts) |
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | — | [`packages/llm/deepseek-llm-api-extensions/src/index.ts`](../packages/llm/deepseek-llm-api-extensions/src/index.ts) |
| `@deepseek-ai/dsh-deliverable-file-references` | `systemPrompt` | [`packages/deliverables/deliverable-file-references/src/index.ts`](../packages/deliverables/deliverable-file-references/src/index.ts) |
| `@deepseek-ai/dsh-experimental-auto-review` | `approval` · `llm` · `permissionPresets` · `sessions` · `tools` · `workingDirectory` | [`packages/experimental/auto-review/src/index.ts`](../packages/experimental/auto-review/src/index.ts) |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | — | [`packages/experimental/client-ui-agent-team/src/index.ts`](../packages/experimental/client-ui-agent-team/src/index.ts) |
| `@deepseek-ai/dsh-experimental-client-ui-claude-code-mods` | — | [`packages/experimental/client-ui-claude-code-mods/src/index.ts`](../packages/experimental/client-ui-claude-code-mods/src/index.ts) |
| `@deepseek-ai/dsh-experimental-client-ui-stats` | — | [`packages/experimental/client-ui-stats/src/index.ts`](../packages/experimental/client-ui-stats/src/index.ts) |
| `@deepseek-ai/dsh-experimental-client-ui-voice-input` | — | [`packages/experimental/client-ui-voice-input/src/index.ts`](../packages/experimental/client-ui-voice-input/src/index.ts) |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | `computerUse` · `tools` · `systemPrompt` | [`packages/experimental/computer-use-cua-driver-native/src/index.ts`](../packages/experimental/computer-use-cua-driver-native/src/index.ts) |
| `@deepseek-ai/dsh-experimental-session-inspector` | — | [`packages/experimental/session-inspector/src/index.ts`](../packages/experimental/session-inspector/src/index.ts) |
| `@deepseek-ai/dsh-experimental-tool-worktree` | `tools` · `worktrees` | [`packages/experimental/tool-worktree/src/index.ts`](../packages/experimental/tool-worktree/src/index.ts) |
| `@deepseek-ai/dsh-fs-observation-policy` | — | [`packages/fs/fs-observation-policy/src/index.ts`](../packages/fs/fs-observation-policy/src/index.ts) |
| `@deepseek-ai/dsh-fs-ssh` | `ssh` · `sandboxPolicy` | [`packages/ssh/fs-ssh/src/index.ts`](../packages/ssh/fs-ssh/src/index.ts) |
| `@deepseek-ai/dsh-goal-round-driver` | `agents` · `goals` · `sessions` | [`packages/goal/goal-round-driver/src/index.ts`](../packages/goal/goal-round-driver/src/index.ts) |
| `@deepseek-ai/dsh-harness-dev-context` | `systemPrompt` · `sessionProjections` · `webApp` | [`packages/context/harness-dev-context/src/index.ts`](../packages/context/harness-dev-context/src/index.ts) |
| `@deepseek-ai/dsh-host-directory-picker-auto` | `webServer` · `connection` · `loader` | [`packages/host/directory-picker-auto/src/index.ts`](../packages/host/directory-picker-auto/src/index.ts) |
| `@deepseek-ai/dsh-host-directory-picker-native` | — | [`packages/host/directory-picker-native/src/index.ts`](../packages/host/directory-picker-native/src/index.ts) |
| `@deepseek-ai/dsh-host-plugin-inventory` | `loader` | [`packages/host/plugin-inventory/src/index.ts`](../packages/host/plugin-inventory/src/index.ts) |
| `@deepseek-ai/dsh-llm` | — | [`packages/llm/llm/src/index.ts`](../packages/llm/llm/src/index.ts) |
| `@deepseek-ai/dsh-lsp` | — | [`packages/lsp/lsp/src/index.ts`](../packages/lsp/lsp/src/index.ts) |
| `@deepseek-ai/dsh-mcp-resources` | `tools` | [`packages/mcp/mcp-resources/src/index.ts`](../packages/mcp/mcp-resources/src/index.ts) |
| `@deepseek-ai/dsh-message-quotes` | — | [`packages/session/message-quotes/src/index.ts`](../packages/session/message-quotes/src/index.ts) |
| `@deepseek-ai/dsh-otel` | — | [`packages/telemetry/otel/src/index.ts`](../packages/telemetry/otel/src/index.ts) |
| `@deepseek-ai/dsh-plugin-recommendations` | `pluginManager` · `agents` · `skills` · `actionCards` | [`packages/experimental/plugin-recommendations/src/index.ts`](../packages/experimental/plugin-recommendations/src/index.ts) |
| `@deepseek-ai/dsh-sandbox-ssh` | `ssh` | [`packages/ssh/sandbox-ssh/src/index.ts`](../packages/ssh/sandbox-ssh/src/index.ts) |
| `@deepseek-ai/dsh-session` | — | [`packages/core/session/src/index.ts`](../packages/core/session/src/index.ts) |
| `@deepseek-ai/dsh-session-checkpoint-policy` | `llm` · `sessionPersistence` · `sessions` · `tools` | [`packages/session/session-checkpoint-policy/src/index.ts`](../packages/session/session-checkpoint-policy/src/index.ts) |
| `@deepseek-ai/dsh-session-projection` | — | [`packages/session/session-projection/src/index.ts`](../packages/session/session-projection/src/index.ts) |
| `@deepseek-ai/dsh-session-stats` | `sessionProjections` | [`packages/session/session-stats/src/index.ts`](../packages/session/session-stats/src/index.ts) |
| `@deepseek-ai/dsh-session-turn-outline` | `sessionProjections` | [`packages/session/session-turn-outline/src/index.ts`](../packages/session/session-turn-outline/src/index.ts) |
| `@deepseek-ai/dsh-settings` | `configEditor` · `profileContext` | [`packages/settings/settings/src/index.ts`](../packages/settings/settings/src/index.ts) |
| `@deepseek-ai/dsh-skill-badge` | `skills` | [`packages/experimental/skill-badge/src/index.ts`](../packages/experimental/skill-badge/src/index.ts) |
| `@deepseek-ai/dsh-storage` | — | [`packages/storage/storage/src/index.ts`](../packages/storage/storage/src/index.ts) |
| `@deepseek-ai/dsh-subprocess-local` | — | [`packages/subprocess/subprocess-local/src/index.ts`](../packages/subprocess/subprocess-local/src/index.ts) |
| `@deepseek-ai/dsh-subprocess-ssh` | `ssh` | [`packages/ssh/subprocess-ssh/src/index.ts`](../packages/ssh/subprocess-ssh/src/index.ts) |
| `@deepseek-ai/dsh-terminal` | — | [`packages/terminal/terminal/src/index.ts`](../packages/terminal/terminal/src/index.ts) |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | `tools` | [`packages/guard/timeout-policy/src/index.ts`](../packages/guard/timeout-policy/src/index.ts) |
| `@deepseek-ai/dsh-tool-cordis` | `tools` · `cordisInspect` | [`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts) |
| `@deepseek-ai/dsh-tool-executor-native` | `tools` | [`packages/core/tool-executor-native/src/index.ts`](../packages/core/tool-executor-native/src/index.ts) |
| `@deepseek-ai/dsh-tool-schedule` | `tools` | [`packages/schedule/tool-schedule/src/index.ts`](../packages/schedule/tool-schedule/src/index.ts) |
| `@deepseek-ai/dsh-tool-subagent-control` | `tools` · `subagents` · `agents` | [`packages/subagent/tool-subagent-control/src/index.ts`](../packages/subagent/tool-subagent-control/src/index.ts) |
| `@deepseek-ai/dsh-tool-working-directory` | `tools` · `workingDirectory` | [`packages/session/tool-working-directory/src/index.ts`](../packages/session/tool-working-directory/src/index.ts) |
| `@deepseek-ai/dsh-tools` | `systemPrompt` | [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts) |
| `@deepseek-ai/dsh-user-questions` | — | [`packages/interaction/user-questions/src/index.ts`](../packages/interaction/user-questions/src/index.ts) |
| `@deepseek-ai/dsh-webhook` | `agents` · `agentDefaultModel` · `agentPresets` · `permissionPresets` · `sessionTitle` · `workspaceRegistry` | [`packages/experimental/webhook/src/index.ts`](../packages/experimental/webhook/src/index.ts) |
| `@deepseek-ai/dsh-workspace` | `storageDomain` · `sessionPersistence` | [`packages/workspace/workspace/src/index.ts`](../packages/workspace/workspace/src/index.ts) |
<!-- END GENERATED config-catalog:no-config -->

## Seam 包（不可直接加载）

抽象服务类——部署时应改为加载具体的实现包（参见[能力 seam](../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）。

<!-- BEGIN GENERATED config-catalog:seam -->
| `package` | `class` | `inject` | `source` |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-attachment` | `AttachmentStore` | — | [`packages/attachment/attachment/src/index.ts`](../packages/attachment/attachment/src/index.ts) |
| `@deepseek-ai/dsh-compaction` | `CompactionEngine` | — | [`packages/compaction/compaction/src/index.ts`](../packages/compaction/compaction/src/index.ts) |
| `@deepseek-ai/dsh-credentials` | `CredentialProvider` | — | [`packages/credentials/credentials/src/index.ts`](../packages/credentials/credentials/src/index.ts) |
| `@deepseek-ai/dsh-deepseek-account` | `DeepSeekAccount` | — | [`packages/credentials/deepseek-account/src/index.ts`](../packages/credentials/deepseek-account/src/index.ts) |
| `@deepseek-ai/dsh-file-reference` | `FileReferenceService` | — | [`packages/context/file-reference/src/index.ts`](../packages/context/file-reference/src/index.ts) |
| `@deepseek-ai/dsh-fs` | `FileSystem` | — | [`packages/fs/fs/src/index.ts`](../packages/fs/fs/src/index.ts) |
| `@deepseek-ai/dsh-host-directory-picker` | `DirectoryPicker` | — | [`packages/host/directory-picker/src/index.ts`](../packages/host/directory-picker/src/index.ts) |
| `@deepseek-ai/dsh-jobs` | `JobRegistry` | — | [`packages/jobs/jobs/src/index.ts`](../packages/jobs/jobs/src/index.ts) |
| `@deepseek-ai/dsh-ptc-runtime` | `PtcRuntime` | — | [`packages/ptc-runtime/ptc-runtime/src/index.ts`](../packages/ptc-runtime/ptc-runtime/src/index.ts) |
| `@deepseek-ai/dsh-sandbox` | `SandboxProvider` | — | [`packages/sandbox/sandbox/src/index.ts`](../packages/sandbox/sandbox/src/index.ts) |
| `@deepseek-ai/dsh-session-persistence` | `SessionPersistence` | — | [`packages/session/session-persistence/src/index.ts`](../packages/session/session-persistence/src/index.ts) |
| `@deepseek-ai/dsh-session-query` | `SessionQueryEngine` | — | [`packages/session-query/session-query/src/index.ts`](../packages/session-query/session-query/src/index.ts) |
| `@deepseek-ai/dsh-shell` | `ShellExecutor` | — | [`packages/shell/shell/src/index.ts`](../packages/shell/shell/src/index.ts) |
| `@deepseek-ai/dsh-spill` | `SpillStore` | — | [`packages/spill/spill/src/index.ts`](../packages/spill/spill/src/index.ts) |
| `@deepseek-ai/dsh-subprocess` | `SubprocessRuntime` | — | [`packages/subprocess/subprocess/src/index.ts`](../packages/subprocess/subprocess/src/index.ts) |
| `@deepseek-ai/dsh-workflow` | `WorkflowEngine` | — | [`packages/workflow/workflow/src/index.ts`](../packages/workflow/workflow/src/index.ts) |
<!-- END GENERATED config-catalog:seam -->

## 库包（无插件入口）

由其他包作为库导入；`cordis.yml` 无法加载它们。

<!-- BEGIN GENERATED config-catalog:library -->
| `package` | `inject` | `source` |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-loop-testkit` | — | [`packages/test-support/agent-loop-testkit/src/index.ts`](../packages/test-support/agent-loop-testkit/src/index.ts) |
| `@deepseek-ai/dsh-anonymous-user-id` | — | [`packages/identity/anonymous-user-id/src/index.ts`](../packages/identity/anonymous-user-id/src/index.ts) |
| `@deepseek-ai/dsh-app-boot` | — | [`packages/boot/app-boot/src/index.ts`](../packages/boot/app-boot/src/index.ts) |
| `@deepseek-ai/dsh-atomic-write` | — | [`packages/util/atomic-write/src/index.ts`](../packages/util/atomic-write/src/index.ts) |
| `@deepseek-ai/dsh-base` | — | [`packages/bundle/base/src/index.ts`](../packages/bundle/base/src/index.ts) |
| `@deepseek-ai/dsh-brand` | — | [`packages/util/brand/src/index.ts`](../packages/util/brand/src/index.ts) |
| `@deepseek-ai/dsh-chunked-list` | — | [`packages/util/chunked-list/src/index.ts`](../packages/util/chunked-list/src/index.ts) |
| `@deepseek-ai/dsh-client-store` | — | [`packages/client/store/src/index.ts`](../packages/client/store/src/index.ts) |
| `@deepseek-ai/dsh-client-test-runtime` | — | [`packages/test-support/client-runtime/src/index.ts`](../packages/test-support/client-runtime/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-dockkit` | — | [`packages/client/ui-dockkit/src/index.ts`](../packages/client/ui-dockkit/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-primitives` | — | [`packages/client/ui-primitives/src/index.ts`](../packages/client/ui-primitives/src/index.ts) |
| `@deepseek-ai/dsh-client-ui-slots` | — | [`packages/client/ui-slots/src/index.ts`](../packages/client/ui-slots/src/index.ts) |
| `@deepseek-ai/dsh-client-web` | — | [`packages/client/web/src/index.ts`](../packages/client/web/src/index.ts) |
| `@deepseek-ai/dsh-cmdline` | — | [`packages/boot/cmdline/src/index.ts`](../packages/boot/cmdline/src/index.ts) |
| `@deepseek-ai/dsh-cua-bundle` | — | [`packages/experimental/cua-bundle/src/index.ts`](../packages/experimental/cua-bundle/src/index.ts) |
| `@deepseek-ai/dsh-deque` | — | [`packages/util/deque/src/index.ts`](../packages/util/deque/src/index.ts) |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | — | [`packages/experimental/agent-team-profile/src/index.ts`](../packages/experimental/agent-team-profile/src/index.ts) |
| `@deepseek-ai/dsh-experimental-badge-skill-bundle` | — | [`packages/experimental/badge-skill-bundle/src/index.ts`](../packages/experimental/badge-skill-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-browser-use-runtime` | — | [`packages/experimental/browser-use-runtime/src/index.ts`](../packages/experimental/browser-use-runtime/src/index.ts) |
| `@deepseek-ai/dsh-experimental-cot-translation-bundle` | — | [`packages/experimental/cot-translation-bundle/src/index.ts`](../packages/experimental/cot-translation-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-forge-bundle` | — | [`packages/experimental/forge-bundle/src/index.ts`](../packages/experimental/forge-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-inspector-profile` | — | [`packages/experimental/inspector-profile/src/index.ts`](../packages/experimental/inspector-profile/src/index.ts) |
| `@deepseek-ai/dsh-experimental-liveshare` | — | [`packages/experimental/liveshare/src/index.ts`](../packages/experimental/liveshare/src/index.ts) |
| `@deepseek-ai/dsh-experimental-liveshare-protocol` | — | [`packages/experimental/liveshare-protocol/src/index.ts`](../packages/experimental/liveshare-protocol/src/index.ts) |
| `@deepseek-ai/dsh-experimental-plugin-market-bundle` | — | [`packages/experimental/plugin-market-bundle/src/index.ts`](../packages/experimental/plugin-market-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-ralph-bundle` | — | [`packages/experimental/ralph-bundle/src/index.ts`](../packages/experimental/ralph-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-session-search` | — | [`packages/experimental/session-search/src/index.ts`](../packages/experimental/session-search/src/index.ts) |
| `@deepseek-ai/dsh-experimental-session-titles-bundle` | — | [`packages/experimental/session-titles-bundle/src/index.ts`](../packages/experimental/session-titles-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | — | [`packages/experimental/terminal-bundle/src/index.ts`](../packages/experimental/terminal-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | — | [`packages/experimental/voice-input-bundle/src/index.ts`](../packages/experimental/voice-input-bundle/src/index.ts) |
| `@deepseek-ai/dsh-experimental-webworker-packer` | — | [`packages/experimental/webworker-packer/src/index.ts`](../packages/experimental/webworker-packer/src/index.ts) |
| `@deepseek-ai/dsh-experimental-webworker-runtime` | — | [`packages/experimental/webworker-runtime/src/index.ts`](../packages/experimental/webworker-runtime/src/index.ts) |
| `@deepseek-ai/dsh-home-paths` | — | [`packages/util/home-paths/src/index.ts`](../packages/util/home-paths/src/index.ts) |
| `@deepseek-ai/dsh-hook-protocol` | — | [`packages/experimental/hook-protocol/src/index.ts`](../packages/experimental/hook-protocol/src/index.ts) |
| `@deepseek-ai/dsh-http-proxy` | — | [`packages/util/http-proxy/src/index.ts`](../packages/util/http-proxy/src/index.ts) |
| `@deepseek-ai/dsh-launch-environment` | — | [`packages/util/launch-environment/src/index.ts`](../packages/util/launch-environment/src/index.ts) |
| `@deepseek-ai/dsh-lazy-require` | — | [`packages/util/lazy-require/src/index.ts`](../packages/util/lazy-require/src/index.ts) |
| `@deepseek-ai/dsh-llm-deepseek` | — | [`packages/llm/llm-deepseek/src/index.ts`](../packages/llm/llm-deepseek/src/index.ts) |
| `@deepseek-ai/dsh-llm-mock-server` | — | [`packages/test-support/llm-mock-server/src/index.ts`](../packages/test-support/llm-mock-server/src/index.ts) |
| `@deepseek-ai/dsh-loader-smoke` | — | [`packages/test-support/loader-smoke/src/index.ts`](../packages/test-support/loader-smoke/src/index.ts) |
| `@deepseek-ai/dsh-native-command` | — | [`packages/util/native-command/src/index.ts`](../packages/util/native-command/src/index.ts) |
| `@deepseek-ai/dsh-official-bundles` | — | [`packages/util/official-bundles/src/index.ts`](../packages/util/official-bundles/src/index.ts) |
| `@deepseek-ai/dsh-output-retention` | — | [`packages/util/output-retention/src/index.ts`](../packages/util/output-retention/src/index.ts) |
| `@deepseek-ai/dsh-package-manifest` | — | [`packages/util/package-manifest/src/index.ts`](../packages/util/package-manifest/src/index.ts) |
| `@deepseek-ai/dsh-personalized-recommendations` | — | [`packages/experimental/personalized-recommendations/src/index.ts`](../packages/experimental/personalized-recommendations/src/index.ts) |
| `@deepseek-ai/dsh-plugin-detail` | — | [`packages/util/plugin-detail/src/index.ts`](../packages/util/plugin-detail/src/index.ts) |
| `@deepseek-ai/dsh-plugin-market-index` | — | [`packages/util/plugin-market-index/src/index.ts`](../packages/util/plugin-market-index/src/index.ts) |
| `@deepseek-ai/dsh-remote-mock` | — | [`packages/test-support/remote-mock/src/index.ts`](../packages/test-support/remote-mock/src/index.ts) |
| `@deepseek-ai/dsh-sandbox-windows-acl` | — | [`packages/sandbox/sandbox-windows-acl/src/index.ts`](../packages/sandbox/sandbox-windows-acl/src/index.ts) |
| `@deepseek-ai/dsh-scope` | — | [`packages/core/scope/src/index.ts`](../packages/core/scope/src/index.ts) |
| `@deepseek-ai/dsh-sdk-client` | — | [`packages/sdk/client/src/index.ts`](../packages/sdk/client/src/index.ts) |
| `@deepseek-ai/dsh-sdk-minimal` | — | [`packages/bundle/sdk-minimal/src/index.ts`](../packages/bundle/sdk-minimal/src/index.ts) |
| `@deepseek-ai/dsh-sdk-protocol` | — | [`packages/sdk/protocol/src/index.ts`](../packages/sdk/protocol/src/index.ts) |
| `@deepseek-ai/dsh-session-format` | — | [`packages/session/session-format/src/index.ts`](../packages/session/session-format/src/index.ts) |
| `@deepseek-ai/dsh-session-format-catalog` | — | [`packages/session/session-format-catalog/src/index.ts`](../packages/session/session-format-catalog/src/index.ts) |
| `@deepseek-ai/dsh-session-format-v0-to-v1` | — | [`packages/session/session-format-v0-to-v1/src/index.ts`](../packages/session/session-format-v0-to-v1/src/index.ts) |
| `@deepseek-ai/dsh-session-format-v1-to-v2` | — | [`packages/session/session-format-v1-to-v2/src/index.ts`](../packages/session/session-format-v1-to-v2/src/index.ts) |
| `@deepseek-ai/dsh-session-format-v2-to-v3` | — | [`packages/session/session-format-v2-to-v3/src/index.ts`](../packages/session/session-format-v2-to-v3/src/index.ts) |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | — | [`packages/session/session-format-v3-to-v4/src/index.ts`](../packages/session/session-format-v3-to-v4/src/index.ts) |
| `@deepseek-ai/dsh-session-snapshot` | — | [`packages/test-support/session-snapshot/src/index.ts`](../packages/test-support/session-snapshot/src/index.ts) |
| `@deepseek-ai/dsh-session-telemetry` | — | [`packages/session/session-telemetry/src/index.ts`](../packages/session/session-telemetry/src/index.ts) |
| `@deepseek-ai/dsh-session-title-llm` | — | [`packages/session/session-title-llm/src/index.ts`](../packages/session/session-title-llm/src/index.ts) |
| `@deepseek-ai/dsh-ssh-helper-runtime` | — | [`packages/ssh/ssh-helper-runtime/src/index.ts`](../packages/ssh/ssh-helper-runtime/src/index.ts) |
| `@deepseek-ai/dsh-timeout` | — | [`packages/util/timeout/src/index.ts`](../packages/util/timeout/src/index.ts) |
| `@deepseek-ai/dsh-tool-testkit` | — | [`packages/test-support/tool-testkit/src/index.ts`](../packages/test-support/tool-testkit/src/index.ts) |
| `@deepseek-ai/dsh-typert-generator` | — | [`packages/typert/generator/src/index.ts`](../packages/typert/generator/src/index.ts) |
| `@deepseek-ai/dsh-typert-protocol` | — | [`packages/typert/protocol/src/index.ts`](../packages/typert/protocol/src/index.ts) |
| `@deepseek-ai/dsh-typert-registry` | — | [`packages/typert/registry/src/index.ts`](../packages/typert/registry/src/index.ts) |
| `@deepseek-ai/dsh-util-code-language` | — | [`packages/util/code-language/src/index.ts`](../packages/util/code-language/src/index.ts) |
| `@deepseek-ai/dsh-util-crypto` | — | [`packages/util/crypto/src/index.ts`](../packages/util/crypto/src/index.ts) |
| `@deepseek-ai/dsh-util-file-drag` | — | [`packages/util/file-drag/src/index.ts`](../packages/util/file-drag/src/index.ts) |
| `@deepseek-ai/dsh-util-time` | — | [`packages/util/time/src/index.ts`](../packages/util/time/src/index.ts) |
| `@deepseek-ai/dsh-util-values` | — | [`packages/util/values/src/index.ts`](../packages/util/values/src/index.ts) |
| `@deepseek-ai/dsh-util-workspace-path` | — | [`packages/util/workspace-path/src/index.ts`](../packages/util/workspace-path/src/index.ts) |
| `@deepseek-ai/dsh-win32-process` | — | [`packages/subprocess/win32-process/src/index.ts`](../packages/subprocess/win32-process/src/index.ts) |
<!-- END GENERATED config-catalog:library -->
