/**
 * Font-size preference row: title + role description + stepper pill (centered value; hover
 * reveals the up/down arrow column anchored to the pill's right edge) + a px
 * unit label after the pill. The text row is registered into the General
 * section item slot; the code and terminal rows render inside the font
 * settings group. The displayed value follows the persisted setting, never the
 * click echo.
 */
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { FONT_SIZE_SPECS, type FontRole } from '../theme-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontRowStore } from './settings-store.ts'
import css from './FontSizeRow.module.css'

/** Injected business face: the row's font role and its write (t rides the standard locale seat). */
export interface FontSizeRowInjected {
  /** Font role this row edits. */
  role: FontRole
  /** Change this role's font size (integer px within its FONT_SIZE_SPECS range). */
  setFontSize: (px: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontSizeRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontRowStore>>
  & PropsLocale<'settings.theme'> & FontSizeRowInjected & {
    /** Disclosure button after the unit label; the font settings group passes it for the text row. */
    expander?: FontSizeRowExpander | undefined
  }

/** Controlled disclosure state for the button that expands more font settings. */
export interface FontSizeRowExpander {
  /** Whether the controlled region is shown. */
  open: boolean
  /** Id of the controlled region. */
  controls: string
  /** Toggle the region. */
  onToggle: () => void
}

/**
 * Render the font-size row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function FontSizeRow({ t, role, setFontSize, useStore, expander }: FontSizeRowComponentProps) {
  const fontSize = useStore(s => s.fontSizes[role])
  const { min, max } = FONT_SIZE_SPECS[role]
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t(`fontSize.${role}.title`)}</div>
        <div className={css.desc}>{t(`fontSize.${role}.description`)}</div>
      </div>
      <div className={css.control}>
        <div className={css.stepper}>
          <span className={css.value}>{fontSize}</span>
          <span className={css.arrows}>
            <button
              type="button"
              className={css.arrow}
              aria-label={t(`fontSize.${role}.increase`)}
              disabled={fontSize >= max}
              onClick={() => { setFontSize(fontSize + 1) }}
            >
              <IconChevronUpOutlineRegular size={9} />
            </button>
            <button
              type="button"
              className={css.arrow}
              aria-label={t(`fontSize.${role}.decrease`)}
              disabled={fontSize <= min}
              onClick={() => { setFontSize(fontSize - 1) }}
            >
              <IconChevronDownOutlineRegular size={9} />
            </button>
          </span>
        </div>
        <span className={css.unit}>{t('fontSize.unit')}</span>
        {expander !== undefined && (
          <button
            type="button"
            className={css.expander}
            aria-label={t('fontSize.more')}
            title={t('fontSize.more')}
            aria-expanded={expander.open}
            aria-controls={expander.controls}
            onClick={expander.onToggle}
          >
            <IconChevronDownOutlineRegular size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
