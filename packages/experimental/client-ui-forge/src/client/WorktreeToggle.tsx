/** New Session option: start the Session in a new worktree, on a chosen or generated branch, from a local or remote branch. */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular,
  IconSearchOutlineRegular, Input, Menu, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { branchLabel, LOCAL_REF_PREFIX, REMOTE_REF_PREFIX } from '../branch-name.ts'
import type { ForgeBaseBranch, ForgePanelState, ForgeWorktreeBases, ForgeWorktreeBlocker } from '../types.ts'
import { branchSearchStatus, useBranchSearch } from './branch-search.tsx'
import type { NS } from './locales.ts'
import { searchFieldKeyDown } from './menu-search.ts'
import type { PanelSnapshot } from './source.ts'
import { WorktreeNameDialog, type WorktreeRequestResult } from './WorktreeNameDialog.tsx'
import css from './WorktreeToggle.module.css'

/** Business face of the New Session option. */
export interface WorktreeToggleInjected {
  /** Panel snapshot of the Session; the renderer binds it as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /**
   * Request a worktree from a base on a branch name, replacing an open request.
   * @param from - full name of a local or remote-tracking base branch, or null for HEAD.
   * @param name - new branch name, or null for a generated one.
   * @returns the outcome; a failure other than a refused name is already reported.
   */
  readonly request: (from: string | null, name: string | null) => Promise<WorktreeRequestResult>
  /**
   * Withdraw the open request.
   * @returns whether the Host accepted it.
   */
  readonly cancel: () => Promise<boolean>
  /**
   * List the branches a worktree of the Session's checkout can start from whose names contain `query`.
   * @param query - search text; empty for every branch.
   * @param signal - aborts the read.
   * @returns the branches, or the failure the menu shows.
   */
  readonly bases: (query: string, signal: AbortSignal) => Promise<RemoteResult<ForgeWorktreeBases>>
}

/** Full props of the New Session option. */
export type WorktreeToggleProps = InjectFace<WorktreeToggleInjected> & PropsLocale<typeof NS>

type Translate = WorktreeToggleProps['t']

/** One selectable branch row: the branch, the remote it belongs to, and the tag that names a pinned row. */
interface BaseRow {
  readonly branch: ForgeBaseBranch
  readonly remote?: string
  readonly tag?: string
}

/** What the option says about a request's base. */
function baseTextOf(from: string | null, t: Translate): string {
  return from === null ? t('worktree.baseHead') : t('worktree.base', { branch: branchLabel(from) })
}

/** What the option says about a request that names its branch. */
function namedTipOf(name: string, from: string | null, t: Translate): string {
  return from === null ? t('worktree.namedTipHead', { name }) : t('worktree.namedTip', { name, branch: branchLabel(from) })
}

/** The full name of a request's base; earlier panels recorded local branches by their short names. */
function refOf(from: string | null): string | null {
  return from === null || from.startsWith('refs/') ? from : `${LOCAL_REF_PREFIX}${from}`
}

/** A branch name split into a remote's prefix and the rest; local branches have no prefix. */
function nameParts(branch: ForgeBaseBranch, remote: string | undefined): { readonly prefix: string; readonly rest: string } {
  return remote !== undefined && branch.ref.startsWith(REMOTE_REF_PREFIX)
    ? { prefix: `${remote}/`, rest: branch.name.slice(remote.length + 1) }
    : { prefix: '', rest: branch.name }
}

function BranchRows({ rows, chosen, pick }: {
  readonly rows: readonly BaseRow[]
  readonly chosen: string | null
  readonly pick: (ref: string) => void
}): ReactNode {
  return rows.map(({ branch, remote, tag }) => {
    const selected = branch.ref === chosen
    const parts = nameParts(branch, remote)
    return (
      <MenuItemButton key={branch.ref} icon={<IconBranchOutlineRegular size={14} />} current={selected}
        onSelect={() => { pick(branch.ref) }}>
        <span className={css.option} data-forge-worktree-base={branch.ref}>
          <span className={css.optionName}>
            {parts.prefix !== '' && <span className={css.remotePrefix}>{parts.prefix}</span>}
            {parts.rest}
          </span>
          {tag !== undefined && <span className={css.tag}>{tag}</span>}
          {selected && <IconCheckOutlineRegular size={14} className={css.check} />}
        </span>
      </MenuItemButton>
    )
  })
}

