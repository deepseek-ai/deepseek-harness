/**
 * Picker of what the local changes view shows: the Session's own checkout, the checkout of a Session delegated from
 * it, or the committed content of another branch.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
  IconWarningTriangleOutlineRegular, Menu, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TextSearchIndex, type SearchKeys } from '@deepseek-ai/dsh-util-text-search'
import type { ForgeBaseBranch, ForgeBaseBranches, ForgeRelatedCheckout } from '../types.ts'
import { branchSearchStatus, useBranchSearch } from './branch-search.tsx'
import type { ChangesHead } from './changes-store.ts'
import type { NS } from './locales.ts'
import css from './BaseMenu.module.css'

/** Props of the head picker. */
export interface HeadMenuProps extends PropsLocale<typeof NS> {
  /** Chosen head, or null for the Session's own checkout. */
  readonly chosen: ChangesHead | null
  /** Branch of the Session's own checkout, or its commit while HEAD is detached. */
  readonly own: string
  /** Whether the chosen head is gone. */
  readonly missing: boolean
  /** Whether the owning tab is visible; a hidden tab keeps the menu closed. */
  readonly visible: boolean
  /** Read the checkouts that related Sessions work in; `signal` aborts the read. */
  readonly related: (signal: AbortSignal) => Promise<RemoteResult<readonly ForgeRelatedCheckout[]>>
  /** Read the branches, other than the Session's checked-out one, whose names contain `query`; `signal` aborts the read. */
  readonly list: (query: string, signal: AbortSignal) => Promise<RemoteResult<ForgeBaseBranches>>
  /** Show a head, or the Session's own checkout for null. */
  readonly choose: (head: ChangesHead | null) => void
}

/** One selectable row. */
interface HeadOption {
  readonly key: string
  readonly name: string
  readonly head: ChangesHead | null
  /** Marks the Session's own checkout. */
  readonly tag?: string
  /** What the Sessions working in a related checkout do. */
  readonly who?: string
  /** Full text of a row whose name alone does not identify it, for the pointer. */
  readonly title?: string
}

/** The name a related checkout shows: its branch, or its commit while HEAD is detached. */
function relatedName(checkout: ForgeRelatedCheckout): string {
  return checkout.branch ?? checkout.commit ?? 'HEAD'
}

/** A related checkout is found by its branch, and by what its Sessions do and where it lies as plain text. */
function relatedSearchKeys(checkout: ForgeRelatedCheckout): SearchKeys {
  return { fuzzy: [relatedName(checkout)], substring: [...checkout.labels, checkout.root] }
}

/** Identity of a head among the rows; null is the Session's own checkout. */
function keyOf(head: ChangesHead | null): string {
  return head === null ? 'own' : head.kind === 'branch' ? `branch:${head.ref}` : `session:${head.sessionId}`
}

/**
 * Render the trigger and, while open, the searchable menu. Opening reads the related checkouts once; opening and each
 * search read the branches again, and rows already shown follow the search at once until the new listing arrives. A
 * branch that the Session or a related Session has checked out shows only as that checkout.
 * @param props - the choice, the own checkout's name, the two reads, the choose action, and copy.
 * @returns the trigger with its portalled menu.
 */
