import { LinkIcon, classifyLinkPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { basename } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './ProducedFiles.module.css'

/** Maximum number of file chips rendered before the remainder counter. */
const SHOWN_LIMIT = 6

/** Matched paths, the opener, and the locale seat. */
export type ProducedFilesProps = Pick<TurnTailOwnerProps, 'openFile'> & {
  matched: readonly string[]
} & PropsLocale<typeof NS>

function moreLabel(t: ProducedFilesProps['t'], count: number): string {
  return count === 1 ? t('produced.moreOne') : t('produced.more', { count: String(count) })
}

/**
 * Render one turn's produced files as openable chips.
 * @param props - selector-matched paths, the chat view's file opener, and the locale seat.
 * @returns The produced-files row.
 */
export function ProducedFiles({ matched: paths, openFile, t }: ProducedFilesProps) {
  const shown = paths.slice(0, SHOWN_LIMIT)
  return (
    <div className={css.root}>
      <span className={css.label}>{t('produced.label')}</span>
      <div className={css.lane}>
        <div className={css.row} data-produced-files-row>
          {shown.map(path => (
            <button
              key={path}
              type="button"
              className={css.file}
              // The full path is the disambiguator when two turns produce files
              // that share a basename; the chip itself stays short.
              title={path}
              aria-label={t('produced.open', { name: path })}
              onClick={() => { openFile(path) }}
            >
              <LinkIcon kind={classifyLinkPath(path)} className={css.fileIcon} />
              <span className={css.fileName}>{basename(path)}</span>
            </button>
          ))}
          {shown.map((_, index) => {
            const shownCount = index + 1
            const remainder = paths.length - shownCount
            if (remainder <= 0) return null
            return (
              <span key={shownCount} className={css.more} data-shown={shownCount}>
                {moreLabel(t, remainder)}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
