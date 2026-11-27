/** Menu search input with a leading magnifier and an optional clear button. */
import type { ComponentPropsWithoutRef, Ref } from 'react'
import clsx from 'clsx'
import { IconCloseFillRegular, IconSearchOutlineRegular } from './icons/index.tsx'
import css from './SearchField.module.css'

/**
 * Render a controlled search input.
 * @param props - localized labels, input value and attributes, and optional clear button.
 * @returns the search control with refs to its wrapper and native input.
 */
export function SearchField({ inputRef, rootRef, className, placeholder, value, onChange, clearLabel, onClear, ...input }: {
  inputRef?: Ref<HTMLInputElement>
  rootRef?: Ref<HTMLDivElement>
  className?: string | undefined
  placeholder: string
  value: string
  onChange: (value: string) => void
  clearLabel?: string | undefined
  onClear: () => void
} & Pick<ComponentPropsWithoutRef<'input'>, 'aria-label' | 'role'>) {
  return (
    <div ref={rootRef} data-search-field="" className={clsx(css.field, className)}>
      <span className={css.leading} aria-hidden="true"><IconSearchOutlineRegular size={14} /></span>
      <input {...input} ref={inputRef} className={css.input} type="text" placeholder={placeholder} value={value}
        onChange={(event) => { onChange(event.currentTarget.value) }} />
      {clearLabel !== undefined && (
        <button type="button" className={css.clear} aria-label={clearLabel} onClick={(event) => {
          event.stopPropagation()
          onClear()
        }}>
          <IconCloseFillRegular />
        </button>
      )}
    </div>
  )
}
