/**
 * WeCom plugin, browser half: registers the WeCom authorization with the
 * Plugins page's CLI account surfaces. The Host's `wecom` Remote owns the
 * operations; this half mounts that Remote itself because the on-demand
 * package stays out of the shipped Remote assembly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-cli-account/client'
import wecomRemote from '@deepseek-ai/dsh-wecom-cli/remote'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { presentAccount } from './account.ts'
import { WECOM_PACKAGE } from './connection.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'

/** Services the Remote mount and the account registration need. */
export const inject = ['remote', 'locale', 'cliAccounts']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'wecom: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.cliAccounts.register<WecomState>({
    packageName: WECOM_PACKAGE, locale: NS,
    follow: signal => ctx.remote.wecom.follow(signal),
    cancel: id => ctx.remote.wecom.cancel(id),
    notices: { connect: () => t('notice.connected') },
    present: (snapshot, page) => presentAccount(snapshot, t, {
      ...page,
      check: () => { page.start(() => ctx.remote.wecom.check()) },
      connect: () => { page.start(() => ctx.remote.wecom.connect()) },
    }),
  }), 'wecom: account')
}

/**
 * Mount the WeCom Remote, then register the authorization for as long as the WeCom row is on.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the authorization, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(wecomRemote)
  const ui = ctx.inject(['remote.wecom', 'locale', 'cliAccounts'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
