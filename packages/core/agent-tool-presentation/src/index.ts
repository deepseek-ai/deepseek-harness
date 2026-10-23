/**
 * Select built-in tool execution for every Agent in the mounting scope.
 * @module
 * @deprecated Mount @deepseek-ai/dsh-tool-executor-native or @deepseek-ai/dsh-tool-executor-ptc directly.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'

/** Cordis plugin name. */
export const name = 'tool-presentation'

/**
 * Native selection does not require a program runtime; the PTC child waits
 * for its runtime before registering an executor in this scope.
 */
export const inject = ['tools']

/**
 * Plugin config.
 * @deprecated Select the native or PTC executor plugin directly instead of configuring a mode.
 */
export interface Config {
  /**
   * The form this agent's model sees. `native` sends every visible schema,
   * `ptc` sends only `run_code` plus a generated SDK.
   * Required rather than defaulted: the deployment default is what a preset
   * without this row already gets, so an omitted value would mean the row was
   * composed for nothing.
   */
  mode: 'native' | 'ptc'
}

/**
 * Runtime schema.
 * @deprecated Select the native or PTC executor plugin directly instead of configuring a mode.
 */
// oxlint-disable-next-line typescript/no-deprecated -- The compatibility schema validates its own deprecated configuration.
export const Config: z<Config> = z.object({
  mode: z.union(['native', 'ptc'] as const).required(),
})

/**
 * Declare the tool presentation for every agent this composition covers.
 * @param ctx - the mounting composition's scope context (a preset's standing scope).
 * @param config - the selected presentation.
 * @deprecated Mount @deepseek-ai/dsh-tool-executor-native or @deepseek-ai/dsh-tool-executor-ptc directly.
 */
// oxlint-disable-next-line typescript/no-deprecated -- The compatibility plugin still accepts this configuration.
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(config.mode === 'native' ? NativeToolExecutor : PtcToolExecutor)
}
