/** General Settings row for the Composer's busy-state Enter preference. */
import { useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BusyEnterBehavior } from '../contract/composer-submission.ts'
import type { ConversationKey } from '../locales.ts'
import css from './EnterBehaviorRow.module.css'

/** Registration-side preference face. */
export interface EnterBehaviorRowInjected {
  hooks: {
    /** Persisted busy-state preference bound as useBusyEnter. */
    busyEnter: SnapshotStore<BusyEnterBehavior>
  }
  /** Change the busy-state plain-Enter behavior. */
  setBusyEnter: (behavior: BusyEnterBehavior) => void
}

/** Full Settings-row props. */
export type EnterBehaviorRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<EnterBehaviorRowInjected>

const OPTIONS: readonly {
  id: BusyEnterBehavior
  label: ConversationKey
}[] = [
  { id: 'queue', label: 'settings.enter.queue' },
  { id: 'steer', label: 'settings.enter.steer' },
]

/**
 * Render the busy-state Enter behavior selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function EnterBehaviorRow({ useBusyEnter, setBusyEnter, t }: EnterBehaviorRowProps) {
  const behavior = useBusyEnter(value => value)
  const [open, setOpen] = useState(false)
  const selectedLabel = behavior === 'queue' ? 'settings.enter.queue' : 'settings.enter.steer'

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.enter.title')}</div>
        <div className={css.desc}>{t('settings.enter.description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={behavior}
        onSelect={(id) => {
          setOpen(false)
          setBusyEnter(id as BusyEnterBehavior)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {t(selectedLabel)}
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
