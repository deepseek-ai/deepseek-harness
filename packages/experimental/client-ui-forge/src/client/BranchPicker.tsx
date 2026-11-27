/**
 * The frame the two branch pickers of the local changes header share: a trigger that names the choice, and a
 * searchable menu of grouped rows above a note.
 */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
  IconWarningTriangleOutlineRegular, Menu, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { useBranchSearch, type BranchSearch } from './branch-search.tsx'
import css from './BaseMenu.module.css'

/** One selectable row of a branch picker. */
export interface BranchPickerOption<T> {
  /** Identity among the rows, which also tells the chosen row. */
  readonly key: string
  /** Branch name the row shows. */
  readonly name: string
  /** What choosing the row picks. */
  readonly value: T
  /** A mark after the name, such as what makes the row the default. */
  readonly tag?: string
  /** Text for the pointer where the name alone does not say where the branch is. */
  readonly title?: string
}

/** Rows under one heading. */
export interface BranchPickerGroup<T> {
  readonly id: string
  /** Accessible name of the group, and its heading unless `plain`. */
  readonly label: string
  /** Whether the group shows no heading, as when its one row carries a tag that names it. */
  readonly plain?: boolean
  readonly options: readonly BranchPickerOption<T>[]
}

/** A data attribute a picker puts on its trigger or its menu, for tests and automation. */
export type PickerMark = Readonly<Record<`data-${string}`, string>>

/** Whether a picker's menu is open, with its search. */
export interface BranchPickerState<L> extends BranchSearch<L> {
  /** Whether the menu shows: the reader opened it and the owning tab is visible. */
  readonly shown: boolean
  /** Close the menu and clear its search. */
  readonly close: () => void
  /** Open the menu, or close it while it shows. */
  readonly toggle: () => void
}

/**
 * Keep a picker's menu and its search: opening and each search read the listing again, and a hidden tab keeps the
 * menu closed.
 * @param visible - whether the owning tab is visible.
 * @param list - reads the branches whose names contain the query; the signal aborts the read.
 * @returns the menu state and the search.
 */
export function useBranchPicker<L>(
  visible: boolean, list: (query: string, signal: AbortSignal) => Promise<RemoteResult<L>>,
): BranchPickerState<L> {
  const [open, setOpen] = useState(false)
  const shown = visible && open
  const search = useBranchSearch(shown, list)
  const close = (): void => {
    setOpen(false)
    search.reset()
  }
  return { ...search, shown, close, toggle: () => { if (shown) close(); else setOpen(true) } }
}

/** Props of the shared frame. */
export interface BranchPickerProps<T, L> {
  /** The menu state and search of {@link useBranchPicker}. */
  readonly state: BranchPickerState<L>
  /** Accessible name and tooltip of the trigger. */
  readonly label: string
  /** Name the trigger shows. */
  readonly name: string
  /** Whether the choice no longer exists. */
  readonly missing: boolean
  /** Class that sizes the trigger in the header. */
  readonly anchorClassName: string | undefined
  /** Attribute of the trigger. */
  readonly triggerMark: PickerMark
  /** Attribute of the menu's content. */
  readonly menuMark: PickerMark
  /** Placeholder and accessible name of the search field. */
  readonly searchLabel: string
  /** What replaces the rows: reading, a failed read, or nothing matching; null to show `groups`. */
  readonly status: ReactNode
  /** Groups with at least one row each. */
  readonly groups: readonly BranchPickerGroup<T>[]
  /** Key of the chosen row. */
  readonly chosen: string
  /** Choose a row other than the chosen one. */
  readonly choose: (value: T) => void
  /** What the rows compare or show, under them. */
  readonly note: string
}

/**
 * Render a branch picker: the trigger and, while open, the portalled menu.
 * @param props - the menu state, the trigger's texts, the rows with the chosen one, and the note.
 * @returns the trigger with its menu.
 */
export function BranchPicker<T, L>({
  state, label, name, missing, anchorClassName, triggerMark, menuMark, searchLabel, status, groups, chosen, choose, note,
}: BranchPickerProps<T, L>): ReactNode {
  const pick = (option: BranchPickerOption<T>): void => {
    state.close()
    if (option.key !== chosen) choose(option.value)
  }
  return (
    <Menu
      open={state.shown}
      portal
      dense
      align="start"
      className={anchorClassName}
      listClassName={css.menu}
      onClose={state.close}
      search={{ label: searchLabel, value: state.query, onChange: state.setQuery, skipAutoFocusOnTouch: true }}
      anchor={(
        <Tooltip label={label} side="bottom" portal delayMs={500}>
          <button type="button" className={clsx(css.trigger, missing && css.missing)} aria-haspopup="menu" aria-expanded={state.shown}
            aria-label={label} {...triggerMark} onClick={state.toggle}>
            {missing && <IconWarningTriangleOutlineRegular size={12} className={css.warning} />}
            <span className={css.triggerName}>{name}</span>
            <IconChevronDownOutlineRegular size={12} />
          </button>
        </Tooltip>
      )}
    >
      <div className={css.root} {...menuMark}>
        <div className={css.rows}>
          {status ?? groups.map(group => (
            <div key={group.id} role="group" aria-label={group.label}>
              {group.plain !== true && <div className={css.label} role="presentation">{group.label}</div>}
              {group.options.map((option) => {
                const selected = option.key === chosen
                return (
                  <MenuItemButton key={option.key} icon={<IconBranchOutlineRegular size={14} />} current={selected}
                    onSelect={() => { pick(option) }}>
                    <span className={css.option} title={option.title}>
                      <span className={css.name}>{option.name}</span>
                      {option.tag !== undefined && <span className={css.tag}>{option.tag}</span>}
                      {selected && <IconCheckOutlineRegular size={14} className={css.check} />}
                    </span>
                  </MenuItemButton>
                )
              })}
            </div>
          ))}
        </div>
        <div className={css.note}>{note}</div>
      </div>
    </Menu>
  )
}
