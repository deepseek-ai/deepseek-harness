/**
 * CLI account surfaces for CLI app plugins, browser half. `ctx.cliAccounts` shows a plugin's account section, title tag,
 * activation prompt, and notices on its bundle's Plugins page, following the plugin's Host account Remote.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CliAccountActivationEntry, CliAccountBadgeEntry, CliAccountSectionEntry, CliAccountToastEntry } from './components.tsx'
import { CliAccountConnection } from './connection.ts'
import type { AnyCliAccountView, CliAccountFace, CliAccountRegistration, CliAccounts } from './types.ts'

export type {
  AnyCliAccountView, CliAccountAction, CliAccountConfirmation, CliAccountDisplay, CliAccountFailure, CliAccountKey,
  CliAccountNamespace, CliAccountNote, CliAccountNotice, CliAccountPage, CliAccountPhase, CliAccountRegistration, CliAccounts,
  CliAccountSnapshot, CliOperationKindOf,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** CLI app plugin account surfaces on the Plugins page. */
    cliAccounts: CliAccounts
  }
}

/** Services the Host stream and the slot registrations need. */
export const inject = ['remote', 'slots']

function register<View extends AnyCliAccountView>(ctx: Context, account: CliAccountRegistration<View>): () => void {
  const { packageName, locale } = account
  const dispose = ctx.effect(function* () {
    const connection = new CliAccountConnection(ctx, { ...account, name: `${packageName} account` })
    yield async () => { await connection.dispose() }
    const face: CliAccountFace = {
      hooks: { cliAccount: connection.state },
      packageName, page: connection.page, present: account.present, notices: account.notices, dismissNotice: connection.dismissNotice,
    }
    yield ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: packageName, locale, inject: () => face,
    }, CliAccountSectionEntry))
    yield ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
      name: 'plugins.bundle.activation', key: packageName, locale, inject: () => face,
    }, CliAccountActivationEntry))
    yield ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
      name: 'plugins.detail.badge', id: `${packageName}.account`, locale, inject: () => face,
    }, CliAccountBadgeEntry))
    yield ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: `${packageName}.account-toast`, locale, inject: () => face,
    }, CliAccountToastEntry))
  }, `cliAccounts.register(${packageName})`)
  return () => void dispose()
}

/**
 * Provide the account registry; each registration lives until its disposer runs or this plugin unloads.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const accounts: CliAccounts = { register: account => register(ctx, account) }
  ctx.provide('cliAccounts', accounts)
}
