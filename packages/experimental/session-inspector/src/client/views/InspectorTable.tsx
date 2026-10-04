/** Virtualized raw-data table shared by Session log and Chat structure views. */

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from '@tanstack/react-virtual'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { InspectorTableHierarchy, inspectorRowCollapsed, type InspectorDisclosure, type InspectorRecord, type InspectorRow } from './table-model.ts'
import { inspectorPreview } from './format.ts'
import { inspectorJson } from './raw-json.ts'
import { InspectorDetails } from './InspectorDetails.tsx'
import { InspectorJsonTree, InspectorObjectTree } from './InspectorObjectTree.tsx'
import type { InspectorChatTarget, InspectorObjects, InspectorObjectReference } from './objects.ts'
import { InspectorTableLayout, INSPECTOR_ROW_HEIGHT, type InspectorRowAnchor } from './table-layout.ts'
import { InspectorTypeFilter } from './type-filter.ts'
import { TypeFilter } from './TypeFilter.tsx'
import css from './inspector.module.css'

/** Framework-bound row sources and Session pagination command. */
export interface InspectorInjected {
  readonly hooks: { readonly rows: ObservableSnapshot<readonly InspectorRow[]> }
  readonly keyedHooks: {
    readonly record: (key: string) => ObservableSnapshot<InspectorRecord | undefined> | undefined
  }
  /** Load the preceding page through the existing Session reference. */
  readonly loadOlder: () => Promise<void>
  /** @param key - Loaded row identity. @returns Current type without mounting a row subscription. */
  readonly typeOf: (key: string) => string | undefined
}

/** Inputs of either Inspector conversation view. */
export type InspectorTableProps = Pick<ConvViewProps, 'useSession'> & InjectFace<InspectorInjected>
  & PropsLocale<'session-inspector'> & {
    readonly title: string
    readonly flash: boolean
    readonly showTime: boolean
    readonly modeSelector?: ReactNode
    readonly objects?: InspectorObjects
    readonly navigation?: {
      readonly reveal: (target: InspectorChatTarget) => void
      readonly target: (key: string) => InspectorChatTarget | undefined
    }
    readonly pickedRow?: { readonly key: string } | undefined
    readonly notice?: string | undefined
  }

interface RowProps extends Pick<InspectorTableProps, 'useRecord' | 't' | 'flash' | 'showTime'> {
  readonly row: InspectorRow
  readonly selected: boolean
  readonly branch: boolean
  readonly collapsed: boolean
  readonly added: boolean
  readonly stickyLevel: number | undefined
  readonly pulse: number
  readonly context: boolean
  readonly select: (key: string) => void
  readonly toggle: (row: InspectorRow, element: HTMLTableRowElement) => void
}

interface ObjectHistory {
  readonly rootKey: string
  readonly rootLabel: string
  readonly references: readonly InspectorObjectReference[]
}

