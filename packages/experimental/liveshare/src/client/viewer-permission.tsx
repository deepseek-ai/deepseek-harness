/**
 * The viewer composer's permission seat: which tier this share carries, stated and not selectable.
 *
 * A reader cannot change what the owner granted, so the seat states the share's own answer — the
 * tier the Relay reported for this share — and says in the page that the reader cannot change it.
 * It renders through {@link ViewerSeat}, whose `readOnly` switch is what keeps it a label; the
 * shipped permission control is shadowed here, because the owner's own preset for the Session is
 * not this reader's permission and offering it would offer a change nothing may make.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-permission
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { type LiveshareKey, NS, type ViewerTranslate } from './locales.ts'
import { viewerCapabilities, type ViewerCapabilities } from './viewer-capabilities.ts'
import { ViewerSeat, VIEWER_SEAT_PRIORITY } from './viewer-seat.tsx'

export const name = 'liveshare-viewer-permission'

/** Composer slot registry this seat occupies. */
export const inject: readonly string[] = ['slots']

/** The observation face this page's capability store exposes. */
interface CapabilityFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): ViewerCapabilities
}

/** Everything the seat reads: what the share's own answer granted this page. */
export interface ViewerPermissionSeatProps {
  /** Whether the composer's own owner disabled the seat; a stated tier stays a label either way. */
  readonly locked: boolean
  /** The one capability set this page holds for the share it presents. */
  readonly capabilities: CapabilityFace
}

/**
 * The tier this seat states, in the reader's words.
 *
 * The share's own answer decides; a page that could not read one states that it has not confirmed
 * the share rather than naming the narrowest tier as though the share had said it.
 * @param page - What the share's answer granted this page.
 * @param t - Translate seat bound to this package's namespace.
 * @returns The tier's label.
 */
function tierValue(page: ViewerCapabilities, t: ViewerTranslate): string {
  if (page.unconfirmed === true) return t('viewer.permission.unconfirmed')
  return t(`dialog.sessionMode.${page.mode}` as const satisfies LiveshareKey)
}

/**
 * Render the permission this share carries.
 * @param props - the share's own capability answer and the framework-injected translate seat.
 * @returns The seat as a label.
 */
export function ViewerPermissionSeat({ capabilities, t }: ViewerPermissionSeatProps & PropsLocale<typeof NS>): ReactNode {
  const page = useSyncExternalStore(
    listener => capabilities.subscribe(listener),
    () => capabilities.getSnapshot(),
  )
  return (
    <ViewerSeat
      kind="permission"
      value={tierValue(page, t)}
      title={t('viewer.permission.title')}
      note={t('viewer.permission.locked')}
      readOnly
    />
  )
}

/**
 * Fill the composer's permission seat with the share's own tier.
 * @param ctx - the viewer page's root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots'], (scope: ClientContext) => {
    scope.slots.inject('conversation.input.permission', () => scope.slots.register({
      name: 'conversation.input.permission',
      priority: VIEWER_SEAT_PRIORITY,
      locale: NS,
      inject: (_sessionId: SessionId) => ({ capabilities: viewerCapabilities }),
    }, ViewerPermissionSeat))
  })
}
