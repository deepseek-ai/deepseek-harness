/**
 * Per-package browser lifecycle: evaluate the closure, wrap `apply` in the guard
 * facade, seat a ready-made factory in the module table, and create a loader
 * entry — so dynamic packages ride the exact machinery static plugins do
 * (activation gating on inject, fiber-effect cleanup, status projection). Unload
 * = loader entry removal (fiber disposal cascades slot entries and facade
 * effects) + factory invalidation + style removal.
 *
 * The engine answers its caller: `load` resolves with what this page ended up
 * with, which is what the run orchestration reports back to the host. Loads
 * converge by Plugin Run ID against live state, not history: loading the exact
 * activation this page already runs is a no-op that still answers, another run
 * replaces it, and the same Package after a retract loads afresh. Per-Plugin
 * serialization keeps a second request from interleaving with one in flight.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, DynamicCordisPackage,
  SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DynamicCordisStyles, evaluateClientHalf, DYNAMIC_CLIENT_REDIRECTS } from './evaluator.ts'
import type { DynamicCordisEvaluatedPlugin } from './evaluator.ts'
import { dynamicCordisContext } from './guard.ts'
import type { DynamicCordisSlotLedgerRow } from './guard.ts'

/**
 * Snapshot source a surface can subscribe to (the render seam's observable
 * shape). Lives here because both this engine and the run orchestration publish
 * through it, and the orchestration already depends on this module.
 */