function WorktreeMenu({ from, name, held, bases, choose, nameBranch, t }: {
  readonly from: string | null
  readonly name: string | null
  /** Whether the worktree is being created, which freezes the request. */
  readonly held: boolean
  readonly bases: WorktreeToggleInjected['bases']
  readonly choose: (ref: string) => void
  readonly nameBranch: () => void
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const { query, setQuery, listing, retry, reset, field } = useBranchSearch(open, bases)
  const chosen = refOf(from)
  const close = (): void => {
    setOpen(false)
    reset()
  }
  const pick = (ref: string): void => {
    close()
    if (ref !== chosen) choose(ref)
  }
  const value = listing?.ok === true ? listing.value : null
  const needle = query.trim().toLowerCase()
  const matches = (branch: ForgeBaseBranch): boolean => branch.name.toLowerCase().includes(needle)
  const pinned: BaseRow[] = value === null ? [] : [
    ...value.current === null ? [] : [{ branch: value.current, tag: t('worktree.currentBranch') }],
    ...value.defaults.map(({ remote, ...branch }) => ({ branch, remote, tag: t('worktree.remoteDefault') })),
  ].filter(row => matches(row.branch))
  const local = (value?.local ?? []).filter(matches).map(branch => ({ branch }))
  const remotes = (value?.remotes ?? []).map(remote => ({
    ...remote, rows: remote.branches.filter(matches).map(branch => ({ branch, remote: remote.name })),
  }))
    .filter(remote => remote.rows.length > 0)
  const first = pinned[0] ?? local[0] ?? remotes[0]?.rows[0]

  const body: ReactNode = branchSearchStatus({ listing, empty: first === undefined, retry, className: css.status, t }) ?? <>
    {pinned.length > 0 && <div role="group" aria-label={t('worktree.pinned')}><BranchRows rows={pinned} chosen={chosen} pick={pick} /></div>}
    {local.length > 0 && (
      <div role="group" aria-label={t('diff.base.local')}>
        <div className={css.groupLabel} role="presentation">{t('diff.base.local')}</div>
        <BranchRows rows={local} chosen={chosen} pick={pick} />
      </div>
    )}
    {remotes.map(remote => (
      <div key={remote.name} role="group" aria-label={t('worktree.remoteGroup', { remote: remote.name })}>
        <div className={css.groupLabel} role="presentation">
          <span className={css.groupName}>{t('worktree.remoteGroup', { remote: remote.name })}</span>
          {remote.repository !== null && <span className={css.groupRepository}>{remote.repository}</span>}
        </div>
        <BranchRows rows={remote.rows} chosen={chosen} pick={pick} />
      </div>
    ))}
  </>

  const baseText = baseTextOf(from, t)
  const label = name === null ? baseText : namedTipOf(name, from, t)
  return (
    <Menu
      open={open}
      side="bottom"
      align="end"
      portal
      dense
      className={css.anchor}
      listClassName={css.menu}
      onClose={close}
      anchor={
        <Tooltip label={label} side="bottom" portal delayMs={500}>
          <button type="button" className={clsx(css.base, name !== null && css.named)} aria-haspopup="menu" aria-expanded={open} aria-label={label}
            data-forge-base-branch="" disabled={held} onClick={() => { if (open) close(); else setOpen(true) }}>
            {name === null
              ? <span className={css.baseLabel}>{baseText}</span>
              : <><span className={css.nameLabel}>{name}</span><span className={css.fromLabel}>{` · ${baseText}`}</span></>}
            <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, open && css.chevronOpen)} />
          </button>
        </Tooltip>
      }
    >
      <div className={css.menuRoot} data-forge-worktree-menu="">
        <div className={css.search}>
          <Input ref={field} className={clsx(css.searchInput)} icon={<IconSearchOutlineRegular size={14} />} value={query}
            aria-label={t('diff.base.search')} placeholder={t('diff.base.search')}
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => { searchFieldKeyDown(event, first === undefined ? undefined : () => { pick(first.branch.ref) }) }} />
        </div>
        <div className={css.rows}>{body}</div>
        <div className={css.footer}>
          <MenuItemButton icon={name === null ? <IconPlusOutlineRegular size={14} /> : <IconEditOutlineRegular size={14} />}
            onSelect={() => { close(); nameBranch() }}>
            <span className={css.option} data-forge-worktree-name-entry="">
              <span className={css.footerLabel}>{t(name === null ? 'worktree.name.add' : 'worktree.name.label')}</span>
              <span className={clsx(css.footerValue, name !== null && css.footerName)}>{name ?? t('worktree.name.auto')}</span>
            </span>
          </MenuItemButton>
        </div>
      </div>
    </Menu>
  )
}

