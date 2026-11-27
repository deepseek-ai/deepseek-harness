/** The changes view's body while it reads: a status line above file cards drawn as skeletons. */

import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { NS } from './locales.ts'
import css from './ChangesLoading.module.css'

/** Widths, in percent of a line, that the skeleton's code bars cycle through. */
const CODE_WIDTHS = [62, 48, 74, 35, 81, 56, 44, 69, 28, 52, 77, 39] as const

/**
 * The skeleton cards: a changed file shown in two columns when the view splits sides, an added file, and two
 * collapsed files. `path` is the path bar's width in percent of the header.
 */
const FILES = [
  { path: 46, lines: 7, sides: 2 },
  { path: 34, lines: 4, sides: 1 },
  { path: 52, lines: 0, sides: 1 },
  { path: 28, lines: 0, sides: 1 },
] as const

function Column({ lines, offset }: { readonly lines: number; readonly offset: number }): ReactNode {
  return (
    <div className={css.column}>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className={css.line}>
          <span className={clsx(css.fill, css.number)} />
          <span className={clsx(css.fill, css.code)} style={{ width: `${CODE_WIDTHS[(index + offset) % CODE_WIDTHS.length]}%` }} />
        </div>
      ))}
    </div>
  )
}

/**
 * Render the reading state of the changes view. The status line is the only text and announces itself politely;
 * the cards are hidden from assistive technology.
 * @param props - whether changed files show their sides in two columns, and copy.
 * @returns the status line and the skeleton cards.
 */
export function ChangesLoading({ split, t }: { readonly split: boolean } & PropsLocale<typeof NS>): ReactNode {
  return (
    <>
      <div className={css.status} role="status">{t('diff.loading')}</div>
      <div aria-hidden="true" data-forge-changes-skeleton="">
        {FILES.map((file, index) => {
          const columns = split && file.sides === 2
          return (
            <div key={index} className={clsx(css.file, file.lines === 0 && css.folded)}>
              <div className={css.header}>
                <span className={clsx(css.fill, css.icon)} />
                <span className={clsx(css.fill, css.path)} style={{ width: `${file.path}%` }} />
                <span className={clsx(css.fill, css.counts)} />
                <span className={clsx(css.fill, css.box)} />
              </div>
              {file.lines > 0 && (
                <div className={clsx(css.lines, columns && css.split)}>
                  <Column lines={file.lines} offset={index * 5} />
                  {columns && <Column lines={file.lines} offset={index * 5 + 4} />}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
