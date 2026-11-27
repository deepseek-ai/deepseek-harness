/** Package-internal row presentation shared by component, data, and child menu entries. */
import { useId } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import type { MenuEntry, MenuItemButtonProps, MenuLabel, MenuSeparator } from './Menu.tsx'
import { IconCheckOutlineRegular, IconChevronRightOutlineRegular } from './icons/index.tsx'
import { ShortcutKeys } from './ShortcutKeys.tsx'
import { Tooltip } from './Tooltip.tsx'
import css from './Menu.module.css'

/** Optional props that also accept `undefined`, so data rows can forward absent `MenuItem` fields. */
type OptionalProps<T, K extends keyof T> = { [P in K]?: T[P] | undefined }

/** Package-internal row props: the `MenuItemButton` row fields plus data- and child-row presentation. */
type MenuRowProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>
  & Pick<MenuItemButtonProps, 'children'>
  & OptionalProps<MenuItemButtonProps, 'icon' | 'shortcut' | 'current' | 'disabledReason' | 'danger' | 'separatorBefore'>
  & {
    /** Whether this data row is the menu's current selection. */
    selected?: boolean
    /** Selection marker: a trailing check, or the row fill. */
    selection?: 'check' | 'fill'
    /** Keep an empty icon column so grouped rows stay aligned. */
    reserveIcon?: boolean
    /** Hide the icon from assistive technology; component rows keep it exposed. */
    decorativeIcon?: boolean
    /** Pointer handlers on the row wrapper, used by submenu parents. */
    wrapperProps?: HTMLAttributes<HTMLDivElement> | undefined
  }

/** Render a focus-stable row with optional selection, shortcut, and disabled explanation.
 * @param props - row content, native button events, and optional pointer wrapper events.
 * @returns one menu item; explained disabled rows remain focusable but never activate.
 */
export function MenuRow({ children, icon, shortcut, current, disabled = false, disabledReason, danger,
  separatorBefore, selected, selection = 'check', reserveIcon, decorativeIcon = true, wrapperProps, ...button }: MenuRowProps) {
  const reasonId = useId()
  const explained = disabled && disabledReason !== undefined
  // Tooltip remains mounted when the explanation changes, preserving button focus.
  return <div {...wrapperProps} className={css.itemWrap}>
    {separatorBefore && <div className={css.separator} role="separator" />}
    <Tooltip label={disabledReason ?? ''} disabled={!explained} side="bottom" delayMs={500} maxWidth={300} portal>
      <button {...button} type="button" role="menuitem"
        className={clsx(css.item, selected && (selection === 'fill' ? css.selectedFill : css.selected), danger && css.danger)}
        disabled={disabled && !explained} aria-disabled={explained || undefined}
        aria-describedby={explained ? reasonId : undefined} aria-keyshortcuts={shortcut?.aria}
        aria-current={current === true ? 'page' : undefined} onClick={explained ? undefined : button.onClick}>
        {(icon !== undefined || reserveIcon) && <span aria-hidden={decorativeIcon || undefined} className={css.itemIcon}>{icon}</span>}
        <span className={css.itemLabel}>{children}</span>
        {shortcut !== undefined && <span aria-hidden="true" className={css.shortcut}><ShortcutKeys keys={shortcut.keys} className={css.shortcutKeys} /></span>}
        {selected && selection === 'check' && <IconCheckOutlineRegular className={css.check} />}
        {button['aria-haspopup'] === 'menu' && <IconChevronRightOutlineRegular aria-hidden="true" className={css.check} />}
      </button>
    </Tooltip>
    {explained && <span id={reasonId} hidden>{disabledReason}</span>}
  </div>
}

/** Mark icon columns within each separator-delimited data group.
 * @param entries - entries in one menu area.
 * @param contextual - whether to align grouped context-menu icons.
 * @returns entries that reserve a leading icon column.
 */
export function menuIconColumns(entries: readonly MenuEntry[], contextual: boolean): ReadonlySet<MenuEntry> {
  const aligned = new Set<MenuEntry>()
  if (!contextual) return aligned
  let group: MenuEntry[] = []
  const finish = (): void => {
    if (group.some(entry => !('type' in entry) && entry.icon !== undefined)) {
      for (const entry of group) aligned.add(entry)
    }
    group = []
  }
  for (const entry of entries) {
    if ('type' in entry && entry.type === 'separator') finish()
    else group.push(entry)
  }
  finish()
  return aligned
}

/** Render a separator or group heading outside the keyboard walk.
 * @param entry - non-interactive menu entry.
 * @returns the corresponding element.
 */
export function renderMenuDecoration(entry: MenuSeparator | MenuLabel): ReactNode {
  return entry.type === 'separator' ? <div key={entry.id} className={css.separator} role="separator" />
    : <div key={entry.id} className={css.label} role="presentation">{entry.text}</div>
}
