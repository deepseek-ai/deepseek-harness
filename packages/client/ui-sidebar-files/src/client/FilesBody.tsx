/**
 * The `files` page: a file browser with no file chosen yet.
 *
 * Its header spans the page: the workspace root's path, the tree's reload and
 * the directory actions, in the order a preview's header ends with its own
 * reload and file actions. The pane's navigator fills the page below it and
 * stays shown, so the page draws no toggle; picking a file leaves this page as
 * it is and opens the file where the right Sidebar places it by default
 * (`FileNavigator`).
 */
import { useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconPauseOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular, PathLabel, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilesInjected } from './face.ts'
import type {} from './FileNavigator.tsx'
import type {} from './locales.ts'
import type { createFilesStore } from './store.ts'
import css from './FilesBody.module.css'

/** The page's composed props: the tab it draws, its directory-actions seat, the pane records and the tree's face, and copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsRenderFactories
  & PropsStore<ReturnType<typeof createFilesStore>>
  & InjectFace<FilesInjected>
  & PropsLocale<'sidebarFiles'>

/**
 * The `files` page body.
 * @param props - composed slot props.
 * @returns the header above the pane's navigator, or the workspace line.
 */
export function FilesBody(props: FilesBodyProps): ReactNode {
  const { useTabInfo, sessionId, useSessions, useStore, refresh, setAutoRefresh, renderSlot, renderFactorySlot, t, useContextMenu } = props
  const { tab, panel } = useTabInfo()
  const { getTriggerProps } = useContextMenu()
  const onOpen = useCallback((address: string): void => {
    if (panel.isFloating) tab.actions.openResource(address)
    else tab.actions.openResource(address, { paneId: panel.id })
  }, [tab.actions, panel.id, panel.isFloating])
  useEffect(
    () => tab.actions.bindCommands({ refresh: () => { refresh(panel.id) } }),
    [tab.actions, panel.id, refresh],
  )
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  // The setting belongs to a listed tree, so there is nothing to set before one.
  const autoRefresh = useStore((store) => {
    const tree = store.byPane[panel.id]?.tree
    return tree?.root === cwd ? tree?.autoRefresh : undefined
  })

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  const automatic = autoRefresh ?? true
  const navigator = renderFactorySlot('sidebar.files.navigator', { useTabInfo, page: true, onOpen })
  return (
    <div className={css.page} data-files-page>
      <div className={css.header}>
        <PathLabel path={cwd} className={css.path} data-files-path
          {...getTriggerProps({ kind: 'directory', value: { sessionId, path: cwd } })} />
        <span hidden>
          <button type="button" className={css.tool} aria-label={t('autoRefresh')}
            aria-pressed={automatic} disabled={autoRefresh === undefined} data-files-auto-refresh
            title={t(automatic ? 'autoRefresh.disable' : 'autoRefresh.enable')}
            onClick={() => { setAutoRefresh(panel.id, !automatic) }}>
            {automatic ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
          </button>
        </span>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            aria-keyshortcuts={tab.refreshShortcut?.aria}
            data-files-reload
            onClick={() => { refresh(panel.id) }}
          >
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
        {renderSlot('sidebar.right.tab.files.actions', { absolutePath: cwd })}
      </div>
      <div className={css.content} data-files-content>{navigator}</div>
    </div>
  )
}
