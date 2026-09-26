/**
 * The plugin manager's state: the Host's bundles joined with its plugin
 * entries, the action in flight, the install run, and the confirmation an
 * uninstall waits on. Every fact comes from the Host — the store re-reads
 * after each action and after every `plugin-manager/changed` event, so a
 * change made on another surface shows here without a manual refresh.
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  BundleInfo,
  ChangeResult,
  IncompatiblePlugin,
  ManagementError,
  PluginEntryId,
  PluginInfo,
  PluginInspectProblem,
  PluginInstallFailureKind,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginRegistries,
  PluginSpecInspection,
  ReadOnlyReason,
  Registry,
} from '@deepseek-ai/dsh-api-remotes/client'
import { normalizeRegistry, NPMMIRROR_REGISTRY, OFFICIAL_NPM_REGISTRY, REGISTRY_URL } from '@deepseek-ai/dsh-plugin-manager/registry'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalizedText, PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import type { SettingsDescribeFace, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigLedger } from './config-ledger.ts'
import { shortName } from './presentation.ts'

/** The action a failed notice names. */
export type FailedAction = 'enable' | 'disable' | 'uninstall' | 'rowEnable' | 'rowDisable'

/** What the last action left to say, shown as a toast; `seq` tells one showing from the next. */
export type ManagerNotice =
  | { readonly kind: 'restart'; readonly packageName: string; readonly seq: number }
  | { readonly kind: 'overridden'; readonly packageName: string; readonly seq: number }
  | { readonly kind: 'cancelled'; readonly seq: number }
  | { readonly kind: 'install'; readonly outcome: 'done' | 'failed' | 'unconfirmed' | 'applying' | 'unknown'; readonly seq: number }
  | {
    readonly kind: 'failed'
    /** What was being done when it failed. */
    readonly action: FailedAction
    /** The Host's refusal, when the Host refused; absent when the transport failed. */
    readonly code?: ManagementError['code']
    /** The Host's diagnostic or the transport's words, shown verbatim; empty when the code says it all. */
    readonly reason: string
    /** The packages an `incompatible-version` refusal names. */
    readonly incompatible?: readonly IncompatiblePlugin[]
    readonly packageName?: string
    readonly seq: number
  }

/** One row a bundle contributes, as the page lists it: the patch's declaration joined with its live entry. */
export interface PackageRow {
  /** The Loader entry carrying the row while the bundle is on; absent for a row of a bundle that is off. */
  readonly entryId?: PluginEntryId
  /** The row id as the bundle declares it. */
  readonly rowId: string
  /** The module the row names. */
  readonly moduleName: string
  /** Local package display text and metadata diagnostics supplied by the Host. */
  readonly meta?: PluginLocalizedMeta
  /** Whether the entry runs; false for a row without a live entry. */
  readonly enabled: boolean
  /** The entry's fiber phase, null without a live fiber. */
  readonly phase: PluginInfo['fiberPhase']
  /** Why the Host refuses to switch the row, when it does. */
  readonly readOnlyReason?: ReadOnlyReason
}

/** One bundle as the page shows it: the Host's bundle joined with the entries its rows run as. */
export interface PackageView {
  readonly name: string
  readonly version?: string
  readonly description?: string
  /** Local package display text and metadata diagnostics supplied by the Host. */
  readonly meta?: PluginLocalizedMeta
  /** Whether the profile's own dependencies hold the package; false for a bundle the installation supplies. */
  readonly installed: boolean
  /** Whether the installation ships the bundle for the person to switch on: official, off until selected, never removable. */
  readonly optional: boolean
  /** Whether the bundle is in the profile's layer list. */
  readonly enabled: boolean
  /** Why the Host refuses to switch the bundle off or remove it, when it does. */
  readonly readOnlyReason?: ReadOnlyReason
  /** Why the Host cannot read the bundle, when it cannot. */
  readonly error?: ManagementError
  readonly rows: readonly PackageRow[]
}

/** The typed spec as the Host read it, on the installing, installed, and failed screens. */
export type InstallSubject = Extract<PluginSpecInspection, { status: 'accepted' }> & { readonly spec: string }

/** The registry the person picked for an install: one the Host offers, or a typed URL. */
export type RegistryChoice =
  | { readonly kind: 'offered'; readonly registry: Registry }
  | { readonly kind: 'custom'; readonly url: string }

/** The choice shown until the Host has said which registry it asks first: the one pnpm's own configuration names. */
const OFFICIAL_REGISTRY: RegistryChoice = { kind: 'offered', registry: null }

/**
 * The registry a choice asks, as the Host's install plan compares registries: pnpm's own configuration stands for
 * the URL it names, once the Host has read it.
 * @param registry - the registry, null for the one pnpm's own configuration names.
 * @param resolved - the URL pnpm's own configuration names, null while the Host could not read it.
 * @returns the comparison key; a registry that does not parse compares as written.
 */
export function registryKey(registry: Registry, resolved: string | null): string {
  const url = registry ?? resolved
  if (url === null) return ''
  try {
    return normalizeRegistry(url)
  } catch {
    // The Host validated its own registries; a remembered one that no longer parses compares as written.
    return url
  }
}

/**
 * The registries the dialog offers: the Host's first, its fallbacks, and pnpm's own, each once. pnpm's own
 * configuration stands for the registry it names, so it never repeats a registry the Host already offers.
 * @param registries - what the Host configured, or null while unread.
 * @returns the registries in the order the dialog lists them.
 */
export function offeredRegistries(registries: PluginRegistries | null): Registry[] {
  const offered: Registry[] = []
  const keys: string[] = []
  for (const registry of [...registries === null ? [] : [registries.registry, ...registries.fallbackRegistries], null]) {
    const key = registryKey(registry, registries?.resolved ?? null)
    if (keys.includes(key)) continue
    offered.push(registry)
    keys.push(key)
  }
  return offered
}

