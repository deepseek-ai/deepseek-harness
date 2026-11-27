/** Register the official plugin card body and its localized copy over the catalog-text Remote. */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-action-cards/client'
import type {} from '@deepseek-ai/dsh-plugin-recommendations/remote'
import { PluginCardBody, type CatalogDetails, type PluginCardServices } from './Card.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type RecommendationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap { pluginRecommendations: RecommendationKey }
}

/** Services the body needs; the shared card plugin provides `actionCards`. */
export const inject = ['locale', 'remote', 'remote.pluginRecommendations', 'actionCards']

/** Register the copy for the plugin lifetime, and the card body while the Plugins page can open.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  // Catalog text by plugin name for this plugin lifetime: a revisited card renders it before its own lookup returns.
  const catalog = createSnapshotStore<Readonly<Record<string, CatalogDetails>>>({})
  ctx.effect(() => ctx.locale.register('pluginRecommendations', { en, zh, ja, es, fr, de, ru, pt }), 'plugin-recommendations: locale')
  // The Plugins page provides its navigation only while the current Peer may use it; without a body the shared frame offers Not now alone.
  ctx.inject(['pluginNavigation'], (scope: Context) => {
    const services: PluginCardServices = {
      catalog,
      describe: async (sessionId, cardId) => {
        const result = await scope.remote.pluginRecommendations.describe(sessionId, cardId)
        return result.ok ? result.value : undefined
      },
      openDetails: (packageName) => { scope.pluginNavigation.openBundle(packageName) },
      resolveText: text => scope.locale.resolveText(text),
    }
    scope.effect(() => scope.actionCards.register({
      action: 'enable_official_plugin', locale: 'pluginRecommendations',
      Body: props => createElement(PluginCardBody, { ...props, ...services }),
    }), 'plugin-recommendations: card body')
  })
}
