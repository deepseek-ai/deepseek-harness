/**
 * Discover, browser half: the Plugins page tab that browses the plugin market indexes the user configures through the
 * `pluginMarket` Remote and installs an entry through the page's install dialog; entry pages show each version's
 * detail document.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge, the forwarded events, and the `plugins.tab` slot declaration.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-market/types'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { DiscoverSection } from './DiscoverSection.tsx'
import { en, zh, type PluginMarketLocaleKey } from './locales.ts'
import { DiscoverController } from './market-store.ts'

export type { DiscoverFace, DiscoverState } from './market-store.ts'
export type { PluginMarketLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Discover tab copy. */
    'pluginMarket': PluginMarketLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'pluginMarket'

/** Services the section reads. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginMarket', 'remote.pluginRegistryProbe']

/**
 * Contribute Discover to the Plugins page and keep it current on Host changes.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-market: dictionaries')
  const controller = new DiscoverController(ctx, () => document.baseURI)
  ctx.effect(() => () => { controller.dispose() }, 'ui-plugin-market: controller')
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('plugin-market/changed', () => { controller.sourcesChanged() }),
      ctx.remote.$on('plugin-manager/changed', () => { controller.bundlesChanged() }),
      ctx.on('connection/reset', () => {
        controller.sourcesChanged()
        controller.detailsReset()
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-plugin-market: host invalidations')
  const face = controller.face(text => ctx.locale.resolveText(text))
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('plugins.tab', () => ctx.slots.register({
    name: 'plugins.tab', id: 'discover', label: () => t('title'), locale: NS, inject: () => face,
  }, DiscoverSection))
}
