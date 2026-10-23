/**
 * Credential display masking for sent Web user text: one UserText matcher and
 * its keyed `secret` node renderer. Masking changes only the drawn text; the
 * message text, copy actions, and model input keep the original characters.
 *
 * @module @deepseek-ai/dsh-client-ui-secret-mask/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the UiConversation service merge (ctx.uiConversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SecretText } from './SecretText.tsx'
import { createSecretRule } from './secret-rule.ts'
export type {} from './secret-rule.ts'
import { en, ja, es, fr, de, ru, pt, NS, zh } from './locales.ts'

/** Required services: the copy, the node renderer registry, and the UserText rule registry. */
export const inject = ['locale', 'slots', 'uiConversation']

/**
 * Register the dictionaries, the credential matcher, and its node renderer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-secret-mask: dictionaries')
  ctx.uiConversation.userText.register(createSecretRule())
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'secret', priority: 100, locale: NS,
  }, SecretText))
}
