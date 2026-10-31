/**
 * CLI account surfaces, browser half: follows the accounts CLI app plugins register on the Host and shows each one's
 * section, title tag, activation prompt, and notices on its bundle's Plugins page. The surfaces read the shared copy from
 * this package's dictionary and each plugin's text from the Host.
 */
import type { Context } from '@deepseek-ai/cordis'
import cliAccountsRemote from '@deepseek-ai/dsh-client-ui-cli-account/remote'
import { mountCliAccounts } from './mount.ts'

export { inject } from './mount.ts'
export type { CliAccountKey } from './locales.ts'
export type { CliAccountFace, CliAccountNotice, CliAccountSnapshot } from './types.ts'

/**
 * Show the registered CLI accounts on the Plugins page.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the surfaces and the stream, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountCliAccounts(ctx, cliAccountsRemote)
}
