/** Temporary 1017 badge for the two official DeepSeek model routes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DeepSeekModelLabel } from './DeepSeekModelLabel.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type LabelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The temporary model release badge. */
    'deepseek-model-label-1017': LabelKey
  }
}

/** Required services: model-label registration and localized badge text. */
export const inject = ['slots', 'locale']

/**
 * Decorate existing model labels while their declaring slot is mounted.
 * @param ctx - Client plugin context owning the dictionaries and registration.
 */
export function apply(ctx: Context): void {
  const namespace = 'deepseek-model-label-1017'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en, ja, es, fr, de, ru, pt }), 'deepseek-model-label-1017: dictionaries')
  ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
    name: 'conversation.input.model.label', locale: namespace,
  }, DeepSeekModelLabel))
}