/** Why the typed spec was refused before anything installed. */
export interface InstallInputError {
  readonly problem: PluginInspectProblem
  readonly reason: string
  /** The registries the check asked, in order, when the refusal came from asking them. */
  readonly registries?: readonly Registry[]
}

/** One pnpm run of an install, as the dialog's terminal draws it. */
export interface InstallRun {
  readonly jobId: string
  /** The command line the Host ran, space-joined. */
  readonly command: string
  /** The directory the Host ran pnpm in: the profile directory. */
  readonly cwd: string
  /** stdout and stderr interleaved as they arrived, pnpm's colour escapes included. */
  readonly output: string
  /** pnpm's exit code once the run settled, null when it ended by a signal or never started; absent while it runs. */
  readonly exitCode?: number | null
}

/**
 * Installation input, Host progress, and the final outcome. `unconfirmed` keeps
 * an unresolved request pending; `unknown` releases it after the Host reports
 * no active request and its original reply is lost. Neither means cancellation.
 * Closing any pending phase preserves its request and output for reopening.
 * Confirmed cancellation and returning from an outcome keep the spec for editing.
 */
export interface InstallState {
  readonly open: boolean
  /** The package spec as typed. */
  readonly spec: string
  /** The spec form was reopened after switching away from a failed GitHub address. */
  readonly mirrorRecovery?: boolean
  /** The registries the Host configured, read when the dialog opens; null until the Host answered. */
  readonly registries: PluginRegistries | null
  /** The registry this install asks first: the one last used, else the Host's first. */
  readonly registry: RegistryChoice
  /** Whether the registry options are unfolded under the spec. */
  readonly registryOpen: boolean
  /** Whether the typed registry was refused for not being an http(s) URL. */
  readonly registryError: boolean
  /** The registries the Host asked for this install, in order, and how many it may ask; null before the run. */
  readonly attempts: { readonly registries: readonly Registry[]; readonly total: number } | null
  readonly phase: 'idle' | 'checking' | 'starting' | 'running' | 'cancelling' | 'applying' | 'unconfirmed' | 'unknown' | 'done' | 'failed'
  /** Identifies this dialog's installation, including log and cancellation messages. */
  readonly requestId?: PluginInstallRequestId
  /** Why the spec was refused before installing; shown under the field. */
  readonly inputError: InstallInputError | null
  /** What the spec names, once the Host has read it. */
  readonly subject: InstallSubject | null
  /** The pnpm runs of the open install, in the order they started. */
  readonly runs: readonly InstallRun[]
  /** Whether the run's command and output are unfolded, including after reopening. */
  readonly detailsOpen: boolean
  /** The bundle the finished run added, left off until enabled from the installed screen. */
  readonly installed: string | null
  /** Whether the finished run's bundle waits for the next start to load. */
  readonly restartRequired: boolean
  /**
   * The run's failure, once one settled the dialog: the Host's refusal
   * `code` with its diagnostic as `reason`, or the transport's words alone;
   * `kind` classifies a pnpm failure, and `pendingBuilds` names the packages
   * whose install scripts pnpm left undecided, offered for approval.
   * `uncertainty` distinguishes a lost installation reply, an unconfirmed
   * cancellation, and a cancellation awaiting the Host's acceptance of the run.
   */
  readonly failure: {
    readonly reason: string
    readonly code?: ManagementError['code']
    /** The packages an `incompatible-version` refusal names. */
    readonly incompatible?: readonly IncompatiblePlugin[]
    readonly kind?: PluginInstallFailureKind
    /** What the last failed run could not reach, as the Host attributed it: the registry, or the spec's own host. */
    readonly failedAt?: 'registry' | 'spec-host'
    readonly pendingBuilds?: readonly string[]
    readonly uncertainty?: 'result' | 'cancellation' | 'acceptance'
  } | null
  /** The packages whose install scripts the finished run was allowed to execute, saved for this profile. */
  readonly approvedBuilds: readonly string[]
  /** Enabling the newly installed bundle from the installed screen is crossing the wire. */
  readonly enabling: boolean
}

/**
 * Whether an installation is still owned by the Host.
 * @param phase - the dialog's current installation phase.
 * @returns true while a Host result or a check for an active request is outstanding.
 */
export function isInstallPending(phase: InstallState['phase']): boolean {
  return phase === 'starting' || phase === 'running' || phase === 'cancelling' || phase === 'applying' || phase === 'unconfirmed'
}

/**
 * Offer the configured mainland mirror after a confirmed GitHub connection failure.
 * @param install - the installation and the Host's failure attribution.
 * @returns the offered entry that asks npmmirror, null when that entry is pnpm's own configuration, or undefined when
 * this recovery does not apply; test for undefined, because null is a valid entry.
 */
export function githubRecoveryRegistry(install: InstallState): Registry | undefined {
  if (install.phase !== 'failed' || install.failure?.failedAt !== 'spec-host'
    || (install.failure.kind !== 'network' && install.failure.kind !== 'timeout')) return undefined
  const host = install.subject?.host?.toLowerCase().split(':')[0]
  if (host !== 'github.com' && !host?.endsWith('.github.com')) return undefined
  const resolved = install.registries?.resolved ?? null
  return offeredRegistries(install.registries).find(registry => registryKey(registry, resolved) === NPMMIRROR_REGISTRY)
}

/**
 * Whether the install already asks npmmirror first, so switching to the offered mirror would not change the registry.
 * @param install - the installation and its registry choice.
 * @returns true when the chosen registry, offered or typed, compares as npmmirror.
 */
