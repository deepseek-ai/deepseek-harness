/** The changes toolbar's filter lens menu: the Host's lenses with the files each keeps among the shown files. */

import { useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconLayersOutlineRegular, IconLoadingOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LensRun } from './lens-filter.ts'
import type { NS } from './locales.ts'
import css from './LensFilter.module.css'

/** One lens the view offers. */
export interface LensChoice {
  /** Identity of the Host lens. */
  readonly id: string
  /** Title in the current language, or the identity when no Client plugin describes it. */
  readonly title: string
  /** Files the lens keeps among the shown files, or null before it ran for them. */
  readonly count: number | null
}

/** Menu row identity of choosing no lens. */
export const NO_LENS = 'lens:none'

/**
 * Menu row identity of choosing a lens.
 * @param id - the lens identity.
 * @returns the row identity.
 */
export function lensRowId(id: string): string {
  return `lens:${id}`
}

/**
 * Read the lens a menu row chooses.
 * @param row - a row identity.
 * @returns the lens identity, null for no lens, or undefined for a row that chooses no lens.
 */
export function lensOfRow(row: string): string | null | undefined {
  if (row === NO_LENS) return null
  return row.startsWith('lens:') ? row.slice('lens:'.length) : undefined
}

/**
 * The rows that choose a lens: a heading, No lens, and each lens with its count.
 * @param lenses - the lenses offered.
 * @param t - forge panel copy.
 * @returns the menu entries.
 */
export function lensEntries(lenses: readonly LensChoice[], t: PropsLocale<typeof NS>['t']): MenuEntry[] {
  return [
    { type: 'label', id: 'lens:heading', text: t('filterLens.heading') },
    { id: NO_LENS, label: t('filterLens.none') },
    ...lenses.map((lens): MenuEntry => ({
      id: lensRowId(lens.id),
      label: <span className={css.row}><span className={css.rowLabel}>{lens.title}</span><span className={css.rowCount}>{lens.count ?? '—'}</span></span>,
    })),
  ]
}

/**
 * Render the lens menu button: Lens while none is chosen; the chosen lens's title, tinted, with the files it keeps, or
 * its progress while it runs.
 * @param props - the offered lenses, the chosen one, its run, the choose action, whether the owning tab is visible, and copy.
 * @returns the trigger with its portalled menu.
 */
export function LensFilterMenu({ lenses, chosen, run, choose, visible, t }: PropsLocale<typeof NS> & {
  readonly lenses: readonly LensChoice[]
  readonly chosen: LensChoice | null
  readonly run: LensRun
  readonly choose: (lens: string | null) => void
  readonly visible: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  let status: ReactNode = null
  if (run.kind === 'running') {
    status = <>
      <IconLoadingOutlineRegular size={12} className={css.spin} />
      {run.done !== null && run.total !== null && <span className={css.count}>{t('filterLens.progress', { done: String(run.done), total: String(run.total) })}</span>}
    </>
  } else if (chosen?.count !== null && chosen?.count !== undefined) {
    status = <span className={css.count}>{chosen.count}</span>
  }
  return (
    <Menu open={visible && open} portal dense align="start" autoFocus items={lensEntries(lenses, t)}
      selectedId={chosen === null ? NO_LENS : lensRowId(chosen.id)}
      onClose={() => { setOpen(false) }}
      onSelect={(row) => {
        setOpen(false)
        const lens = lensOfRow(row)
        /* v8 ignore next -- the menu offers only rows that choose a lens */
        if (lens === undefined) return
        choose(lens)
      }}
      anchor={(
        <button type="button" className={css.trigger} aria-haspopup="menu" aria-expanded={visible && open}
          aria-label={chosen === null ? t('filterLens.aria') : t('filterLens.chosenAria', { lens: chosen.title })}
          data-active={chosen === null ? undefined : ''} data-forge-filter-lens={chosen?.id ?? ''}
          onClick={() => { setOpen(value => !value) }}>
          <IconLayersOutlineRegular size={14} />
          <span className={css.label}>{chosen === null ? t('filterLens.label') : chosen.title}</span>
          {status}
          <IconChevronDownOutlineRegular size={12} />
        </button>
      )} />
  )
}
