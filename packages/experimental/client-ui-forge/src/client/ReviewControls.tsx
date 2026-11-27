/**
 * Review controls of the changes toolbar: the lens that keeps the files of one review layer, as a full-width
 * radio group above the file tree or as a menu where no tree shows; the switch that hides test files; and the
 * share of shown files the reader marked viewed. The thread list shares the segmented radio group.
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu, Switch, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ChangesLens } from './changes-store.ts'
import type { ForgePanelKey, NS } from './locales.ts'
import css from './ReviewControls.module.css'

/** Lenses in display order. */
export const LENSES: readonly ChangesLens[] = ['all', 'interface', 'implementation', 'test']

/**
 * Inert attribute for the measuring copies. React 18 forwards `inert` only as a string, and React 19
 * treats an empty string as false; a non-empty string sets the attribute under both. Typed `object`
 * because React 18's DOM types omit `inert` and React 19's declare it boolean.
 */
const INERT: object = { inert: 'inert' }

const LENS_LABEL: Record<ChangesLens, ForgePanelKey> = {
  all: 'lens.all',
  interface: 'lens.interface',
  implementation: 'lens.implementation',
  test: 'lens.test',
}

/** Props shared by both forms of the lens. */
export interface LensProps extends PropsLocale<typeof NS> {
  /** The lens shown. */
  readonly lens: ChangesLens
  /** Files each lens keeps among the files the switch leaves. */
  readonly counts: Readonly<Record<ChangesLens, number>>
  /** Whether test files hide, which disables the `test` lens. */
  readonly hideTests: boolean
  /** Show another lens. */
  readonly choose: (lens: ChangesLens) => void
}

/** One segment of a {@link SegmentedChoice}. */
export interface Segment<Value extends string> {
  /** Value the segment chooses. */
  readonly value: Value
  /** Localized label. */
  readonly label: string
  /** Count shown after the label, or null for none. */
  readonly count: number | null
  /** Localized hover text of a disabled segment, or null for an enabled one. */
  readonly disabledTip: string | null
}

/**
 * Render a radio group whose segments share its width, each with a count after its label; arrow keys, Home, and End
 * move between enabled segments. Segments are equally wide, or as wide as their labels with the rest shared equally.
 * Without shown counts, a segment keeps its count in its accessible name and its hover text.
 * @param props - the segments, the chosen value, the choose action, the group's localized accessible name, how segments
 * size, and whether counts show.
 * @returns the radio group.
 */
