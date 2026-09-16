/** Current-profile plugin and bundle management over shared dsh plugin operations. */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { pluginEntryId, readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import {
  readProfileManifest, resolveBundleDir, loadOverlayPatches, composeEntries, reconcileProfilePatches, readProfilePatches, OPTIONAL_BUNDLES,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-hmr'
import type { ProfileContext, ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { bundleManifest, runProfilePnpm, saveManifest, viewProfilePackage } from './operations.ts'
import { classifyInstallFailure } from './install-failure.ts'
import { InvalidInstallSpecError, parseInstallSpec } from './install-spec.ts'
import { writePluginEnabled } from './patch.ts'
import { ManagementFailure } from './failure.ts'
import { approveBuilds, readPendingBuilds } from './build-approval.ts'
import type {
  BundleInfo, BundleRowInfo, ChangeResult, InstallBundleOptions, ManagementError, PackageResult, PluginChange, PluginEntryId, PluginInfo,
  PluginInspectProblem, PluginInstallCancellation, PluginInstallProgress, PluginInstallRequestId, PluginSpecInspection,
} from './types.ts'
export type * from './types.ts'
export { classifyInstallFailure, type InstallFailureFacts } from './install-failure.ts'
export { InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from './install-spec.ts'

/** The pnpm executable and the limits for package diagnostics and registry lookups. */
export interface Config {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  pnpmCommand?: string
  /** Maximum retained pnpm diagnostic bytes per operation. */
  outputBytes?: number
  /** Maximum time to wait for another process's profile package operation. */
  lockWaitMs?: number
  /** Bound on one registry lookup an inspection runs, in milliseconds. */
  inspectTimeoutMs?: number
}

const protectedModules = new Set([
  '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory', '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-host-plugin-inventory', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-frontend-static', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-hmr',
])

/** The profile files an installation writes and a failed or cancelled one restores. */
const RESTORED_FILES = ['package.json', 'pnpm-lock.yaml'] as const

/** pnpm's colour escapes, which a JSON answer may be wrapped in. */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g

/** Flatten only the groups addressable by the profile's patch composer. */
function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : [])])
}

/** Preserve the exact observed diagnostic, including non-Error failures. */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** An expected refusal keeps its code; anything else becomes an operation error carrying its exact diagnostic. */
function managementError(error: unknown): ManagementError {
  return error instanceof ManagementFailure ? { code: error.code } : { code: 'operation-error', diagnostic: messageOf(error) }
}

/** The caller stopped an installation; its files are restored before this is thrown. */
class InstallCancelledError extends Error {
  constructor() {
    super('Installation cancelled')
    this.name = 'InstallCancelledError'
  }
}

/** One installation the manager owns until its call settles. */
interface InstallControl {
  readonly abort: AbortController
  /** `applying` once pnpm has exited and the bundle is being selected and loaded, which cannot be stopped. */
  phase: 'installing' | 'applying'
  /** Settlement of the install call, whichever way it ended. */
  settled: Promise<void>
}

