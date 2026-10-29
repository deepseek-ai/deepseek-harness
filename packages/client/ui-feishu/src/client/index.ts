/**
 * Feishu plugin, browser half: registers the Feishu account with the Plugins
 * page's CLI account surfaces. The Host's `feishu` Remote owns the account
 * operations; this half mounts that Remote itself because the on-demand
 * package stays out of the shipped Remote assembly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-cli-account/client'
import feishuRemote from '@deepseek-ai/dsh-feishu-cli/remote'
import type { FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'
import { presentAccount } from './account.ts'
import { FEISHU_PACKAGE } from './connection.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'

/** Services the Remote mount and the account registration need. */
export const inject = ['remote', 'locale', 'cliAccounts']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'feishu: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.cliAccounts.register<FeishuState>({
    packageName: FEISHU_PACKAGE, locale: NS,
    follow: signal => ctx.remote.feishu.follow(signal),
    cancel: id => ctx.remote.feishu.cancel(id),
    notices: { 'link-app': () => t('notice.app-linked'), 'sign-in': () => t('notice.connected'), 'sign-out': () => t('notice.signed-out') },
    present: (snapshot, page) => presentAccount(snapshot, t, {
      ...page,
      check: () => { page.start(() => ctx.remote.feishu.check()) },
      linkApp: () => { page.start(() => ctx.remote.feishu.linkApp()) },
      signIn: () => { page.start(() => ctx.remote.feishu.signIn()) },
      signOut: () => { page.start(() => ctx.remote.feishu.signOut()) },
    }),
  }), 'feishu: account')
}

/**
 * Mount the Feishu Remote, then register the account for as long as the Feishu row is on.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the account, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(feishuRemote)
  const ui = ctx.inject(['remote.feishu', 'locale', 'cliAccounts'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
