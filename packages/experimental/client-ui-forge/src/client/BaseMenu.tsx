/** Base branch picker of the local changes view's `branch` scope: the automatic fork point, then remote-tracking and local branches. */

import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeBaseBranch, ForgeBaseBranches } from '../types.ts'
import { branchSearchStatus } from './branch-search.tsx'
import { BranchPicker, useBranchPicker, type BranchPickerGroup } from './BranchPicker.tsx'
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
  /** What the comparison covers, under the rows. */
  readonly note: string
  /** Whether the owning tab is visible; a hidden tab keeps the menu closed. */
  readonly visible: boolean
  /** Read the branches whose names contain `query`; `signal` aborts the read. */
  readonly list: (query: string, signal: AbortSignal) => Promise<RemoteResult<ForgeBaseBranches>>
  /** Compare with a branch, or with the automatic fork point for null. */
  readonly choose: (base: ForgeBaseBranch | null) => void
}

/**
 * Render the trigger and, while open, the searchable menu. Opening and each
 * search read the branches again; rows already shown follow the search at once
 * until the new listing arrives.
 * @param props - the choice, the trigger label, the note, the listing read, the choose action, and copy.
 * @returns the trigger with its portalled menu.
 */
export function BaseMenu({ chosen, label, missing, note, visible, list, choose, t }: BaseMenuProps): ReactNode {
  const state = useBranchPicker(visible, list)
  const value = state.listing?.ok === true ? state.listing.value : null
  const needle = state.query.trim().toLowerCase()
  const matches = (name: string): boolean => name.toLowerCase().includes(needle)
  const automatic = value?.automatic ?? null
  const branchOption = (branch: ForgeBaseBranch) => ({ key: branch.ref, name: branch.name, value: branch })
  const groups: BranchPickerGroup<ForgeBaseBranch | null>[] = [
    {
      id: 'automatic',
      label: t('diff.base.automatic'),
      // The automatic row's tag names it, so its group shows no heading.
      plain: true,
      options: automatic === null || !matches(automatic.name) ? [] : [{
        key: '', name: automatic.name, value: null, tag: t(automatic.worktree ? 'diff.base.worktree' : 'diff.base.automatic'),
      }],
    },
    {
      id: 'remote',
      label: t('diff.base.remote'),
      // The automatic fork point of a code host's default branch is the same comparison as choosing that branch.
      options: (value?.remote ?? [])
        .filter(branch => matches(branch.name) && (automatic === null || automatic.worktree || branch.name !== automatic.name))
        .map(branchOption),
    },
    { id: 'local', label: t('diff.base.local'), options: (value?.local ?? []).filter(branch => matches(branch.name)).map(branchOption) },
  ].filter(group => group.options.length > 0)

  return (
    <BranchPicker
      state={state} label={t('diff.base.aria', { base: label })} name={label} missing={missing} anchorClassName={css.anchor}
      triggerMark={{ 'data-forge-base': chosen?.ref ?? '' }} menuMark={{ 'data-forge-base-menu': '' }}
      searchLabel={t('diff.base.search')}
      status={branchSearchStatus({ listing: state.listing, empty: groups.length === 0, retry: state.retry, className: css.status, t })}
      groups={groups} chosen={chosen?.ref ?? ''} choose={choose} note={note}
    />
  )
}
