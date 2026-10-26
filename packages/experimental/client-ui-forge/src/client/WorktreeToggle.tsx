/** New Session option: start the Session in a new worktree, from a chosen local branch. */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ForgeBranches, ForgePanelState } from '../types.ts'
import type { NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import css from './WorktreeToggle.module.css'

/** Business face of the New Session option. */
export interface WorktreeToggleInjected {
  /** Panel snapshot of the Session; the renderer binds it as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /**
   * Request a worktree from a base branch, replacing an open request.
   * @param from - base branch, or null for HEAD.
   * @returns whether the Host accepted it.
   */
  readonly request: (from: string | null) => Promise<boolean>
  /**
   * Withdraw the open request.
   * @returns whether the Host accepted it.
   */
  readonly cancel: () => Promise<boolean>
  /**
   * List the local branches of the Session's checkout.
   * @returns the branches, or undefined when they could not be read.
   */
  readonly branches: () => Promise<ForgeBranches | undefined>
}

/** Full props of the New Session option. */
export type WorktreeToggleProps = InjectFace<WorktreeToggleInjected> & PropsLocale<typeof NS>

type Translate = WorktreeToggleProps['t']

function BaseMenu({ base, held, branches, request, t }: {
  readonly base: string | null
  /** Whether the worktree is being created, which freezes the base. */
  readonly held: boolean
  readonly branches: WorktreeToggleInjected['branches']
  readonly request: WorktreeToggleInjected['request']
  readonly t: Translate
}): ReactNode {
  const [listed, setListed] = useState<ForgeBranches | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const show = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setLoading(true)
    void branches().then((result) => {
      setLoading(false)
      if (result === undefined) return
      setListed(result)
      setOpen(true)
    })
  }
  const items: MenuEntry[] = [
    { type: 'label', id: 'title', text: t('worktree.baseMenu') },
    ...(listed?.branches ?? []).map(name => ({
      id: name,
      label: name === listed?.current
        ? <span className={css.option}><span className={css.optionName}>{name}</span><span className={css.optionNote}>{t('worktree.currentBranch')}</span></span>
        : <span className={css.optionName}>{name}</span>,
    })),
  ]
  return (
    <Menu
      open={open}
      items={items}
      selectedId={base ?? undefined}
      onSelect={(id) => {
        setOpen(false)
        if (id !== base) void request(id)
      }}
      onClose={() => { setOpen(false) }}
      side="bottom"
      align="end"
      portal
      anchor={
        <button type="button" className={css.base} aria-haspopup="menu" aria-expanded={open} disabled={loading || held} onClick={show}>
          <span className={css.baseLabel}>{base === null ? t('worktree.baseHead') : t('worktree.base', { branch: base })}</span>
          <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, open && css.chevronOpen)} />
        </button>
      }
    />
  )
}

/** What the option shows for a panel state, or undefined while it stays hidden. */
function optionOf(state: ForgePanelState | null): { readonly usable: boolean; readonly current: string | null } | undefined {
  if (state === null || !state.worktree.editable) return undefined
  const checkout = state.checkout
  if (checkout.state === 'none') return { usable: false, current: null }
  if (checkout.state !== 'ready') return undefined
  return { usable: state.worktree.blocker === null, current: checkout.checkout.branch }
}

/**
 * Render the worktree option while the Session can still start in a worktree:
 * the base branch menu once requested, then the checkbox. When the checkout
 * cannot host a worktree, the tooltip gives the reason and the checkbox only
 * withdraws an open request. Both stay fixed while the worktree is being
 * created.
 * @param props - panel snapshot hook, request actions, and copy.
 * @returns the option, or nothing once a turn started, the request settled, or no worktree service is mounted.
 */
export function WorktreeToggle({ usePanel, request, cancel, branches, t }: WorktreeToggleProps): ReactNode {
  const state = usePanel(snapshot => snapshot.state)
  const [pending, setPending] = useState<boolean | null>(null)
  const option = optionOf(state)
  if (state === null || option === undefined) return null
  const held = state.worktree.creation !== null
  const requested = pending ?? state.worktree.request !== null
  const disabled = held || pending !== null || (!option.usable && !requested)
  const blocker = state.worktree.blocker ?? 'not-git'
  const change = (checked: boolean): void => {
    setPending(checked)
    void (checked ? request(option.current) : cancel()).then(() => { setPending(null) })
  }
  return (
    <span className={css.root} data-forge-worktree="">
      {requested && option.usable && (
        <BaseMenu base={state.worktree.request?.from ?? option.current} held={held} branches={branches} request={request} t={t} />
      )}
      <Tooltip label={option.usable ? t('worktree.hint') : t(`worktree.blocked.${blocker}`)} side="bottom" delayMs={500}>
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
    </span>
  )
}
