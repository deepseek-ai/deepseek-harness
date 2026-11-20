/** Remote connection settings registration; invitation credentials stay in this plugin's memory. */
import type { Context } from '@deepseek-ai/cordis'
import remoteConnectionRemote from '@deepseek-ai/dsh-client-remote-connection/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { RemoteConnectionController } from './remote-connection-controller.ts'
import { LoginLinkController } from './login-link-controller.ts'
import { LoginLinkToast } from './LoginLinkToast.tsx'
import { RemoteConnectionSection } from './RemoteConnectionSection.tsx'
import { RemoteConnectionSettings } from './RemoteConnectionSettings.tsx'
import { PairingApproval } from './pairing-approval.ts'
import { requestsResource } from './pairing-resource.ts'
import { PairingToast, type PairingInjected } from './PairingRequests.tsx'
import { en, zh, ja, es, fr, de, ru, pt, type RemoteConnectionLocaleKey } from './locales.ts'

export type { RemoteConnectionContentProps, RemoteConnectionExtensionProps } from './slots.ts'
export type { RemoteConnectionState } from './remote-connection-controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote connection settings copy. */
    remoteConnection: RemoteConnectionLocaleKey
  }
}

/** Services consumed by the settings registration. */
export const inject = ['slots', 'locale', 'remote', 'remoteAccess', 'resources']

/**
 * Register the section and own its polling until plugin disposal.
 * @param ctx - Browser context providing the settings slot and authenticated Remote.
 * @returns After the generated service and section are registered.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(remoteConnectionRemote)
  ctx.effect(() => ctx.locale.register('remoteConnection', { en, zh, ja, es, fr, de, ru, pt }), 'remote-connection: dictionaries')
  const t = ctx.locale.bind('remoteConnection')
  ctx.inject(['remote.remoteConnection'], (scope) => {
    const controller = new RemoteConnectionController(scope.remote.remoteConnection)
    const link = new LoginLinkController(scope.remote.remoteConnection, writeClipboard,
      () => controller.store.getSnapshot().deployment?.url ?? null,
      () => controller.store.getSnapshot().deployment?.availability === 'available')
    const pairing = requestsResource(scope.remote.remoteConnection)
    const approval = new PairingApproval(scope.remote.remoteConnection, id => pairing.confirmed(id))
    const pairingFace = (): PairingInjected => ({
      hooks: { approval: approval.state },
      decide: (id, decision) => approval.decide(id, decision),
      dismiss: () => { approval.dismiss() },
    })
    const invitationFace = controller.inject()
    const linkFace = link.inject()
    const approvalFace = pairingFace()
    const face = {
      ...invitationFace, ...linkFace, ...approvalFace,
      hooks: { ...invitationFace.hooks, ...linkFace.hooks, ...approvalFace.hooks },
    }
    scope.effect(() => () => controller.dispose(), 'remote-connection: invitation lifetime')
    scope.effect(() => () => link.dispose(), 'remote-connection: login link')
    let linkAvailable = false
    scope.effect(() => controller.store.subscribe(() => {
      const available = controller.store.getSnapshot().deployment?.availability === 'available'
      if (available === linkAvailable) return
      linkAvailable = available
      if (available) void link.refresh()
    }), 'remote-connection: link availability')
    scope.on('connection/reset', () => {
      if (linkAvailable) void link.refresh()
      void controller.load()
    })
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'remote-connection', order: 25,
      label: () => t('title'),
      inject: () => ({ onLeave: () => { link.resetCopyWarning() } }),
      children: {
        'settings.remoteConnection.content': { kind: 'single', scope: 'root', inject: face },
        'settings.remoteConnection.extensions': { kind: 'list', scope: 'root', inject: face },
      },
    }, RemoteConnectionSettings))
    scope.slots.inject('settings.remoteConnection.content', () => scope.slots.register({
      name: 'settings.remoteConnection.content', locale: 'remoteConnection',
    }, RemoteConnectionSection))
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'remote-connection-copy', locale: 'remoteConnection', inject: () => linkFace,
    }, LoginLinkToast))
    scope.remoteAccess.whenAccess('remoteConnection/pairingRequests', function* () {
      approval.activate()
      yield () => { approval.dispose() }
      yield scope.resources.register(pairing.provider)
      yield scope.slots.inject('shell.overlay', () => scope.slots.register({
        name: 'shell.overlay', id: 'remote-connection-pairing-notice', locale: 'remoteConnection', inject: pairingFace,
      }, PairingToast))
    })
    void controller.load()
  })
}
