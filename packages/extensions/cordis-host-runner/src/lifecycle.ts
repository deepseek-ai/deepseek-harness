/**
 * Host-half fiber lifecycle over the `cordis-dynamic` group: settle a
 * sandbox-produced plugin as a child fiber (never leaving a failed fiber
 * mounted), and report the services a settled-but-pending fiber still waits
 * for. Stopping needs no helper — a host half unwinds through an ordinary
 * awaited `fiber.dispose()`, because everything the plugin registered is an
 * effect on its fiber.
 * @module @deepseek-ai/dsh-cordis-host-runner/lifecycle
 */

import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { guardedPlugin } from './guard.ts'

/**
 * Await the group, start and settle one guarded child, and dispose it before rethrowing any
 * startup failure so a failed run never lingers. A valid unresolved inject may remain pending.
 * @param group - the `cordis-dynamic` group fiber every host half hangs under.
 * @param plugin - the plugin the sandbox returned; wrapped with the registration guard before starting.
 * @param reportGuardFailure - reports post-activation Host guard rejections to the owning Agent.
 * @returns the settled child fiber (possibly pending on unsatisfied `inject`).
 */
export async function startHostHalf(
  group: Fiber,
  plugin: Plugin,
  reportGuardFailure: (error: Error) => void,
): Promise<Fiber> {
  await group.await()
  const fiber = group.ctx.plugin(guardedPlugin(plugin, reportGuardFailure))
  try {
    await fiber.await()
  } catch (error) {
    await fiber.dispose()
    const message = error instanceof Error ? error.message : String(error)
    // The commonest startup collision is running a NEW version of a package
    // while the old run still holds the name — teach the replace recipe.
    if (message.includes('already registered')) {
      throw new Error(
        `${message} — to REPLACE something an earlier dynamic package registered, first stop that package through its runner or the Cordis panel `
        + 'before running the new version.',
      )
    }
    throw error instanceof Error ? error : new Error(message)
  }
  return fiber
}

/**
 * The services a fiber declared in `inject` that do not exist yet — a settled
 * fiber that is not active is waiting on exactly these (legal cordis
 * semantics: it activates when the service appears).
 * @param ctx - the context to resolve service existence against.
 * @param fiber - the host-half fiber whose `inject` declarations are checked.
 * @returns the missing service names, in declaration order.
 */
export function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
}
