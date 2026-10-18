/**
 * DingTalk plugin, browser half: the account section on the DingTalk bundle's page, the tag beside its title, guidance
 * after the bundle is switched on, and notices. The Host's `dingtalk` Remote owns the account operations; this half
 * mounts that Remote itself because the on-demand package stays out of the shipped Remote assembly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import dingtalkRemote from '@deepseek-ai/dsh-dingtalk-cli/remote'
import { DINGTALK_PACKAGE, createConnection } from './connection.ts'
import { en, NS, zh } from './locales.ts'
import { DingtalkConnectionActivation, DingtalkConnectionBadge, DingtalkConnectionSection, DingtalkConnectionToast } from './DingtalkConnection.tsx'

/** Services the Remote mount and the slot registrations need. */
export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dingtalk: dictionaries')
  const { connection, face } = createConnection(ctx)
  ctx.effect(() => async () => { await connection.dispose() }, 'dingtalk: connection')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: DINGTALK_PACKAGE, locale: NS, inject: () => face,
  }, DingtalkConnectionSection))
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
    name: 'plugins.bundle.activation', key: DINGTALK_PACKAGE, locale: NS, inject: () => face,
  }, DingtalkConnectionActivation))
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge', id: 'dingtalk.connection', locale: NS, inject: () => face,
  }, DingtalkConnectionBadge))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dingtalk.connection-toast', locale: NS, inject: () => face,
  }, DingtalkConnectionToast))
}

/**
 * Mount the DingTalk Remote, then register the account surfaces for as long as the DingTalk row is on.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the surfaces, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(dingtalkRemote)
  const ui = ctx.inject(['remote.dingtalk', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