export interface CordisObservable<T> {
  /** Current value; the reference is stable between mutations. */
  getSnapshot(): T
  /**
   * Observe mutations.
   * @param fn - notified after each committed change.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
}

/** Which stage of a load failed, as the page classified it. */
export type DynamicCordisLoadErrorCause = 'evaluate' | 'module-import' | 'activate'

/** Error fields retained by the page runner and Host transport. */
export interface CordisErrorDetails {
  /** Original error message. */
  message: string
  /** Original stack when the thrown value supplied one. */
  stack?: string
}

/** One package's browser half as the host handed it over. */
export interface DynamicCordisClientHalf {
  /** Stable Plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Immutable Package source version. */
  packageId: CordisDynamicPackageId
  /** Exact activation. */
  pluginRunId: CordisDynamicPluginRunId
  /** Session the run is carried out for; a later render failure is reported under it. */
  agentId: SessionId
  /** Label from the define call; also the plugin name. */
  name: string
  /** Browser-half source: an async function body returning a plugin. */
  code: string
}

/**
 * One render-time crash of a dynamic package's slot entry, as this page reports
 * it. Post-settle diagnosis only: the run it belongs to was answered long before
 * (a package that crashes while rendering loaded successfully), so this never
 * reaches a run resolution.
 */
export interface DynamicCordisRenderFailure {
  /** Slot key the crashed entry rendered under. */
  slot: string
  /** What the author has to read to fix it: the crash text, plus a redirect when it names a withheld global. */
  message: string
  /** Original render failure stack when available. */
  stack?: string
  /** Whether the crash retired the entry from its cell — the package's UI is gone, not merely broken. */
  abdicated: boolean
}

/**
 * What this page ended up with. A parked package is a success — the browser half
 * settled and waits on declared services this page has not got.
 */
export type DynamicCordisLoadResult =
  | { ok: true; pluginRunId: CordisDynamicPluginRunId; waitingFor?: string[] }
  | ({ ok: false; cause: DynamicCordisLoadErrorCause; error?: unknown } & CordisErrorDetails)

/** The `window.__ModuleLoader__` registration sink (client-modules contract C6). */
interface ModuleLoaderSink {
  __ModuleLoader__?: {
    load(handoff: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void
  }
}

/** One live package's bookkeeping. */
interface LivePackage {
  pkg: DynamicCordisPackage
  entryId: string
  styles: DynamicCordisStyles
  ledger: DynamicCordisSlotLedgerRow[]
  /** Services the browser half declared and this page has not got (parked, still a success). */
  waitingFor: string[]
}

/** Runner dependencies, resolved by the plugin entry at activation. */
export interface DynamicCordisRunnerEnv {
  /** The client root context (service reads and the guard's fiber owner). */
  ctx: Context
  /** Client cordis Loader: dynamic packages become entries under it. */
  loader: Loader
  /** Module table, for factory invalidation before every (re-)registration. */
  modules: ClientModuleSystem
  /** Slot registry, for the entry-crash supervision seam. */
  slots: SlotRegistry
  /** Route one `host.call` to the package's host half through the Remote namespace. */
  invoke(
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    method: string,
    args: unknown,
  ): Promise<unknown>
  /**
   * Send one render-time crash back to the session that authored the package.
   * Fire-and-forget by contract: the crash already happened, and a failed report
   * must not become a second failure.
   * @param agentId - session the crashed package was run for.
   * @param id - the crashed package.
   * @param failure - slot, teaching text, and whether the entry was retired.
   */
  reportRenderFailure(
    agentId: SessionId,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    failure: DynamicCordisRenderFailure,
  ): void
  /** Send one post-activation Client guard rejection to the owning Agent. */
  reportGuardFailure(
    agentId: SessionId,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    failure: CordisErrorDetails,
  ): void
}

/** Module-table id of one package (also its loader entry name and fiber name). */
function moduleIdOf(id: CordisDynamicPluginId): string {
  return `dyn/${id}`
}

/** One live package's contribution summary in this page. */
export interface DynamicCordisLivePackage {
  /** Stable Plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Immutable Package source version. */
  packageId: CordisDynamicPackageId
  /** Exact activation loaded in this page. */
  pluginRunId: CordisDynamicPluginRunId
  /** Label from the define call. */
  name: string
  /** Slot names and `factory:<name>` definitions this package registered here. */
  slots: string[]
  /** Live injected-style tag count. */
  styleCount: number
}

/** The browser-side load engine for dynamic packages. */
export class DynamicCordisPackageRunner {
  private readonly live = new Map<CordisDynamicPluginId, LivePackage>()
  /** Serializes load/unload per package id (a second request can outrun a slow load). */
  private readonly queues = new Map<CordisDynamicPluginId, Promise<unknown>>()
  private readonly changeListeners = new Set<() => void>()
  /** Page-local shadowing rank. A later registration receives a lower priority. */
  private nextPriority = 0
  /**
   * Which package seated which component, and for whom. Component identity is the
   * only attribution key that holds:
   * - the registry stores the component verbatim, so a crashed entry carries its
   *   own way back — no parallel entry ledger to keep in step;
   * - `entry.registrant` is `options.registrant ?? fiber.name` and the facade does
   *   not strip a package-supplied one, so a package could name itself something
   *   else — attributing by it would let a package impersonate another;
   * - the assigned shadowing priority is unique but absent on chain entries (their
   *   election is deliberately left alone), so it would miss chain crashes;
   * - a package torn down between the crash and the report is still attributable,
   *   because this index does not depend on the live record.
   *
   * Two packages cannot collide here: each browser half is evaluated in its own
   * closure, so no component object reaches two of them. A collision is only
   * possible inside ONE package (the same component seated twice), where both
   * entries map to the same id and the value is identical.
   */
  private readonly owners = new WeakMap<object, {
    pluginId: CordisDynamicPluginId
    pluginRunId: CordisDynamicPluginRunId
    agentId: SessionId
  }>()
  /** This page's last render crash per package: what a run surface shows on the row. */
  private readonly failures = new Map<CordisDynamicPluginId, DynamicCordisRenderFailure>()
  private readonly unwatch: () => void
  private snapshotCache: readonly DynamicCordisLivePackage[] | undefined
  private failureCache: ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure> | undefined

