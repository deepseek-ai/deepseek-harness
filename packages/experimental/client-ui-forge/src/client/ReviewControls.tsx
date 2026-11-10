/**
 * Review controls of the changes toolbar: the lens that keeps the files of one review layer, as a full-width
 * radio group above the file tree or as a menu where no tree shows; the switch that hides test files; and the
 * share of shown files the reader marked viewed. The thread list shares the segmented radio group.
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu, Switch, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesLens } from './changes-store.ts'
import type { ForgePanelKey, NS } from './locales.ts'
import css from './ReviewControls.module.css'

/** Lenses in display order. */
export const LENSES: readonly ChangesLens[] = ['all', 'interface', 'implementation', 'test']

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
 * move between enabled segments.
 * @param props - the segments, the chosen value, the choose action, and the group's localized accessible name.
 * @returns the radio group.
 */
export function SegmentedChoice<Value extends string>({ segments, value, choose, label }: {
  readonly segments: readonly Segment<Value>[]
  readonly value: Value
  readonly choose: (value: Value) => void
  readonly label: string
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
    <div ref={group} role="radiogroup" aria-label={label} className={css.segmented}>
      {segments.map((segment) => {
        const button = (
          <button key={segment.value} type="button" role="radio" className={css.segment} aria-checked={value === segment.value}
            disabled={segment.disabledTip !== null} tabIndex={value === segment.value ? 0 : -1} data-segment={segment.value}
            onKeyDown={move} onClick={() => { choose(segment.value) }}>
            <span className={css.segmentLabel}>{segment.label}</span>
            <span className={css.count}>{segment.count ?? ''}</span>
          </button>
        )
        return segment.disabledTip === null ? button : <Tooltip key={segment.value} label={segment.disabledTip} side="bottom">{button}</Tooltip>
      })}
    </div>
  )
}

/**
 * Render the lens as a radio group whose segments share its width.
 * @param props - the lens, its counts, whether test files hide, the choose action, and copy.
 * @returns the radio group.
 */
export function LensControl({ lens, counts, hideTests, choose, t }: LensProps): ReactNode {
  // A disabled lens shows no count, since hidden test files are not counted.
  return <SegmentedChoice label={t('lens.aria')} value={lens} choose={choose} segments={LENSES.map(item => item === 'test' && hideTests
    ? { value: item, label: t(LENS_LABEL[item]), count: null, disabledTip: t('lens.testHidden') }
    : { value: item, label: t(LENS_LABEL[item]), count: counts[item], disabledTip: null })} />
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
    <Tooltip label={t('tests.hideHint')} side="bottom">
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
