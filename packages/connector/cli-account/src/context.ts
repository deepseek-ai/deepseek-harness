/** Runtime context that tells the model the absolute path of an app plugin's CLI. */

import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** What one app plugin states about its CLI. */
export interface CliPathContext {
  /** Runtime-context name, unique across plugins, such as `feishu:cli`. */
  readonly name: string
  /** Product name in the text, such as `Feishu`. */
  readonly product: string
  /** Name the CLI's guides and skills run it by. */
  readonly program: string
  /** Absolute path of the executable. */
  readonly executable: string
  /** Whether the plugin's skill has scripts that run {@link program} by name; the text then gives their PATH prefix. */
  readonly scripts?: boolean
  /** Whether the executable is installed; the context contributes nothing while it returns false. Absent means always. */
  readonly ready?: () => boolean
}

/**
 * Register required runtime context that tells the model to run the CLI by its absolute path, not by name, and, when
 * the skill has scripts, to start each command that runs them with the executable's directory first on PATH. The text
 * is never interpolated, so a path keeps its exact characters.
 * @param ctx - the plugin context, which injects `systemPrompt`; disposing it removes the context.
 * @param cli - the CLI to describe.
 * @returns the registration's effect disposer.
 */
export function registerCliPathContext(ctx: Context, cli: CliPathContext): () => void {
  const lines = [
    `${cli.product} CLI: run \`${cli.program}\` by its absolute path ${JSON.stringify(cli.executable)}; the bare name may resolve to another installation or to none.`,
  ]
  if (cli.scripts === true) {
    lines.push(`Scripts in the ${cli.product} skill call \`${cli.program}\` by name; prefix only the commands that run them with PATH=${JSON.stringify(`${dirname(cli.executable)}:$PATH`)}, and never export PATH or run \`${cli.program}\` by name yourself.`)
  }
  const text = lines.join('\n')
  const { ready } = cli
  return ctx.systemPrompt.context({
    name: cli.name,
    order: ctx.systemPrompt.getContextOrder('PLUGIN_CLIS'),
    required: true,
    interpolate: false,
    text: ready === undefined ? text : () => (ready() ? text : ''),
  })
}
