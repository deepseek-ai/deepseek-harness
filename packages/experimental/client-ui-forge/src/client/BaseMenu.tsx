/** Base branch picker of the local changes view's `branch` scope: the automatic fork point, then remote-tracking and local branches. */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
  IconWarningTriangleOutlineRegular, Menu, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeBaseBranch, ForgeBaseBranches } from '../types.ts'
import { branchSearchStatus, useBranchSearch } from './branch-search.tsx'
import type { NS } from './locales.ts'
import css from './BaseMenu.module.css'

/** Props of the base branch picker. */
export interface BaseMenuProps extends PropsLocale<typeof NS> {
  /** Chosen branch, or null for the automatic fork point. */
  readonly chosen: ForgeBaseBranch | null
  /** Name the trigger shows: the chosen branch, the automatic fork point, or the automatic choice's own name. */
  readonly label: string
  /** Whether the chosen branch no longer exists. */
  readonly missing: boolean
  /** Whether the owning tab is visible; a hidden tab keeps the menu closed. */
  readonly visible: boolean
  /** Read the branches whose names contain `query`; `signal` aborts the read. */
  readonly list: (query: string, signal: AbortSignal) => Promise<RemoteResult<ForgeBaseBranches>>
  /** Compare with a branch, or with the automatic fork point for null. */
  readonly choose: (base: ForgeBaseBranch | null) => void
}

/** One selectable row: a branch, or the automatic fork point. */
interface BaseOption {
  readonly key: string
  readonly name: string
  readonly base: ForgeBaseBranch | null
  readonly tag?: string
}

/**
 * Render the trigger and, while open, the searchable menu. Opening and each
 * search read the branches again; rows already shown follow the search at once
 * until the new listing arrives.
 * @param props - the choice, the trigger label, the listing read, the choose action, and copy.
 * @returns the trigger with its portalled menu.
 */
export function BaseMenu({ chosen, label, missing, visible, list, choose, t }: BaseMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const shown = visible && open
  const { query, setQuery, listing, retry, reset } = useBranchSearch(shown, list)
  const close = (): void => {
    setOpen(false)
    reset()
  }
  const pick = (base: ForgeBaseBranch | null): void => {
    close()
    if ((base?.ref ?? null) !== (chosen?.ref ?? null)) choose(base)
  }

  const value = listing?.ok === true ? listing.value : null
  const needle = query.trim().toLowerCase()
  const matches = (name: string): boolean => name.toLowerCase().includes(needle)
  const automatic = value?.automatic ?? null
  const groups: { readonly id: string; readonly label: string; readonly options: readonly BaseOption[] }[] = [
    {
      id: 'automatic',
      label: t('diff.base.automatic'),
      options: automatic === null || !matches(automatic.name) ? [] : [{
        key: 'automatic', name: automatic.name, base: null, tag: t(automatic.worktree ? 'diff.base.worktree' : 'diff.base.automatic'),
      }],
    },
    {
      id: 'remote',
      label: t('diff.base.remote'),
      // The automatic fork point of a code host's default branch is the same comparison as choosing that branch.
      options: (value?.remote ?? [])
        .filter(branch => matches(branch.name) && (automatic === null || automatic.worktree || branch.name !== automatic.name))
        .map(branch => ({ key: branch.ref, name: branch.name, base: branch })),
    },
    {
      id: 'local',
      label: t('diff.base.local'),
      options: (value?.local ?? []).filter(branch => matches(branch.name))
        .map(branch => ({ key: branch.ref, name: branch.name, base: branch })),
    },
  ].filter(group => group.options.length > 0)

  const body: ReactNode = branchSearchStatus({ listing, empty: groups.length === 0, retry, className: css.status, t })
    ?? groups.map(group => (
      <div key={group.id} role="group" aria-label={group.label}>
        {/* The automatic row's tag names it, so its group shows no heading. */}
        {group.id !== 'automatic' && <div className={css.label} role="presentation">{group.label}</div>}
        {group.options.map((option) => {
          const selected = (option.base?.ref ?? null) === (chosen?.ref ?? null)
          return (
            <MenuItemButton key={option.key} icon={<IconBranchOutlineRegular size={14} />} current={selected}
              onSelect={() => { pick(option.base) }}>
              <span className={css.option}>
                <span className={css.name}>{option.name}</span>
                {option.tag !== undefined && <span className={css.tag}>{option.tag}</span>}
                {selected && <IconCheckOutlineRegular size={14} className={css.check} />}
              </span>
            </MenuItemButton>
          )
        })}
      </div>
    ))

  return (
    <Menu
      open={shown}
      portal
      dense
      align="start"
      className={css.anchor}
      listClassName={css.menu}
      onClose={close}
      search={{ label: t('diff.base.search'), value: query, onChange: setQuery, skipAutoFocusOnTouch: true }}
      anchor={(
        <Tooltip label={t('diff.base.aria', { base: label })} side="bottom" portal delayMs={500}>
          <button type="button" className={clsx(css.trigger, missing && css.missing)} aria-haspopup="menu" aria-expanded={shown}
            aria-label={t('diff.base.aria', { base: label })} data-forge-base={chosen?.ref ?? ''}
            onClick={() => { if (shown) close(); else setOpen(true) }}>
            {missing && <IconWarningTriangleOutlineRegular size={12} className={css.warning} />}
            <span className={css.triggerName}>{label}</span>
            <IconChevronDownOutlineRegular size={12} />
          </button>
        </Tooltip>
      )}
    >
      <div className={css.root} data-forge-base-menu="">
        <div className={css.rows}>{body}</div>
        <div className={css.note}>{t('diff.base.note')}</div>
      </div>
    </Menu>
  )
}
