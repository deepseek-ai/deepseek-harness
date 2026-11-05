/** Environment row naming the Session's project directory. */
import type { ReactNode } from 'react'
import { IconFolderCloseRegular, PanelRow, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { ProjectRowProps } from './slots.ts'
import css from './ProjectRow.module.css'

/**
 * Render the project directory: the Workspace that lists the Session, or the
 * directory the Session was created in when no Workspace lists it. The row
 * and its More button open the directory context menu.
 * @param props - Session values, Workspace and Session list hooks, Host facts, menu bindings, and copy.
 * @returns the row, or null before the Session's directory is known.
 */
export function ProjectRow({
  sessionId, useWorkspaces, useSessions, useHost, useContextMenu, renderFactorySlot, t,
}: ProjectRowProps): ReactNode {
  const workspacePath = useWorkspaces(snapshot => snapshot.items.find(item => item.sessionIds.includes(sessionId))?.path)
  const createdIn = useSessions(snapshot => snapshot.byId[sessionId]?.cwd)
  const home = useHost(facts => facts.home)
  const { getTriggerProps } = useContextMenu()
  const path = workspacePath ?? createdIn
  if (path === undefined) return null
  const target = { kind: 'directory', value: { sessionId, path } } as const
  return (
    <PanelRow
      {...getTriggerProps(target)}
      className={css.row}
      icon={<IconFolderCloseRegular size={16} />}
      trailing={renderFactorySlot('contextMenu.button', {
        target, label: t('project.actions'), className: css.more, size: 'sm',
      })}
      data-session-panel-project=""
    >
      <PathLabel path={abbreviateHomePath(path, home)} />
    </PanelRow>
  )
}
