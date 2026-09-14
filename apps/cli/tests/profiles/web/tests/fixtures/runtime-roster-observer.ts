/** Test-only IPC observer mounted beside the unchanged default Web composition. */

import type { Context } from '@deepseek-ai/cordis'
import { runtimeRoster } from '../runtime-roster.ts'

/** Services whose live state the observer reads. */
export const inject = ['loader', 'clientModules']

/**
 * Observe the shipped process and optionally mount the real negative-control plugin dynamically.
 * @param ctx - context in the real Loader tree.
 * @param config - absolute module URL used only by the explicit negative-control command.
 */
export function apply(ctx: Context, config: { negativeControl: string }): void {
  if (process.send === undefined) throw new Error('Runtime roster observer requires an IPC channel')
  const receive = (message: unknown): void => {
    if (message === 'stop') {
      process.emit('SIGTERM')
      return
    }
    if (message !== 'roster' && message !== 'mount-experimental' && message !== 'mount-experimental-entry') return
    void (async () => {
      if (message === 'mount-experimental') {
        const namespace: unknown = await import(config.negativeControl)
        await ctx.plugin(ctx.loader.unwrapExports(namespace))
      }
      if (message === 'mount-experimental-entry') await ctx.loader.create({ name: config.negativeControl })
      await ctx.loader.await()
      process.send!({ command: message, roster: runtimeRoster(ctx) })
    })().catch((error: unknown) => {
      process.send!({ command: message, error: error instanceof Error ? error.stack : String(error) })
    })
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => { process.off('message', receive) }
  })
}
