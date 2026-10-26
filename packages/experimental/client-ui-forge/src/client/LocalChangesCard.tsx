/**
 * The panel card of the checkout's changes before a change request carries
 * them: the files the `branch` scope changes, their size, which opens the
 * changes view, and the action that asks the Agent for a change request.
 */

import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconListPenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeLocalChanges } from '../types.ts'
import { Counts } from './DiffFile.tsx'
import { FileLabel } from './FileLabel.tsx'
import type { NS } from './locales.ts'
import css from './ChangesTab.module.css'

/** Props of the local changes card. */
export interface LocalChangesCardProps {
  /** Files the `branch` scope changes and the ref it compares with. */
  readonly local: ForgeLocalChanges
  /** Whether the card offers to create a change request. */
  readonly creatable: boolean
  /** Open the changes view, scrolled to `path` when given. */
  readonly view: (path?: string) => void
  /** Ask the Agent to create a change request for the changes. */
  readonly create: () => void
  /** Forge panel copy. */
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * Render the local changes card; the file list starts collapsed.
 * @param props - the changes, the view and create actions, and copy.
 * @returns the card.
 */
export function LocalChangesCard({ local, creatable, view, create, t }: LocalChangesCardProps): ReactNode {
  const [open, setOpen] = useState(false)
  let additions = 0
  let deletions = 0
  for (const file of local.files) {
    additions += file.additions
    deletions += file.deletions
  }
  const count = local.files.length
  return (
    <section className={css.local} data-forge-local="">
      <div className={css.localHead}>
        <button type="button" className={css.localToggle} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
          {t('changes.local.title')}
          <IconChevronDownOutlineRegular size={12} />
        </button>
        <span className={css.localRefs}>{t('changes.local.refs', { head: 'HEAD', base: local.base })}</span>
      </div>
      <div className={css.localRow}>
        <button
          type="button"
          className={css.localView}
          aria-label={t('changes.local.viewAria', { count, added: additions, deleted: deletions })}
          onClick={() => { view() }}
        >
          <IconListPenOutlineRegular size={15} />
          <Counts file={{ additions, deletions, binary: false }} t={t} />
          <span aria-hidden="true">·</span>
          <span>{t('changes.local.files', { count })}</span>
        </button>
        {creatable && (
          <Button size="sm" variant="outline" className={css.localCreate} onClick={create}>{t('changes.local.create')}</Button>
        )}
      </div>
      {open && (
        <ul className={css.localFiles}>
          {local.files.map(file => (
            <li key={file.path}>
              <button type="button" className={css.localFile} onClick={() => { view(file.path) }}>
                <FileLabel path={file.path} className={css.menuPath} />
                <Counts file={file} t={t} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
