/** Script execution in the Main Realm or a package's resident iframe. */
import type {
  ScriptRealm, ScriptRealmCreateOptions, ScriptRealmId, ScriptRealmRegistry, ScriptRealmRegistryHost,
} from '@deepseek-ai/dsh-client-script-realm/client'
import type { BootModuleRow } from './manifest.ts'

/** Ordinary Loader rows whose activation supplies the iframe provider at cold boot. */
export const ISOLATED_REALM_PROVIDER_ROWS: readonly string[] = [
  '@deepseek-ai/dsh-client-script-realm',
  '@deepseek-ai/dsh-client-script-realm-iframe',
]

interface Frame {
  readonly ready: Promise<ScriptRealm>
  readonly close: () => void
}

/** Script placement lasts until the package and its dependents no longer need its code. */
export class PackageRealms implements ScriptRealmRegistryHost {
  private readonly places = new Map<string, 'main' | 'iframe' | Frame>()
  private readonly disposals = new Set<Promise<void>>()
  private registry: ScriptRealmRegistry | undefined
  private closed = false

  /**
   * @param main - Page carrier for ordinary bundles.
   * @param bindings - Globals exposed before the first iframe script.
   */
  constructor(private readonly main: Pick<ScriptRealm, 'execute'>, private readonly bindings: Readonly<Record<string, unknown>>) {}

  installRealmRegistry = (registry: ScriptRealmRegistry): (() => void) => {
    this.registry = registry
    return () => {
      if (this.registry === registry) this.registry = undefined
    }
  }

  /**
   * Keep a factory that arrived in another package's Main batch in the Main Realm.
   * @param id - Owning package.
   */
  registered(id: string): void {
    if (!this.closed && !this.places.has(id)) this.places.set(id, 'main')
  }

  /**
   * Execute the entry, a chunk, or rebuilt code in the same package environment.
   * @param row - Descriptor of the package whose script is loading.
   * @param url - Revisioned script URL.
   * @returns After execution; an unavailable iframe provider never falls back to Main.
   */
  async execute(row: Pick<BootModuleRow, 'id' | 'isolation'>, url: string): Promise<void> {
    if (this.closed) throw new Error('client-modules: package Realms are disposed')
    const { id } = row
    let place = this.places.get(id)
    if (place === undefined) {
      place = row.isolation.script ? 'iframe' : 'main'
      this.places.set(id, place)
    }
    if (place === 'main') return this.main.execute({ url })
    const frame = place === 'iframe' ? this.open(id) : place
    const realm = await frame.ready
    await realm.execute({ url })
  }

  private open(id: string): Frame {
    const controller = new AbortController()
    const { signal } = controller
    const acquired = this.create({ id: id as ScriptRealmId, signal })
    const ready = acquired.then(async (realm) => {
      signal.throwIfAborted()
      await realm.expose(this.bindings)
      signal.throwIfAborted()
      return realm
    })
    const close = (): void => {
      controller.abort(new Error('client-modules: package iframe closed'))
      // A provider may return its iframe after cancellation, or exposing the bindings may fail.
      const disposal = acquired.then(realm => realm.dispose(), () => {})
      this.disposals.add(disposal)
      disposal.then(() => { this.disposals.delete(disposal) }, (error: unknown) => {
        console.error(`client-modules: could not dispose isolated Realm ${id}`, error)
      })
    }
    const frame = { ready, close }
    this.places.set(id, frame)
    ready.catch(() => {
      if (this.places.get(id) !== frame) return
      this.places.set(id, 'iframe')
      close()
    })
    return frame
  }

  private async create(options: ScriptRealmCreateOptions): Promise<ScriptRealm> {
    const registry = this.registry
    if (!registry) throw new Error(`client-modules: script isolation needs the ${ISOLATED_REALM_PROVIDER_ROWS.join(' and ')} entries, and the Realm registry is not active`)
    return await registry.create('iframe', options)
  }

  /**
   * Release a package's placement and close its iframe, if any.
   * @param id - Package evicted by the module table.
   */
  evict(id: string): void {
    const place = this.places.get(id)
    this.places.delete(id)
    if (typeof place === 'object') place.close()
  }

  /**
   * Stop accepting scripts and release every package.
   * @returns After all iframe disposals settle; failures reject together.
   */
  async dispose(): Promise<void> {
    this.closed = true
    for (const id of this.places.keys()) this.evict(id)
    const results = await Promise.allSettled(this.disposals)
    const failures: unknown[] = []
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length) throw new AggregateError(failures, 'client-modules: isolated Realm disposal failed')
  }
}
