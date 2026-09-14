/**
 * Exclusive named registration for the computer-use capability.
 * @module @deepseek-ai/dsh-computer-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ComputerUseProviderName } from './brand.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    computerUse: ComputerUseRegistry
  }
}

/** Owns one optional provider registration in the shared computer-use service. */
export class ComputerUseRegistry extends Service {
  private registration: ComputerUseProviderName | undefined

  constructor(ctx: Context) {
    super(ctx, 'computerUse')
  }

  /** Name of the registered provider, including while its resources are closing. */
  get providerName(): ComputerUseProviderName | undefined {
    return this.registration
  }

  /**
   * Reserve the sole provider slot until the contribution is disposed.
   * A second registration fails even when it repeats the current name. Providers
   * must stop their tools and await owned work before releasing this registration.
   * @param name - provider-owned name used in registration diagnostics.
   * @returns the effect disposer for this exact registration.
   */
  register(name: ComputerUseProviderName): () => Promise<void> {
    if (this.registration !== undefined) {
      throw new Error(`computer use provider "${this.registration}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.registration = name
      return () => {
        this.registration = undefined
      }
    }, 'computerUse.register()')
  }
}

export default ComputerUseRegistry
