/**
 * The effect controller behind `whenAccess`: install a callback's effects
 * while one access answer is true and dispose them while it is false.
 * @module @deepseek-ai/dsh-api-remote-access/src/client/when-allowed
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One synchronous effect installed while access holds: a disposer, or disposers installed as one transaction. */
export type AccessEffect = (() => void) | Iterable<() => void, void, void>

/**
 * Install `callback`'s effects while `answer` is true. The callback runs
 * synchronously when the answer is already true; a later true runs it again
 * after a false disposed the previous installation in reverse order. The
 * controller belongs to `ctx`'s fiber.
 * @param ctx - the caller's Context; it owns the controller and every installation.
 * @param answer - the access answer to follow.
 * @param callback - creates one disposer or an iterable of disposers.
 * @param label - effect label for diagnostics.
 * @returns idempotent disposer for the controller and any installed effects.
 * @throws callback setup failures synchronously when the answer is already true.
 */
export function whenAllowed(
  ctx: Context,
  answer: HostObservable<boolean>,
  callback: () => AccessEffect,
  label: string,
): () => void {
  const disposeController = ctx.effect(() => {
    let installed: (() => void) | undefined
    let stopped = false

    const uninstall = (): void => {
      const dispose = installed
      installed = undefined
      dispose?.()
    }

    const reconcile = (): void => {
      if (stopped) return
      const allowed = answer.getSnapshot()
      if (allowed === (installed !== undefined)) return
      if (!allowed) {
        uninstall()
        return
      }
      // Each installation is a nested Cordis effect, so an iterable callback
      // installs transactionally and disposes in reverse order.
      const disposeEffect = ctx.effect(callback, `${label}: allowed`)
      installed = () => { void disposeEffect() }
    }

    const unsubscribe = answer.subscribe(() => { changed() })

    const stop = (): void => {
      if (stopped) return
      // A failed installation retires the controller: a later grant never retries it.
      stopped = true
      unsubscribe()
      uninstall()
    }

    const changed = (): void => {
      try {
        reconcile()
      } catch (error) {
        stop()
        if ((error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT') return
        const failure = error instanceof Error ? error : new Error(String(error))
        queueMicrotask(() => { throw failure })
      }
    }

    try {
      reconcile()
    } catch (error) {
      stop()
      throw error
    }
    return stop
  }, label)
  return () => { void disposeController() }
}