const DataRow = memo(function DataRow({ row, selected, branch, collapsed, added, stickyLevel, pulse,
  context, select, toggle, useRecord, flash, showTime, t }: RowProps) {
  const record = useRecord(row.key)
  const element = useRef<HTMLTableRowElement>(null)
  const previous = useRef(record)
  const previousPulse = useRef(0)
  useEffect(() => {
    const changed = previous.current !== record
    previous.current = record
    const navigated = pulse > 0 && previousPulse.current !== pulse
    previousPulse.current = pulse
    if ((!flash && !navigated) || (!changed && !added && !navigated) || element.current === null
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const color = getComputedStyle(element.current).getPropertyValue('--dsw-specific-bubble-highlight')
    const animation = element.current.animate([{ backgroundColor: color }, { backgroundColor: 'transparent' }], { duration: 700 })
    return () => { animation.cancel() }
  }, [record, added, flash, pulse])
  const summary = useMemo(() => (collapsed ? record?.collapsedSummary : undefined)
    ?? record?.summary ?? inspectorPreview(record?.value), [record, collapsed])
  return <tr ref={element} aria-selected={selected} data-inspector-context={context ? '' : undefined}
    title={context ? t('filter.context') : undefined}
    className={[selected && css.selected, stickyLevel !== undefined && css.sticky, context && css.contextRow].filter(Boolean).join(' ')}
    style={stickyLevel === undefined ? undefined : { top: (stickyLevel + 1) * INSPECTOR_ROW_HEIGHT, zIndex: 9 - stickyLevel }}>
    <td className={css.identity}><Tooltip label={record?.identity ?? ''} side="right" portal>
      <span className={css.identityText} tabIndex={0}>{record?.identity}</span>
    </Tooltip></td>
    <td style={{ paddingInlineStart: 8 + row.depth * 20 }}>
      {branch && <button type="button" className={css.disclosure} aria-label={collapsed ? t('table.expand') : t('table.collapse')}
        aria-expanded={!collapsed} onClick={() => {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- The clicked button belongs to this mounted row.
          toggle(row, element.current!)
        }}>{collapsed ? '▸' : '▾'}</button>}
      <button type="button" className={css.record} onClick={() => { select(row.key) }}>{record?.type}</button>
    </td>
    <td>{record?.location}</td>
    {showTime && <td>{record?.time === undefined ? '' : new Date(record.time).toISOString().slice(11, 23)}</td>}
    <td><button type="button" className={css.preview} onClick={() => { select(row.key) }}>{summary}</button></td>
  </tr>
})

/**
 * Render a paged hierarchy with stable virtual row keys and live JSON details.
 * @param props - Framework hooks, pagination, locale, and the view's highlight policy.
 * @returns Virtual table and selected raw data.
 */
export function InspectorTable({ title, flash, showTime, modeSelector, objects, navigation, pickedRow, notice,
  useRows, useRecord, useSession, loadOlder, typeOf, t }: InspectorTableProps) {
  const allRows = useRows(value => value)
  const hasMore = useSession(value => value.hasMore)
  const loading = useSession(value => value.loadingOlder)
  const openError = useSession(value => value.openError)
  const [failure, setFailure] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const record = useRecord(selected ?? '')
  const rowLabel = `${record?.type ?? ''} · ${record?.identity ?? selected}`
  const [objectHistory, setObjectHistory] = useState<ObjectHistory | null>(null)
  const objectTarget = objectHistory?.references.at(-1)
  const [reveal, setReveal] = useState<{ key: string; pulse: number } | null>(null)
  const appliedReveal = useRef<typeof reveal>(null)
  const appliedPick = useRef<typeof pickedRow>()
  const [disclosures, setDisclosures] = useState<ReadonlyMap<string, InspectorDisclosure>>(new Map())
  const [typeQuery, setTypeQuery] = useState('')
  const typeFilter = useMemo(() => new InspectorTypeFilter(typeQuery), [typeQuery])
  const filtered = useMemo(() => typeFilter.apply(allRows, typeOf), [allRows, typeOf, typeFilter])
  const suggestTypes = useCallback((query: string) => new InspectorTypeFilter(query).suggest(allRows, typeOf), [allRows, typeOf])
  const scroller = useRef<HTMLDivElement>(null)
  const followMode = useRef<'tail' | 'scroll' | 'manual'>('tail')
  const viewport = useRef({ offset: 0, height: 600 })
  const disclosureAnchor = useRef<InspectorRowAnchor>()
  const [spacingGeneration, resetSpacing] = useState(0)
  const toggle = useCallback((row: InspectorRow, element: HTMLTableRowElement) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Row disclosure runs only inside the mounted scrollport.
    const host = scroller.current!
    followMode.current = 'manual'
    disclosureAnchor.current = { key: row.key,
      top: element.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientTop }
    viewport.current = { offset: host.scrollTop, height: host.clientHeight }
    setDisclosures((previous) => {
      const next = new Map(previous)
      next.set(row.key, { state: row.disclosure, collapsed: !inspectorRowCollapsed(row, previous) })
      return next
    })
  }, [])
  const locateChat = useCallback((target: InspectorChatTarget | undefined) => {
    navigation?.reveal(target ?? {})
  }, [navigation])
  const select = useCallback((key: string) => {
    setSelected(key)
    setObjectHistory(null)
    const target = navigation?.target(key)
    locateChat(target)
  }, [navigation, locateChat])
  const revealRow = useCallback((key: string) => {
    const clearFilter = typeFilter.active && !filtered.rows.some(row => row.key === key)
    if (clearFilter) setTypeQuery('')
    followMode.current = 'scroll'
    setSelected(key)
    setDisclosures((previous) => {
      const next = new Map(previous)
      const byKey = new Map((clearFilter ? allRows : filtered.rows).map(row => [row.key, row]))
      let parent = byKey.get(key)?.parent
      while (parent !== undefined) {
        const row = byKey.get(parent)
        if (row === undefined) break
        next.set(parent, { state: row.disclosure, collapsed: false })
        parent = row.parent
      }
      return next
    })
    setReveal(previous => ({ key, pulse: (previous?.pulse ?? 0) + 1 }))
  }, [allRows, typeFilter, filtered.rows])
  const navigate = useCallback((reference: InspectorObjectReference) => {
    setObjectHistory(previous => ({
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Detail navigation is mounted only for a selected row.
      rootKey: previous?.rootKey ?? selected!,
      rootLabel: previous?.rootLabel ?? rowLabel,
      references: [...(previous?.references ?? []), reference],
    }))
    locateChat(reference.target)
    if (reference.rowKey !== undefined) revealRow(reference.rowKey)
  }, [revealRow, locateChat, selected, rowLabel])
  const backToObject = (index: number): void => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A breadcrumb is enabled only when a reference history exists.
    const history = objectHistory!
    const reference = history.references[index - 1]
    const key = index === 0 ? history.rootKey : reference?.rowKey
    const target = index === 0 ? navigation?.target(history.rootKey) : reference?.target
    setObjectHistory(index === 0 ? null : { ...history, references: history.references.slice(0, index) })
    if (key !== undefined) revealRow(key)
    locateChat(target)
  }
  useLayoutEffect(() => {
    if (pickedRow === undefined || appliedPick.current === pickedRow || !allRows.some(row => row.key === pickedRow.key)) return
    appliedPick.current = pickedRow
    setObjectHistory(null)
    revealRow(pickedRow.key)
  }, [pickedRow, allRows, revealRow])
  const hierarchy = useMemo(() => new InspectorTableHierarchy(filtered.rows, disclosures), [filtered.rows, disclosures])
  const rows = hierarchy.rows
  const committed = useRef<{ layout: InspectorTableLayout; disclosures: typeof disclosures; spacingGeneration: number }>()
  const layout = useMemo(() => new InspectorTableLayout(hierarchy,
    committed.current?.disclosures === disclosures && committed.current.spacingGeneration === spacingGeneration
      ? committed.current.layout : undefined, viewport.current, disclosureAnchor.current), [hierarchy, disclosures, spacingGeneration])
  const anchoredOffset = committed.current?.layout !== layout ? layout.scrollOffset : undefined
  const seen = useRef(new Map<string, number>())
  const initialized = useRef(false)
  const arrivals = useMemo(() => {
    const now = performance.now()
    const next = new Map(allRows.map(row => [row.key, seen.current.get(row.key) ?? (initialized.current ? now : -Infinity)]))
    if (allRows.length > 0) initialized.current = true
    seen.current = next
    return next
  }, [allRows])
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Virtualizer indexes are bounded by this layout's item count.
  const keyOf = useCallback((index: number) => layout.items[index]!.key, [layout])
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Virtualizer indexes are bounded by this layout's item count.
  const sizeOf = useCallback((index: number) => layout.items[index]!.size, [layout])
  const virtualRef = useRef<Virtualizer<HTMLDivElement, HTMLTableRowElement>>()
  const extractRange = useCallback((range: Range) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The enabled Virtualizer initializes its offset before range extraction.
    const offset = anchoredOffset ?? virtualRef.current!.scrollOffset!
    // Render the anchored viewport before the layout effect moves the scrollport.
    const visible = anchoredOffset === undefined ? range : { ...range,
      startIndex: Math.max(0, Math.floor(offset / INSPECTOR_ROW_HEIGHT) - 1),
      endIndex: Math.min(range.count - 1, Math.ceil((offset + viewport.current.height) / INSPECTOR_ROW_HEIGHT) - 1),
    }
    return [...new Set([...layout.stickyIndexesAtOffset(offset), ...defaultRangeExtractor(visible)])]
      .sort((left, right) => left - right)
  }, [layout, anchoredOffset])
  const virtual = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: layout.items.length, getScrollElement: () => scroller.current,
    estimateSize: sizeOf, getItemKey: keyOf, overscan: 12,
    initialRect: { width: 0, height: 600 },
    anchorTo: layout.scrollOffset !== undefined || followMode.current === 'manual' ? 'start' : 'end', scrollEndThreshold: 40,
    paddingStart: INSPECTOR_ROW_HEIGHT, scrollPaddingStart: INSPECTOR_ROW_HEIGHT, rangeExtractor: extractRange,
    paddingEnd: layout.bottomPadding,
  })
  virtualRef.current = virtual
  const viewportHeight = virtual.scrollRect?.height
  const applyTypeFilter = (query: string): void => {
    followMode.current = 'scroll'
    setTypeQuery(new InspectorTypeFilter(query).query)
    setDisclosures(new Map())
    resetSpacing(value => value + 1)
    setSelected(null); setObjectHistory(null); setReveal(null)
    virtual.scrollToOffset(0)
  }
  useLayoutEffect(() => {
    if (anchoredOffset !== undefined) virtual.scrollToOffset(anchoredOffset)
    else if (followMode.current === 'tail' && layout.bottomPadding === 0) virtual.scrollToEnd()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- This layout effect runs with the scrollport ref attached.
    viewport.current = { offset: scroller.current!.scrollTop, height: viewportHeight ?? 600 }
    disclosureAnchor.current = undefined
    committed.current = { layout, disclosures, spacingGeneration }
  }, [virtual, layout, disclosures, spacingGeneration, viewportHeight, anchoredOffset])
  useLayoutEffect(() => {
    if (reveal === null || appliedReveal.current === reveal) return
    const index = layout.items.findIndex(item => item.key === reveal.key)
    if (index === -1) return
    virtual.scrollToIndex(index, { align: 'center' })
    appliedReveal.current = reveal
  }, [layout, reveal, virtual])
  const items = virtual.getVirtualItems()
  // oxlint-disable-next-line typescript/no-non-null-assertion -- getVirtualItems initializes the enabled Virtualizer's scroll offset.
  const sticky = new Map(layout.stickyIndexesAtOffset(anchoredOffset ?? virtual.scrollOffset!)
    .map((index, level) => [index, level]))
  const lastItem = items.at(-1)
  const bottom = lastItem === undefined ? 0 : Math.max(0, virtual.getTotalSize() - lastItem.end)
  const detail = useMemo(() => inspectorJson(objects === undefined ? record?.value : undefined), [record, objects])
  const detailValue = objectTarget === undefined ? record?.value : objectTarget.read()
  const breadcrumbs = [objectHistory?.rootLabel ?? rowLabel,
    ...(objectHistory?.references.map(reference => `${t(`object.${reference.kind}`)} · ${reference.identity}`) ?? [])]
  const columns = showTime ? 5 : 4
  return <section className={css.root} aria-label={title}>
    <div className={css.toolbar}>
      <span>{modeSelector ?? title} · {typeFilter.active ? `${filtered.matches.size} / ${allRows.length}` : allRows.length}</span>
      {hasMore && <button type="button" disabled={loading} onClick={() => {
        followMode.current = 'scroll'
        setFailure(null)
        void loadOlder().catch((error: unknown) => { setFailure(String(error)) })
      }}>{loading ? t('table.loading') : t('table.older')}</button>}
      <button type="button" onClick={() => { followMode.current = 'tail'; resetSpacing(value => value + 1) }}>{t('table.latest')}</button>
    </div>
    {notice !== undefined && <div className={css.pickNotice} role="status">{notice}</div>}
    {(failure !== null || openError !== null) && <p role="alert">{failure ?? openError?.message}</p>}
    <div ref={scroller} className={css.scroller} onScroll={({ currentTarget }) => {
      viewport.current.offset = currentTarget.scrollTop
      if (followMode.current !== 'manual') {
        followMode.current = currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop <= 40 ? 'tail' : 'scroll'
      }
    }}>
      <table className={css.table} aria-label={title} aria-rowcount={rows.length + 1}>
        <thead><tr><th className={css.idColumn}>{t('table.id')}</th><th className={css.typeColumn}>
          <span className={css.typeHeader}>{t('table.type')}<TypeFilter value={typeQuery} suggest={suggestTypes} apply={applyTypeFilter} t={t} /></span>
        </th>
        <th className={css.locationColumn}>{t('table.location')}</th>
        {showTime && <th className={css.timeColumn}>{t('table.time')}</th>}<th>{t('table.data')}</th></tr></thead>
        <tbody>
          {items.map((item, position) => {
            const gap = item.start - (items[position - 1]?.end ?? INSPECTOR_ROW_HEIGHT)
            // oxlint-disable-next-line typescript/no-non-null-assertion -- The virtual item comes from this layout's count.
            const entry = layout.items[item.index]!
            // oxlint-disable-next-line typescript/no-non-null-assertion -- Every layout row belongs to the arrival map's allRows input.
            const arrival = arrivals.get(entry.row.key)!
            return <Fragment key={item.key}>
              {gap > 0 && <tr aria-hidden="true"><td colSpan={columns} style={{ height: gap, padding: 0 }} /></tr>}
              <DataRow row={entry.row} selected={entry.row.key === selected}
                context={typeFilter.active && !filtered.matches.has(entry.row.key)}
                branch={hierarchy.isBranch(entry.row.key)} collapsed={inspectorRowCollapsed(entry.row, disclosures)}
                stickyLevel={sticky.get(item.index)}
                pulse={reveal?.key === entry.row.key ? reveal.pulse : 0}
                added={performance.now() - arrival < 700}
                useRecord={useRecord} select={select} toggle={toggle} flash={flash} showTime={showTime} t={t} />
            </Fragment>
          })}
          {bottom > 0 && <tr aria-hidden="true" data-inspector-fold-space={layout.bottomPadding > 0 ? '' : undefined}>
            <td colSpan={columns} style={{ height: bottom, padding: 0 }} /></tr>}
        </tbody>
      </table>
      {rows.length === 0 && <p className={css.empty}>{t('table.empty')}</p>}
    </div>
    {selected !== null && <InspectorDetails failed={detail.failed}
      text={record === undefined ? t('table.removed') : detail.failed ? `${t('table.rawError')}\n${detail.text}` : detail.text}
      close={() => { setSelected(null); setObjectHistory(null) }} t={t}>
      {objects === undefined ? record === undefined || detail.failed ? undefined
        : <InspectorJsonTree key={selected} text={detail.text} t={t} /> : <>
        <nav className={css.objectBreadcrumbs} aria-label={t('object.navigation')}><ol>
          {breadcrumbs.map((label, index) => <li key={index}>
            {index > 0 && <span aria-hidden="true">›</span>}
            <button type="button" title={label} disabled={index === breadcrumbs.length - 1}
              aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
              onClick={() => { backToObject(index) }}>{label}</button>
          </li>)}
        </ol></nav>
        <InspectorObjectTree key={objectTarget?.id ?? selected} value={detailValue} objects={objects} navigate={navigate} t={t} />
      </>}
    </InspectorDetails>}
  </section>
}