export function asksMirror(install: InstallState): boolean {
  const choice = install.registry
  return registryKey(choice.kind === 'custom' ? choice.url.trim() : choice.registry, install.registries?.resolved ?? null) === NPMMIRROR_REGISTRY
}

/** A destructive action waiting for the user's confirmation: a package's uninstall. */
export interface ConfirmState {
  readonly action: 'uninstall'
  readonly packageName: string
}

/** What the tab renders. */
export interface PluginManagerState {
  /** `unavailable` when the Host runs without a managed profile; `error` keeps the last packages. */
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  readonly packages: readonly PackageView[]
  /** Package names and row keys with an action crossing the wire. */
  readonly busy: readonly string[]
  readonly notice: ManagerNotice | null
  readonly install: InstallState
  readonly confirm: ConfirmState | null
  /** The package the list scrolls to and marks, once an install enabled it. */
  readonly highlight: string | null
}

/** The registration-side face the tab's slot entry injects. */
export interface PluginManagerFace {
  /** Resolve local package text in the current Client locale at render time. */
  resolveText: (text: LocalizedText) => string
  /** Resolve a configuration form by the Host entry id. */
  configForm: ConfigForms['get']
  hooks: {
    /** Shared accepted configuration values. */
    configurations: SettingsDescribeFace
    /** Tab snapshot bound by the renderer as usePluginManager. */
    pluginManager: SnapshotStore<PluginManagerState>
    /** The plugins carrying configuration, bound by the renderer as useConfigLedger. */
    configLedger: HostObservable<ConfigLedger>
  }
  /** Read the Host once the tab first renders. */
  ensure: () => void
  /** Read the Host again. */
  refresh: () => void
  openInstall: () => void
  /** Hide immediately, abort a check, or request cancellation while retaining the Host-owned installation. */
  closeInstall: () => void
  editInstallSpec: (text: string) => void
  /** Check the spec with the Host, then install it; from the failed screen, run it again. */
  runInstall: () => void
  /** Fold or unfold the registry options under the spec. */
  toggleRegistryOptions: () => void
  /** Pick the registry the install asks first, or type one. */
  chooseRegistry: (choice: RegistryChoice) => void
  /** From the failed screen: back to the spec with the registry options unfolded. */
  changeRegistry: () => void
  /** Return from a GitHub connection failure to an empty spec asking the offered mainland mirror, keeping a choice that asks it. */
  useGithubMirror: () => void
  /** Allow the install scripts the failed run left pending, saved for this profile, and run the same spec again. */
  approveBuildsAndRetry: () => void
  /** Leave the check or the failed screen for the spec, or ask the Host to stop the run and wait for its cleanup. */
  cancelInstall: () => void
  /** Ask the Host for the result of an installation whose original reply was lost. */
  reconcileInstall: () => void
  toggleInstallDetails: () => void
  /** Enable the bundle the finished install added, then close the dialog and mark it in the list. */
  enableInstalled: () => void
  /** Drop the list mark once it has been shown. */
  clearHighlight: () => void
  /** Put a bundle into, or take it out of, the profile's layer list. */
  setEnabled: (packageName: string, enabled: boolean) => void
  /** Ask before removing a package from the profile. */
  uninstall: (packageName: string) => void
  confirm: () => void
  cancelConfirm: () => void
  /** Switch one of a bundle's rows on or off in the profile's user layer. */
  setRowEnabled: (entryId: PluginEntryId, enabled: boolean) => void
  dismissNotice: () => void
}

/** A Remote answer as the generated client returns it. */
type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }

/** A refused answer or a change the Host could not apply, carrying what it said and, for a refusal, its code. */
class RemoteAnswerError extends Error {
  constructor(
    readonly reason: string, readonly code?: ManagementError['code'], readonly incompatible?: readonly IncompatiblePlugin[],
  ) {
    super(reason)
    this.name = 'RemoteAnswerError'
  }
}

/** The dialog's reading of a failed change: the Host's code and diagnostic, and the run's classified failure. */
function failureOf(
  error: ManagementError | undefined, kind: PluginInstallFailureKind | undefined, pendingBuilds?: readonly string[],
  failedAt?: ChangeResult['failedAt'],
): NonNullable<InstallState['failure']> {
  return {
    reason: error?.diagnostic ?? '',
    ...error === undefined ? {} : { code: error.code },
    ...error?.incompatible === undefined ? {} : { incompatible: error.incompatible },
    ...kind === undefined ? {} : { kind },
    ...failedAt === undefined ? {} : { failedAt },
    ...pendingBuilds === undefined || pendingBuilds.length === 0 ? {} : { pendingBuilds },
  }
}

/** The notice a thrown failure becomes: a refusal keeps its code, anything else its words. */
function failedNotice(error: unknown, subject: { action: FailedAction; packageName?: string }, seq: number): ManagerNotice {
  const code = error instanceof RemoteAnswerError ? error.code : undefined
  const incompatible = error instanceof RemoteAnswerError ? error.incompatible : undefined
  return {
    kind: 'failed', reason: reasonOf(error), ...code === undefined ? {} : { code },
    ...incompatible === undefined ? {} : { incompatible }, ...subject, seq,
  }
}

/** The runs with every one still open settled at `exitCode`. */
function settledRuns(runs: readonly InstallRun[], exitCode: number | null): readonly InstallRun[] {
  return runs.map(run => run.exitCode === undefined ? { ...run, exitCode } : run)
}

/**
 * The key one row occupies in the busy list.
 * @param entryId - the row's Loader entry id.
 * @returns the busy key.
 */
export function rowKey(entryId: string): string {
  return `row:${entryId}`
}

