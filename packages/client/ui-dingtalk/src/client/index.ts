/**
 * DingTalk plugin, browser half: registers the DingTalk account with the Plugins page's CLI account surfaces. The Host's
 * `dingtalk` Remote owns the account operations; this half mounts that Remote itself because the on-demand package stays
 * out of the shipped Remote assembly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-cli-account/client'
import dingtalkRemote from '@deepseek-ai/dsh-dingtalk-cli/remote'
import type { DingtalkState } from '@deepseek-ai/dsh-dingtalk-cli/types'
import { presentAccount } from './account.ts'
import { DINGTALK_PACKAGE } from './connection.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'

/** Services the Remote mount and the account registration need. */
export const inject = ['remote', 'locale', 'cliAccounts']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'dingtalk: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.cliAccounts.register<DingtalkState>({
    packageName: DINGTALK_PACKAGE, locale: NS,
    follow: signal => ctx.remote.dingtalk.follow(signal),
    cancel: id => ctx.remote.dingtalk.cancel(id),
    notices: { 'sign-in': () => t('notice.connected'), 'sign-out': () => t('notice.signed-out') },
    present: (snapshot, page) => presentAccount(snapshot, t, {
      ...page,
      check: () => { page.start(() => ctx.remote.dingtalk.check()) },
      signIn: () => { page.start(() => ctx.remote.dingtalk.signIn()) },
      signOut: () => { page.start(() => ctx.remote.dingtalk.signOut()) },
    }),
  }), 'dingtalk: account')
}

/**
 * Mount the DingTalk Remote, then register the account for as long as the DingTalk row is on.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the account, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(dingtalkRemote)
  const ui = ctx.inject(['remote.dingtalk', 'locale', 'cliAccounts'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
