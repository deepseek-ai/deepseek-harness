/** Mount the `cliAccounts` Remote and show the surfaces of each account the Host registers, for one plugin lifetime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-cli-account/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { CliAccountActivationEntry, CliAccountBadgeEntry, CliAccountSectionEntry, CliAccountToastEntry } from './components.tsx'
import { CliAccountsConnection } from './connection.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import type { CliAccountFace, CliAccountSnapshot } from './types.ts'

/** Services the Remote mount and the slot registrations need. */
export const inject = ['remote', 'slots', 'locale']

function registerAccount(
  ctx: Context, connection: CliAccountsConnection, packageName: string, store: SnapshotStore<CliAccountSnapshot>,
): () => void {
  const face: CliAccountFace = {
    hooks: { cliAccount: store }, packageName, resolveText: text => ctx.locale.resolveText(text), ...connection.actions(packageName),
  }
  const dispose = ctx.effect(function* () {
    yield ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: packageName, locale: NS, inject: () => face,
    }, CliAccountSectionEntry))
    yield ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
      name: 'plugins.bundle.activation', key: packageName, locale: NS, inject: () => face,
    }, CliAccountActivationEntry))
    yield ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
      name: 'plugins.detail.badge', id: `${packageName}.account`, locale: NS, inject: () => face,
    }, CliAccountBadgeEntry))
    yield ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: `${packageName}.account-toast`, locale: NS, inject: () => face,
    }, CliAccountToastEntry))
  }, `cliAccounts: ${packageName}`)
  return () => void dispose()
}

function showAccounts(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'cli-account: dictionaries')
  const connection = new CliAccountsConnection(ctx, ctx.remote.cliAccounts)
  ctx.effect(() => async () => { await connection.dispose() }, 'cli-account: connection')
  ctx.effect(() => {
    const shown = new Map<string, () => void>()
    const sync = (): void => {
      const accounts = connection.accounts.getSnapshot()
      for (const [name, withdraw] of shown) {
        if (accounts.has(name)) continue
        withdraw()
        shown.delete(name)
      }
      for (const [name, store] of accounts) if (!shown.has(name)) shown.set(name, registerAccount(ctx, connection, name, store))
    }
    sync()
    const stop = connection.accounts.subscribe(sync)
    return () => {
      stop()
      for (const withdraw of shown.values()) withdraw()
    }
  }, 'cli-account: surfaces')
}

/**
 * Mount the `cliAccounts` Remote, then show the registered accounts for the same plugin lifetime.
 * @param ctx - the browser plugin context.
 * @param contribution - the generated `cliAccounts` Remote definitions the built entry supplies.
 * @returns a disposer that withdraws the surfaces and the stream before the Remote.
 */
export async function mountCliAccounts(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.cliAccounts', 'slots', 'locale'], showAccounts)
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