/**
 * One bundle as the page shows it: its rows joined with the Host's entries.
 * @param bundle - the Host's bundle.
 * @param plugins - the Host's plugin entries.
 * @returns the package view.
 */
export function packageView(bundle: BundleInfo, plugins: readonly PluginInfo[]): PackageView {
  const rows = bundle.rows.map((row): PackageRow => {
    const live = row.entryId === undefined ? undefined : plugins.find(plugin => plugin.entryId === row.entryId)
    return {
      rowId: row.rowId,
      moduleName: row.moduleName,
      enabled: live?.enabled ?? false,
      phase: live?.fiberPhase ?? null,
      ...row.meta === undefined ? {} : { meta: row.meta },
      ...row.entryId === undefined ? {} : { entryId: row.entryId },
      ...live?.readOnlyReason === undefined ? {} : { readOnlyReason: live.readOnlyReason },
    }
  })
  return {
    name: bundle.name,
    installed: bundle.installed,
    optional: bundle.optional,
    enabled: bundle.enabled,
    rows,
    ...bundle.version === undefined ? {} : { version: bundle.version },
    ...bundle.description === undefined ? {} : { description: bundle.description },
    ...bundle.meta === undefined ? {} : { meta: bundle.meta },
    ...bundle.readOnlyReason === undefined ? {} : { readOnlyReason: bundle.readOnlyReason },
    ...bundle.error === undefined ? {} : { error: bundle.error },
  }
}

/**
 * The order the list shows packages in: by the short name a person reads, so a
 * card stays put when its bundle is switched, whatever order the Host answers in.
 * @param packages - the Host's bundles as views.
 * @returns the views sorted by short name.
 */
export function sortPackages(packages: readonly PackageView[]): PackageView[] {
  return [...packages].sort((a, b) => shortName(a.name).localeCompare(shortName(b.name)))
}

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', registries: null, registry: OFFICIAL_REGISTRY, registryOpen: false, registryError: false, attempts: null,
  phase: 'idle', inputError: null, subject: null, runs: [], detailsOpen: false,
  installed: null, restartRequired: false, failure: null, approvedBuilds: [], enabling: false,
}

/** The dialog back at its spec: the run and its outcome forgotten, the spec and the registries kept. */
function specAgain(install: InstallState): InstallState {
  const { open, spec, registries, registry, mirrorRecovery } = install
  return { ...IDLE_INSTALL, open, spec, registries, registry, ...mirrorRecovery === undefined ? {} : { mirrorRecovery } }
}

/**
 * The choice as the dialog can show it once the Host has answered: nothing remembered starts from the registry the
 * Host asks first; a remembered registry the Host now asks under another entry takes that entry, and one it no
 * longer offers is kept as a typed one.
 */
function reconciled(remembered: RegistryChoice | null, registries: PluginRegistries): RegistryChoice {
  if (remembered === null) return { kind: 'offered', registry: registries.registry }
  if (remembered.kind === 'custom' || remembered.registry === null) return remembered
  const key = registryKey(remembered.registry, registries.resolved)
  const offered = offeredRegistries(registries)
    .find(registry => registryKey(registry, registries.resolved) === key)
  return offered === undefined ? { kind: 'custom', url: remembered.registry } : { kind: 'offered', registry: offered }
}

interface RegistryRead {
  /** Last automatically assigned choice; a different object belongs to a manual selection. */
  choice: RegistryChoice
  /** Pending initial registry list and response probes; an untouched installation waits until it settles. */
  done?: Promise<void>
}

/** Only the shipped public mirror can replace an unconfigured official npm default. */
function eligibleMirror(registries: PluginRegistries): string | undefined {
  if (registries.registry !== null || registries.resolved === null) return undefined
  let resolved: string
  try { resolved = normalizeRegistry(registries.resolved) }
  catch (_error) {
    // An invalid pnpm registry cannot receive a public mirror recommendation.
    return undefined
  }
  if (resolved !== OFFICIAL_NPM_REGISTRY) return undefined
  return registries.fallbackRegistries.find(registry => registry === NPMMIRROR_REGISTRY)
}

/** One installation owns acceptance, response recovery, and every cancellation attempt. */
interface InstallRequest {
  readonly requestId: PluginInstallRequestId
  acknowledged: boolean
  replyLost: boolean
  recovering: boolean
  cancellation?: { waitingForStart: boolean } | undefined
}

/** Reads and mutates the profile's plugins through the `pluginManager` Remote. */
export class PluginManagerController {
  private readonly store: SnapshotStore<PluginManagerState>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0
  private disposed = false
  private pendingConfirm: (() => Promise<void>) | undefined
  /** Cancels the check the dialog has in flight. */
  private inspectAbort: AbortController | undefined
  private request: InstallRequest | undefined
  private noticeSeq = 0
  private registryRead: RegistryRead | undefined
  /** The registry last used from this browser, kept across dialogs and page loads; null until one was used. */
  private readonly registryMemory: SnapshotStore<RegistryChoice | null> = createSnapshotStore<RegistryChoice | null>(null, {
    persist: { name: 'dsh.plugin-manager.install-registry' },
  })

  /**
   * @param ctx - the tab plugin's context, whose `remote.pluginManager` and `remote.pluginInventory` namespaces answer.
   */
  constructor(
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore<PluginManagerState>({
      status: 'idle', packages: [], busy: [], notice: null,
      install: IDLE_INSTALL, confirm: null, highlight: null,
    })
  }

  /**
   * Read the tab's state.
   * @returns the current sync snapshot (stable reference until the next change).
   */
  getSnapshot(): PluginManagerState {
    return this.store.getSnapshot()
  }

