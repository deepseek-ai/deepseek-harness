/**
 * Picker of the branch the local changes view shows: the Session's checked-out one, or another local or
 * remote-tracking branch, which is read in the worktree that has it checked out, else from its commits.
 */

import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeBaseBranch, ForgeBaseBranches } from '../types.ts'
import { branchSearchStatus } from './branch-search.tsx'
import { BranchPicker, useBranchPicker, type BranchPickerGroup } from './BranchPicker.tsx'
import type { ChangesHead } from './changes-store.ts'
import type { NS } from './locales.ts'
import css from './BaseMenu.module.css'

/** Props of the head picker. */
export interface HeadMenuProps extends PropsLocale<typeof NS> {
  /** Chosen branch, or null for the Session's own checkout. */
  readonly chosen: ChangesHead | null
  /** Name of the Session's own checkout: its branch, its commit while HEAD is detached, or Git's name for neither. */
  readonly own: string
  /** Whether the chosen branch no longer exists. */
  readonly missing: boolean
  /** Whether the owning tab is visible; a hidden tab keeps the menu closed. */
  readonly visible: boolean
  /** Read the branches, other than the Session's checked-out one, whose names contain `query`; `signal` aborts the read. */
  readonly list: (query: string, signal: AbortSignal) => Promise<RemoteResult<ForgeBaseBranches>>
  /** Show a branch, or the Session's own checkout for null. */
  readonly choose: (head: ChangesHead | null) => void
}

/**
 * Render the trigger and, while open, the searchable menu: the Session's own checkout, then local and remote-tracking
 * branches. A branch that a worktree has checked out carries a tag and names that worktree's directory for the pointer.
 * Opening and each search read the branches again; rows already shown follow the search at once until the new listing
 * arrives.
 * @param props - the choice, the own checkout's name, the listing read, the choose action, and copy.
 * @returns the trigger with its portalled menu.
 */
export function HeadMenu({ chosen, own, missing, visible, list, choose, t }: HeadMenuProps): ReactNode {
  const state = useBranchPicker(visible, list)
  const value = state.listing?.ok === true ? state.listing.value : null
  const needle = state.query.trim().toLowerCase()
  const matches = (name: string): boolean => name.toLowerCase().includes(needle)
  const options = (branches: readonly ForgeBaseBranch[]) => branches.filter(branch => matches(branch.name)).map(branch => ({
    key: branch.ref,
    name: branch.name,
    value: { ref: branch.ref, name: branch.name, worktree: branch.worktree ?? null },
    ...(branch.worktree === undefined ? {} : { tag: t('checkout.worktree'), title: branch.worktree }),
  }))
  const groups: BranchPickerGroup<ChangesHead | null>[] = [
    // The own row's tag names it, so its group shows no heading.
    { id: 'own', label: t('diff.head.own'), plain: true, options: matches(own) ? [{ key: '', name: own, value: null, tag: t('diff.head.own') }] : [] },
    // What a reader looks at is usually a local branch, so the local group comes before the remote one.
    { id: 'local', label: t('diff.base.local'), options: options(value?.local ?? []) },
    { id: 'remote', label: t('diff.base.remote'), options: options(value?.remote ?? []) },
  ].filter(group => group.options.length > 0)

  const name = chosen?.name ?? own
  return (
    <BranchPicker
      state={state} label={t('diff.head.aria', { head: name })} name={name} missing={missing} anchorClassName={css.headAnchor}
      triggerMark={{ 'data-forge-head': chosen?.ref ?? '' }} menuMark={{ 'data-forge-head-menu': '' }}
      searchLabel={t('diff.base.search')}
      status={branchSearchStatus({ listing: state.listing, empty: groups.length === 0, retry: state.retry, className: css.status, t })}
      groups={groups} chosen={chosen?.ref ?? ''} choose={choose} note={t('diff.head.note')}
    />
  )
}