export function HeadMenu({ chosen, own, missing, visible, related, list, choose, t }: HeadMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const shown = visible && open
  const { query, setQuery, listing, retry, reset } = useBranchSearch(shown, list)
  const [attempt, setAttempt] = useState(0)
  const [checkouts, setCheckouts] = useState<RemoteResult<readonly ForgeRelatedCheckout[]> | null>(null)
  useEffect(() => {
    if (!shown) return
    const controller = new AbortController()
    void related(controller.signal).then((result) => { if (!controller.signal.aborted) setCheckouts(result) })
    return () => { controller.abort() }
  }, [shown, related, attempt])
  const retryBoth = useCallback(() => {
    retry()
    setAttempt(count => count + 1)
  }, [retry])
  const close = (): void => {
    setOpen(false)
    reset()
  }
  const pick = (head: ChangesHead | null): void => {
    close()
    if (keyOf(head) !== keyOf(chosen)) choose(head)
  }

  const listed = checkouts?.ok === true ? checkouts.value : null
  const index = useMemo(() => new TextSearchIndex(listed ?? [], relatedSearchKeys), [listed])
  const branches = listing?.ok === true ? listing.value : null
  const needle = query.trim().toLowerCase()
  const matches = (name: string): boolean => name.toLowerCase().includes(needle)
  // The related checkouts name their branches, so the branch groups wait for them rather than list a branch twice.
  const taken = new Set((listed ?? []).map(checkout => checkout.branch))
  const branchOptions = (group: readonly ForgeBaseBranch[], local: boolean): HeadOption[] => listed === null ? []
    : group.filter(branch => matches(branch.name) && !(local && taken.has(branch.name)))
      .map((branch): HeadOption => ({ key: `branch:${branch.ref}`, name: branch.name, head: { kind: 'branch', ref: branch.ref, name: branch.name } }))
  const groups: { readonly id: string; readonly label: string; readonly options: readonly HeadOption[] }[] = [
    { id: 'own', label: t('diff.head.own'), options: matches(own) ? [{ key: 'own', name: own, head: null, tag: t('diff.head.own') }] : [] },
    {
      id: 'related',
      label: t('diff.head.related'),
      options: index.search(query).map((checkout): HeadOption => {
        const name = relatedName(checkout)
        return {
          key: `session:${checkout.sessionId}`, name, who: checkout.labels.join(' · '), title: checkout.root,
          head: { kind: 'session', sessionId: checkout.sessionId, name, root: checkout.root },
        }
      }),
    },
    // What a reader looks at is usually a local branch, so the local group comes before the remote one.
    { id: 'local', label: t('diff.base.local'), options: branchOptions(branches?.local ?? [], true) },
    { id: 'remote', label: t('diff.base.remote'), options: branchOptions(branches?.remote ?? [], false) },
  ].filter(group => group.options.length > 0)

  // Either failed read offers the retry of both; rows show once both listings arrived.
  const failed = [checkouts, listing].find(result => result?.ok === false) ?? null
  const status = branchSearchStatus({
    listing: failed ?? (checkouts === null || listing === null ? null : listing), empty: false, retry: retryBoth, className: css.status, t,
  })
  const body: ReactNode = status ?? (groups.length === 0 ? <div className={css.status} role="status">{t('diff.head.empty')}</div>
    : groups.map(group => (
      <div key={group.id} role="group" aria-label={group.label}>
        {/* The own row's tag names it, so its group shows no heading. */}
        {group.id !== 'own' && <div className={css.label} role="presentation">{group.label}</div>}
        {group.options.map((option) => {
          const selected = option.key === keyOf(chosen)
          return (
            <MenuItemButton key={option.key} icon={<IconBranchOutlineRegular size={14} />} current={selected}
              onSelect={() => { pick(option.head) }}>
              <span className={clsx(css.option, option.who !== undefined && css.related)} title={option.title}>
                <span className={css.name}>{option.name}</span>
                {option.tag !== undefined && <span className={css.tag}>{option.tag}</span>}
                {option.who !== undefined && <span className={css.who}>{option.who}</span>}
                {selected && <IconCheckOutlineRegular size={14} className={css.check} />}
              </span>
            </MenuItemButton>
          )
        })}
      </div>
    )))

  const label = chosen?.name ?? own
  return (
    <Menu
      open={shown}
      portal
      dense
      align="start"
      className={css.headAnchor}
      listClassName={css.menu}
      onClose={close}
      search={{ label: t('diff.head.search'), value: query, onChange: setQuery, skipAutoFocusOnTouch: true }}
      anchor={(
        <Tooltip label={t('diff.head.aria', { head: label })} side="bottom" portal delayMs={500}>
          <button type="button" className={clsx(css.trigger, missing && css.missing)} aria-haspopup="menu" aria-expanded={shown}
            aria-label={t('diff.head.aria', { head: label })} data-forge-head={chosen === null ? '' : keyOf(chosen)}
            onClick={() => { if (shown) close(); else setOpen(true) }}>
            {missing && <IconWarningTriangleOutlineRegular size={12} className={css.warning} />}
            <span className={css.triggerName}>{label}</span>
            <IconChevronDownOutlineRegular size={12} />
          </button>
        </Tooltip>
      )}
    >
      <div className={css.root} data-forge-head-menu="">
        <div className={css.rows}>{body}</div>
        <div className={css.note}>{t('diff.head.note')}</div>
      </div>
    </Menu>
  )
}
