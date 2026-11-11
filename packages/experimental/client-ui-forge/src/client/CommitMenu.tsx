/**
 * Commit picker of the changes header: every commit, or one commit, or with Shift a run of consecutive commits of a
 * change request or of the local `branch` scope, listed oldest first like the code host's commit list. A run is
 * accepted only when each of its commits has the one listed before it as its first parent.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, Menu, MenuItemButton, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeCommitList } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { rangeStart } from '../commit-range.ts'
import type { ForgeCommitRange, ForgeLocalCommits } from '../types.ts'
import { formatAgo } from './format.ts'
import type { NS } from './locales.ts'
import css from './CommitMenu.module.css'

/** Characters of a commit object name the picker shows. */
const SHORT = 7

/** Props of the commit picker. */
export interface CommitMenuProps extends PropsLocale<typeof NS> {
  /** Commits shown, or null for all of them. */
  readonly chosen: ForgeCommitRange | null
  /** Whether the owning tab is visible; a hidden tab keeps the menu closed. */
  readonly visible: boolean
  /** Read the commits; null means the source cannot show single commits. `signal` aborts the read. */
  readonly list: (signal: AbortSignal) => Promise<RemoteResult<ForgeCommitList | ForgeLocalCommits | null>>
  /** Which commits a truncated list keeps: a change request lists its oldest ones, the local branch its newest ones. */
  readonly kept: 'oldest' | 'newest'
  /** Changes when the commits may have changed, such as a new head commit or a refresh; the commits are read once per value. */
  readonly version: string
  /** Show consecutive commits, or every commit for null. */
  readonly choose: (commits: ForgeCommitRange | null) => void
}

/**
 * Name the shown commits on the trigger.
 * @param chosen - the shown commits, or null for all of them.
 * @param t - forge panel copy.
 * @returns the label.
 */
export function commitsLabel(chosen: ForgeCommitRange | null, t: PropsLocale<typeof NS>['t']): string {
  if (chosen === null) return t('commits.all')
  if (chosen.from === chosen.to) return chosen.from.slice(0, SHORT)
  return t('commits.range', { from: chosen.from.slice(0, SHORT), to: chosen.to.slice(0, SHORT) })
}

/**
 * Render the trigger and, while open, the commit list. A click shows one commit; a Shift click shows the commits
 * from the last commit clicked without Shift to the clicked one.
 * @param props - the shown commits, the listing read, the choose action, and copy.
 * @returns the trigger with its portalled menu, or nothing when the source cannot show single commits.
 */
