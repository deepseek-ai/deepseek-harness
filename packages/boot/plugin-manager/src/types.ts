/** Public plugin management records shared with clients. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import type { PluginInventoryEntry } from '@deepseek-ai/dsh-host-plugin-inventory/types'
export type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'

/** Reasons a profile control cannot modify its target. */
export type ReadOnlyReason = 'management-required' | 'unaddressable'

/** A package whose declared DSH peers reject the running DSH version, without an exemption for the exact pair. */
export interface IncompatiblePlugin {
  name: string
  version: string
  runtimeVersion: string
  /** Only the DSH peer ranges the running version does not satisfy. */
  peers: Record<string, string>
}

/** Localizable management failure and optional external diagnostic. */
export interface ManagementError {
  code: ReadOnlyReason | 'unknown-plugin' | 'invalid-spec' | 'ambiguous-install' | 'not-bundle' | 'not-removable' | 'stop-profile' | 'bundle-in-use' | 'stale-approval' | 'incompatible-version' | 'operation-error'
  diagnostic?: string
  /** Present with `incompatible-version`: the packages the running DSH version rejects. */
  incompatible?: IncompatiblePlugin[]
}

/** One running-profile entry and its persistent control availability. */
export type PluginInfo = PluginInventoryEntry & (
  | { patchId: string; readOnlyReason?: never }
  | { patchId?: never; readOnlyReason: ReadOnlyReason }
)

/** One row a bundle's patch declares, with its live entry while the bundle contributes it. */
export interface BundleRowInfo {
  /** The row id as the patch declares it. */
  rowId: string
  /** The module the row names. */
  moduleName: string
  /** Local package display metadata, including rows whose bundle is disabled. */
  meta?: PluginLocalizedMeta
  /** The Loader entry carrying this row, when exactly one live entry has its id. */
  entryId?: PluginEntryId
}

/** One installed or installation-provided bundle. */
export interface BundleInfo {
  name: string
  version?: string
  /** Local display text with available translations or literal fallbacks, or a metadata diagnostic. */
  meta?: PluginLocalizedMeta
  /** Untranslated `description` of this bundle's package manifest. */
  description?: string
  /** Selected in the profile manifest; a load error means its layer was skipped. */
  enabled: boolean
  /** Whether the profile's own dependencies hold the package; false for a bundle the dsh installation supplies. */
  installed: boolean
  /**
   * Whether the installation ships the bundle for the person to switch on: named by the launcher's `OPTIONAL_BUNDLES`,
   * held by the installation's dependencies, selected by no shipped template, and never removable.
   */
  optional: boolean
  removable: boolean
  readOnlyReason?: ReadOnlyReason
  error?: ManagementError
  /** The rows the bundle's patch inserts, in declaration order; empty when the patch cannot be read. */
  rows: BundleRowInfo[]
  /** Ids of rows the bundle's patch changes without declaring them: the built-in rows it configures or disables. */
  overrides: string[]
}

/** A registry to install from: an http(s) URL, or null for the one pnpm's own configuration names. */
export type Registry = string | null

/** The registries the manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names. */
export interface PluginRegistries {
  readonly registry: Registry
  readonly fallbackRegistries: readonly string[]
  /** The URL pnpm's own configuration names in the profile, read from pnpm; null when it could not be read. */
  readonly resolved: string | null
}

/** How a package operation failed, read off how it ended and what it printed. */
export type PluginInstallFailureKind =
  | 'pnpm-missing'
  | 'timeout'
  | 'not-found'
  | 'no-matching-version'
  | 'network'
  | 'disk-full'
  | 'permission'
  | 'build-blocked'
  | 'integrity'
  | 'unknown'

/** Package operation completion, including Git checks and a retrieval path for unabridged diagnostics. */
export interface PackageResult {
  exitCode: number
  output: string
  truncated: boolean
  logPath: string
  /** Present when the run failed: what kind of failure its exit and output describe. */
  kind?: PluginInstallFailureKind
  /** The manager terminated the run after it printed nothing for its silence bound; `exitCode` still reports how it ended. */
  timedOut?: boolean
  /** Present when a compatibility check refused the run: the packages the running DSH version rejects. */
  incompatible?: IncompatiblePlugin[]
}

/** Persisted change and independently observed application outcome. */
export interface ChangeResult {
  changed: boolean
  /** `cancelled` is an installation the caller stopped, its files restored. */
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  /** Last attempted step; successful installation can proceed to enablement. */
  stage: 'install' | 'enable' | 'remove'
  target: string
  enabled?: boolean
  error?: ManagementError
  /** Pre-existing inactive entries the operation left as they were. */
  warnings?: string[]
  packageResult?: PackageResult
  /** The bundle an installation added, once pnpm and the bundle check accepted it. */
  bundle?: string
  /** Exact package names awaiting explicit script approval in the profile's pnpm settings, read after a failed run. */
  pendingBuilds?: string[]
  /** Package script permissions saved before this installation attempt. */
  approvedBuilds?: string[]
  /** The registries the installation asked, in order; `packageResult` is the last one's run. */
  registries?: Registry[]
  /**
   * What the last failed run could not reach or get an answer from: the registry it asked, or the host a git or
   * tarball spec is fetched from, which no registry stands in for; absent for a failure neither explains.
   */
  failedAt?: 'registry' | 'spec-host'
}

