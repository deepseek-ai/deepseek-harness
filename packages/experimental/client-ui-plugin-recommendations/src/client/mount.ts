/** Register the official plugin card body, its catalog-text Remote and its localized copy. */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-action-cards/client'
import type {} from '@deepseek-ai/dsh-plugin-recommendations/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { PluginCardBody, type CatalogDetails, type PluginCardServices } from './Card.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type RecommendationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { pluginRecommendations: RecommendationKey }
}

/** Services the body needs; the shared card plugin provides `actionCards`. */
export const inject = ['locale', 'remote', 'actionCards', 'pluginNavigation']

/** Mount the catalog-text Remote, then register the body for the same plugin lifetime.
 * @param ctx - Client plugin context.
 * @param contribution - Generated Remote descriptors supplied by the built entry.
 * @returns disposer removing the body before the Remote contribution.
 */
export async function mountRecommendations(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const body = ctx.inject(['remote.pluginRecommendations'], registerBody)
  try { await body } catch (error) { await body.dispose(); await unmount(); throw error }
  return async () => { await body.dispose(); await unmount() }
}

function registerBody(ctx: Context): void {
  const services: PluginCardServices = {
    // Catalog text by plugin name for this plugin lifetime: a revisited card renders it before its own lookup returns.
    catalog: createSnapshotStore<Readonly<Record<string, CatalogDetails>>>({}),
    describe: async (sessionId, callId) => {
      const result = await ctx.remote.pluginRecommendations.describe(sessionId, callId)
      return result.ok ? result.value : undefined
    },
    openDetails: (packageName) => { ctx.pluginNavigation.openBundle(packageName) },
    resolveText: text => ctx.locale.resolveText(text),
  }
  ctx.effect(() => ctx.locale.register('pluginRecommendations', { en, zh, ja, es, fr, de, ru, pt }), 'plugin-recommendations: locale')
  ctx.effect(() => ctx.actionCards.register({
    action: 'enable_official_plugin', locale: 'pluginRecommendations',
    Body: props => createElement(PluginCardBody, { ...props, ...services }),
  }), 'plugin-recommendations: card body')
}
