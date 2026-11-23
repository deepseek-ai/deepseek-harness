/** The Connectors tab with its custom MCP servers section, over the generated `connectors` Remote. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-connectors/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ConnectorsController } from './connectors-store.ts'
import { ConnectorsTab } from './ConnectorsTab.tsx'
import { CustomServersController } from './custom-servers-store.ts'
import { CustomServersSection } from './CustomServersSection.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'connectors'
/** The tab's id in `plugins.tab`. */
const TAB = 'connectors'

/** Services the tab and its state reads need. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager']

/**
 * Contribute the Connectors tab and follow the Host's bundle changes, then mount the `connectors` Remote and add the
 * custom servers section once the manager's Remote exists.
 * @param ctx - the browser plugin context.
 * @param contribution - the generated `connectors` Remote definitions.
 * @returns the disposer that withdraws the section before its Remote.
 */
export async function mountConnectors(ctx: ClientContext, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
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
    name: 'plugins.tab', id: TAB, label: () => t('title'), locale: NS, inject: () => face,
    children: { 'connectors.custom': { kind: 'single', scope: 'root' } },
  }, ConnectorsTab))
  const unmountRemote = await ctx.remote.$mount(contribution)
  // A profile without the MCP manager keeps the tab without the section.
  const custom = ctx.inject(['remote.connectors', 'remote.mcpManager'], (scope) => {
    const servers = new CustomServersController(scope)
    scope.effect(() => () => { servers.dispose() }, 'connectors: custom servers')
    scope.effect(() => scope.remote.$on('settings/document-updated', () => { servers.changed() }), 'connectors: settings changes')
    const section = servers.face()
    scope.slots.inject('connectors.custom', () => scope.slots.register({
      name: 'connectors.custom', locale: NS, inject: () => section,
    }, CustomServersSection))
  })
  return async () => {
    await custom.dispose()
    await unmountRemote()
  }
}
