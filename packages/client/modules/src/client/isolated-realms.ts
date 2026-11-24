/** Owns each script-isolated package's current Realm. */
import type { Context } from '@deepseek-ai/cordis'
import type { ScriptRealm, ScriptRealmCreateOptions, ScriptRealmId } from '@deepseek-ai/dsh-client-script-realm/client'

/** Ordinary Loader rows whose activation supplies the iframe provider at cold boot. */
export const ISOLATED_REALM_PROVIDER_ROWS: readonly string[] = [
  '@deepseek-ai/dsh-client-script-realm',
  '@deepseek-ai/dsh-client-script-realm-iframe',
]

interface RealmSlot {
  readonly ready: Promise<ScriptRealm>
  readonly dispose: () => void
}

/** An entry and its lazy chunks share one Realm until their generation is invalidated. */
export class IsolatedRealms {
  /** The Loader context, available once entry startup begins. Providers can still come and go. */
  context?: Context
  private readonly current = new Map<string, RealmSlot>()
  private readonly disposals = new Set<Promise<void>>()
  private sequence = 0
  private closed = false

  /** @param bindings - Globals installed in every Realm before a package script executes. */
  constructor(private readonly bindings: Readonly<Record<string, unknown>>) {}

  /**
   * Check whether this generation has an iframe Realm in use or being acquired.
   * @param ownerId - Owning package.
   * @returns Whether its current slot belongs to this owner.
   */
  has(ownerId: string): boolean {
    return this.current.has(ownerId)
  }

  /**
   * Share the package's first acquisition even when several scripts arrive together.
   * @param ownerId - Owning package.
   * @param url - Entry or chunk URL.
   * @returns After script execution; creation, exposure, or script failure rejects.
   */
  async execute(ownerId: string, url: string): Promise<void> {
    if (this.closed) throw new Error('client-modules: isolated Realms are disposed')
    const slot = this.current.get(ownerId) ?? this.open(ownerId)
    const realm = await slot.ready
    await realm.execute({ url })
  }

  private open(ownerId: string): RealmSlot {
    const controller = new AbortController()
    const { signal } = controller
    const id = `${ownerId}#${++this.sequence}` as ScriptRealmId
    const acquired = this.create({ id, signal })
    const ready = acquired.then(async (realm) => {
      signal.throwIfAborted()
      await realm.expose(this.bindings)
      signal.throwIfAborted()
      return realm
    })
    const dispose = (): void => {
      controller.abort(new Error('client-modules: isolated Realm retired'))
      // A provider may return its Realm after cancellation, or exposure may have failed.
      const disposal = acquired.then(realm => realm.dispose(), () => {})
      this.disposals.add(disposal)
      disposal.then(() => { this.disposals.delete(disposal) }, (error: unknown) => {
        console.error(`client-modules: could not dispose isolated Realm ${id}`, error)
      })
    }
    const slot = { ready, dispose }
    this.current.set(ownerId, slot)
    ready.catch(() => { if (this.current.get(ownerId) === slot) this.take(ownerId)?.() })
    return slot
  }

  private async create(options: ScriptRealmCreateOptions): Promise<ScriptRealm> {
    const registry = this.context?.get('scriptRealms')
    if (!registry) throw new Error(`client-modules: script isolation needs the ${ISOLATED_REALM_PROVIDER_ROWS.join(' and ')} entries, and the Realm registry is not active`)
    return await registry.create('iframe', options)
  }

  /**
   * Detach the current generation so subsequent scripts get a fresh Realm.
   * @param id - Invalidated package.
   * @returns Its Realm's disposer, if any; the caller owns it.
   */
  take(id: string): (() => void) | undefined {
    const slot = this.current.get(id)
    this.current.delete(id)
    return slot?.dispose
  }

  /**
   * Stop accepting scripts and retire the remaining slots.
   * @returns After disposal settles for all acquired Realms; failures reject together.
   */
  async dispose(): Promise<void> {
    this.closed = true
    for (const slot of this.current.values()) slot.dispose()
    this.current.clear()
    const results = await Promise.allSettled(this.disposals)
    const failures: unknown[] = []
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length) throw new AggregateError(failures, 'client-modules: isolated Realm disposal failed')
  }
}
