import { useEffect } from 'react'
import { LinkIcon, classifyLinkPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { basename } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './ProducedFiles.module.css'

/** Maximum number of file chips rendered before the remainder counter. */
const SHOWN_LIMIT = 6

/** Registration-side Host capability facts. */
export interface ProducedFilesInjected {
  /** Whether the browser itself is connected over loopback. */
  isLoopback: boolean
  /** Load the opener capability when this row first reaches the page. */
  ensureWorkspacePathOpen(): void
  hooks: {
    /** Current generation's Session workspace opener capability. */
    workspacePathOpen: HostObservable<boolean | undefined>
  }
}

/** Matched paths plus the opener, locale, and injected Host capability. */
export type ProducedFilesProps = Pick<TurnTailOwnerProps, 'openFile'> & {
  matched: readonly string[]
} & PropsLocale<typeof NS> & InjectFace<ProducedFilesInjected>

function moreLabel(t: ProducedFilesProps['t'], count: number): string {
  return count === 1 ? t('produced.moreOne') : t('produced.more', { count: String(count) })
}

/**
 * Render one turn's produced files as openable chips.
 * @param props - selector-matched paths, the chat view's file opener, and the locale seat.
 * @returns The produced-files row.
 */
export function ProducedFiles({
  matched: paths, openFile, isLoopback, ensureWorkspacePathOpen, useWorkspacePathOpen, t,
}: ProducedFilesProps) {
  useEffect(() => { ensureWorkspacePathOpen() }, [ensureWorkspacePathOpen])
  const hostCanOpenPath = useWorkspacePathOpen(available => available === true)
  const canOpenPath = isLoopback && hostCanOpenPath
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
        {paths.length > 1 && canOpenPath && (
          <button
            type="button"
            className={css.showFolder}
            onClick={() => { openFile('.') }}
          >
            <LinkIcon kind="folder" className={css.fileIcon} />
            {t('produced.showInFolder')}
          </button>
        )}
      </div>
    </div>
  )
}
