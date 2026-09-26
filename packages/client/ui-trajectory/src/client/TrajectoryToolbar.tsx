/** Trajectory toolbar: timeline and ledger fold controls. */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import css from './TrajectoryToolbar.module.css'

export interface TrajectoryToolbarProps {
  /** Whether timeline blocks use recorded durations instead of equal widths. */
  actualDuration: boolean
  /** Select recorded-duration or equal-width blocks. */
  onActualDurationChange: (actualDuration: boolean) => void
  /** Whether recorded timing retains idle gaps between operations. */
  actualTime: boolean
  /** Select complete wall-clock timing or idle-compressed timing. */
  onActualTimeChange: (actualTime: boolean) => void
  /** Whether every collapsible turn is currently folded. */
  allTurnsCollapsed: boolean
  /** Fold or expand every collapsible turn. */
  onToggleAllTurns: () => void
  /** Whether every collapsible assistant's tool calls are currently folded. */
  allAssistantsCollapsed: boolean
  /** Fold or expand tool calls under every collapsible assistant. */
  onToggleAllAssistants: () => void
  /** Current live ledger search query. */
  searchQuery: string
  /** Update the live ledger search query. */
  onSearchQueryChange: (query: string) => void
  /** Translate a toolbar dictionary key. */
  t: TranslateNS<typeof NS>
}

/**
 * Render the sticky trajectory toolbar.
 * @param props - rendered counts and whole-list fold state.
 * @returns the toolbar element.
 */
export function TrajectoryToolbar({
  actualDuration,
  onActualDurationChange,
  actualTime,
  onActualTimeChange,
  allTurnsCollapsed,
  onToggleAllTurns,
  allAssistantsCollapsed,
  onToggleAllAssistants,
  searchQuery,
  onSearchQueryChange,
  t,
}: TrajectoryToolbarProps) {
  return (
    <div className={css.root} role="toolbar" aria-label={t('toolbar.aria')}>
      <div className={css.inner}>
        <div className={css.actions}>
          <button
            type="button"
            className={css.toggle}
            aria-label={t('toolbar.useActualDuration')}
            aria-pressed={actualDuration}
            title={actualDuration ? t('toolbar.useEqualWidth') : t('toolbar.useActualDuration')}
            onClick={() => { onActualDurationChange(!actualDuration) }}
          >
            <svg
              className={css.toggleIcon}
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="5.25" />
              <path d="M8 4.75V8l2.25 1.5" />
            </svg>
            {t('toolbar.duration')}
          </button>
          <button
            type="button"
            className={css.control}
            role="switch"
            aria-checked={actualTime}
            hidden
            onClick={() => { onActualTimeChange(!actualTime) }}
          >
            <span>{t('toolbar.actualTime')}</span>
            <span className={css.controlTrack} data-on={actualTime || undefined} aria-hidden="true">
              <span className={css.controlThumb} />
            </span>
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns')}
            aria-pressed={allTurnsCollapsed}
            title={allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns')}
            onClick={onToggleAllTurns}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allTurnsCollapsed ? '⊞' : '⊟'}
            </span>
            {t('toolbar.turns')}
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls')}
            aria-pressed={allAssistantsCollapsed}
            title={allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls')}
            onClick={onToggleAllAssistants}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allAssistantsCollapsed ? '⊞' : '⊟'}
            </span>
            {t('toolbar.calls')}
          </button>
        </div>
        <div className={css.search}>
          <IconSearchOutlineRegular size={11} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            aria-label={t('toolbar.search')}
            placeholder={t('toolbar.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => { onSearchQueryChange(event.currentTarget.value) }}
          />
        </div>
      </div>
    </div>
  )
}
