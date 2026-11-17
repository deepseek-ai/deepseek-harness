/**
 * The fold control of a Session panel list: the list's last row, which shows
 * the rows the list holds back or folds them again. The plugin offers it as
 * the `conversation.session.panel.fold` Component Factory, so the lists of
 * every section fold through one control.
 */
import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slots.ts'

/**
 * Render the fold control as a panel row whose body is the button: a chevron
 * in the icon column, down while rows are held back and up once they all
 * show, and the label where the row names start.
 * @param props - whether the list shows every row, the copy for that state, and the toggle.
 * @returns the row.
 */
export function PanelFold({ expanded, label, name, onToggle }: FactoryComponentPropsOf<'conversation.session.panel.fold'>): ReactNode {
  return (
    <div data-session-panel-row="fold">
      <button type="button" data-row-part="body" aria-expanded={expanded} aria-label={name} onClick={onToggle}>
        <span data-row-part="icon" aria-hidden="true">
          {expanded ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />}
        </span>
        <span data-row-part="content">{label}</span>
      </button>
    </div>
  )
}
