/** A launcher row separates navigation from its independently focusable pin action. */
import clsx from 'clsx'
import {
  Button, IconPinFillRegular, IconPinOutlineRegular, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './EntryMenu.module.css'

interface EntryPickerRowProps {
  readonly label: string
  readonly pinned: boolean
  readonly pinLabel: string
  readonly pinAccessibleLabel: string
  /** Truncate the label to one line instead of wrapping it. */
  readonly singleLine: boolean
  readonly onOpen: () => void
  readonly onPin: () => void
}

/**
 * Render two sibling controls so pinning never opens the entry.
 * @param props - Entry label, pin state, localized action names and independent callbacks.
 * @returns A shared menu row with a trailing pin button.
 */
export function EntryPickerRow({
  label, pinned, pinLabel, pinAccessibleLabel, singleLine, onOpen, onPin,
}: EntryPickerRowProps) {
  return <div className={clsx(css.entryRow, singleLine && css.singleLine)}>
    <MenuItemButton onSelect={onOpen}>
      <span className={css.entryName}>
        <span className={css.entryTitle}>{label}</span>
      </span>
    </MenuItemButton>
    <span className={css.pinAnchor} data-pinned={pinned}>
      <Tooltip label={pinLabel} side="bottom" align="end" delayMs={500} portal>
        <Button size="sm" className={css.pinButton} role="menuitem" aria-label={pinAccessibleLabel}
          onClick={(event) => { event.stopPropagation(); onPin() }}>
          {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
        </Button>
      </Tooltip>
    </span>
  </div>
}
