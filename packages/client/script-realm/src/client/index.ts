/** Cordis-owned script-environment providers, independent from module placement. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ScriptRealm, ScriptRealmCreateOptions, ScriptRealmFactory, ScriptRealmId } from './types.ts'

export type { ScriptRealm, ScriptRealmCreateOptions, ScriptRealmFactory, ScriptRealmId, ScriptRealmScript } from './types.ts'

/** Failure of one execution-environment operation. */
export class ScriptRealmError extends Error {
  /** Realm operation that failed. */
  readonly stage: 'create' | 'expose' | 'execute' | 'dispose'
  /** Environment in which the operation failed. */
  readonly realmId: ScriptRealmId
  /** Requested script URL when the failure concerns script execution. */
  readonly url?: string

  constructor(options: {
    readonly stage: ScriptRealmError['stage']
    readonly realmId: ScriptRealmId
    readonly message: string
    readonly url?: string
    readonly cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = 'ScriptRealmError'
    this.stage = options.stage
    this.realmId = options.realmId
    if (options.url !== undefined) this.url = options.url
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Registered execution-environment providers; instances belong to their creators. */
    scriptRealms: ScriptRealmRegistry
  }
}

/** Registers provider factories through their calling plugin's effect lifetime. */
export class ScriptRealmRegistry extends Service {
  private readonly factories = new Map<string, ScriptRealmFactory>()

  constructor(ctx: Context) {
    super(ctx, 'scriptRealms')
  }

  /**
   * Register one provider without creating any environment.
   * @param name - Exact provider name.
   * @param factory - Environment factory retained until the registration is disposed.
   * @returns The caller-owned registration disposer; duplicate names reject.
   */
  register(name: string, factory: ScriptRealmFactory): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.factories.has(name)) throw new Error(`script-realms: provider ${JSON.stringify(name)} is already registered`)
      this.factories.set(name, factory)
      return () => {
        this.factories.delete(name)
      }
    }, `scriptRealms.register(${JSON.stringify(name)})`)
  }

  /**
   * Create an environment through an already registered provider.
   * @param name - Exact provider name.
   * @param options - Instance identity and cancellation; the caller owns the returned instance.
   * @returns The provider's ready environment; unknown providers reject.
   */
  async create(name: string, options: ScriptRealmCreateOptions): Promise<ScriptRealm> {
    const factory = this.factories.get(name)
    if (factory === undefined) {
      throw new ScriptRealmError({ stage: 'create', realmId: options.id,
        message: `script-realms: provider ${JSON.stringify(name)} is not registered` })
    }
    options.signal.throwIfAborted()
    return await factory.create(options)
  }
}

export default ScriptRealmRegistry