export function CommitMenu({ chosen, visible, list, kept, version, choose, t }: CommitMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [rejected, setRejected] = useState(false)
  const [listing, setListing] = useState<{
    readonly key: string
    readonly result: RemoteResult<ForgeCommitList | ForgeLocalCommits | null>
  } | null>(null)
  const shift = useRef(false)
  const anchor = useRef<string | null>(chosen?.from ?? null)
  const loaded = useRef<string | null>(null)
  const shown = visible && open
  const key = `${version}\n${String(attempt)}`
  const current = listing?.key === key ? listing.result : null
  // The list is read once per version, which also tells whether the source has commits to pick, and again on a retry.
  useEffect(() => {
    if (!visible || loaded.current === key) return
    const controller = new AbortController()
    void list(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      loaded.current = key
      setListing({ key, result })
    })
    return () => { controller.abort() }
  }, [visible, key, list])
  if (current?.ok === true && current.value === null) return null
  const commits = current?.ok === true && current.value !== null ? current.value : null
  const close = (): void => {
    setOpen(false)
    setRejected(false)
  }
  const pick = (sha: string | null): void => {
    if (sha === null || commits === null) {
      close()
      anchor.current = null
      if (chosen !== null) choose(null)
      return
    }
    const order = commits.commits.map(commit => commit.sha)
    const start = shift.current && anchor.current !== null && order.includes(anchor.current) ? anchor.current : sha
    const [from, to] = order.indexOf(start) <= order.indexOf(sha) ? [start, sha] : [sha, start]
    // Two ends cannot name a run that leaves the first-parent line, so the menu stays open and says why.
    if (rangeStart(commits.commits, { from, to }) === 'not-linear') {
      setRejected(true)
      return
    }
    close()
    if (!shift.current || start === sha) anchor.current = sha
    if (from !== chosen?.from || to !== chosen.to) choose({ from, to })
  }
  const inChosen = (index: number): boolean => {
    if (chosen === null || commits === null) return false
    const order = commits.commits.map(commit => commit.sha)
    return index >= order.indexOf(chosen.from) && index <= order.indexOf(chosen.to) && order.includes(chosen.from)
  }

  let body: ReactNode
  if (current === null) {
    body = <div className={css.status} role="status"><StateDot state="ongoing" />{t('commits.loading')}</div>
  } else if (!current.ok || commits === null) {
    body = (
      <div className={css.status} role="status">
        <span>{t('commits.failed')}</span>
        <Button size="sm" variant="outline" onClick={() => { setAttempt(count => count + 1) }}>{t('retry')}</Button>
      </div>
    )
  } else {
    const now = Date.now()
    body = <>
      <MenuItemButton current={chosen === null} onSelect={() => { pick(null) }}>
        <span className={css.option}>
          <span className={css.allTitle}>{t('commits.all')}</span>
          <span className={css.meta}>{t('commits.count', { count: commits.commits.length })}</span>
          {chosen === null && <IconCheckOutlineRegular size={14} className={css.check} />}
        </span>
      </MenuItemButton>
      {commits.commits.length > 0 && <div className={css.label} role="presentation">{t('commits.shiftHint')}</div>}
      {commits.commits.map((commit, index) => {
        const selected = inChosen(index)
        return (
          <MenuItemButton key={commit.sha} current={selected} onSelect={() => { pick(commit.sha) }}>
            <span className={css.option} data-forge-commit={commit.sha}>
              <span className={css.sha}>{commit.sha.slice(0, SHORT)}</span>
              <span className={css.title}>{commit.title}</span>
              <span className={css.meta}>{formatAgo(commit.authoredAt, now, t) ?? ''}</span>
              <span className={clsx(css.check, !selected && css.unchecked)}><IconCheckOutlineRegular size={14} /></span>
            </span>
          </MenuItemButton>
        )
      })}
      {commits.truncated && (
        <div className={css.note}>
          {t(kept === 'oldest' ? 'commits.truncatedOldest' : 'commits.truncatedNewest', { count: commits.commits.length })}
        </div>
      )}
    </>
  }

  const label = commitsLabel(chosen, t)
  return (
    <Menu
      open={shown}
      portal
      dense
      align="end"
      className={css.anchor}
      listClassName={css.menu}
      onClose={close}
      anchor={(
        <Tooltip label={t('commits.aria', { commits: label })} side="bottom" portal delayMs={500}>
          <button type="button" className={clsx(css.trigger, chosen !== null && css.chosen)} aria-haspopup="menu" aria-expanded={shown}
            aria-label={t('commits.aria', { commits: label })} data-forge-commits={chosen === null ? '' : `${chosen.from}..${chosen.to}`}
            onClick={() => { setOpen(value => !value); setRejected(false) }}>
            <span className={css.triggerName}>{label}</span>
            <IconChevronDownOutlineRegular size={12} />
          </button>
        </Tooltip>
      )}
    >
      {/* Rows report activation without the event, so the modifier is read while the click or key travels to them. */}
      <div className={css.rows} data-forge-commit-menu=""
        onClickCapture={(event) => { shift.current = event.shiftKey }}
        onKeyDownCapture={(event) => { shift.current = event.shiftKey }}>
        {body}
      </div>
      {rejected && <div className={css.rejected} role="status">{t('commits.notLinear')}</div>}
    </Menu>
  )
}
