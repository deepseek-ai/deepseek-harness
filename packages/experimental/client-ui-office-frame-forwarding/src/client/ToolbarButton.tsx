/** Compact command buttons of the native Office view. */
import type { ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconPauseOutlineRegular,
  IconPlayOutlineRegular, IconRefreshOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { OfficeKey } from './locales.ts'
import css from './Editor.module.css'

const icons = {
  play: IconPlayOutlineRegular, stop: IconCloseOutlineRegular, previous: IconChevronLeftOutlineRegular,
  next: IconChevronRightOutlineRegular, pause: IconPauseOutlineRegular, resume: IconPlayOutlineRegular,
  retry: IconRefreshOutlineRegular, reconnect: IconRefreshOutlineRegular,
} satisfies Partial<Record<OfficeKey, typeof IconPlayOutlineRegular>>
/** Commands available in the Office view's controls. */
export type OfficeAction = keyof typeof icons
const labeled = new Set<OfficeAction>(['play', 'stop', 'retry', 'reconnect'])

/**
 * Keep focus while invoking a command; tooltip anchors also work for disabled controls.
 * @param props - Command, localized name, command state, and activation callback.
 * @returns An accessible, compact command button with a portaled tooltip.
 */
export function ToolbarButton({ action, label, disabled, active, onClick }: {
  action: OfficeAction
  label: string
  disabled: boolean
  active?: boolean | undefined
  onClick: () => void
}): ReactNode {
  const Icon = icons[action], text = labeled.has(action)
  return (
    <Tooltip label={label} side="bottom" portal>
      <span className={css.toolAnchor}>
        <Button
          size="sm"
          variant="ghost"
          className={text ? css.toolButton : `${css.toolButton} ${css.iconButton}`}
          icon={<Icon size={16} />}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={onClick}
        >
          {text ? label : null}
        </Button>
      </span>
    </Tooltip>
  )
}
