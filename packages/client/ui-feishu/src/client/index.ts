/**
 * Feishu plugin, browser half: the connection section on the Feishu bundle's
 * page, the tag beside its title, guidance after the bundle is switched on, and
 * connection notices. The Host's `feishu` Remote owns the account operations;
 * this half mounts that Remote itself because the on-demand package stays out
 * of the shipped Remote assembly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import feishuRemote from '@deepseek-ai/dsh-feishu-cli/remote'
import { FEISHU_PACKAGE, FeishuConnection } from './connection.ts'
import { en, NS, zh } from './locales.ts'
import { FeishuConnectionActivation, FeishuConnectionBadge, FeishuConnectionSection, FeishuConnectionToast } from './FeishuConnection.tsx'

/** Services the Remote mount and the slot registrations need. */
export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'feishu: dictionaries')
  const connection = new FeishuConnection(ctx)
  ctx.effect(() => async () => { await connection.dispose() }, 'feishu: connection')
  const face = connection.face()
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: FEISHU_PACKAGE, locale: NS, inject: () => face,
  }, FeishuConnectionSection))
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
    name: 'plugins.bundle.activation', key: FEISHU_PACKAGE, locale: NS, inject: () => face,
  }, FeishuConnectionActivation))
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge', id: 'feishu.connection', locale: NS, inject: () => face,
  }, FeishuConnectionBadge))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'feishu.connection-toast', locale: NS, inject: () => face,
  }, FeishuConnectionToast))
}

/**
 * Mount the Feishu Remote, then register the connection surfaces for as long as the Feishu row is on.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the surfaces, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(feishuRemote)
  const ui = ctx.inject(['remote.feishu', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
