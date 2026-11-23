/** Dedicated Script Realms of script-isolated packages: one Realm per package, never shared. */
import type { ScriptRealm, ScriptRealmId } from '@deepseek-ai/dsh-client-script-realm/client'
import type { IsolatedRealmFactory } from './manifest.ts'

/**
 * Packages whose Client plugins provide the Realms of script-isolated packages: the Realm registry and
 * its `iframe` provider. Entry startup activates them before it creates a script-isolated entry.
 */
export const ISOLATED_REALM_PROVIDER_ROWS: readonly string[] = [
  '@deepseek-ai/dsh-client-script-realm',
  '@deepseek-ai/dsh-client-script-realm-iframe',
]

/** The Realm of one slot, read by disposal. */
interface CreatedRealm {
  /** Realm whose bindings are installed; set only while the slot has not been retired. */
  realm: ScriptRealm | undefined
}

/** One package's Realm, from the start of its creation through disposal. */
interface RealmSlot {
  readonly controller: AbortController
  readonly created: CreatedRealm
  /** Realm with the module-system bindings installed. */
  readonly ready: Promise<ScriptRealm>
}

/**
 * Owns the Realms created for script-isolated packages. A package's slot is created by its first script
 * load and retired when its code is invalidated; a retired slot under replacement stays alive until
 * {@link release}, because the runtime created from it is still running.
 */
export class IsolatedRealms {
  private factory: IsolatedRealmFactory | undefined
  private readonly current = new Map<string, RealmSlot>()
  private readonly replaced = new Map<string, RealmSlot[]>()
  private readonly executions = new Set<Promise<void>>()
  private readonly disposals = new Set<Promise<void>>()
  private sequence = 0
  private closed = false

  /** @param bindings - Globals installed in every Realm before a package script executes. */
  constructor(private readonly bindings: Readonly<Record<string, unknown>>) {}

  /**
   * Install the Realm factory. A script load that starts while none is installed fails.
   * @param factory - Creates one dedicated Realm per package.
   */
  use(factory: IsolatedRealmFactory): void {
    this.factory = factory
  }

  /**
   * Execute one package script in that package's Realm, creating the Realm on first use.
   * @param ownerId - Package that owns the script.
   * @param url - Script URL.
   * @returns After the script loaded; Realm creation, exposure, or execution failure rejects.
   */
  async execute(ownerId: string, url: string): Promise<void> {
    if (this.closed) throw new Error('client-modules: isolated Realms are disposed')
    const execution = this.slot(ownerId).ready.then(realm => realm.execute({ url }))
    this.executions.add(execution)
    try {
      await execution
    } finally {
      this.executions.delete(execution)
    }
  }

  /**
   * Stop using one package's Realm.
   * @param ownerId - Package whose code was invalidated.
   * @param retain - Keep the Realm until {@link release} because its runtime is still mounted.
   */
  retire(ownerId: string, retain: boolean): void {
    const slot = this.current.get(ownerId)
    if (slot === undefined) return
    this.current.delete(ownerId)
    if (retain) this.replaced.set(ownerId, [...this.replaced.get(ownerId) ?? [], slot])
    else this.retireSlot(slot)
  }

  /**
   * Dispose the Realms retained for a package's replaced runtime.
   * @param ownerId - Package whose previous runtime has been torn down.
   */
  release(ownerId: string): void {
    const slots = this.replaced.get(ownerId)
    if (slots === undefined) return
    this.replaced.delete(ownerId)
    for (const slot of slots) this.retireSlot(slot)
  }

  /**
   * Dispose every Realm and reject later executions.
   * @returns After every Realm disposal settled; disposal failures reject together.
   */
  async dispose(): Promise<void> {
    this.closed = true
    for (const id of [...this.current.keys()]) this.retire(id, false)
    for (const id of [...this.replaced.keys()]) this.release(id)
    // A cancelled factory can still return a Realm after retirement. Its execution schedules that disposal.
    await Promise.allSettled(this.executions)
    const results = await Promise.allSettled(this.disposals)
    const failures: unknown[] = []
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'client-modules: isolated Realm disposal failed')
  }

  private slot(ownerId: string): RealmSlot {
    const existing = this.current.get(ownerId)
    if (existing !== undefined) return existing
    const controller = new AbortController()
    const id = `${ownerId}#${String(++this.sequence)}` as ScriptRealmId
    const created: CreatedRealm = { realm: undefined }
    const slot: RealmSlot = { controller, created, ready: this.create(ownerId, id, controller.signal, created) }
    // A failed creation leaves no slot behind, so the next script load starts a new Realm.
    slot.ready.catch((_creationError: unknown) => {
      if (this.current.get(ownerId) !== slot) return
      this.current.delete(ownerId)
      this.retireSlot(slot)
    })
    this.current.set(ownerId, slot)
    return slot
  }

  private async create(ownerId: string, id: ScriptRealmId, signal: AbortSignal, created: CreatedRealm): Promise<ScriptRealm> {
    if (this.factory === undefined) {
      throw new Error(`client-modules: "${ownerId}" isolates its scripts, but no Script Realm provider is installed`)
    }
    const realm = await this.factory({ id, signal })
    try {
      signal.throwIfAborted()
      await realm.expose(this.bindings)
      signal.throwIfAborted()
    } catch (error) {
      this.disposeRealm(realm)
      throw error
    }
    created.realm = realm
    return realm
  }

  private retireSlot(slot: RealmSlot): void {
    slot.controller.abort(new Error('client-modules: isolated Realm retired'))
    if (slot.created.realm !== undefined) this.disposeRealm(slot.created.realm)
  }

  /** Dispose one Realm; a failure is reported at once and again by {@link dispose}. */
  private disposeRealm(realm: ScriptRealm): void {
    const disposal = realm.dispose()
    this.disposals.add(disposal)
    disposal.then(() => { this.disposals.delete(disposal) }, (error: unknown) => {
      console.error(`client-modules: could not dispose isolated Realm ${realm.id}`, error)
    })
  }
}
