/** The existing task rule menu treatment shared by target and timing fields. */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TaskMenu } from './TaskMenu.tsx'
import type { TaskMenuEntry } from './TaskMenu.tsx'
import { zoneChoices, zoneName } from './schedule-format.ts'
import { loadRecentTimeZones, rememberTimeZone } from './recent-time-zones.ts'
import css from './TaskManagerPage.module.css'

/** A labelled menu row using the current task detail's trigger, portal, and keyboard behavior. */
export function RuleSelectRow({ label, value, current, items, disabled, onChange, onDismiss, header, listClassName }: {
  readonly label: string
  readonly value: string
  readonly current: string
  readonly items: readonly TaskMenuEntry[]
  readonly disabled: boolean
  readonly onChange: (value: string) => void
  readonly onDismiss?: () => void
  readonly header?: ReactNode
  readonly listClassName?: string | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const close = (): void => { setOpen(false); onDismiss?.() }
  return <TaskMenu className={css.ruleRowMenu} open={open && !disabled} onClose={close}
    items={items} selectedId={value} align="end" portal header={header} listClassName={listClassName}
    onSelect={(id) => { close(); onChange(id) }}
    anchor={<button type="button" className={css.ruleValue} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open && !disabled} onClick={() => { if (open) close(); else setOpen(true) }}>
      <span className={css.ruleLabel}>{label}</span>{' '}
      <span className={clsx(css.ruleValueFace, css.ruleControl)}><span className={css.ruleCurrent}>{current}</span>
        <IconChevronDownOutlineRegular /></span>
    </button>} />
}

/** The current task detail's searchable, localized zone menu with recent choices. */
export function RuleZoneRow({ value, disabled, onChange, t }: PropsLocale<'schedule.manager'> & {
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}): ReactNode {
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState(() => loadRecentTimeZones(systemZone))
  const id = useId()
  const catalog = useMemo(() => {
    const byLabel = new Map<string, { id: string; label: string; zones: string[] }>()
    const at = Date.now()
    for (const zone of zoneChoices(value, systemZone, at)) {
      const label = zoneName(zone, systemZone, t, at)
      const existing = byLabel.get(label)
      if (existing === undefined) byLabel.set(label, { id: zone, label, zones: [zone] })
      else { existing.zones.push(zone); if (zone === value) existing.id = zone }
    }
    return [...byLabel.values()]
  }, [value, systemZone, t])
  const normalized = query.trim().toLocaleLowerCase(t('time.locale'))
  const matches = catalog.filter(item => `${item.zones.join(' ')} ${item.label}`.toLocaleLowerCase(t('time.locale')).includes(normalized))
    .map(item => ({ ...item, id: item.zones.find(zone => zone.toLocaleLowerCase(t('time.locale')) === normalized) ?? item.id }))
  const recentItems = normalized === '' ? recent.flatMap((zone) => {
    const item = catalog.find(item => item.zones.includes(zone))
    return item === undefined ? [] : [{ ...item, id: zone }]
  }).filter((item, index, items) => items.findIndex(candidate => candidate.label === item.label) === index) : []
  const available = matches.filter(item => !recentItems.some(recent => recent.label === item.label))
  const items: readonly TaskMenuEntry[] = recentItems.length === 0 ? available : available.length === 0 ? recentItems
    : [...recentItems, { type: 'separator', id: `${id}-recent` }, ...available]
  return <RuleSelectRow label={t('timing.zone')} value={value} current={zoneName(value, systemZone, t)} disabled={disabled}
    onDismiss={() => { setQuery('') }}
    items={items.length === 0 ? [{ id: `${id}-empty`, label: t('timing.zoneNoResults'), disabled: true }] : items}
    listClassName={css.zoneMenu} header={<input className={css.zoneSearch} type="search" value={query} data-menu-field=""
      placeholder={t('timing.zoneSearch')} aria-label={t('timing.zoneSearch')} onChange={(event) => { setQuery(event.target.value) }} />}
    onChange={(zone) => { setQuery(''); setRecent(recent => rememberTimeZone(recent, zone)); onChange(zone) }} />
}
