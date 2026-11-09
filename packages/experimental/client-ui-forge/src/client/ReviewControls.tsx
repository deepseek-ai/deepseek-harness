/**
 * Review controls of the changes toolbar: the lens that keeps the files of one review layer, as a full-width
 * radio group above the file tree or as a menu where no tree shows; the switch that hides test files; and the
 * share of shown files the reader marked viewed.
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

/**
 * Render the lens as a radio group whose segments share its width; arrow keys, Home, and End move between enabled lenses.
 * @param props - the lens, its counts, whether test files hide, the choose action, and copy.
 * @returns the radio group.
 */
export function LensControl({ lens, counts, hideTests, choose, t }: LensProps): ReactNode {
  const group = useRef<HTMLDivElement>(null)
  const enabled = LENSES.filter(item => item !== 'test' || !hideTests)
  const move = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = enabled.indexOf(lens)
    let next: ChangesLens | undefined
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowUp': next = enabled[(at + enabled.length - 1) % enabled.length]; break
      case 'ArrowRight': case 'ArrowDown': next = enabled[(at + 1) % enabled.length]; break
      case 'Home': next = enabled[0]; break
      case 'End': next = enabled.at(-1); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    /* v8 ignore next -- at most the test lens is disabled, so every key lands on an enabled lens */
    if (next === undefined) return
    choose(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-forge-lens="${next}"]`)?.focus()
  }
  return (
    <div ref={group} role="radiogroup" aria-label={t('lens.aria')} className={css.lens}>
      {LENSES.map((item) => {
        const disabled = item === 'test' && hideTests
        const button = (
          <button key={item} type="button" role="radio" className={css.segment} aria-checked={lens === item} disabled={disabled}
            tabIndex={lens === item ? 0 : -1} data-forge-lens={item} onKeyDown={move} onClick={() => { choose(item) }}>
            <span className={css.segmentLabel}>{t(LENS_LABEL[item])}</span>
            <span className={css.count}>{disabled ? '' : counts[item]}</span>
          </button>
        )
        return disabled ? <Tooltip key={item} label={t('lens.testHidden')} side="bottom">{button}</Tooltip> : button
      })}
    </div>
  )
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

/**
 * Render how many of the shown files the reader marked viewed, as a count and a bar.
 * @param props - the viewed and shown file counts, and copy.
 * @returns the progress, or nothing without shown files.
 */
export function ViewedProgress({ viewed, total, t }: PropsLocale<typeof NS> & {
  readonly viewed: number
  readonly total: number
}): ReactNode {
  if (total === 0) return null
  const label = t('viewed.progress', { viewed: String(viewed), total: String(total) })
  return (
    <span className={css.progress} role="progressbar" aria-label={t('viewed.progressAria')} aria-valuemin={0} aria-valuemax={total}
      aria-valuenow={viewed} aria-valuetext={label} data-forge-viewed-progress={`${viewed}/${total}`}>
      <span className={css.progressLabel}>{label}</span>
      <span className={css.bar} aria-hidden="true">
        <span className={css.fill} style={{ width: `${(viewed / total) * 100}%` }} />
      </span>
    </span>
  )
}
