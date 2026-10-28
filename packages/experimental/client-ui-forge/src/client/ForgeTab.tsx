/** Body of the forge sidebar tab: where the Session works, its local changes, and the change requests it created or pushed. */

import { useEffect, useState, type ReactNode } from 'react'
import {
  Button, IconBranchOutlineRegular, IconCopyOutlineRegular, IconFolderCloseRegular, IconWarningTriangleOutlineRegular, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { MergeRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ForgePanelChangeRequest, ForgePanelState } from '../types.ts'
import { changesAddress, type ChangesSource } from './changes-address.ts'
import { ChangeRequestCard, type ChangeRequestActions } from './ChangeRequestCard.tsx'
import { checkoutLabel } from './checkout.ts'
import { LocalChangesCard } from './LocalChangesCard.tsx'
import type { NS } from './locales.ts'
import { RefreshGlyph } from './RefreshGlyph.tsx'
import type { PanelSnapshot } from './source.ts'
import { defaultExpanded, openChangeRequestOf } from './status.ts'
import css from './ForgeTab.module.css'

/** Business face of the tab body. */
export interface ForgeTabInjected {
  /** Panel snapshot of the Session and the Host facts; the renderer binds them as `usePanel` and `useHost`. */
  readonly hooks: {
    readonly panel: HostObservable<PanelSnapshot>
    readonly host: HostObservable<RemoteHostFacts>
    readonly locale: HostObservable<string>
  }
  /** Open the stream again after it ended. */
  readonly reconnect: () => void
  /**
   * Reinspect the checkout, probe sign-in, and poll the change requests;
   * settles once the Host has inspected and probed, after reporting a failure.
   */
  readonly refresh: () => Promise<void>
  /** Remove a change request from the Session, offering to undo it. */
  readonly remove: (entry: ForgePanelChangeRequest) => void
  /** Mark a draft ready for review; settles once the outcome is reported. */
  readonly markReady: (entry: ForgePanelChangeRequest) => Promise<void>
  /** Merge a change request as `request` describes; settles once the outcome is reported. */
  readonly merge: (entry: ForgePanelChangeRequest, request: MergeRequest) => Promise<void>
  /** Check the removed worktree of the Session out again, reporting the outcome. */
  readonly restore: () => void
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Copy text to the clipboard and report the outcome. */
  readonly copyText: (text: string) => void
  /** Copy a path to the clipboard and report the outcome. */
  readonly copyPath: (path: string) => void
  /** Record whether the tab is visible, for the header entry's pressed state. */
  readonly reportVisible: (visible: boolean) => void
  /** Ask the Session's Agent to create a change request for its changes, reporting the outcome. */
  readonly createChangeRequest: () => void
}

/** Full props of the tab body. */
export type ForgeTabProps =
  Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useTabInfo' | 'sessionId'>
  & InjectFace<ForgeTabInjected>
  & PropsLocale<typeof NS>

type Translate = ForgeTabProps['t']

function Checkout({ state, home, restore, copyPath, t }: {
  readonly state: ForgePanelState
  readonly home: string | undefined
  readonly restore: () => void
  readonly copyPath: (path: string) => void
  readonly t: Translate
}): ReactNode {
  const checkout = state.checkout
  const label = checkoutLabel(state, home, t)
  if (label === undefined) {
    if (checkout.state === 'none') return <div className={css.checkout}>{t('checkout.none')}</div>
    if (checkout.state !== 'failed') return null
    return (
      <Tooltip label={checkout.message} side="bottom">
        <div className={css.checkout} tabIndex={0}>{t('checkout.failed')}</div>
      </Tooltip>
    )
  }
  const copyLabel = t(label.worktree ? 'checkout.copyWorktreePath' : 'checkout.copyProjectPath')
  return (
    <div className={css.checkout} data-forge-checkout="" data-missing={label.missing ? '' : undefined}>
      <Tooltip label={label.tooltip} side="bottom">
        <span className={css.checkoutName} tabIndex={0}>
          {label.missing
            ? <IconWarningTriangleOutlineRegular size={14} className={css.checkoutIcon} />
            : label.worktree
              ? <IconBranchOutlineRegular size={14} className={css.checkoutIcon} />
              : <IconFolderCloseRegular size={14} className={css.checkoutIcon} />}
          {label.detached && <span>{t('checkout.detached')}</span>}
          {label.detached && label.name !== null && <span aria-hidden="true">·</span>}
          {label.name !== null && <span className={css.checkoutBranch}>{label.name}</span>}
        </span>
      </Tooltip>
      <span className={css.checkoutNote}>{label.kind}</span>
      <Tooltip label={copyLabel} side="bottom">
        <button type="button" className={`${css.iconButton} ${css.checkoutCopy}`} aria-label={copyLabel} onClick={() => { copyPath(label.path) }}>
          <IconCopyOutlineRegular size={14} />
        </button>
      </Tooltip>
      {label.missing && (
        <Button
          size="sm"
          variant="outline"
          disabled={state.worktree.restoration !== null}
          icon={state.worktree.restoration === null ? undefined : <StateDot state="ongoing" size={14} />}
          onClick={restore}
        >
          {t('checkout.restore')}
        </Button>
      )}
    </div>
  )
}

function SignIn({ state, copyText, t }: {
  readonly state: ForgePanelState
  readonly copyText: (text: string) => void
  readonly t: Translate
}): ReactNode {
  const { repository, readiness } = state
  if (repository === null || readiness === null || readiness.state === 'ready') return null
  const host = repository.host
  if (readiness.state === 'unavailable') {
    return <div className={css.banner} role="status">{t('signin.unavailable', { host, message: readiness.message ?? '' })}</div>
  }
  const command = repository.forge === 'github' ? `gh auth login --hostname ${host}` : undefined
  return (
    <div className={css.banner} role="status">
      <span>{t('signin.title', { host })}</span>
      {command === undefined
        ? readiness.message !== null && <span className={css.bannerDetail}>{readiness.message}</span>
        : (
          <>
            <code className={css.bannerCommand}>{command}</code>
            <Button size="sm" variant="outline" className={css.bannerAction} onClick={() => { copyText(command) }}>
              {t('signin.copy')}
            </Button>
          </>
        )}
    </div>
  )
}

/**
 * Render the forge tab of one Session. The local changes card shows while the
 * `branch` scope changes files and no open change request has the checked-out
 * branch as its head. The only open change request starts expanded; once the
 * user expands or collapses a card, the panel keeps that choice across later updates.
 * @param props - tab information, panel snapshot and Host facts hooks, actions, and copy.
 * @returns the tab body.
 */
export function ForgeTab({
  useTabInfo, sessionId, usePanel, useHost, useLocale, reconnect, refresh, remove, markReady, merge, restore, openLink, copyText, copyPath,
  reportVisible, createChangeRequest, t,
}: ForgeTabProps): ReactNode {
  const snapshot = usePanel(current => current)
  const home = useHost(facts => facts.home)
  const locale = useLocale(value => value)
  const { tab } = useTabInfo()
  const visible = tab.visible
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    reportVisible(visible)
  }, [reportVisible, visible])
  useEffect(() => () => { reportVisible(false) }, [reportVisible])
  const state = snapshot.state
  const disconnected = snapshot.disconnected && (
    <div className={css.disconnected} role="status">
      <span>{t('stream.failed')}</span>
      <Button size="sm" variant="outline" onClick={reconnect}>{t('retry')}</Button>
    </div>
  )
  if (state === null) return <div className={css.centered}>{disconnected || <StateDot state="ongoing" />}</div>
  const viewChanges = (source: ChangesSource, path?: string): void => {
    tab.actions.openResource(changesAddress({ sessionId, source }), path === undefined ? undefined : { params: { path } })
  }
  const startRefresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void refresh().finally(() => { setRefreshing(false) })
  }
  const actions: ChangeRequestActions = {
    openLink, copyLink: copyText, retry: startRefresh, remove, markReady, merge,
    viewChanges: (entry) => { viewChanges({ kind: 'change', url: entry.url }) },
  }
  const local = state.local !== null && state.local.files.length > 0 && openChangeRequestOf(state) === undefined ? state.local : null
  const expanded = chosen ?? defaultExpanded(state.changeRequests)
  const toggle = (url: string): void => {
    const next = new Set(expanded)
    if (next.has(url)) next.delete(url)
    else next.add(url)
    setChosen(next)
  }
  const now = Date.now()
  const count = state.changeRequests.length
  return (
    <div className={css.root} data-forge-panel="">
      {disconnected}
      <Checkout state={state} home={home} restore={restore} copyPath={copyPath} t={t} />
      {local !== null && (
        <LocalChangesCard
          local={local}
          creatable={state.repository !== null}
          view={(path) => { viewChanges({ kind: 'local' }, path) }}
          create={createChangeRequest}
          t={t}
        />
      )}
      <section className={css.section}>
        <div className={css.sectionHeader}>
          <h3 className={css.sectionTitle}>{t('changes.title', { count })}</h3>
          <Tooltip label={t('refresh')} side="top">
            <button type="button" className={css.iconButton} aria-label={t('refresh')} aria-disabled={refreshing} onClick={startRefresh}>
              <RefreshGlyph busy={refreshing} size={14} />
            </button>
          </Tooltip>
        </div>
        <SignIn state={state} copyText={copyText} t={t} />
        {count === 0
          ? (
            <div className={css.empty}>
              <p className={css.emptyTitle}>{t('changes.empty')}</p>
              <p className={css.emptyHint}>{t('changes.emptyHint')}</p>
            </div>
          )
          : (
            <ul className={css.list}>
              {state.changeRequests.map(entry => (
                <ChangeRequestCard
                  key={entry.url}
                  entry={entry}
                  expanded={expanded.has(entry.url)}
                  onToggle={() => { toggle(entry.url) }}
                  now={now}
                  actions={actions}
                  locale={locale}
                  t={t}
                />
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