  /** Stop publishing and drop every late settlement. */
  dispose(): void {
    this.disposed = true
    this.registryRead = undefined
    this.request = undefined
    this.generation += 1
  }

  /**
   * Build the face the tab's slot registration injects.
   * @param configLedger - the projection of the plugins carrying configuration, bound beside the tab's own state.
   * @param resolveText - render-time package text resolution supplied by the locale service.
   * @returns the tab's snapshot sources and its actions.
   */
  inject(configLedger: HostObservable<ConfigLedger>, resolveText: PluginManagerFace['resolveText']): PluginManagerFace {
    return {
      resolveText,
      hooks: { pluginManager: this.store, configLedger, configurations: this.ctx.configForms.describe() },
      configForm: id => this.ctx.configForms.get(id),
      ensure: () => { if (this.getSnapshot().status === 'idle') void this.load() },
      refresh: () => { void this.load() },
      openInstall: () => {
        const install = this.getSnapshot().install
        if (install.requestId === undefined) {
          // A new dialog starts from the registry last used here and reads what the Host offers; a hidden install reopens as it is.
          this.patch({ install: { ...IDLE_INSTALL, open: true, registry: this.registryMemory.getSnapshot() ?? OFFICIAL_REGISTRY } })
          const read: RegistryRead = { choice: this.getSnapshot().install.registry }
          this.registryRead = read
          read.done = this.readRegistries(read).finally(() => { delete read.done })
        } else {
          this.patchInstall({ open: true })
        }
        void this.reconcileInstall()
      },
      closeInstall: () => {
        if (isInstallPending(this.getSnapshot().install.phase)) {
          this.patchInstall({ open: false })
          void this.cancelInstall()
          return
        }
        this.abortInspect()
        this.registryRead = undefined
        this.patch({ install: IDLE_INSTALL })
      },
      editInstallSpec: (text) => {
        const install = this.getSnapshot().install
        // Typing while the Host checks or installs is not possible; a new spec after an outcome starts over.
        if (install.phase === 'checking' || isInstallPending(install.phase)) return
        this.patchInstall(install.phase === 'idle' ? { spec: text, inputError: null } : { ...specAgain(install), spec: text })
      },
      runInstall: () => { void this.runInstall() },
      toggleRegistryOptions: () => { this.patchInstall({ registryOpen: !this.getSnapshot().install.registryOpen }) },
      chooseRegistry: (choice) => {
        if (this.getSnapshot().install.phase === 'idle') this.patchInstall({ registry: choice, registryError: false })
      },
      changeRegistry: () => {
        const install = this.getSnapshot().install
        if (install.phase === 'failed') this.patch({ install: { ...specAgain(install), registryOpen: true } })
      },
      useGithubMirror: () => {
        const install = this.getSnapshot().install
        const mirror = githubRecoveryRegistry(install)
        if (mirror === undefined) return
        const recovered = { ...specAgain(install), spec: '', mirrorRecovery: true }
        // A typed address or pnpm's own entry that already asks the mirror stays chosen instead of becoming the offered one.
        if (asksMirror(install)) {
          this.patch({ install: recovered })
          return
        }
        const registry: RegistryChoice = { kind: 'offered', registry: mirror }
        this.registryMemory.set(registry)
        this.patch({ install: { ...recovered, registry } })
      },
      approveBuildsAndRetry: () => { void this.approveBuildsAndRetry() },
      cancelInstall: () => { void this.cancelInstall() },
      reconcileInstall: () => { void this.reconcileInstall() },
      toggleInstallDetails: () => { this.patchInstall({ detailsOpen: !this.getSnapshot().install.detailsOpen }) },
      enableInstalled: () => { void this.enableInstalled() },
      clearHighlight: () => { if (this.getSnapshot().highlight !== null) this.patch({ highlight: null }) },
      setEnabled: (packageName, enabled) => {
        void this.run(packageName, { packageName, action: enabled ? 'enable' : 'disable' }, async () => {
          this.applied(await this.ctx.remote.pluginManager.setBundleEnabled(packageName, enabled), packageName)
        })
      },
      uninstall: (packageName) => {
        this.pendingConfirm = () => this.run(packageName, { packageName, action: 'uninstall' }, async () => {
          this.applied(await this.ctx.remote.pluginManager.removeBundle(packageName), packageName)
        })
        this.patch({ confirm: { action: 'uninstall', packageName } })
      },
      confirm: () => { void this.confirm() },
      cancelConfirm: () => { this.pendingConfirm = undefined; this.patch({ confirm: null }) },
      setRowEnabled: (entryId, enabled) => {
        void this.run(rowKey(entryId), { packageName: entryId, action: enabled ? 'rowEnable' : 'rowDisable' }, async () => {
          this.applied(await this.ctx.remote.pluginManager.setPluginEnabled(entryId, enabled), entryId)
        })
      },
      dismissNotice: () => { this.patch({ notice: null }) },
    }
  }

  /**
   * Follow the Host's cancellation window for this dialog's installation.
   * @param progress - a request id and phase received from the Host.
   */
  installProgress(progress: PluginInstallProgress): void {
    const install = this.getSnapshot().install
    if (install.requestId !== progress.requestId || !isInstallPending(install.phase)) return
    const request = this.request
    if (request === undefined) return
    request.acknowledged = true
    // Host progress cannot reopen a cancellation window that has already closed.
    if (install.phase === 'applying') return
    if (progress.phase === 'installing' && request.cancellation !== undefined) {
      if (request.cancellation.waitingForStart) void this.sendCancellation(request, request.cancellation)
      return
    }
    const attempt = progress.attempt
    this.patchInstall({
      phase: progress.phase === 'installing' ? 'running' : progress.phase,
      ...attempt === undefined
        ? {}
        : { attempts: { registries: [...install.attempts?.registries ?? [], attempt.registry], total: attempt.total } },
    })
  }

