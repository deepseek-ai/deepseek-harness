import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import wecomRemote from '@deepseek-ai/dsh-wecom-cli/remote'
import { WECOM_PACKAGE, createConnection } from './connection.ts'
import { en, NS, zh } from './locales.ts'
import { WecomConnectionActivation, WecomConnectionBadge, WecomConnectionSection, WecomConnectionToast } from './WecomConnection.tsx'

export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'wecom: dictionaries')
  const { connection, face } = createConnection(ctx)
  ctx.effect(() => async () => { await connection.dispose() }, 'wecom: connection')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: WECOM_PACKAGE, locale: NS, inject: () => face,
  }, WecomConnectionSection))
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
    name: 'plugins.bundle.activation', key: WECOM_PACKAGE, locale: NS, inject: () => face,
  }, WecomConnectionActivation))
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge', id: 'wecom.connection', locale: NS, inject: () => face,
  }, WecomConnectionBadge))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'wecom.connection-toast', locale: NS, inject: () => face,
  }, WecomConnectionToast))
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(wecomRemote)
  const ui = ctx.inject(['remote.wecom', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
