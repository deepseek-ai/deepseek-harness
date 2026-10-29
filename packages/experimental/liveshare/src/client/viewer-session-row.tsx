/**
 * The viewer page's branch lineage markers.
 *
 * The viewer renders the normal sidebar. Its Session menu actions belong to
 * ui-workspace and follow the page's endpoint access snapshot. Branch creation
 * uses the Workspace navigation service's reader path, without a title write
 * the reader does not hold, and opens the child once the Host lists it.
 *
 * The Liveshare client face mounts this module only on a viewer page.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-session-row
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconBranchOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionProjectionValues } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from './locales.ts'

export const name = 'liveshare-viewer-session-row'

/** The slot ledger and locale seat used by branch lineage markers. */
export const inject: readonly string[] = ['slots', 'locale']

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
 * Register the viewer's branch lineage marker.
 * @param ctx - browser context of the viewer's module table.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading', id: 'liveshare.fork', locale: NS,
  }, ViewerForkMarker)), 'liveshare: branch lineage marker')
}
