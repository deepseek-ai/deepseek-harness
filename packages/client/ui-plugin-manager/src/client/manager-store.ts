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
  ManagementError,
  PluginEntryId,
  PluginInfo,
  PluginInspectProblem,
  PluginInstallFailureKind,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginSpecInspection,
  ReadOnlyReason,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { shortName } from './presentation.ts'

/** The action a failed notice names. */
export type FailedAction = 'enable' | 'disable' | 'uninstall' | 'rowEnable' | 'rowDisable'

/** What the last action left to say, shown as a toast; `seq` tells one showing from the next. */
export type ManagerNotice =
  | { readonly kind: 'restart'; readonly packageName: string; readonly seq: number }
  | { readonly kind: 'overridden'; readonly packageName: string; readonly seq: number }
  | { readonly kind: 'cancelled'; readonly seq: number }
  | {
    readonly kind: 'failed'
    /** What was being done when it failed. */
    readonly action: FailedAction
    /** The Host's refusal, when the Host refused; absent when the transport failed. */
    readonly code?: ManagementError['code']
    /** The Host's diagnostic or the transport's words, shown verbatim; empty when the code says it all. */
    readonly reason: string
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

/** Why the typed spec was refused before anything installed. */
export interface InstallInputError {
  readonly problem: PluginInspectProblem
  readonly reason: string
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
 * The install dialog: the spec is typed while `idle`, read by the Host while
 * `checking`, then installed through the Host-owned phases — `starting` until
 * the Host acknowledges the run, `running`, `cancelling` while the Host stops
 * it, `applying` once the bundle is being loaded, which closed the cancellation
 * window — and the outcome shown as `done` or `failed`. A refused check, a
 * confirmed cancellation, and the back control return to `idle` with the spec kept.
 */
export interface InstallState {
  readonly open: boolean
  /** The package spec as typed. */
  readonly spec: string
  readonly phase: 'idle' | 'checking' | 'starting' | 'running' | 'cancelling' | 'applying' | 'done' | 'failed'
  /** Identifies this dialog's installation, including log and cancellation messages. */
  readonly requestId?: PluginInstallRequestId
  /** Why the spec was refused before installing; shown under the field. */
  readonly inputError: InstallInputError | null
  /** What the spec names, once the Host has read it. */
  readonly subject: InstallSubject | null
  /** The pnpm runs of the open install, in the order they started. */
  readonly runs: readonly InstallRun[]
  /** Whether the run's command and output are unfolded. */
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
   * `cancelUnconfirmed` is a stop the Host did not confirm, shown over the
   * running screen while the run goes on.
   */
  readonly failure: {
    readonly reason: string
    readonly code?: ManagementError['code']
    readonly kind?: PluginInstallFailureKind
    readonly pendingBuilds?: readonly string[]
    readonly cancelUnconfirmed?: true
  } | null
  /** The packages whose install scripts the finished run was allowed to execute, saved for this profile. */
  readonly approvedBuilds: readonly string[]
  /** Enabling the newly installed bundle from the installed screen is crossing the wire. */
  readonly enabling: boolean
}

/**
 * Whether an installation is still owned by the Host.
 * @param phase - the dialog's current installation phase.
 * @returns true until an authoritative result settles the installation.
 */
export function isInstallPending(phase: InstallState['phase']): boolean {
  return phase === 'starting' || phase === 'running' || phase === 'cancelling' || phase === 'applying'
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
  hooks: {
    /** Tab snapshot bound by the renderer as usePluginManager. */
    pluginManager: SnapshotStore<PluginManagerState>
  }
  /** Read the Host once the tab first renders. */
  ensure: () => void
  /** Read the Host again. */
  refresh: () => void
  openInstall: () => void
  /** Close the dialog; a check in flight is dropped, a Host-owned run has to be cancelled first. */
  closeInstall: () => void
  editInstallSpec: (text: string) => void
  /** Check the spec with the Host, then install it; from the failed screen, run it again. */
  runInstall: () => void
  /** Allow the install scripts the failed run left pending, saved for this profile, and run the same spec again. */
  approveBuildsAndRetry: () => void
  /** Leave the check or the failed screen for the spec, or ask the Host to stop the run and wait for its cleanup. */
  cancelInstall: () => void
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
  constructor(readonly reason: string, readonly code?: ManagementError['code']) {
    super(reason)
    this.name = 'RemoteAnswerError'
  }
}

/** The dialog's reading of a failed change: the Host's code and diagnostic, and the run's classified failure. */
function failureOf(
  error: ManagementError | undefined, kind: PluginInstallFailureKind | undefined, pendingBuilds?: readonly string[],
): NonNullable<InstallState['failure']> {
  return {
    reason: error?.diagnostic ?? '',
    ...error === undefined ? {} : { code: error.code },
    ...kind === undefined ? {} : { kind },
    ...pendingBuilds === undefined || pendingBuilds.length === 0 ? {} : { pendingBuilds },
  }
}

/** The notice a thrown failure becomes: a refusal keeps its code, anything else its words. */
function failedNotice(error: unknown, subject: { action: FailedAction; packageName?: string }, seq: number): ManagerNotice {
  const code = error instanceof RemoteAnswerError ? error.code : undefined
  return { kind: 'failed', reason: reasonOf(error), ...code === undefined ? {} : { code }, ...subject, seq }
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
  open: false, spec: '', phase: 'idle', inputError: null, subject: null, runs: [], detailsOpen: false,
  installed: null, restartRequired: false, failure: null, approvedBuilds: [], enabling: false,
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
  private noticeSeq = 0

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
    this.generation += 1
  }

  /**
   * Build the face the tab's slot registration injects.
   * @returns the tab's snapshot source and its actions.
   */
  inject(): PluginManagerFace {
    return {
      hooks: { pluginManager: this.store },
      ensure: () => { if (this.getSnapshot().status === 'idle') void this.load() },
      refresh: () => { void this.load() },
      openInstall: () => {
        if (!isInstallPending(this.getSnapshot().install.phase)) this.patch({ install: { ...IDLE_INSTALL, open: true } })
      },
      closeInstall: () => {
        if (isInstallPending(this.getSnapshot().install.phase)) return
        this.abortInspect()
        this.patch({ install: IDLE_INSTALL })
      },
      editInstallSpec: (text) => {
        const install = this.getSnapshot().install
        // Typing while the Host checks or installs is not possible; a new spec after an outcome starts over.
        if (install.phase === 'checking' || isInstallPending(install.phase)) return
        this.patchInstall(install.phase === 'idle' ? { spec: text, inputError: null } : { ...IDLE_INSTALL, open: true, spec: text })
      },
      runInstall: () => { void this.runInstall() },
      approveBuildsAndRetry: () => { void this.approveBuildsAndRetry() },
      cancelInstall: () => { void this.cancelInstall() },
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
    // A queued start notification cannot undo the local user's cancellation request.
    if (install.phase === 'cancelling' && progress.phase === 'installing') return
    this.patchInstall({ phase: progress.phase === 'installing' ? 'running' : progress.phase })
  }

  /**
   * Fold a chunk belonging to this installation into its pnpm command.
   * A final chunk may arrive after the install answer and still updates an existing run.
   * @param chunk - the chunk the Host forwarded.
   */
  appendLog(chunk: PluginInstallLogChunk): void {
    const install = this.getSnapshot().install
    if (chunk.requestId !== install.requestId) return
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
    this.abortInspect()
    const controller = new AbortController()
    this.inspectAbort = controller
    this.patchInstall({
      phase: 'checking', inputError: null, subject: null, runs: [], detailsOpen: false,
      installed: null, restartRequired: false, failure: null, approvedBuilds: [],
    })
    const inspected = await this.ctx.remote.pluginManager.inspect(spec, controller.signal)
    if (this.gone(controller.signal)) return
    this.inspectAbort = undefined
    if (!inspected.ok) {
      this.patchInstall({ phase: 'idle', inputError: { problem: 'unknown', reason: inspected.error.message } })
      return
    }
    if (inspected.value.status === 'refused') {
      this.patchInstall({ phase: 'idle', inputError: { problem: inspected.value.problem, reason: inspected.value.reason } })
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
    const { spec } = subject
    const requestId = randomUUID() as PluginInstallRequestId
    this.patchInstall({ phase: 'starting', requestId, subject, runs: [], failure: null, installed: null, approvedBuilds: [] })
    // The Host announces `plugin-manager/changed` while the run is still on
    // the wire, and every such event reads again; those reads must not cancel
    // the run's settlement.
    const result = await this.ctx.remote.pluginManager.installBundle(spec, {
      enabled: false, requestId, ...approvedBuilds === undefined ? {} : { approvedBuilds: [...approvedBuilds] },
    })
    if (this.disposed || this.getSnapshot().install.requestId !== requestId) return
    const runs = this.getSnapshot().install.runs
    if (!result.ok) {
      this.patchInstall({ phase: 'failed', runs: settledRuns(runs, null), failure: { reason: result.error.message } })
    } else if (result.value.application === 'cancelled') {
      this.offerSpecAgain({ kind: 'cancelled', seq: ++this.noticeSeq })
    } else if (result.value.application === 'failed') {
      // A run whose last chunk never reached the dialog settles from the answer.
      const packages = result.value.packageResult
      this.patchInstall({
        phase: 'failed',
        runs: settledRuns(runs, packages?.exitCode ?? null),
        failure: failureOf(result.value.error, packages?.kind, result.value.pendingBuilds),
      })
    } else {
      this.patchInstall({
        phase: 'done',
        runs: settledRuns(runs, 0),
        installed: result.value.bundle ?? null,
        restartRequired: result.value.application === 'restart-required',
        approvedBuilds: result.value.approvedBuilds ?? [],
      })
    }
    void this.load()
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
   * run is asked to stop and the dialog waits for the Host's word, since
   * neither a dropped RPC nor a closed connection means pnpm has stopped.
   */
  private async cancelInstall(): Promise<void> {
    const install = this.getSnapshot().install
    if (install.phase === 'checking' || install.phase === 'failed') {
      this.abortInspect()
      this.offerSpecAgain()
      return
    }
    if (install.phase !== 'running' || install.requestId === undefined) return
    const requestId = install.requestId
    this.patchInstall({ phase: 'cancelling', failure: null })
    const result = await this.ctx.remote.pluginManager.cancelInstall(requestId)
    const current = this.getSnapshot().install
    if (this.disposed || current.requestId !== requestId || !isInstallPending(current.phase)) return
    if (!result.ok) {
      this.patchInstall({ phase: 'running', failure: { reason: result.error.message, cancelUnconfirmed: true } })
      return
    }
    if (result.value.status === 'cancelled') {
      this.offerSpecAgain({ kind: 'cancelled', seq: ++this.noticeSeq })
      void this.load()
    } else if (result.value.status === 'too-late') {
      this.patchInstall({ phase: 'applying' })
    } else {
      this.patchInstall({ phase: 'running', failure: { reason: '', cancelUnconfirmed: true } })
    }
  }

  /**
   * Back to the spec: the check, the run, and its request are forgotten and
   * the spec is kept, with a toast when there is something to say — the Host
   * stopped the run.
   */
  private offerSpecAgain(notice: ManagerNotice | null = null): void {
    const { open, spec } = this.getSnapshot().install
    this.patch({ install: { ...IDLE_INSTALL, open, spec }, ...notice === null ? {} : { notice } })
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
        throw new RemoteAnswerError(result.error?.diagnostic ?? '', result.error?.code)
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
