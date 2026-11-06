/** Account notifications driven by the existing account UI stream. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { AccountUiState } from '@deepseek-ai/dsh-client-ui-settings-account/client'
import { Config, NOTIFICATIONS_CONFIG_GLOBAL } from '../config.ts'
import { AccountNotifications, type AccountNotificationsInjected } from './AccountNotifications.tsx'
import { createNotificationController, type AccountNotice } from './notification-controller.ts'
import { en, zh, ja, es, fr, de, ru, pt } from './locales.ts'
export type { AccountNotificationsInjected, AccountNotificationsProps } from './AccountNotifications.tsx'

/** Services used for notification lifecycle and presentation. */
export const inject = ['slots', 'locale', 'remote', 'remote.account', 'accountUi']

/** @param ctx - client plugin context sharing the account owner's existing state stream. */
export function apply(ctx: Context): void {
  const page = globalThis as Partial<Record<typeof NOTIFICATIONS_CONFIG_GLOBAL, unknown>>
  const config = Config(page[NOTIFICATIONS_CONFIG_GLOBAL] ?? {})
  ctx.effect(() => ctx.locale.register('account.notifications', { en, zh, ja, es, fr, de, ru, pt }), 'notifications: dictionaries')
  let snapshot: readonly AccountNotice[] = []
  const listeners = new Set<() => void>()
  const controller = createNotificationController({
    locale: ctx.locale.getSnapshot().active,
    pollIntervalMs: config.notificationPollIntervalMs,
    read: async (locale) => {
      const result = await ctx.remote.account.getNotifications(ctx.accountUi.clientMetadata(locale))
      if (!result.ok) throw new Error('account notification read failed')
      return result.value
    },
    readContent: async (id, locale) => {
      const result = await ctx.remote.account.getNotificationContent(id, ctx.accountUi.clientMetadata(locale))
      if (!result.ok) throw new Error('account notification content read failed')
      return result.value
    },
    reportEvent: async (id, event) => {
      const result = await ctx.remote.account.reportNotificationEvent(id, event,
        ctx.accountUi.clientMetadata(ctx.locale.getSnapshot().active))
      if (!result.ok) throw new Error('account notification event report failed')
      return result.value
    },
    publish: (notices) => { snapshot = notices; for (const listener of listeners) listener() },
  })
  const update = (state: AccountUiState, reset: boolean): void => {
    const signedIn = state.view?.status === 'credential-stored' && !state.failed
    if (reset || !signedIn) controller.end()
    if (signedIn && reset) controller.begin()
  }
  ctx.effect(() => () => { controller.end() }, 'notifications: account lifetime')
  ctx.on('account-ui/change', update)
  ctx.on('account-ui/refresh', () => controller.refresh())
  ctx.on('locale/change', (state) => { void controller.setLocale(state.active) })
  update(ctx.accountUi.getSnapshot(), true)
  const state = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const injected: AccountNotificationsInjected = {
    hooks: { notices: state },
    shown: (id) => { controller.shown(id) },
    ctaClicked: (id) => { controller.ctaClicked(id) },
    dismiss: (id) => { controller.dismiss(id) },
  }
  ctx.slots.inject('settings.launcher.notifications', () => ctx.slots.register({
    name: 'settings.launcher.notifications', locale: 'account.notifications',
    inject: () => injected,
  }, AccountNotifications))
}
