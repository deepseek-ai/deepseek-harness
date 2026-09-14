/**
 * Agent-plane presentation selector: the row an agent preset carries to say
 * which form of its tools the model sees.
 *
 * The tool registry itself stays on the host plane — the agent loop's
 * scheduler, the API proxy's presenters, and every tool plugin are all its
 * consumers, so it cannot move into a preset. What a preset CAN own is the
 * presentation: `ctx.tools.presentAs()` declares it for the mounting SCOPE,
 * which is the preset's standing mount, so the declaration covers every agent
 * joined to that preset and a PTC mode preset runs beside native ones in one
 * process. One row per composition, not one per session.
 *
 * A PTC mode needs a TypeScript PTC runtime, which is a host-plane service
 * ([`dsh-ptc-runtime-node`](../../../ptc-runtime/ptc-runtime-node/README.md)).
 * This row therefore waits for it rather than assuming it: a preset selecting
 * PTC mode against a deployment that composes no runtime fails at mount, named
 * in the preset's own activation audit, instead of at the first prompt.
 * @module @deepseek-ai/dsh-agent-tool-presentation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolPresentationMode } from '@deepseek-ai/dsh-tools'
// Type-only: brings the `ctx.tools` Context merge into this program.
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-presentation'

/**
 * Required services. `ptcRuntime` is NOT listed: a `native` row must mount in
 * a deployment that composes no runtime, and the mode-dependent wait is
 * declared inside {@link apply} instead.
 */
export const inject = ['tools']

/** Plugin config. */
export interface Config {
  /**
   * The form this agent's model sees. `native` sends every visible schema,
   * `ptc` sends only `run_code` plus a generated SDK, `both` sends both.
   * Required rather than defaulted: the deployment default is what a preset
   * without this row already gets, so an omitted value would mean the row was
   * composed for nothing.
   */
  mode: ToolPresentationMode
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  mode: z.union(['native', 'ptc', 'both'] as const).required(),
})

/**
 * Declare the tool presentation for every agent this composition covers.
 * @param ctx - the mounting composition's scope context (a preset's standing scope).
 * @param config - the selected presentation.
 */
export function apply(ctx: Context, config: Config): void {
  // `presentAs` is itself the effect — it registers through the calling
  // context and hands back that exact disposer — so the declaration unwinds
  // with this row without a second wrapper owning it.
  if (config.mode === 'native') {
    ctx.tools.presentAs('native')
    return
  }
  // The wait is the loud failure: an entry still pending on `ptcRuntime` is
  // what `dsh-agent-presets` reports as an unusable row, naming this id.
  ctx.inject(['ptcRuntime'], (runtimeCtx: Context) => {
    runtimeCtx.tools.presentAs(config.mode)
  })
}