/** A manifest field that is a string, when the manifest carries one. */
function stringField(manifest: object, field: string): string | undefined {
  const value = (manifest as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

/** The fields of the dsh installation's own manifest the manager reads. */
interface InstallationManifest {
  dependencies?: Record<string, string>
}

/** What a package manifest says about the package: identity, one-liner, and whether it is a bundle. */
function inspectionOf(kind: 'registry' | 'path', manifest: object): Extract<PluginSpecInspection, { status: 'accepted' }> {
  const dsh = (manifest as { dsh?: unknown }).dsh
  const declared = typeof dsh === 'object' && dsh !== null ? dsh as { bundle?: unknown } : undefined
  const bundle = declared !== undefined && typeof declared.bundle === 'object' && declared.bundle !== null
  const name = stringField(manifest, 'name')
  const version = stringField(manifest, 'version')
  const description = stringField(manifest, 'description')
  return {
    status: 'accepted', kind, bundle,
    ...name === undefined ? {} : { name },
    ...version === undefined ? {} : { version },
    ...description === undefined || description === '' ? {} : { description },
  }
}

function refused(problem: PluginInspectProblem, reason: string): PluginSpecInspection {
  return { status: 'refused', problem, reason }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent management of the current profile's composition and packages. */
    pluginManager: PluginManager
  }
}

/** Manage profile files and apply their declared reload lifecycle. */
export class PluginManager extends TypertRemoteService {
  static inject = ['loader', 'profileContext']
  static Config: z<Config> = z.object({
    pnpmCommand: z.string().default('pnpm'),
    outputBytes: z.number().step(1).min(1).default(16384),
    lockWaitMs: z.number().step(1).min(0).default(120000),
    inspectTimeoutMs: z.number().step(1).min(1000).default(20000),
  })
  private readonly ownerEntryId: string | undefined
  private readonly packageOperations = new Set<Promise<unknown>>()
  private readonly profile: ProfileContext
  private readonly outputBytes: number
  private readonly lockWaitMs: number
  private readonly inspectTimeoutMs: number
  private readonly pnpmCommand: string
  private readonly ownerContext: Context
  private readonly abort = new AbortController()
  /** Installations by request id, from their call until it settles. */
  private readonly installs = new Map<PluginInstallRequestId, InstallControl>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'pluginManager')
    this.ownerEntryId = ctx.fiber.entry?.id
    this.ownerContext = ctx
    this.profile = ctx.profileContext
    this.outputBytes = (config as Required<Config>).outputBytes
    this.lockWaitMs = (config as Required<Config>).lockWaitMs
    this.inspectTimeoutMs = (config as Required<Config>).inspectTimeoutMs
    this.pnpmCommand = (config as Required<Config>).pnpmCommand
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled([...this.packageOperations])
    }, 'plugin-manager: package cancellation')
  }

  /** Read current plugins, including why a row cannot be changed through the profile patch.
   * @returns Current runtime entries with persistent patch targets.
   */
  @Remote
  async listPlugins(): Promise<PluginInfo[]> {
    const rows = flatten(composeEntries([readProfilePatches('dsh', this.profile)]))
    const snapshot = await readPluginInventory(this.ctx)
    return snapshot.entries.map((entry) => {
      const actual = [...this.ctx.loader.entries()].find(row => row.id === entry.entryId)
      const candidates = rows.filter(row => row.id === actual?.options.id)
      const candidate = candidates[0]
      if (protectedModules.has(entry.moduleName) || entry.entryId === this.ownerEntryId) {
        return { ...entry, readOnlyReason: 'management-required' as const }
      }
      if (candidate === undefined || candidates.length > 1 || candidate.name !== entry.moduleName
        || actual?.parent.tree.ctx.fiber.entry?.id !== 'include') {
        return { ...entry, readOnlyReason: 'unaddressable' as const }
      }
      return { ...entry, patchId: candidate.id }
    })
  }

  /** Read the profile's installed bundles, the bundles this dsh installation supplies, and the selected names that are not bundles.
   * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
   * @returns Package versions, one-liners, rows, activation selections, whether the installation offers the
   * bundle, and removal availability.
   */
  @Remote
  listBundles(): Promise<BundleInfo[]> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const selected = manifest.dsh?.profile?.bundles ?? []
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const names = [...new Set([...selected, ...dependencies, ...Object.keys(installation.dependencies ?? {})])]
    const bundles: BundleInfo[] = []
    for (const name of names) {
      const installed = dependencies.includes(name)
      const optional = OPTIONAL_BUNDLES.includes(name)
      const removable = installed && !Object.hasOwn(installation.dependencies ?? {}, name)
      const enabled = selected.includes(name)
      try {
        const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (info === undefined) {
          if (enabled) bundles.push({ name, enabled, installed, optional, removable, error: { code: 'not-bundle' }, rows: [], overrides: [] })
          continue
        }
        const readOnlyReason = this.protectsManager(name) ? 'management-required' as const : undefined
        bundles.push({ name, ...(info.version === undefined ? {} : { version: info.version }),
          ...(info.description === undefined || info.description === '' ? {} : { description: info.description }),
          enabled, installed, optional, removable: removable && readOnlyReason === undefined,
          ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
          ...this.declaredRows(name, info) })
      } catch (error) {
        if (enabled || installed) {
          bundles.push({ name, enabled, installed, optional, removable, error: managementError(error), rows: [], overrides: [] })
        }
      }
    }
    return Promise.resolve(bundles)
  }

  /** Read what a spec names before installing it.
   * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
   * @param signal Ends a registry lookup early.
   * @returns The package the spec names, or why it is refused.
   */
  @Remote
  async inspect(spec: string, signal?: AbortSignal): Promise<PluginSpecInspection> {
    let parsed
    try {
      parsed = parseInstallSpec(spec)
    } catch (error) {
      /* v8 ignore next 2 -- parseInstallSpec throws nothing but its own refusal */
      if (!(error instanceof InvalidInstallSpecError)) throw error
      return refused('invalid-spec', error.reason)
    }
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const known = new Set([
      ...manifest.dsh?.profile?.bundles ?? [], ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(installation.dependencies ?? {}),
    ])
    switch (parsed.kind) {
      case 'git': return { status: 'accepted', kind: 'git', bundle: null }
      case 'tarball':
        if (parsed.path !== undefined && !existsSync(parsed.path)) return refused('not-a-package', 'the tarball does not exist')
        return { status: 'accepted', kind: 'tarball', bundle: null }
      case 'path': {
        if (!existsSync(parsed.path)) return refused('not-a-package', 'the path does not exist')
        let read: object
        try {
          read = JSON.parse(await readFile(join(parsed.path, 'package.json'), 'utf8')) as object
        } catch (error) {
          return refused('not-a-package', `no readable package.json at the path: ${messageOf(error)}`)
        }
        const inspection = inspectionOf('path', read)
        if (inspection.name === undefined) return refused('not-a-package', 'the package.json names no package')
        if (known.has(inspection.name)) return refused('already-installed', `${inspection.name} is already installed`)
        if (!inspection.bundle) return refused('not-a-bundle', `${inspection.name} declares no dsh.bundle`)
        return inspection
      }
      case 'registry': {
        if (known.has(parsed.name)) return refused('already-installed', `${parsed.name} is already installed`)
        const view = await viewProfilePackage(this.profile.dir, spec.trim(), {
          command: this.pnpmCommand, timeoutMs: this.inspectTimeoutMs, ...signal === undefined ? {} : { signal },
        })
        const log = `${view.stderr}${view.cause === undefined ? '' : `${messageOf(view.cause)}\n`}`.trim()
        if (view.exitCode !== 0 || view.cause !== undefined || view.timedOut) {
          const kind = classifyInstallFailure({ log, timedOut: view.timedOut, ...view.cause === undefined ? {} : { cause: view.cause } })
          const reason = log || view.stdout.trim() || `pnpm view exited with ${String(view.exitCode)}`
          if (kind === 'not-found' || kind === 'no-matching-version') return refused('not-found', reason)
          if (kind === 'network') return refused('network', reason)
          return refused('unknown', view.timedOut ? `pnpm view timed out after ${String(this.inspectTimeoutMs)}ms` : reason)
        }
        let answer: unknown
        try {
          answer = JSON.parse(view.stdout.replace(ANSI_SEQUENCE, '').trim() || 'null')
        } catch (error) {
          return refused('unknown', `unreadable pnpm view output: ${messageOf(error)}`)
        }
        // A range answers one object per matching version, oldest first.
        const latest: unknown = Array.isArray(answer) ? answer.at(-1) : answer
        if (typeof latest !== 'object' || latest === null) return refused('unknown', 'pnpm view answered no package')
        const inspection = inspectionOf('registry', latest)
        const named = inspection.name === undefined ? { ...inspection, name: parsed.name } : inspection
        if (!named.bundle) return refused('not-a-bundle', `${named.name} declares no dsh.bundle`)
        return named
      }
    }
  }

  /** Persist a plugin entry's desired enablement and apply it on live profiles.
   * @param id Loader entry identity returned by listPlugins.
   * @param enabled Whether the plugin should run.
   * @returns Saved and runtime outcomes, including higher-priority overrides.
   */
  @Remote
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      const row = (await this.listPlugins()).find(item => item.entryId === id)
      if (row === undefined) throw new ManagementFailure('unknown-plugin')
      if (row.readOnlyReason !== undefined) throw new ManagementFailure(row.readOnlyReason)
      await writePluginEnabled(this.profile.patchPath, row.patchId, row.moduleName, enabled)
      result.warnings = await this.reload(enabled ? [row.patchId] : [])
      const current = (await this.listPlugins()).find(item => item.entryId === id)
      return current?.enabled !== enabled && this.ownerContext.get('hmr') !== undefined ? 'overridden' : undefined
    }), { stage: 'enable', target: id, enabled }, 'plugin')
  }

  /** Select or remove a bundle layer while retaining installed dependencies.
   * @param name Bundle package name.
   * @param enabled Whether the bundle contributes its patch layer.
   * @returns Persisted and runtime outcomes.
   */
  @Remote
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      await this.selectBundle(name, enabled)
      result.warnings = await this.reload(enabled ? this.bundleRows(name).map(row => row.id) : [])
    }), { stage: 'enable', target: name, enabled }, 'bundle')
  }

  /**
   * Install a package using the same pnpm implementation as dsh plugin. A run
   * that fails, is cancelled, or adds a package without a bundle patch restores
   * `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay.
   * @param spec One package spec, including local paths relative to the invocation directory.
   * @param options Whether to activate the installed bundle (defaults to true), the request id a cancellation names, and
   * the pending build scripts to allow for this profile before pnpm runs.
   * @returns Package-manager diagnostics and observed activation outcome.
   */
  @Remote
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    const requestId = options?.requestId
    const control: InstallControl = { abort: new AbortController(), phase: 'installing', settled: Promise.resolve() }
    const stopped = (): boolean => control.abort.signal.aborted
    if (requestId !== undefined) this.installs.set(requestId, control)
    const announce = (phase: PluginInstallProgress['phase']): void => {
      if (requestId !== undefined) this.ownerContext.emit('plugin-manager/install-state', { requestId, phase })
    }
    const result = this.change(async (result) => {
      if (spec.trim() === '' || spec.startsWith('-')) throw new ManagementFailure('invalid-spec')
      if (stopped()) throw new InstallCancelledError()
      if (options?.approvedBuilds !== undefined) {
        await approveBuilds(this.profile.dir, options.approvedBuilds)
        result.approvedBuilds = options.approvedBuilds
      }
      const files = await this.readRestoredFiles()
      const before = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
      announce('installing')
      let name: string
      try {
        result.packageResult = await this.runPnpm(['add', spec], control.abort.signal, requestId)
        if (stopped()) throw new InstallCancelledError()
        if (result.packageResult.exitCode !== 0) {
          // pnpm-workspace.yaml is not restored, so the names pnpm left undecided there can be offered for approval.
          try { result.pendingBuilds = await readPendingBuilds(this.profile.dir) }
          catch (error) {
            this.ownerContext.logger.warn('Could not read pending build approvals after pnpm failed', error)
          }
          throw new Error(result.packageResult.output)
        }
        const after = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
        const installed = Object.keys(after).filter(name => before[name] !== after[name])
        // Registry retries can retain the saved range after a partial installation.
        if (installed.length === 0) installed.push(...Object.keys(after).filter(name => spec === name || spec.startsWith(`${name}@`)))
        const target = installed[0]
        if (installed.length !== 1 || target === undefined) throw new ManagementFailure('ambiguous-install')
        name = target
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const manifest = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (manifest?.dsh?.bundle?.patch === undefined) throw new ManagementFailure('not-bundle')
        loadOverlayPatches('dsh', join(dir, manifest.dsh.bundle.patch))
      } catch (error) {
        // pnpm has exited by now, so the files it rewrote go back as they were.
        await this.restoreFiles(files)
        throw error
      }
      control.phase = 'applying'
      announce('applying')
      result.bundle = name
      result.target = name
      result.stage = 'enable'
      return this.configure(async () => {
        if (options?.enabled !== false) await this.selectBundle(name, true)
        if (Object.hasOwn(before, name)) return 'restart-required'
        if (options?.enabled !== false) result.warnings = await this.reload()
      })
    }, { stage: 'install', target: spec, enabled: options?.enabled !== false }, 'install')
    /* v8 ignore next -- change() folds every failure into its result; only a lock or disposal error rejects */
    control.settled = result.then(() => undefined, () => undefined)
    return result.finally(() => { if (requestId !== undefined) this.installs.delete(requestId) })
  }

  /** Stop an installation this manager owns and wait until its files are back.
   * @param requestId The id the installation was started with.
   * @returns `cancelled` once pnpm exited and the files are restored, `too-late` once the bundle is being
   * applied, `not-running` for any other id.
   */
  @Remote
  async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation> {
    const control = this.installs.get(requestId)
    if (control === undefined) return { status: 'not-running' }
    if (control.phase === 'applying') return { status: 'too-late' }
    this.ownerContext.emit('plugin-manager/install-state', { requestId, phase: 'cancelling' })
    control.abort.abort()
    await control.settled
    return { status: 'cancelled' }
  }

  /** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
   * @param name Installed dependency name.
   * @returns Removal diagnostics and the remaining profile state.
   */
  @Remote
  removeBundle(name: string): Promise<ChangeResult> {
    return this.change(async (result) => {
      await this.configure(async () => {
        const bundle = (await this.listBundles()).find(item => item.name === name)
        if (bundle === undefined || !bundle.removable) throw new ManagementFailure('not-removable')
        if (this.ownerContext.get('hmr') === undefined && (this.profile.startedBundles.includes(name)
          || this.bundleRows(name).some(row => [...this.ctx.loader.entries()]
            .some(entry => entry.options.id === row.id && entry.fiber !== undefined)))) {
          throw new ManagementFailure('stop-profile')
        }
        const contributions = bundle.error === undefined ? this.bundleRows(name) : []
        if (bundle.enabled) {
          await this.selectBundle(name, false)
          result.warnings = await this.reload()
        }
        if ([...this.ctx.loader.entries()].some(entry => entry.fiber?.uid != null
          && contributions.some(row => row.id === entry.options.id && row.name === entry.options.name))) {
          throw new ManagementFailure('bundle-in-use')
        }
      })
      result.packageResult = await this.runPnpm(['remove', name])
      if (result.packageResult.exitCode !== 0) throw new Error(result.packageResult.output)
    }, { stage: 'remove', target: name }, 'remove')
  }

  /** The rows a bundle's patch inserts and the existing rows it changes; an unreadable patch throws. */
  private declaredRows(name: string, info: ProfileManifest): Pick<BundleInfo, 'rows' | 'overrides'> {
    const patch = info.dsh?.bundle?.patch
    /* v8 ignore next -- bundleManifest answers only manifests that declare a patch */
    if (patch === undefined) return { rows: [], overrides: [] }
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    const patches: PatchOptions[] = loadOverlayPatches('dsh', join(dir, patch))
    // One entry per row id: the Loader keeps a single entry for an id, whichever layer declared it last.
    const live = new Map<string, PluginEntryId>()
    for (const entry of this.ctx.loader.entries()) {
      /* v8 ignore next -- the Loader gives every entry an id before it is listed */
      if (typeof entry.options.id === 'string') live.set(entry.options.id, pluginEntryId(entry.id))
    }
    const rows: BundleRowInfo[] = []
    for (const row of flatten(composeEntries([patches.filter(item => item.insert !== undefined)]))) {
      if (typeof row.id !== 'string' || typeof row.name !== 'string') continue
      const entryId = live.get(row.id)
      rows.push({ rowId: row.id, moduleName: row.name, ...entryId === undefined ? {} : { entryId } })
    }
    const declared = new Set(rows.map(row => row.rowId))
    const overrides = [...new Set(patches.flatMap(item =>
      item.insert === undefined && typeof item.id === 'string' && !declared.has(item.id) ? [item.id] : []))]
    return { rows, overrides }
  }

  /** Run one pnpm command in the profile, streaming its output as install-log chunks. */
  private async runPnpm(
    args: readonly string[], signal?: AbortSignal, requestId?: PluginInstallRequestId,
  ): Promise<PackageResult> {
    const jobId = randomUUID()
    const argv = ['pnpm', ...args]
    const cwd = this.profile.dir
    const identity = requestId === undefined ? {} : { requestId }
    const task = runProfilePnpm({ ...this.profile, profile: this.profile.name }, args, {
      execution: 'service', command: this.pnpmCommand,
      signal: signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, signal]),
      outputBytes: this.outputBytes, activateNewBundles: false,
      onOutput: (text, stream) => {
        this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream, text })
      },
    })
    this.packageOperations.add(task)
    try {
      const result = await task
      this.ownerContext.emit('plugin-manager/install-log', {
        ...identity, jobId, argv, cwd, stream: 'stdout', text: '', exitCode: signal?.aborted === true ? null : result.exitCode,
      })
      return result.exitCode === 0 ? result : { ...result, kind: classifyInstallFailure({ log: result.output }) }
    } catch (error) {
      this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream: 'stderr', text: messageOf(error), exitCode: null })
      throw error
    } finally {
      this.packageOperations.delete(task)
    }
  }

  /** The profile files an installation may rewrite, as they are now; absent files read as undefined. */
  private async readRestoredFiles(): Promise<Map<string, string | undefined>> {
    const files = new Map<string, string | undefined>()
    for (const name of RESTORED_FILES) {
      const path = join(this.profile.dir, name)
      files.set(path, existsSync(path) ? await readFile(path, 'utf8') : undefined)
    }
    return files
  }

  /** Put the profile files back; pnpm has exited by the time this runs. */
  private async restoreFiles(files: Map<string, string | undefined>): Promise<void> {
    for (const [path, content] of files) {
      if (content === undefined) await rm(path, { force: true })
      else await writeFileAtomic(path, content, { mode: 0o600 })
    }
  }

  private async selectBundle(name: string, enabled: boolean): Promise<void> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const previous = manifest.dsh?.profile?.bundles ?? []
    if ((enabled || !previous.includes(name)) && bundleManifest(name, this.profile.dir, this.profile.installAnchor) === undefined) {
      throw new ManagementFailure('not-bundle')
    }
    if (!enabled && previous.includes(name)) {
      if (this.protectsManager(name)) throw new ManagementFailure('management-required')
    }
    const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter(item => item !== name)
    if (JSON.stringify(previous) === JSON.stringify(bundles)) return
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await saveManifest(this.profile.dir, manifest)
  }

  private bundleRows(name: string): EntryOptions[] {
    const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
    if (info?.dsh?.bundle === undefined) return []
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    return flatten(composeEntries([loadOverlayPatches('dsh', join(dir, info.dsh.bundle.patch))]))
  }

  private protectsManager(name: string): boolean {
    return this.bundleRows(name).some(row => protectedModules.has(row.name) || `include:${row.id}` === this.ownerEntryId)
  }

  private configure<T>(operation: () => Promise<T>): Promise<T> {
    const hmr = this.ownerContext.get('hmr')
    const apply = () => { this.abort.signal.throwIfAborted(); return operation() }
    return hmr === undefined ? apply() : hmr.runExclusive(apply)
  }

  private async reload(requiredIds: readonly string[] = []): Promise<string[]> {
    if (this.ownerContext.get('hmr') === undefined) return []
    return reconcileProfilePatches(this.ownerContext.root, readProfilePatches('dsh', this.profile), 'dsh', requiredIds)
  }

  private async change(
    operation: (result: ChangeResult) => Promise<ChangeResult['application'] | void>,
    request: Pick<ChangeResult, 'stage' | 'target' | 'enabled'>,
    reason: PluginChange['reason'],
  ): Promise<ChangeResult> {
    return withFileLock(join(this.profile.dir, 'package.json'), async () => {
      this.abort.signal.throwIfAborted()
      const before = this.diskState()
      const result: ChangeResult = { ...request, changed: false,
        application: this.ownerContext.get('hmr') !== undefined ? 'applied' : 'restart-required' }
      try {
        result.application = await operation(result) ?? result.application
      } catch (error) {
        if (error instanceof InstallCancelledError) {
          result.application = 'cancelled'
        } else {
          result.application = 'failed'
          result.error = managementError(error)
        }
      }
      result.changed = before !== this.diskState()
      this.ownerContext.emit('plugin-manager/changed', { reason })
      return result
    }, { waitMs: this.lockWaitMs })
  }

  private diskState(): string {
    return ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'].map((file) => {
      try { return readFileSync(join(this.profile.dir, file), 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }).join('\0')
  }
}

export default PluginManager