  /** @param env - loader/module/slot wiring plus the two host verbs this engine uses. */
  constructor(private readonly env: DynamicCordisRunnerEnv) {
    // The supervision seam fires for EVERY entry crash on the page, factory UI
    // included; only the ones this runner seated are ours to report.
    this.unwatch = env.slots.onEntryError((slot, entry, error, info) => {
      const component: unknown = (entry as { component?: unknown }).component
      const owner = indexable(component) ? this.owners.get(component) : undefined
      if (owner === undefined) return
      const details = errorDetails(error)
      const failure: DynamicCordisRenderFailure = {
        slot,
        message: renderFailureMessage(slot, details.message),
        ...details.stack === undefined ? {} : { stack: details.stack },
        abdicated: info.abdicated,
      }
      // One observation, two outlets with different owners and lifetimes: the host
      // keeps the last crash ACROSS pages for the model, this map is what THIS page
      // currently shows. Neither is derived from the other.
      env.reportRenderFailure(owner.agentId, owner.pluginId, owner.pluginRunId, failure)
      this.failures.set(owner.pluginId, failure)
      this.notify()
    })
  }

  /**
   * Observe live-set changes (the run-state surface's re-render seam).
   * @param fn - notified after every converged mutation.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => { this.changeListeners.delete(fn) }
  }

  /**
   * This page's last render crash per package, on the same notification channel as
   * the live set — a surface that already subscribed learns about a crash without
   * a second mechanism to wire.
   */
  readonly renderFailures: CordisObservable<ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure>> = {
    getSnapshot: () => this.failureCache ??= new Map(this.failures),
    subscribe: fn => this.subscribe(fn),
  }

  /**
   * What this page currently has loaded (stable reference between mutations, so
   * it can back a snapshot selector).
   * @returns one row per live package.
   */
  getSnapshot(): readonly DynamicCordisLivePackage[] {
    return this.snapshotCache ??= [...this.live.values()].map(({ pkg, ledger, styles }) => ({
      pluginId: pkg.pluginId,
      packageId: pkg.packageId,
      pluginRunId: pkg.pluginRunId,
      name: pkg.name,
      slots: [...new Set(ledger.map(row => row.slot))],
      styleCount: styles.count,
    }))
  }

  /**
   * Whether this page has the browser half loaded — page-local truth, never the
   * host's "it is running".
   * @param pluginId - stable Plugin identity.
   * @returns true while one activation of the Plugin is live here.
   */
  isLoaded(pluginId: CordisDynamicPluginId): boolean {
    return this.live.has(pluginId)
  }

  /**
   * Load one browser half into this page and answer what happened.
   * @param half - source for one exact Host activation.
   * @returns the outcome the run orchestration reports to the host.
   */
  load(half: DynamicCordisClientHalf): Promise<DynamicCordisLoadResult> {
    return this.enqueue(half.pluginId, async () => {
      const current = this.live.get(half.pluginId)
      if (current !== undefined) {
        // Already running this activation here: nothing to load, but the caller
        // still needs an answer (a replayed run must not look unacknowledged).
        if (current.pkg.pluginRunId === half.pluginRunId) return settled(current)
        await this.teardown(current.pkg.pluginId, current.entryId, current.styles)
      }
      const result = await this.mount(half)
      this.notify()
      return result
    })
  }

  /**
   * Unload one package (`cordis/dynamic-retract`: a stop, or an undefine
   * that stops first).
   * @param pluginId - stable Plugin identity.
   * @param pluginRunId - exact activation being retracted; a newer run survives.
   */
  retract(pluginId: CordisDynamicPluginId, pluginRunId: CordisDynamicPluginRunId): void {
    void this.enqueue(pluginId, async () => {
      const current = this.live.get(pluginId)
      if (current === undefined || current.pkg.pluginRunId !== pluginRunId) return
      await this.teardown(pluginId, current.entryId, current.styles)
      this.notify()
    })
  }

