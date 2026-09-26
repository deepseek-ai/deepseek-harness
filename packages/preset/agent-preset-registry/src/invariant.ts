/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-preset-registry`.
 * @module @deepseek-ai/dsh-agent-preset-registry/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Type-only: resolves the `system-prompt/assemble` waterfall this companion
// joins, and the `agent` field `dsh-agent` merges into its context.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
// Imported through the package name, not `./mount.ts`: a module shared between
// the two build entry points becomes a third chunk that the published `files`
// list does not carry, which `verify-built-package-invariants` rejects.
import { leakedServices, livePresetMounts } from '@deepseek-ai/dsh-agent-preset-registry'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-preset-registry'

/** Cordis companion plugin name. */
export const name = 'agent-presets-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Assert that no installed preset composition reaches the root service realm,
 * and that a deployment configuring a roster composes every agent from it.
 *
 * `mountPreset` proves the first once, when the subtree settles. A row that
 * publishes later — from a timer, or an asynchronous continuation after its
 * plugin returned — would escape that one-shot audit, so re-check every live
 * mount whenever a service registration changes.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/service', function (this: Context, name) {
    for (const mount of livePresetMounts()) {
      const leaked = leakedServices(ctx, mount.fiber)
      if (leaked.length === 0) continue
      fail(
        `preset "${mount.presetId}" published process-global service(s) [${leaked.join(', ')}] `
        + `after its mount was audited (observed while notifying "${name}") — `
        + 'a preset service must sit behind an `isolate` realm or move to the host composition',
      )
    }
  }, { global: true })

  // Bare Agents are valid until model assembly. Cold scoped reads carry no
  // Agent and do not require a session binding.
  ctx.on('system-prompt/assemble', (_assembly, context, next) => {
    const presets = ctx.get('agentPresets')
    const agent = context.agent
    if (presets !== undefined
      && agent !== undefined && presets.composedPreset(agent.ctx) === undefined) {
      fail(
        `agent "${agent.id}" addressed a model without joining any agent preset while a roster is `
        + 'composed; its tools, prompt sections, and skill catalog resolve against the empty global layer',
      )
    }
    return next()
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