  private currentRegistryRead(read: RegistryRead): boolean {
    return !this.disposed && this.registryRead === read
  }

  /** Read the registries the Host offers, for the dialog just opened; a refused read leaves pnpm's own and a typed one. */
  private async readRegistries(read: RegistryRead): Promise<void> {
    const answer = await this.ctx.remote.pluginManager.registries()
    const install = this.getSnapshot().install
    if (!this.currentRegistryRead(read) || !install.open || !answer.ok) return
    const remembered = this.registryMemory.getSnapshot()
    const untouched = install.registry === read.choice && (install.phase === 'idle' || install.phase === 'checking')
    if (untouched) read.choice = reconciled(remembered, answer.value)
    this.patchInstall({ registries: answer.value, ...untouched ? { registry: read.choice } : {} })
    const mirror = eligibleMirror(answer.value)
    if (!untouched || remembered !== null || mirror === undefined) return
    const fastest = await this.ctx.remote.pluginRegistryProbe.fastest()
    const current = this.getSnapshot().install
    if (!this.currentRegistryRead(read) || !current.open || (current.phase !== 'idle' && current.phase !== 'checking')
      || current.registry !== read.choice || !fastest.ok || fastest.value !== mirror) return
    read.choice = { kind: 'offered', registry: mirror }
    this.patchInstall({ registry: read.choice })
  }

  /**
   * Fold a chunk belonging to this installation into its pnpm command.
   * A final chunk may arrive after the install answer and still updates an existing run.
   * @param chunk - the chunk the Host forwarded.
   */
  appendLog(chunk: PluginInstallLogChunk): void {
    const install = this.getSnapshot().install
    if (chunk.requestId !== install.requestId) return
    // Output also acknowledges an install when its start notification was lost.
    if (install.requestId !== undefined && (install.phase === 'starting' || install.phase === 'cancelling' || install.phase === 'unconfirmed')) {
      this.installProgress({ requestId: install.requestId, phase: 'installing' })
    }
    const index = install.runs.findIndex(run => run.jobId === chunk.jobId)
    if (index === -1 && !isInstallPending(install.phase)) return
    const settled = chunk.exitCode === undefined ? {} : { exitCode: chunk.exitCode }
    const runs = index === -1
      ? [...install.runs, { jobId: chunk.jobId, command: chunk.argv.join(' '), cwd: chunk.cwd, output: chunk.text, ...settled }]
      : install.runs.map((run, at) => at === index ? { ...run, output: run.output + chunk.text, ...settled } : run)
    this.patchInstall({ runs })
  }

  /**
   * Read the bundles and the entries their rows run as. A call during an
   * in-flight read marks one rerun after it settles.
   * @returns settlement after this call's freshness is reflected.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    void this.reconcileInstall()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    const run = Promise.resolve().then(() => this.read())
    this.inFlight = run
    return run
  }

  private async read(): Promise<void> {
    try {
      do {
        this.rerun = false
        const generation = ++this.generation
        if (this.getSnapshot().status === 'idle') this.patch({ status: 'loading' })
        // The manager Remote is mounted whether or not the Host manages a
        // profile; the inventory says whether it does.
        const inventory = await this.ctx.remote.pluginInventory.list()
        if (generation !== this.generation) return
        if (!inventory.ok) {
          this.patch({ status: 'error' })
          continue
        }
        if (inventory.value.managementAvailable !== true) {
          this.patch({ status: 'unavailable', packages: [] })
          continue
        }
        const [bundles, plugins] = await Promise.all([
          this.ctx.remote.pluginManager.listBundles(),
          this.ctx.remote.pluginManager.listPlugins(),
        ])
        if (generation !== this.generation) return
        if (!bundles.ok || !plugins.ok) {
          this.patch({ status: 'error' })
          continue
        }
        this.patch({
          status: 'ready',
          packages: sortPackages(bundles.value.map(bundle => packageView(bundle, plugins.value))),
        })
      } while (this.shouldRerun())
    } finally {
      this.inFlight = undefined
    }
  }

  private shouldRerun(): boolean {
    return this.rerun
  }

  private async confirm(): Promise<void> {
    const pending = this.pendingConfirm
    this.pendingConfirm = undefined
    this.patch({ confirm: null })
    if (pending !== undefined) await pending()
  }

  /** Drop the check in flight; its answer is ignored. */
  private abortInspect(): void {
    this.inspectAbort?.abort()
    this.inspectAbort = undefined
  }

  /** Whether a settlement arrives too late to matter: the store is disposed, or the dialog moved on. */
  private gone(signal: AbortSignal): boolean {
    return this.disposed || signal.aborted
  }

