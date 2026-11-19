/**
 * Connectors, browser half: the Plugins page tab that lists the official connectors, installs a missing one through
 * the page's install dialog, and opens an installed one's page.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { ConnectorsController } from './connectors-store.ts'
import { ConnectorsTab } from './ConnectorsTab.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type ConnectorsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Connectors tab copy. */
    connectors: ConnectorsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'connectors'

/** Services the tab and its state reads need. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager']

/**
 * Contribute the Connectors tab and follow the Host's bundle changes.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'connectors: dictionaries')
  const controller = new ConnectorsController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'connectors: controller')
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('plugin-manager/changed', () => { controller.changed() }),
      ctx.on('connection/reset', () => { controller.changed() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'connectors: host invalidations')
  const face = controller.face(process.env.DSH_CLIENT_VERSION)
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('plugins.tab', () => ctx.slots.register({
    name: 'plugins.tab', id: 'connectors', label: () => t('title'), locale: NS, inject: () => face,
  }, ConnectorsTab))
}
