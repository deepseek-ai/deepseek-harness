/**
 * Font-family preference row rendered inside the font settings group, once
 * per font role: title + role description + a text field holding the
 * comma-separated family list. Blur or Enter normalizes and commits the list;
 * an empty field restores the built-in stack. The field shows the persisted
 * list and resets whenever that list changes.
 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { normalizeFontFamily, type FontRole } from '../theme-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontRowStore } from './settings-store.ts'
import rowCss from './FontSizeRow.module.css'
import css from './FontFamilyRow.module.css'

/** Injected business face: the row's font role and its write. */
export interface FontFamilyRowInjected {
  /** Font role this row edits. */
  role: FontRole
  /** Change this role's font list (normalized by the theme service). */
  setFontFamily: (value: string) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontFamilyRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontRowStore>>
  & PropsLocale<'settings.theme'> & FontFamilyRowInjected

/**
 * Render one font-family row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function FontFamilyRow({ t, role, setFontFamily, useStore }: FontFamilyRowComponentProps) {
  const value = useStore(s => s.fontFamilies[role])
  const title = t(`fontFamily.${role}.title`)
  const commit = (input: HTMLInputElement): void => {
    input.value = normalizeFontFamily(input.value)
    setFontFamily(input.value)
  }
  return (
    <div className={rowCss.row}>
      <div className={rowCss.rowText}>
        <div className={rowCss.title}>{title}</div>
        <div className={rowCss.desc}>{t(`fontFamily.${role}.description`)}</div>
      </div>
      <Input
        key={value}
        className={css.field as string}
        defaultValue={value}
        placeholder={t('fontFamily.placeholder')}
        aria-label={title}
        spellCheck={false}
        autoComplete="off"
        onBlur={(event) => { commit(event.currentTarget) }}
        maxLength={200}
        onKeyDown={(event) => {
          // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report composition only through keyCode 229.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </div>
  )
}