/** What the option shows for a panel state, or undefined while it stays hidden. */
function optionOf(state: ForgePanelState | null): {
  readonly blocker: Exclude<ForgeWorktreeBlocker, 'not-git'> | null
  readonly current: string | null
  readonly commit: string | null
} | undefined {
  if (state === null || !state.worktree.editable) return undefined
  const blocker = state.worktree.blocker
  if (blocker === 'not-git') return undefined
  const checkout = state.checkout
  if (checkout.state !== 'ready') return undefined
  return { blocker, current: checkout.checkout.branch, commit: checkout.checkout.commit }
}

/**
 * Render the worktree option while the Session can still start in a worktree:
 * the current branch, or the base and branch name menu once requested, then the
 * checkbox. The menu searches local branches and each remote's branches and
 * opens the naming dialog. A blocked request keeps its selected base visible
 * without a menu; the checkbox only withdraws it. Branch details support
 * pointer, touch, and keyboard access. The request stays fixed while the
 * worktree is being created.
 * @param props - panel snapshot hook, request actions, the base listing, and copy.
 * @returns the option, or nothing outside a known Git checkout, once a turn started,
 * the request settled, or no worktree service is mounted.
 */
export function WorktreeToggle({ usePanel, request, cancel, bases, t }: WorktreeToggleProps): ReactNode {
  const state = usePanel(snapshot => snapshot.state)
  const [pending, setPending] = useState<boolean | null>(null)
  const [naming, setNaming] = useState(false)
  const option = optionOf(state)
  if (state === null || option === undefined) return null
  const held = state.worktree.creation !== null
  const requested = pending ?? state.worktree.request !== null
  const usable = option.blocker === null
  const disabled = held || pending !== null || (!usable && !requested)
  const currentRef = option.current === null ? null : `${LOCAL_REF_PREFIX}${option.current}`
  const current = option.current ?? (option.commit === null ? t('checkout.detached') : t('worktree.detachedTip', { commit: option.commit }))
  const from = state.worktree.request === null ? currentRef : state.worktree.request.from
  const name = state.worktree.request?.name ?? null
  const requestedText = name === null ? baseTextOf(from, t) : namedTipOf(name, from, t)
  const branchText = requested ? requestedText : current
  const branchTip = requested || option.current === null ? branchText : t('worktree.currentBranchTip', { branch: option.current })
  const change = (checked: boolean): void => {
    setPending(checked)
    void (checked ? request(currentRef, null) : cancel()).then(() => { setPending(null) })
  }
  return (
    <span className={css.root} data-forge-worktree="">
      {requested && usable ? (
        <WorktreeMenu from={from} name={name} held={held} bases={bases} t={t}
          choose={(ref) => { void request(ref, name) }} nameBranch={() => { setNaming(true) }} />
      ) : (
        <Tooltip label={branchTip} side="bottom" portal openOnClick>
          <button type="button" className={css.current} aria-label={branchTip}
            data-forge-current-branch={requested ? undefined : ''} data-forge-base-branch={requested ? '' : undefined}>
            <IconBranchOutlineRegular size={14} />
            <span className={css.baseLabel}>{branchText}</span>
          </button>
        </Tooltip>
      )}
      <Tooltip label={option.blocker === null ? t('worktree.hint') : t(`worktree.blocked.${option.blocker}`)} side="bottom" delayMs={500}>
        <label className={css.toggle} data-disabled={disabled ? '' : undefined}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={requested}
            disabled={disabled}
            onChange={(event) => { change(event.currentTarget.checked) }}
          />
          {t('worktree.label')}
        </label>
      </Tooltip>
      {naming && requested && (
        <WorktreeNameDialog mode="name" initial={name ?? state.worktree.namePrefix} prefix={state.worktree.namePrefix} from={from}
          named={name !== null} submit={next => request(from, next)} close={() => { setNaming(false) }} t={t} />
      )}
    </span>
  )
}
