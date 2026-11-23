/** Register the card frame, the hidden answer block, the General settings switch, their copy and the body registry. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-action-cards/remote'
import { ACTION_CARD_FENCE, ActionCardTail, HiddenCardBlock, type TailInjected } from './Card.tsx'
import { SettingsRow, type CardSettings, type SettingsRowInjected } from './SettingsRow.tsx'
import { ActionCardRegistry } from './registry.ts'
import { de, en, es, fr, ja, pt, ru, zh, type ActionCardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { actionCards: ActionCardKey }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Card bodies by action kind; kinds register theirs inside their own `ctx.effect`. */
    actionCards: ActionCardRegistry
  }
}

/** Host entry whose `enabled` field the General settings row edits. */
const SETTINGS_NAMESPACE = 'action-cards'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.actionCards', 'configForms']

/**
 * Provide the body registry and register the UI for the plugin lifetime.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  // Built at the plugin's top level: kinds register into it from their own apply.
  const registry = new ActionCardRegistry(ctx)
  ctx.reflect.provide('actionCards', registry)
  ctx.effect(() => ctx.locale.register('actionCards', { en, zh, ja, es, fr, de, ru, pt }), 'action-cards: locale')
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: '@deepseek-ai/dsh-client-ui-action-cards', locale: 'actionCards',
    inject: (sessionId: SessionId): TailInjected => ({
      sessionId,
      hooks: { bodies: registry.source },
      bind: locale => ctx.locale.bind(locale),
      act: async (cardId, verb, payload) => {
        const result = await ctx.remote.actionCards.act(sessionId, cardId, verb, payload)
        return result.ok ? result.value : undefined
      },
    }),
  }, ActionCardTail))
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register(
    { name: 'conversation.chat.markdown.fence', key: ACTION_CARD_FENCE, id: '@deepseek-ai/dsh-client-ui-action-cards/block' }, HiddenCardBlock,
  ))
  const form = ctx.configForms.get<CardSettings>(SETTINGS_NAMESPACE)
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register({
      name: 'settings.general.item', id: 'action-cards', order: 40, locale: 'actionCards',
      inject: (): SettingsRowInjected => ({ hooks: { cardSettings: form }, setEnabled: enabled => form.set('enabled', enabled) }),
    }, SettingsRow))), 'action-cards: settings row')
}
