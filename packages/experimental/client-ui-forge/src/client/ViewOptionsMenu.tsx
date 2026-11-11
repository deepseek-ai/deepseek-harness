/** The changes toolbar's More menu, which holds the view controls a narrow toolbar folds out of its row. */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconEllipsisOutlineRegular, Menu, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { foldOf } from './toolbar-fold.ts'
import { lensEntries, lensOfRow, NO_LENS, type LensChoice } from './LensFilter.tsx'
import css from './ChangesTab.module.css'

/** Toolbar state and actions the menu repeats. */
export interface ViewOptions {
  /** Whether any shown file is expanded, so the expansion row collapses them all. */
  readonly anyExpanded: boolean
  /** Whether any file shows, so the expansion row has files to change. */
  readonly hasFiles: boolean
  readonly toggleExpansion: () => void
  readonly split: boolean
  readonly toggleSplit: () => void
  readonly wrap: boolean
  readonly toggleWrap: () => void
  /** Whether test files hide, or undefined when the toolbar offers no test switch. */
  readonly hideTests: boolean | undefined
  readonly toggleTests: () => void
  readonly refresh: () => void
  /** Lenses the menu offers while the lens menu folds, empty while a lens is chosen and its menu stays in the row. */
  readonly lenses: readonly LensChoice[]
  readonly chooseLens: (lens: string | null) => void
  /** Draw the `MenuItemButton` rows of plugin toolbar entries, which fold first; `close` closes the menu. */
  readonly plugins: (close: () => void) => ReactNode
}

/**
 * Render the More button and its menu, which lists the controls of the toolbar's fold level when it opens (see
 * `observeToolbarFold`), then the rows of plugin toolbar entries; the toolbar's styles hide the button while nothing folds.
 * @param props - the toolbar state and actions, whether the owning tab is visible, and copy.
 * @returns the button and its portalled menu.
 */
export function ViewOptionsMenu({ options, visible, t }: PropsLocale<typeof NS> & {
  readonly options: ViewOptions
  readonly visible: boolean
}): ReactNode {
  const [fold, setFold] = useState<number | null>(null)
  const open = visible && fold !== null
  const entries: MenuEntry[] = []
  if (fold !== null) {
    entries.push(
      { id: 'expansion', label: t(options.anyExpanded ? 'diff.collapseAll' : 'diff.expandAll'), disabled: !options.hasFiles },
      { id: 'split', label: t('diff.splitAria') },
      { id: 'wrap', label: t('diff.wrapAria') },
    )
    if (fold >= 2 && options.hideTests !== undefined) entries.push({ type: 'separator', id: 'tests-separator' }, { id: 'tests', label: t('tests.hide') })
    if (fold >= 2 && options.lenses.length > 0) entries.push({ type: 'separator', id: 'lens-separator' }, ...lensEntries(options.lenses, t))
    if (fold >= 3) entries.push({ type: 'separator', id: 'refresh-separator' }, { id: 'refresh', label: t('diff.refresh') })
  }
  const selected = [options.split && 'split', options.wrap && 'wrap', options.hideTests === true && 'tests', options.lenses.length > 0 && NO_LENS]
    .filter(item => item !== false)
  const run = (id: string): void => {
    const lens = lensOfRow(id)
    if (lens !== undefined) {
      options.chooseLens(lens)
      return
    }
    switch (id) {
      case 'expansion': options.toggleExpansion(); break
      case 'split': options.toggleSplit(); break
      case 'wrap': options.toggleWrap(); break
      case 'tests': options.toggleTests(); break
      case 'refresh': options.refresh(); break
      /* v8 ignore next -- the menu offers only the rows above */
      default: break
    }
  }
  return (
    <Menu open={open} portal dense align="end" autoFocus items={entries} selectedIds={selected}
      onClose={() => { setFold(null) }}
      onSelect={(id) => {
        setFold(null)
        run(id)
      }}
      anchor={(
        <Tooltip label={t('diff.moreOptions')} side="bottom">
          <button type="button" className={clsx(css.tool, css.more)} aria-label={t('diff.moreOptions')}
            aria-haspopup="menu" aria-expanded={open} data-forge-view-options=""
            onClick={(event) => { setFold(fold === null ? foldOf(event.currentTarget) : null) }}>
            <IconEllipsisOutlineRegular />
          </button>
        </Tooltip>
      )}>
      {fold !== null && <div className={css.menuPlugins}>{options.plugins(() => { setFold(null) })}</div>}
    </Menu>
  )
}
