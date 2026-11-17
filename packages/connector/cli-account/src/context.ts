/** Runtime context that tells the model the absolute path of an app plugin's CLI. */

import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** What one app plugin states about its CLI. */
export interface CliPathContext {
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
 * Write the runtime-context text in the dialect of the shell that shipped compositions give the model on `platform`:
 * PowerShell on Windows, where `tool-pwsh` replaces `tool-bash`, and a POSIX shell elsewhere. Paths are quoted as
 * literals of that shell, so a path keeps its exact characters.
 * @param cli - the CLI to describe.
 * @param platform - the Host platform.
 * @returns a line naming the absolute path, then, with `cli.scripts`, a line giving the PATH prefix for the commands that
 *   run the skill's scripts.
 */
export function cliPathContextText(cli: CliPathContext, platform: NodeJS.Platform): string {
  const { product, program, executable } = cli
  if (platform === 'win32') {
    const lines = [`${product} CLI: run \`${program}\` by its absolute path with the call operator, & ${pwshLiteral(executable)}; the bare name may resolve to another installation or to none.`]
    if (cli.scripts === true) {
      lines.push(`Scripts in the ${product} skill call \`${program}\` by name; start only the commands that run them with $env:PATH = ${pwshLiteral(`${win32.dirname(executable)};`)} + $env:PATH, and never run \`${program}\` by name yourself.`)
    }
    return lines.join('\n')
  }
  const lines = [`${product} CLI: run \`${program}\` by its absolute path ${JSON.stringify(executable)}; the bare name may resolve to another installation or to none.`]
  if (cli.scripts === true) {
    lines.push(`Scripts in the ${product} skill call \`${program}\` by name; prefix only the commands that run them with PATH=${JSON.stringify(`${posix.dirname(executable)}:$PATH`)}, and never export PATH or run \`${program}\` by name yourself.`)
  }
  return lines.join('\n')
}

/** A PowerShell single-quoted string, which expands nothing; an embedded quote is doubled. */
function pwshLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`
}

/**
 * Register required runtime context that tells the model to run the CLI by its absolute path, not by name, and, when
 * the skill has scripts, to put the executable's directory first on PATH only in the commands that run them. The text
 * uses the Host platform's shell dialect ({@link cliPathContextText}) and is never interpolated.
 * @param ctx - the registering plugin's context, which reaches `systemPrompt`; disposing it removes the context.
 * @param name - the runtime-context name, unique across plugins, such as `feishu:cli`.
 * @param cli - the CLI to describe.
 * @returns the registration's effect disposer.
 */
export function registerCliPathContext(ctx: Context, name: string, cli: CliPathContext): () => void {
  const text = cliPathContextText(cli, process.platform)
  const { ready } = cli
  return ctx.systemPrompt.context({
    name,
    order: ctx.systemPrompt.getContextOrder('PLUGIN_CLIS'),
    required: true,
    interpolate: false,
    text: ready === undefined ? text : () => (ready() ? text : ''),
  })
}
