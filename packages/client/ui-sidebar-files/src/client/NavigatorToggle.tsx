/**
 * The navigator's show/hide control, at the end of a document preview's
 * header through its Factory; the `files` page's tree is always
 * shown and has none. It writes the pane's choice, which every file tab of
 * the pane reads, and registers itself with the face, which hands it the
 * keyboard when Escape closes the navigator.
 */
import { useCallback } from 'react'
import type { ReactNode } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconFolderCloseRegular, IconFolderOpenRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilesInjected } from './face.ts'
import type { createFilesStore } from './store.ts'
import type {} from './locales.ts'
import css from './FilesBody.module.css'

/** The tab whose pane's navigator this control toggles. */
export interface NavigatorToggleInput {
  readonly useTabInfo: UseSidebarRightTabInfo
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Show or hide the pane's workspace tree; absent without a working directory. */
    'sidebar.files.navigator.toggle': {
      scope: 'session'
      props: NavigatorToggleInput
      store: ReturnType<typeof createFilesStore>
      locale: 'sidebarFiles'
      inject: Pick<FilesInjected, 'toggleDrawn'>
    }
  }
}

/**
 * Show or hide the pane's navigator.
 * @param props - the tab, the pane records, the face's registration, and copy.
 * @returns the toggle, or nothing without a workspace.
 */
export function NavigatorToggle(
  { useTabInfo, sessionId, useSessions, useStore, actions, toggleDrawn, t }: FactoryComponentPropsOf<'sidebar.files.navigator.toggle'>,
): ReactNode {
  const { panel } = useTabInfo()
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const open = useStore(store => store.byPane[panel.id]?.open) === true
  // Stable, so the control registers once per drawing rather than on every render.
  const toggleRef = useCallback((button: HTMLElement | null) => { toggleDrawn(panel.id, button) }, [toggleDrawn, panel.id])
  if (cwd === undefined) return null
  const label = t(open ? 'navigator.hide' : 'navigator.show')
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button
        ref={toggleRef}
        type="button"
        className={css.tool}
        aria-label={label}
        aria-expanded={open}
        data-files-navigator-toggle
        onClick={() => { actions.shown(panel.id, !open) }}
      >
        {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
      </button>
    </Tooltip>
  )
}