  /** Unload everything (plugin disposal path). */
  async dispose(): Promise<void> {
    this.unwatch()
    for (const current of [...this.live.values()]) {
      await this.teardown(current.pkg.pluginId, current.entryId, current.styles)
    }
    this.notify()
  }

  private notify(): void {
    this.snapshotCache = undefined
    this.failureCache = undefined
    for (const fn of [...this.changeListeners]) fn()
  }

  /** Queue one package operation behind that package's previous ones. */
  private enqueue<T>(id: CordisDynamicPluginId, op: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(op)
    // The queue tail must survive this operation's failure, or one rejection
    // would wedge every later operation on the same package.
    this.queues.set(id, next.then(() => {}, () => {}))
    return next
  }

  private async mount(half: DynamicCordisClientHalf): Promise<DynamicCordisLoadResult> {
    const styles = new DynamicCordisStyles(half.pluginId)
    const ledger: DynamicCordisSlotLedgerRow[] = []
    let plugin: DynamicCordisEvaluatedPlugin | ((ctx: unknown) => unknown)
    try {
      plugin = await evaluateClientHalf(half.pluginId, half.code, {
        invoke: (method, args) => this.env.invoke(half.pluginId, half.pluginRunId, method, args),
        noteError: (message) => {
          // A loaded package's own console.error: a page-local diagnostic with
          // no wire carrier (the run round trip settled long before).
          console.error(`[cordis-client-runner] ${half.pluginId} logged an error:`, message)
        },
      }, styles)
    } catch (error) {
      styles.dispose()
      return { ok: false, cause: 'evaluate', ...errorDetails(error), error }
    }

    const pkg: DynamicCordisPackage = {
      pluginId: half.pluginId,
      packageId: half.packageId,
      pluginRunId: half.pluginRunId,
      name: half.name,
    }
    const surface = this.guardedSurface(pkg, half.agentId, plugin, ledger)
    const moduleId = moduleIdOf(half.pluginId)
    // Invalidate-then-register keeps re-loading legal: the module table throws
    // loudly on a duplicate factory registration.
    this.env.modules.invalidate(moduleId)
    const sink = (globalThis as ModuleLoaderSink).__ModuleLoader__
    if (sink === undefined) {
      throw new Error('cordis-client-runner: window.__ModuleLoader__ is missing (booted outside the web shell?)')
    }
    sink.load({ id: moduleId, factory: () => surface })

    const entryId = await this.env.loader.create({ name: moduleId })
    const fiber = this.env.loader.resolve(entryId).fiber
    if (fiber === undefined) {
      await this.teardown(half.pluginId, entryId, styles)
      return { ok: false, cause: 'module-import', message: 'module import failed (see the browser console)' }
    }
    try {
      await fiber.await()
    } catch (error) {
      await this.teardown(half.pluginId, entryId, styles)
      return { ok: false, cause: 'activate', ...errorDetails(error), error }
    }
    // Settled but not active = legal pending on an unsatisfied declaration. The
    // record is seated only now, so an error mirrored during `apply` cannot
    // claim the package is already live.
    const waitingFor = Object.keys(fiber.inject).filter(name => this.env.ctx.get(name) === undefined)
    const record: LivePackage = { pkg, entryId, styles, ledger, waitingFor }
    this.live.set(half.pluginId, record)
    // A fresh load answers for itself: whatever this page last showed as crashed
    // is no longer true of what is mounted now.
    this.failures.delete(half.pluginId)
    return settled(record)
  }

