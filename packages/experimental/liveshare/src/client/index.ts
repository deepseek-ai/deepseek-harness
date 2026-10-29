/**
 * Browser plugin: the owner's Session-scoped Liveshare action, or the viewer page's own surfaces.
 *
 * The served viewer page is the owner's own Web shell with every owner plugin, so this one face
 * decides which half it mounts from the page global the Relay's carrier installs
 * (`__DSH_LIVESHARE_VIEWER__`): absent on the owner's page, present on a viewer page.
 *
 * The owner half mounts the generated `liveshareShares` Remote before it contributes the header
 * action, because that action and its dialogs address every share-management call through it.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import liveshareSharesRemote from '@deepseek-ai/dsh-experimental-liveshare/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { LIVESHARE_VIEWER_GLOBAL } from '../viewer-channel.ts'
import { LiveshareShareAction } from './ShareAction.tsx'
import type { OwnerShares } from './owner-shares.ts'
import { forgetOwnerDisplay, rememberOwnerIdentity } from './owner-display.ts'
import { setManagedShareOpener } from './share-navigation.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh, type LiveshareKey } from './locales.ts'
import { SharedSessionOrigin, shareViewerAuthor } from './user-origin.tsx'
import * as viewerBrand from './viewer-brand.tsx'
import * as viewerModel from './viewer-model.tsx'
import * as viewerPermission from './viewer-permission.tsx'
import * as viewerSession from './viewer-session-plugin.ts'
import * as viewerSessionRow from './viewer-session-row.tsx'
import * as viewerSharePath from './viewer-share-path.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    liveshare: LiveshareKey
  }
}

/** Required client services: dictionaries, the Remote carrier, and the header contribution. */
export const inject = ['slots', 'locale', 'remote']

/** Viewer-page plugins, each mounted with its own service requirements. */
const VIEWER_PLUGINS = [
  viewerSession, viewerBrand, viewerModel, viewerPermission, viewerSessionRow, viewerSharePath,
]

/**
 * Whether this page is a served viewer page.
 * @returns True when the Relay's carrier named the share this page presents.
 */
function isViewerPage(): boolean {
  return (globalThis as Record<string, unknown>)[LIVESHARE_VIEWER_GLOBAL] !== undefined
}

/**
 * Register Liveshare dictionaries and the shared-session origin seat, then the owner's Session
 * Header utility or the viewer surfaces.
 *
 * The owner Remote is mounted only on the owner page: a viewer Peer is refused every management
 * method, so a viewer page has nothing to mount it for.
 * @param ctx - browser context carrying slot, locale, and Remote services.
 * @returns Disposer releasing the owner Remote when the face unmounts.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // The viewer plugins are children of this face, so this one registration outlives every one of them.
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'liveshare: browser dictionaries')
  // The shared Session's attributed messages reach both pages through the same durable source, so
  // one registration supplies Chat's origin seat on either face. Declaration-aware injection makes
  // this independent of whether Chat's user renderer is already registered.
  ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
    name: 'conversation.chat.user.before',
    locale: NS,
    select: owner => owner.kind === 'user' ? (shareViewerAuthor(owner.source) ?? null) : null,
  }, SharedSessionOrigin))
  if (isViewerPage()) {
    for (const plugin of VIEWER_PLUGINS) ctx.plugin(plugin)
    return async () => {}
  }
  // Navigation is a workspace service, not a Remote child. The manager still opens the selected
  // share's dialog when this page has none (or navigation is unavailable).
  const workspace = ctx.get('uiWorkspace')
  if (workspace !== undefined) {
    setManagedShareOpener((sessionId) => { workspace.openSession(sessionId as SessionId) })
  }
  const transport = ctx.plugin(async (owner) => {
    await owner.remote.$mount(liveshareSharesRemote)
    // The generated namespace only exists after this fiber's own mount; injecting it on a child
    // scope reads the carrier without making the face wait for a service it creates itself.
    owner.inject(['remote.liveshareShares'], (scope) => {
      const shares: OwnerShares = scope.remote.liveshareShares
      // The transcript's attribution line reads the owner's own display name; a failed read leaves the
      // durable subject id as its only identity.
      void rememberOwnerIdentity(shares)
      ctx.effect(() => () => { forgetOwnerDisplay() }, 'liveshare.ownerDisplay')
      scope.slots.inject(
        'conversation.session.header.utilities',
        () => scope.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'liveshare-share',
          order: 30,
          locale: NS,
          inject: () => ({ shares }),
        }, LiveshareShareAction),
      )
    })
  })
  await transport
  return async () => {
    await transport.dispose()
    setManagedShareOpener(undefined)
  }
}

export type { LiveshareShareActionProps } from './ShareAction.tsx'
export type { LiveshareShareDialogProps } from './ShareDialog.tsx'
export type { LiveshareManageSharesDialogProps } from './ManageSharesDialog.tsx'
