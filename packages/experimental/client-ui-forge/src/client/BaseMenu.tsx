/** Base branch picker of the local changes view's `branch` scope: the automatic fork point, then remote-tracking and local branches. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconSearchOutlineRegular,
  IconWarningTriangleOutlineRegular, Input, Menu, MenuItemButton, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeBaseBranch, ForgeBaseBranches } from '../types.ts'
import type { NS } from './locales.ts'
import { searchFieldKeyDown } from './menu-search.ts'
import css from './BaseMenu.module.css'

/** Milliseconds between the last keystroke of a search and the listing it reads. */
const SEARCH_DELAY_MS = 150

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
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [listing, setListing] = useState<RemoteResult<ForgeBaseBranches> | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const shown = visible && open
  useEffect(() => {
    if (!shown) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void list(query, controller.signal).then((result) => { if (!controller.signal.aborted) setListing(result) })
    }, query === '' ? 0 : SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [shown, query, attempt, list])
  // The portalled menu measures itself hidden before its first frame, and a hidden field cannot take the keyboard.
  // A touch screen keeps its on-screen keyboard closed until the field is tapped.
  useEffect(() => {
    if (!shown || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)) return
    const frame = requestAnimationFrame(() => { search.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [shown])
  const close = (): void => {
    setOpen(false)
    setQuery('')
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
  const first = groups[0]?.options[0]

  let body: ReactNode
  if (listing === null) {
    body = <div className={css.status} role="status"><StateDot state="ongoing" />{t('diff.base.loading')}</div>
  } else if (!listing.ok) {
    body = (
      <div className={css.status} role="status">
        <span>{t('toast.branchesFailed')}</span>
        <Button size="sm" variant="outline" onClick={() => { setAttempt(count => count + 1) }}>{t('retry')}</Button>
      </div>
    )
  } else if (groups.length === 0) {
    body = <div className={css.status}>{t('diff.base.empty')}</div>
  } else {
    body = groups.map(group => (
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
  }

  return (
    <Menu
      open={shown}
      portal
      dense
      align="start"
      className={css.anchor}
      listClassName={css.menu}
      onClose={close}
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
        <div className={css.search}>
          <Input ref={search} className={clsx(css.searchInput)} icon={<IconSearchOutlineRegular size={14} />} value={query}
            aria-label={t('diff.base.search')} placeholder={t('diff.base.search')}
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => { searchFieldKeyDown(event, first === undefined ? undefined : () => { pick(first.base) }) }} />
        </div>
        <div className={css.rows}>{body}</div>
        <div className={css.note}>{t('diff.base.note')}</div>
      </div>
    </Menu>
  )
}