  /**
   * Check the typed spec, then install it. The Host reads what the spec
   * names first; a refused spec returns to the field with the reason, an
   * accepted one becomes the subject the next screens show while pnpm runs.
   */
  private async runInstall(): Promise<void> {
    const state = this.getSnapshot()
    const install = state.install
    const spec = install.spec.trim()
    if (install.phase === 'checking' || isInstallPending(install.phase) || spec === '') return
    // A name the list already shows is refused at once, before the Host is asked.
    if (state.packages.some(pkg => pkg.name === spec)) {
      this.patchInstall({ phase: 'idle', inputError: { problem: 'already-installed', reason: spec } })
      return
    }
    const choice = install.registry
    const typed = choice.kind === 'custom' ? choice.url.trim() : undefined
    if (typed !== undefined && !REGISTRY_URL.test(typed)) {
      this.patchInstall({ phase: 'idle', registryError: true })
      return
    }
    this.abortInspect()
    const controller = new AbortController()
    this.inspectAbort = controller
    this.patchInstall({
      phase: 'checking', inputError: null, subject: null, runs: [], detailsOpen: false, attempts: null, registryOpen: false,
      installed: null, restartRequired: false, failure: null, approvedBuilds: [],
    })
    const read = this.registryRead
    if (read !== undefined && choice === read.choice && read.done !== undefined) {
      await read.done
      if (this.gone(controller.signal) || this.registryRead !== read) return
    }
    const currentChoice = this.getSnapshot().install.registry
    const selected = currentChoice.kind === 'custom' ? { ...currentChoice, url: currentChoice.url.trim() } : currentChoice
    const registry: Registry = selected.kind === 'custom' ? selected.url : selected.registry
    this.registryMemory.set(selected)
    const inspected = await this.ctx.remote.pluginManager.inspect(spec, { registry }, controller.signal)
    if (this.gone(controller.signal)) return
    this.inspectAbort = undefined
    if (!inspected.ok) {
      this.patchInstall({ phase: 'idle', inputError: { problem: 'unknown', reason: inspected.error.message } })
      return
    }
    if (inspected.value.status === 'refused') {
      const { problem, reason, registries } = inspected.value
      this.patchInstall({ phase: 'idle', inputError: { problem, reason, ...registries === undefined ? {} : { registries } } })
      return
    }
    await this.startInstall({ spec, ...inspected.value })
  }

  /**
   * Hand the checked spec to the Host and settle the dialog from its answer.
   * `approvedBuilds` names the pending install scripts the person allowed;
   * the Host saves that permission for this profile before pnpm runs.
   */
  private async startInstall(subject: InstallSubject, approvedBuilds?: readonly string[]): Promise<void> {
    const { spec, registry } = subject
    const requestId = randomUUID() as PluginInstallRequestId
    const request: InstallRequest = { requestId, acknowledged: false, replyLost: false, recovering: false }
    this.request = request
    this.patchInstall({ phase: 'starting', requestId, subject, runs: [], attempts: null, failure: null, installed: null, approvedBuilds: [] })
    // The Host announces `plugin-manager/changed` while the run is still on
    // the wire, and every such event reads again; those reads must not cancel
    // the run's settlement.
    const result = await this.ctx.remote.pluginManager.installBundle(spec, {
      enabled: false, requestId, registry, ...approvedBuilds === undefined ? {} : { approvedBuilds: [...approvedBuilds] },
    })
    if (this.disposed || this.request !== request) return
    if (!result.ok) {
      request.replyLost = true
      this.installUncertain('result', result.error.message)
      void this.reconcileInstall()
      return
    }
    this.settleInstall(result.value)
  }

  /** A recovery call shares the Host's active result; absent results are explicitly unknown. */
  private async reconcileInstall(): Promise<void> {
    const request = this.request
    if (request === undefined || !request.replyLost || request.recovering) return
    request.recovering = true
    const result = await this.ctx.remote.pluginManager.waitForInstall(request.requestId)
    if (this.disposed || this.request !== request) return
    request.recovering = false
    if (!result.ok) {
      this.installUncertain('result', result.error.message)
      return
    }
    if (result.value !== null) {
      this.settleInstall(result.value)
      return
    }
    this.request = undefined
    this.patchInstall({ phase: 'unknown', failure: null, runs: settledRuns(this.getSnapshot().install.runs, null) })
    this.notifyHiddenInstall('unknown')
    void this.load()
  }

  private settleInstall(result: ChangeResult): void {
    const { runs, attempts } = this.getSnapshot().install
    this.request = undefined
    // The Host's answer names every registry it asked, whether or not each attempt's announcement arrived.
    const asked = result.registries === undefined
      ? {}
      : { attempts: { registries: result.registries, total: Math.max(attempts?.total ?? 0, result.registries.length) } }
    if (result.application === 'cancelled') {
      this.offerSpecAgain({ kind: 'cancelled', seq: ++this.noticeSeq })
    } else if (result.application === 'failed') {
      const packages = result.packageResult
      this.patchInstall({
        phase: 'failed', runs: settledRuns(runs, packages?.exitCode ?? null),
        failure: failureOf(result.error, packages?.kind, result.pendingBuilds, result.failedAt),
        ...asked,
      })
    } else {
      this.patchInstall({
        phase: 'done', runs: settledRuns(runs, 0), failure: null,
        installed: result.bundle ?? null,
        restartRequired: result.application === 'restart-required',
        approvedBuilds: result.approvedBuilds ?? [],
        ...asked,
      })
    }
    const phase = this.getSnapshot().install.phase
    if (phase === 'done' || phase === 'failed') this.notifyHiddenInstall(phase)
    void this.load()
  }

  private installUncertain(uncertainty: NonNullable<InstallState['failure']>['uncertainty'] & string, reason: string): void {
    this.patchInstall({
      phase: this.getSnapshot().install.phase === 'applying' ? 'applying' : 'unconfirmed',
      failure: { reason, uncertainty },
    })
    this.notifyHiddenInstall('unconfirmed')
  }

  /**
   * Allow the install scripts the failed run left pending and run the same
   * spec again. Only the failed screen with pending names offers this.
   */
  private async approveBuildsAndRetry(): Promise<void> {
    const install = this.getSnapshot().install
    const pending = install.failure?.pendingBuilds
    if (install.phase !== 'failed' || install.subject === null || pending === undefined || pending.length === 0) return
    await this.startInstall(install.subject, pending)
  }

