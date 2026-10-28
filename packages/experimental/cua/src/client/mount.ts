/** Optional Computer Use controls mounted through existing plugin-page and overlay slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cua/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ApplicationApproval, selectApplicationApproval } from './ApplicationApproval.tsx'
import { PermissionController } from './controller.ts'
import { PermissionPanel, PermissionSetup, PermissionToast } from './PermissionPanel.tsx'
import { en, ja, es, fr, de, ru, pt, NS, zh, type CuaPermissionLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Native permission controls and application consent. */
    cuaPermissions: CuaPermissionLocaleKey
  }
}

/** Existing browser registries needed by the optional permission UI. */
export const inject = ['remote', 'slots', 'locale', 'configForms']

/**
 * Mount the optional permission Remote and its browser controls.
 * @param ctx Browser plugin context.
 * @param contribution Generated permission Remote definitions.
 * @returns Cleanup for the optional Remote and UI registrations.
 */
export async function mountCuaPermissions(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const transport = ctx.plugin(async (owner) => { await owner.remote.$mount(contribution) })
  const ui = ctx.inject(['remote.cuaAccess', 'slots', 'locale'], (ctx) => {
    ctx.effect(() => ctx.locale.register(NS, { en, zh, ja, es, fr, de, ru, pt }))
    const controller = new PermissionController(ctx.remote.cuaAccess)
    const face = controller.face()
    ctx.slots.inject('conversation.composer', () => ctx.slots.register({
      name: 'conversation.composer', priority: -1, locale: NS,
      select: ({ pendingInteraction }: ComposerChainProps) => selectApplicationApproval(pendingInteraction),
      inject: () => ({ resolveText: (text: { en: string; [locale: string]: string }) => ctx.locale.resolveText(text) }),
    }, ApplicationApproval))
    ctx.inject(['pluginChanges'], (scope) => {
      const changes = scope.pluginChanges.bundle('@deepseek-ai/dsh-cua-bundle')
      const synchronize = () => { controller.setChanging(changes.getSnapshot()) }
      synchronize()
      scope.effect(() => {
        const unsubscribe = changes.subscribe(synchronize)
        return () => { unsubscribe(); controller.setChanging(false) }
      })
    })
    const preset = ctx.configForms.get<{ default: string; selectedDefault?: string }>('agent-preset-registry')
    const settings = {
      ...face,
      hooks: { ...face.hooks, cuaDefaultPreset: preset },
      setPtcDefault: () => preset.set('selectedDefault', 'ptc'),
      setPersistentPtc: async () => {
        const result = await ctx.remote.cuaAccess.enablePersistentPtc(); if (!result.ok) throw result.error
        face.refresh()
        return true
      },
    }
    ctx.effect(() => () => controller.dispose())
    ctx.on('connection/reset', face.refresh)
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: '@deepseek-ai/dsh-cua-bundle', locale: NS, inject: () => settings,
    }, PermissionPanel))
    ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
      name: 'plugins.bundle.activation', key: '@deepseek-ai/dsh-cua-bundle', locale: NS, inject: () => face,
    }, PermissionSetup))
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'cua-permission-outcome', locale: NS, inject: () => face,
    }, PermissionToast))
  })
  const dispose = ctx.effect(function* () {
    yield transport.dispose
    yield ui.dispose
  }, 'cua-permissions.mount')
  try { await Promise.all([transport, ui]) } catch (error) { await dispose(); throw error }
  return dispose
}
