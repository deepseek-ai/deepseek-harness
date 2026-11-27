/** Environment row naming the Session's working folder. */
import type { ReactNode } from 'react'
import { IconFolderCloseRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { abbreviateHomePath, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-working-directory/types'
import type { ProjectRowProps } from './slots.ts'
import css from './ProjectRow.module.css'

const ROOT = /^(?:[/\\]|[A-Za-z]:[/\\])$/

/**
 * Render the Session's working folder as its name followed by its parent
 * folder, with the label and the full path in the tooltip. The folder is the
 * Session's current working directory; before that projection arrives, or
 * when it records none, it is the directory the Session was created in, else
 * the Workspace that lists the Session. Paths under the Host account home
 * start with `~`. The row and its More button open the directory context menu.
 * @param props - Session values, the working directory projection, Workspace and Session list hooks, Host facts, menu bindings, and copy.
 * @returns the row, or null before the Session's directory is known.
 */
export function ProjectRow({
  sessionId, useProjection, useWorkspaces, useSessions, useHost, useContextMenu, renderFactorySlot, t,
}: ProjectRowProps): ReactNode {
  const current = useProjection('workingDirectory')
  const createdIn = useSessions(snapshot => snapshot.byId[sessionId]?.cwd)
  const workspacePath = useWorkspaces(snapshot => snapshot.items.find(item => item.sessionIds.includes(sessionId))?.path)
  const home = useHost(facts => facts.home)
  const { getTriggerProps } = useContextMenu()
  const path = current ?? createdIn ?? workspacePath
  if (path === undefined) return null
  const shown = abbreviateHomePath(path, home)
  const { directory, name } = pathPartsOf(shown)
  const parent = ROOT.test(directory) ? directory : directory.replace(/[/\\]+$/, '')
  const target = { kind: 'directory', value: { sessionId, path } } as const
  return (
    <div {...getTriggerProps(target)} data-session-panel-row="" data-session-panel-project="">
      <span data-row-part="body">
        <span data-row-part="icon" aria-hidden="true"><IconFolderCloseRegular size={16} /></span>
        <span data-row-part="content">
          <Tooltip label={`${t('project.label')}\n${shown}`} side="left" delayMs={500}>
            <span className={css.folder} tabIndex={0}>
              <span className={css.name}>{name}</span>
              {parent !== '' && <span className={css.parent}>{parent}</span>}
            </span>
          </Tooltip>
        </span>
      </span>
      <span data-row-part="menu">{renderFactorySlot('contextMenu.button', { target, label: t('project.actions') })}</span>
    </div>
  )
}
