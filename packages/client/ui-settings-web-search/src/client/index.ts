/**
 * The web search and fetch settings page, browser half: one provider menu per
 * capability, which writes the `web` provider selection, the Search API result
 * count over the `web-deepseek-api` namespace, and legacy Messages search's
 * key, endpoint, and search limit over `web-search-deepseek`. The page
 * registers into the Plugins page's `plugins.item` slot while the Host serves
 * `web`; a provider's own controls appear only while the Host serves its
 * namespace.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { WebSearchCard } from './WebSearchCard.tsx'
import { WEB_API_NS, WEB_NS, WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { en, ja, es, fr, de, ru, pt, zh, type WebSearchSettingsLocaleKey } from './locales.ts'

export type { WebSearchCardProps } from './WebSearchCard.tsx'
export type {
  WebApiSettings, WebLegacySettings, WebProviderSelection, WebSearchCardFace, WebSearchCardScopes, WebSearchCardState,
} from './web-search-card-controller.ts'
export type { WebSearchSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Web search and fetch settings page copy. */
    'settings.webSearch': WebSearchSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.webSearch'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.web', 'configForms']

/**
 * Mount the web search and fetch settings page while the Host serves the `web` namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-web-search: dictionaries')
  const card = new WebSearchCardController({
    web: ctx.configForms.get(WEB_NS), api: ctx.configForms.get(WEB_API_NS), legacy: ctx.configForms.get(WEB_SEARCH_NS),
  }, ctx)
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-web-search: form subscription')
  // The credentials the page reports are not part of any settings section, so
  // no scope publishes when one is written. This is the only signal
  // that a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref) }),
    'ui-settings-web-search: credential invalidations',
  )
  // Plugins register and retract providers without touching any settings
  // section, and a reconnected Host may hold a different set.
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('web/providers-changed', () => { card.refreshProviders() }),
      ctx.on('connection/reset', () => { card.refreshProviders() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-web-search: provider invalidations')
  ctx.effect(() => ctx.configForms.whileServed([WEB_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'web-search', order: 20, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, WebSearchCard))), 'ui-settings-web-search: page')
}