/** Identifies one installation from its start to its settlement, including its log chunks and cancellation. */
export type PluginInstallRequestId = Branded<'PluginInstallRequestId'>

/** Bundle installation defaults to activation; callers that offer cancellation supply their request id. */
export interface InstallBundleOptions {
  enabled?: boolean
  requestId?: PluginInstallRequestId
  /** Explicitly allow these pending packages' scripts for this profile, then install; a name no longer pending refuses the call. */
  approvedBuilds?: string[]
  /** The registry asked first; absent, the configured one. The configured fallbacks follow while a registry is unreachable or stale. */
  registry?: Registry
}

/** Where an inspection asks. */
export interface InspectOptions {
  /** The registry asked first; absent, the configured one. */
  readonly registry?: Registry
}

/** The form one install spec takes, in pnpm's vocabulary. */
export type InstallSpecKind = 'registry' | 'path' | 'git' | 'tarball'

/** Why a spec was refused before anything installed. */
export type PluginInspectProblem =
  | 'invalid-spec'
  | 'already-installed'
  | 'not-found'
  | 'not-a-package'
  | 'not-a-bundle'
  | 'network'
  | 'unknown'

/**
 * What a spec names, read before installing it: the registry's answer for a
 * name, a directory's manifest for a path, and only the form for a git or
 * tarball spec, whose package is known once pnpm has fetched it.
 */
export type PluginSpecInspection =
  | {
    readonly status: 'accepted'
    readonly kind: InstallSpecKind
    readonly name?: string
    readonly version?: string
    /** `description` of the package manifest. */
    readonly description?: string
    /** Whether the package declares a bundle patch; null when the spec's form does not say. */
    readonly bundle: boolean | null
    /** The registry that answered for a name, and for the other forms the one an install of the spec asks first. */
    readonly registry: Registry
    /** The host a git spec or a tarball URL is fetched from, which no registry stands in for. */
    readonly host?: string
  }
  | {
    readonly status: 'refused'
    readonly problem: PluginInspectProblem
    /** What pnpm, the registry, or the file system said. */
    readonly reason: string
    /** The registries asked, in order, when the refusal came from asking them; `reason` is the last one's. */
    readonly registries?: Registry[]
  }

/** The Host phase of one installation, before its install call settles; `installing` is announced once per registry asked. */
export interface PluginInstallProgress {
  readonly requestId: PluginInstallRequestId
  readonly phase: 'installing' | 'cancelling' | 'applying'
  /** With `installing`: the registry this attempt asks, its one-based position, and how many the installation may ask. */
  readonly attempt?: { readonly registry: Registry; readonly index: number; readonly total: number }
}

/** Cancellation is confirmed only after process exit and file restoration. */
export interface PluginInstallCancellation {
  readonly status: 'cancelled' | 'too-late' | 'not-running'
}

/** One chunk of a pnpm run's output, as the run produces it. */
export interface PluginInstallLogChunk {
  /** The installation the run belongs to, when its caller supplied a request id. */
  readonly requestId?: PluginInstallRequestId
  /** The run the chunk belongs to. */
  readonly jobId: string
  /** The command line the run executes: pnpm's command name, then its arguments. */
  readonly argv: readonly string[]
  /** The directory the run executes in: the profile directory. */
  readonly cwd: string
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
  /** Present on the run's last chunk: pnpm's exit code, null when it ended without one. */
  readonly exitCode?: number | null
}

/** What changed in the profile, for consumers that show it. */
export interface PluginChange {
  /** The operation that changed it. */
  readonly reason: 'plugin' | 'bundle' | 'install' | 'remove'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The profile's plugins, bundles, or composition changed: a manager
     * operation completed. A patch generation applied outside the manager,
     * by HMR's watcher after a CLI or hand edit, announces nothing here.
     * @mode emit
     * @param change - what changed.
     */
    'plugin-manager/changed'(change: PluginChange): void
    /**
     * One chunk of a pnpm run's output, streamed as the run produces it.
     * @mode emit
     * @param chunk - the chunk and the run it belongs to.
     */
    'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
    /**
     * An installation moved between its Host phases. `installing` is announced once per registry the
     * installation asks, with the attempt's registry and position; `cancelling` and `applying` once.
     * @mode emit
     * @param progress - the installation's request id and phase, with the attempt while installing.
     */
    'plugin-manager/install-state'(progress: PluginInstallProgress): void
  }
}