export function SegmentedChoice<Value extends string>({ segments, value, choose, label, sizing = 'equal', counted = true }: {
  readonly segments: readonly Segment<Value>[]
  readonly value: Value
  readonly choose: (value: Value) => void
  readonly label: string
  readonly sizing?: 'equal' | 'content'
  readonly counted?: boolean
}): ReactNode {
  const group = useRef<HTMLDivElement>(null)
  const enabled = segments.filter(segment => segment.disabledTip === null).map(segment => segment.value)
  const move = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = enabled.indexOf(value)
    let next: Value | undefined
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowUp': next = enabled[(at + enabled.length - 1) % enabled.length]; break
      case 'ArrowRight': case 'ArrowDown': next = enabled[(at + 1) % enabled.length]; break
      case 'Home': next = enabled[0]; break
      case 'End': next = enabled.at(-1); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    /* v8 ignore next -- every caller keeps a segment enabled, so every key lands on one */
    if (next === undefined) return
    choose(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-segment="${next}"]`)?.focus()
  }
  return (
    <div ref={group} role="radiogroup" aria-label={label} className={css.segmented} data-sizing={sizing}>
      {segments.map((segment) => {
        const button = (
          <button type="button" role="radio" className={css.segment} aria-checked={value === segment.value}
            disabled={segment.disabledTip !== null} tabIndex={value === segment.value ? 0 : -1} data-segment={segment.value}
            onKeyDown={move} onClick={() => { choose(segment.value) }}>
            <span className={css.segmentLabel}>{segment.label}</span>
            <span className={counted ? css.count : css.hiddenCount}>{segment.count ?? ''}</span>
          </button>
        )
        const tip = segment.disabledTip ?? (counted || segment.count === null ? null : `${segment.label} ${String(segment.count)}`)
        // Every segment keeps its Tooltip, disabled without hover text, so showing or hiding the counts keeps the
        // button mounted and the focus on it.
        return <Tooltip key={segment.value} label={tip ?? segment.label} side="bottom" delayMs={500} disabled={tip === null}>{button}</Tooltip>
      })}
    </div>
  )
}

/**
 * Render the lens above the file tree as a radio group whose segments are as wide as their labels. Counts show while
 * every segment fits whole beside its count; otherwise only labels show. The widths both forms need are measured on
 * hidden copies whenever the cell, the labels, the counts, or the fonts change, and `need` receives the width of the
 * cell that labels alone fill, which the file tree keeps as its least width.
 * @param props - the lens, its counts, whether test files hide, the choose action, copy, and the receiver of the
 * labels' width.
 * @returns the radio group with its hidden measures.
 */
export function LensControl({ lens, counts, hideTests, choose, t, need }: LensProps & {
  /** Receives the cell width, padding included, at which the labels fit without counts. */
  readonly need: (width: number) => void
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const withCounts = useRef<HTMLDivElement>(null)
  const labelsOnly = useRef<HTMLDivElement>(null)
  const [counted, setCounted] = useState(true)
  // A disabled lens shows no count, since hidden test files are not counted.
  const segments = LENSES.map((item): Segment<ChangesLens> => item === 'test' && hideTests
    ? { value: item, label: t(LENS_LABEL[item]), count: null, disabledTip: t('lens.testHidden') }
    : { value: item, label: t(LENS_LABEL[item]), count: counts[item], disabledTip: null })
  const key = JSON.stringify(segments.map(segment => [segment.label, segment.count]))
  const needRef = useRef(need)
  needRef.current = need
  useLayoutEffect(() => {
    const element = root.current
    const full = withCounts.current
    const bare = labelsOnly.current
    const cell = element?.parentElement
    /* v8 ignore next -- the refs are attached, inside a cell, before layout effects run */
    if (element === null || full === null || bare === null || cell === null || cell === undefined) return
    let live = true
    // Fractional widths: a segment row a fraction of a pixel short of its labels still cuts every label short.
    const width = (node: Element): number => node.getBoundingClientRect().width
    const measure = (): void => {
      const available = width(element)
      // A hidden cell, such as one below the tree's breakpoint or in a hidden tab, has no width to compare.
      if (!live || available === 0) return
      setCounted(width(full) <= available)
      needRef.current(Math.ceil(width(bare) + width(cell) - available))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const fonts = document.fonts
    fonts.addEventListener('loadingdone', measure)
    return () => {
      live = false
      observer.disconnect()
      fonts.removeEventListener('loadingdone', measure)
    }
  }, [key])
  return <div ref={root} className={css.lensFit}>
    <SegmentedChoice label={t('lens.aria')} value={lens} choose={choose} segments={segments} sizing="content" counted={counted} />
    <div className={css.measures} aria-hidden="true" {...INERT}>
      <div ref={withCounts}><SegmentedChoice label="" value={lens} choose={choose} segments={segments} sizing="content" /></div>
      <div ref={labelsOnly}><SegmentedChoice label="" value={lens} choose={choose} segments={segments} sizing="content" counted={false} /></div>
    </div>
  </div>
}

/**
 * Render the lens as a menu button, for a toolbar without the file tree beside it.
 * @param props - the lens, its counts, whether test files hide, the choose action, copy, and whether the owning tab is visible.
 * @returns the trigger with its portalled menu.
 */
export function LensMenu({ lens, counts, hideTests, choose, visible, t }: LensProps & { readonly visible: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = LENSES.map((item) => {
    // Like the segment, a disabled lens shows no count, since hidden test files are not counted.
    const disabled = item === 'test' && hideTests
    return {
      id: item,
      disabled,
      label: <span className={css.menuRow}><span>{t(LENS_LABEL[item])}</span><span className={css.count}>{disabled ? '' : counts[item]}</span></span>,
    }
  })
  return (
    <Menu open={visible && open} portal dense align="start" autoFocus selectedId={lens} items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        choose(id as ChangesLens)
      }}
      anchor={(
        <button type="button" className={css.trigger} aria-haspopup="menu" aria-expanded={visible && open}
          aria-label={t('lens.menuAria', { lens: t(LENS_LABEL[lens]) })} data-forge-lens-menu={lens}
          onClick={() => { setOpen(value => !value) }}>
          {t(LENS_LABEL[lens])}
          <IconChevronDownOutlineRegular size={12} />
        </button>
      )} />
  )
}

/**
 * Render the switch that hides test files, with its label beside it where the toolbar has room.
 * @param props - whether test files hide, the toggle action, and copy.
 * @returns the switch and its label.
 */
export function HideTestsSwitch({ hidden, toggle, t }: PropsLocale<typeof NS> & {
  readonly hidden: boolean
  readonly toggle: () => void
}): ReactNode {
  return (
    <Tooltip label={t('tests.hideHint')} side="bottom" delayMs={500}>
      {/* A label forwards a click on its text to the switch, its first labelable descendant. */}
      <label className={css.switch} data-forge-hide-tests="">
        <Switch checked={hidden} label={t('tests.hide')} onChange={toggle} />
        <span className={css.switchLabel} aria-hidden="true">{t('tests.hide')}</span>
      </label>
    </Tooltip>
  )
}

/** Radius of the progress ring, inside its 14px box with a 2px stroke. */
const RING_RADIUS = 5.5

/**
 * Render how many of the shown files the reader marked viewed: a ring filled to the viewed share, then a label, or the
 * bare count that a narrow toolbar shows instead (`data-forge-progress` names each form for the toolbar's styles).
 * @param props - the viewed and shown file counts, and copy.
 * @returns the progress, or nothing without shown files.
 */
export function ViewedProgress({ viewed, total, t }: PropsLocale<typeof NS> & {
  readonly viewed: number
  readonly total: number
}): ReactNode {
  if (total === 0) return null
  const counts = { viewed: String(viewed), total: String(total) }
  const label = t('viewed.progress', counts)
  const circumference = 2 * Math.PI * RING_RADIUS
  return (
    <span className={css.progress} role="progressbar" aria-label={t('viewed.progressAria')} aria-valuemin={0} aria-valuemax={total}
      aria-valuenow={viewed} aria-valuetext={label} data-forge-viewed-progress={`${viewed}/${total}`}>
      <svg className={css.ring} viewBox="0 0 14 14" aria-hidden="true">
        <circle className={css.ringTrack} cx="7" cy="7" r={RING_RADIUS} />
        <circle className={css.ringFill} cx="7" cy="7" r={RING_RADIUS}
          strokeDasharray={`${(viewed / total) * circumference} ${circumference}`} />
      </svg>
      <span className={css.progressForm} data-forge-progress="full">{label}</span>
      <span className={css.progressForm} data-forge-progress="compact">{t('viewed.count', counts)}</span>
    </span>
  )
}
