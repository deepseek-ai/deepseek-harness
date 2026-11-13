/** The existing task rule menu treatment shared by target and timing fields. */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
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
  // A row groups zones that share one label. The zone saved is the one the query
  // names, by the same matching that kept the row; the row's own id wins only
  // while the query names it or names no zone at all. The label answers query
  // terms that name no zone, such as a localized city name.
  const rowIndex = useMemo(() => new TextSearchIndex(
    catalog.map(item => ({ item, zones: new TextSearchIndex(item.zones, zone => ({ fuzzy: [zone, item.label] })) })),
    ({ item }) => ({ fuzzy: [...item.zones, item.label] }),
  ), [catalog])
  const searching = query.trim() !== ''
  const matches = rowIndex.search(query).map(({ item, zones }) => {
    if (!searching) return item
    const named = zones.search(query)
    return { ...item, id: named.includes(item.id) ? item.id : named[0] ?? item.id }
  })
  const recentItems = !searching ? recent.flatMap((zone) => {
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
