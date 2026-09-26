/**
 * Plugin manager, browser half: the **Plugins** entry of the sidebar and the
 * management page it opens in the main column. The page installs, enables,
 * disables, and removes the bundles of the Host's profile through the
 * `pluginManager` Remote and switches their rows in the profile's user layer.
 * A plugin that carries its own configuration renders it on this page through
 * the slots the page declares (`slot-contract.ts`).
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot the page registers into, declared by
// ui-layout with the panel id brand, and the `sidebar.panellist` list the
// entry registers into, declared by ui-sidebar.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the forwarded events' own declaration (`$on`'s key face resolves
// through the owning package's client-safe types subpath).
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import { PluginManagerPage } from './PluginManagerPage.tsx'
import { PluginsPanelIcon } from './PluginsPanelIcon.tsx'
import { configLedgerSource } from './config-ledger.ts'
import { PluginManagerController } from './manager-store.ts'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'
import { createNavigationStore } from './navigation-store.ts'
import type {} from './slot-contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-plugin navigation to the Plugins panel. */
    pluginNavigation: {
      /**
       * Open a bundle's details without changing the current Session.
       * An absent bundle displays the plugin list after loading.
       * @param packageName - npm package name of the bundle.
       */
      openBundle(packageName: string): void
    }
  }
}

export type { PluginManagerPageProps } from './PluginManagerPage.tsx'
export type { ConfigLedger, OfficialItem } from './config-ledger.ts'
export type { PluginManagerFace } from './manager-store.ts'
export type { PluginManagerLocaleKey } from './locales.ts'
export type {
  ConfigPageForm, PluginActivationOwnerProps, PluginConfigViewProps, PluginDetailProps, PluginPackageRef, PluginRowRef, PluginsSubject,
} from './slot-contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin manager tab copy. */
    'pluginManager': PluginManagerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'pluginManager'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'plugins' as MainPanelId

/** Services required by the sidebar registration and the Remote methods; the inventory says whether the Host manages a profile. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory', 'remote.pluginRegistryProbe', 'configForms', 'layout']

/**
 * Contribute the Plugins entry to the sidebar with the management page it
 * opens, and keep it current on the Host's change events.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new PluginManagerController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'ui-plugin-manager: controller')
  // The Host says when what is installed, enabled, or composed changed — from
  // this page, the CLI, or another browser — and streams install output.
  ctx.effect(() => {
    // A page never rendered holds no snapshot to refresh.
    const refresh = (): void => {
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    }
    const disposers = [
      ctx.remote.$on('plugin-manager/changed', refresh),
      ctx.remote.$on('plugin-manager/install-log', (chunk) => { controller.appendLog(chunk) }),
      ctx.remote.$on('plugin-manager/install-state', (progress) => { controller.installProgress(progress) }),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-plugin-manager: host invalidations')

  // The page is a global panel: it belongs to the profile, not to a Session,
  // and the sidebar's entry selects it. What is installed and switched on is
  // the page's own; a plugin's configuration arrives through the slots the
  // page declares here, so the page never names a configurable plugin.
  const configLedger = configLedgerSource(ctx)
  ctx.slots.inject('main', function* () {
    const handle = createNavigationStore(), instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    yield ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      store,
      inject: () => controller.inject(configLedger, text => ctx.locale.resolveText(text)),
      children: {
        'plugins.item': { kind: 'list', scope: 'root' },
        'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
        'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
        'plugins.row.config': { kind: 'keyed', scope: 'root' },
        'plugins.detail.actions': { kind: 'list', scope: 'root' },
        'plugins.detail.badge': { kind: 'list', scope: 'root' },
        'plugins.detail.section': { kind: 'list', scope: 'root' },
      },
    }, PluginManagerPage)
    yield ctx.layout.panelInfo.subscribe(() => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId !== PANEL_ID) instance.actions.setView({ kind: 'list' })
    })
    const disposeNavigation = ctx.reflect.provide('pluginNavigation', {
      openBundle: (packageName: string) => {
        ctx.layout.selectPanel(PANEL_ID)
        instance.actions.setView({ kind: 'package', name: packageName })
      },
    })
    yield () => { void disposeNavigation() }
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 0,
    label: () => t('panel'),
    locale: NS,
  }, PluginsPanelIcon))

}
