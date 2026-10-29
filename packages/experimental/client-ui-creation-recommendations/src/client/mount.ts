/** Register the personalized page card body and its localized copy. */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-action-cards/client'
import { PageCardBody } from './Card.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type RecommendationKey } from './locales.ts'
import { createCreationInfoStore } from './info-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { creationRecommendations: RecommendationKey }
}

/** Services the body registration needs; the shared card plugin provides `actionCards`. */
export const inject = ['locale', 'actionCards']

/**
 * Register the `create_personalized_page` body for the plugin lifetime.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  const infoDismissed = createCreationInfoStore()
  ctx.effect(() => ctx.locale.register('creationRecommendations', { en, zh, ja, es, fr, de, ru, pt }), 'creation-recommendations: locale')
  ctx.effect(() => ctx.actionCards.register({
    action: 'create_personalized_page', locale: 'creationRecommendations',
    Body: props => createElement(PageCardBody, { ...props, infoDismissed }),
  }), 'creation-recommendations: card body')
}
