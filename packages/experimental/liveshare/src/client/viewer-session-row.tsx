/**
 * The viewer page's own Session row verbs.
 *
 * The viewer page renders the normal sidebar, so it carries ui-workspace's shipped Session row
 * entries, and each of them hides itself while the page's access snapshot excludes its endpoint. This
 * module registers the viewer's own branch row over the shipped one by id — the one verb a share can
 * grant, stated in the reader's words when the Host refuses it — and the row's branch mark.
 *
 * The Liveshare client face mounts this module only on a viewer page.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-session-row
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconBranchOutlineRegular, MenuItemButton, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionProjectionValues } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from './locales.ts'

export const name = 'liveshare-viewer-session-row'

/** The slot ledger, the locale seat, and the navigation service. */
export const inject: readonly string[] = ['slots', 'locale', 'uiWorkspace']

/**
 * Cell shadowing rank of the viewer's branch row. The shipped row registers at the default 0, and the
 * lowest rank renders, so the viewer's row takes the cell the shipped row would have rendered while
 * keeping the shipped order.
 */
const VIEWER_PRIORITY = -100

/** The viewer share the branch row receives. */
export interface ViewerSessionRowInjected {
  /** Branch the row's Session the way this page's reader path does. */
  forkSession: (sessionId: SessionId) => void
}

/** Props of the viewer's branch row: the row share, the menu hook, the locale seat, and the viewer share. */
export type ViewerForkMenuItemProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'liveshare'>
  & InjectFace<ViewerSessionRowInjected>

/**
 * The branch row: present only while the access snapshot includes `session/fork` for the row's Session.
 *
 * The label is this package's own copy, and the click asks the Workspace navigation service for the
 * reader's branch: the child is created without the title write a reader does not hold, and opens
 * once the Host lists it.
 * @param props - owner share, menu open state, access Hook, locale seat, and the viewer share.
 * @returns the menu row, or null while the page may not branch that Session.
 */
export function ViewerForkMenuItem({
  sessionId, useMenuOpenState, useSessionAccess, forkSession, t,
}: ViewerForkMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const forkAllowed = useSessionAccess(sessionId, 'session/fork')
  if (!forkAllowed) return null
  return (
    <MenuItemButton
      icon={<IconBranchOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        forkSession(sessionId)
      }}
    >
      {t('viewer.row.fork')}
    </MenuItemButton>
  )
}

/** Liveshare interprets its own lineage projection without retaining every listed Session. */
function ViewerForkMarker({ sessionId, useSessions, t }: PropsRuntime<'sidebar.session.row.leading'> & PropsLocale<'liveshare'>) {
  const lineage = useSessions((list) => {
    const values = list.byId[sessionId]?.projectionValues as SessionProjectionValues | undefined
    const value = values?.['forkLineage']
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || value.origin !== 'fork' || value.workspaceReadOnly !== true) return undefined
    return typeof value.sourceSessionId === 'string' ? value.sourceSessionId : ''
  })
  const sourceTitle = useSessions(list => lineage ? list.byId[SessionId(lineage)]?.title : undefined)
  if (lineage === undefined) return null
  const label = sourceTitle ? t('viewer.row.forkSource', { title: sourceTitle }) : t('viewer.row.fork')
  return <Tooltip label={label}><span><IconBranchOutlineRegular size={14} /></span></Tooltip>
}


/**
 * Read the stable code one refused branch carries.
 *
 * A share refusal decided by the access check arrives as {@link ACCESS_DENIED} with the share's own
 * code as its reason, which is the code the reader's copy names.
 * @param error - Rejection the fork reported.
 * @returns The Host's code, or undefined when the rejection named none.
 */

/**
 * Register the viewer's branch mark and its branch row over the shipped one.
 * @param ctx - browser context of the viewer's module table.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading', id: 'liveshare.fork', locale: NS,
  }, ViewerForkMarker))
  const uiWorkspace = ctx.uiWorkspace
  const forkSession = (sessionId: SessionId): void => {
    uiWorkspace.forkSession(sessionId).catch((error: unknown) => {
      // A refused branch leaves the current selection unchanged. The shared Client conversation
      // surface no longer carries the branch-refusal notice this page stated it through.
      void error
    })
  }
  const viewerInjected = (): ViewerSessionRowInjected => ({ forkSession })
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces.session.menu.item',
      id: 'fork',
      order: 300,
      priority: VIEWER_PRIORITY,
      locale: NS,
      inject: viewerInjected,
    },
    ViewerForkMenuItem,
  ))
}