  /**
   * Wrap the evaluated plugin so `apply` sees the guard facade; the surface
   * doubles as the module-table module. The plugin's OWN `inject` survives (the
   * object form's declaration is the facade's service gate, mirroring the host
   * sandbox reading `ctx.fiber.inject`); the function form has no declaration
   * site and therefore reaches no service.
   */
  private guardedSurface(
    pkg: DynamicCordisPackage,
    agentId: SessionId,
    plugin: DynamicCordisEvaluatedPlugin | ((ctx: unknown) => unknown),
    ledger: DynamicCordisSlotLedgerRow[],
  ): DynamicCordisEvaluatedPlugin {
    const claim = (component: unknown): void => {
      if (indexable(component)) {
        this.owners.set(component, { pluginId: pkg.pluginId, pluginRunId: pkg.pluginRunId, agentId })
      }
    }
    const guarded = (ctx: unknown): Context => dynamicCordisContext(ctx as Context, {
      pkg,
      ledger,
      claim,
      allocatePriority: () => --this.nextPriority,
      reportFailure: (error) => {
        this.env.reportGuardFailure(agentId, pkg.pluginId, pkg.pluginRunId, errorDetails(error))
      },
    })
    if (typeof plugin === 'function') {
      return { name: moduleIdOf(pkg.pluginId), apply: (ctx: unknown) => plugin(guarded(ctx)) }
    }
    return {
      ...plugin,
      name: moduleIdOf(pkg.pluginId),
      apply: (ctx: unknown, config?: unknown) => plugin.apply(guarded(ctx), config),
    }
  }

  /**
   * Unload one package's contributions. Takes the pieces rather than the record
   * because a load can fail before any record is seated.
   */
  private async teardown(
    id: CordisDynamicPluginId,
    entryId: string,
    styles: DynamicCordisStyles,
  ): Promise<void> {
    this.live.delete(id)
    // Nothing of this package renders here any more, so a crash row would outlive
    // the thing it described.
    this.failures.delete(id)
    // Entry removal disposes the fiber (slot entries and facade effects
    // cascade); the factory invalidation makes a later re-load legal.
    const disposal = this.env.loader.resolve(entryId).fiber?.dispose()
    this.env.loader.remove(entryId)
    await disposal
    this.env.modules.invalidate(moduleIdOf(id))
    styles.dispose()
  }
}

/** The success answer for a package that is live here, parked or active. */
function settled(record: { pkg: DynamicCordisPackage; waitingFor: string[] }): DynamicCordisLoadResult {
  return {
    ok: true,
    pluginRunId: record.pkg.pluginRunId,
    ...record.waitingFor.length > 0 ? { waitingFor: record.waitingFor } : {},
  }
}

/**
 * Whether a component can key the ownership index. Identity is the key, so only
 * objects and functions qualify — a package may register anything, and what it
 * registered is what a crash report carries back.
 * @param component - whatever a package passed as its component.
 * @returns true when the value can be indexed by identity.
 */
function indexable(component: unknown): component is object {
  return typeof component === 'object' && component !== null || typeof component === 'function'
}

/**
 * Preserve error fields for a load result without fabricating a stack.
 * @param error - original thrown value.
 * @returns its message and original string stack, when present.
 */
/* jscpd:ignore-start */
export function errorDetails(error: unknown): CordisErrorDetails {
  if (typeof error !== 'object' || error === null) return { message: String(error) }
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : Object.prototype.toString.call(error)
  const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined
  return { message, ...stack === undefined ? {} : { stack } }
}
/* jscpd:ignore-end */

/**
 * What the authoring session reads about one render crash. The slot says where it
 * happened, the crash message says what broke, and a withheld global named in that
 * text pulls in its redirect — a package that reached `window.setInterval` around
 * the closure trap crashes with the engine's bare message, which teaches nothing.
 */
function renderFailureMessage(slot: string, message: string): string {
  const redirect = Object.entries(DYNAMIC_CLIENT_REDIRECTS)
    .find(([name, text]) => message.includes(name) && !message.includes(text))?.[1]
  const subject = slot.startsWith('factory:')
    ? `your component in Factory "${slot.slice('factory:'.length)}"`
    : `your entry in slot "${slot}"`
  return `${subject} crashed while React rendered it: ${message}`
    + (redirect === undefined ? '' : `\n${redirect}`)
}