  /**
   * Leave the check or the failed screen for the spec at once; a Host-owned
   * run is asked to stop and its state waits for the Host's word, since
   * neither a dropped RPC nor a closed connection means pnpm has stopped.
   */
  private async cancelInstall(): Promise<void> {
    const install = this.getSnapshot().install
    if (install.phase === 'checking' || install.phase === 'failed' || install.phase === 'unknown') {
      this.abortInspect()
      this.offerSpecAgain()
      return
    }
    const request = this.request
    if ((install.phase !== 'starting' && install.phase !== 'running' && install.phase !== 'unconfirmed') || request === undefined) return
    if (request.cancellation !== undefined && !request.cancellation.waitingForStart) return
    const cancellation = { waitingForStart: false }
    request.cancellation = cancellation
    await this.sendCancellation(request, cancellation)
  }

  /** A cancellation that overtakes installation is retried after the Host acknowledges that request. */
  private async sendCancellation(request: InstallRequest, cancellation: NonNullable<InstallRequest['cancellation']>): Promise<void> {
    const acknowledged = request.acknowledged
    cancellation.waitingForStart = false
    this.patchInstall({ phase: 'cancelling', failure: null })
    const result = await this.ctx.remote.pluginManager.cancelInstall(request.requestId)
    if (this.disposed || this.request !== request || request.cancellation !== cancellation) return
    if (!result.ok) {
      cancellation.waitingForStart = !request.acknowledged
      if (request.acknowledged) request.cancellation = undefined
      this.installUncertain(request.replyLost ? 'result' : 'cancellation', result.error.message)
      return
    }
    if (result.value.status === 'cancelled') {
      this.offerSpecAgain({ kind: 'cancelled', seq: ++this.noticeSeq })
      void this.load()
    } else if (result.value.status === 'too-late') {
      request.acknowledged = true
      request.cancellation = undefined
      this.patchInstall({ phase: 'applying' })
      this.notifyHiddenInstall('applying')
      void this.reconcileInstall()
    } else if (request.replyLost) {
      request.cancellation = undefined
      this.installUncertain('result', '')
      void this.reconcileInstall()
    } else if (!acknowledged && this.getSnapshot().install.phase !== 'applying') {
      if (request.acknowledged) {
        await this.sendCancellation(request, cancellation)
      } else {
        cancellation.waitingForStart = true
        this.installUncertain('acceptance', '')
      }
    } else {
      request.cancellation = undefined
      this.installUncertain('cancellation', '')
    }
  }

  private notifyHiddenInstall(outcome: Extract<ManagerNotice, { kind: 'install' }>['outcome']): void {
    if (!this.getSnapshot().install.open) this.patch({ notice: { kind: 'install', outcome, seq: ++this.noticeSeq } })
  }

  /**
   * Release the tracked request and return to editing with its spec retained.
   * A cancellation notice is supplied only after the Host confirms it stopped.
   */
  private offerSpecAgain(notice: ManagerNotice | null = null): void {
    this.request = undefined
    this.patch({ install: specAgain(this.getSnapshot().install), ...notice === null ? {} : { notice } })
  }

  /**
   * Enable the bundle the finished install added, then close the dialog and
   * mark it in the list. A refusal toasts and still closes: the list shows
   * what did not switch on.
   */
  private async enableInstalled(): Promise<void> {
    const install = this.getSnapshot().install
    if (install.phase !== 'done' || install.enabling) return
    const name = install.installed
    this.patchInstall({ enabling: true })
    if (name !== null) {
      const result = await this.ctx.remote.pluginManager.setBundleEnabled(name, true)
      if (this.disposed) return
      try {
        this.applied(result, name)
      } catch (error) {
        this.patch({ notice: failedNotice(error, { packageName: name, action: 'enable' }, ++this.noticeSeq) })
      }
    }
    this.patch({ install: IDLE_INSTALL, highlight: name })
    await this.load()
  }

  /**
   * Run one action under a busy key, turn its failure into the notice, and
   * re-read the Host afterwards whatever happened.
   */
  private async run(
    key: string,
    subject: { action: FailedAction; packageName?: string },
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.disposed || this.getSnapshot().busy.includes(key)) return
    this.patch({ busy: [...this.getSnapshot().busy, key], notice: null })
    try {
      await action()
    } catch (error) {
      // `patch` drops the notice after disposal.
      this.patch({ notice: failedNotice(error, subject, ++this.noticeSeq) })
    } finally {
      this.patch({ busy: this.getSnapshot().busy.filter(entry => entry !== key) })
    }
    await this.load()
  }

  /**
   * Publish a change's outcome: a refused answer or a change the Host could
   * not apply throws for {@link run} to report; a change that waits for the
   * next start, that a higher layer overrides, or that the Host stopped is
   * said in passing.
   */
  private applied(answer: Answer<ChangeResult>, packageName: string): void {
    if (!answer.ok) throw new RemoteAnswerError(answer.error.message)
    const result = answer.value
    switch (result.application) {
      case 'failed':
        throw new RemoteAnswerError(result.error?.diagnostic ?? '', result.error?.code, result.error?.incompatible)
      case 'cancelled':
        this.patch({ notice: { kind: 'cancelled', seq: ++this.noticeSeq } })
        return
      case 'restart-required':
        this.patch({ notice: { kind: 'restart', packageName, seq: ++this.noticeSeq } })
        return
      case 'overridden':
        this.patch({ notice: { kind: 'overridden', packageName, seq: ++this.noticeSeq } })
        return
      case 'applied':
        return
    }
  }

  private patch(next: Partial<PluginManagerState>): void {
    if (this.disposed) return
    this.store.set({ ...this.getSnapshot(), ...next })
  }

  private patchInstall(next: Partial<InstallState>): void {
    this.patch({ install: { ...this.getSnapshot().install, ...next } })
  }
}

/** What a thrown failure said: a refused answer's reason, else the error's message. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
