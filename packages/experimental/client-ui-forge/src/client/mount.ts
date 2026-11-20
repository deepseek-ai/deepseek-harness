/** Remote contribution and slot registrations of the forge panel. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { QuoteSummary } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-forge/remote'
import type { ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ForgeChangeRequestListState, ForgeChangeRequestStatesFrame, ForgeExtensionState, ForgePanelState,
} from '../types.ts'
import { actionReporter } from './action-notices.ts'
import { AnnotationView } from './annotations.ts'
import { ForgeChangesService } from './changes-service.ts'
import type {} from './slots.ts'
import { ReviewQueue } from './review-queue.ts'
import { registerReviewPage } from './review-page/review-mount.ts'
import { ViewedFiles } from './viewed-files.ts'
import { formatReviewComment, reviewQuoteSummary, type ReviewSelection } from './review.ts'
import { formatThreadQuote, threadQuoteSummary } from './review-threads.ts'
import { ActionToast } from './ActionToast.tsx'
import { AttentionIndicator, type AttentionIndicatorInjected } from './AttentionIndicator.tsx'
import { CHANGES_ID, CHANGES_KIND, changesAddress, changesDefinition, parseChangesAddress, type ChangesSource } from './changes-address.ts'
import {
  ChangeRequestsActions, ChangeRequestsSection, type ChangeRequestsActionsInjected, type ChangeRequestsSectionInjected,
} from './ChangeRequestsSection.tsx'
import { createChangeRequestsSectionStore } from './change-requests-store.ts'
import { createChangesStore } from './changes-store.ts'
import { ChangesTab, type ChangesTabInjected } from './ChangesTab.tsx'
import { ChangesTabTitle } from './ChangesTabTitle.tsx'
import {
  CheckoutRow, ConnectionRow, LocalChangesRow, type CheckoutRowInjected, type ConnectionRowInjected, type LocalChangesRowInjected,
} from './EnvironmentRows.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh, type ForgePanelKey } from './locales.ts'
import type { SessionListInjected } from './session-list.ts'
import { SessionHoverForge } from './SessionHoverForge.tsx'
import { SessionRowForge } from './SessionRowForge.tsx'
import {
  createNoticeSource, createPanelSource, createStreamSource, foldStates, pageVisibility, type PanelSource, type PanelStream,
} from './source.ts'
import { numberOf, type ChangeRequestEntry } from './status.ts'
import type { WorktreeRequestResult } from './WorktreeNameDialog.tsx'
import { WorktreeProgress, type WorktreeProgressInjected } from './WorktreeProgress.tsx'
import { WorktreeSettings } from './WorktreeSettings.tsx'
import { WorktreeSettingsForm, type WorktreeSettings as WorktreeSettingsFields } from './worktree-settings-form.ts'
import { WorktreeToggle, type WorktreeToggleInjected } from './WorktreeToggle.tsx'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'configForms', 'remoteAccess', 'workspaces', 'uiWorkspace']

/** The worktree row of the Forge bundle, whose Plugins page carries the archive cleanup switch. */
export const WORKTREE_ROW_KEY = '@deepseek-ai/dsh-experimental-forge-bundle#worktree'

/** The Loader entry id the worktree service's settings namespace follows. */
export const WORKTREE_NS = 'worktree'

/**
 * Open a URL in a new browsing context without giving it access to this page.
 * @param url - change request web URL.
 */
function openLink(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Per-Session stores shared by the Session panel entries, the New Session option, and the worktree card. */
interface SessionStores {
  readonly panel: PanelSource
  readonly reviews: WeakMap<AbortSignal, ReviewQueue>
  readonly viewed: ViewedFiles
  /** Revisit the Session's panel on the Host unless an automatic revisit of this Session ran within {@link AUTO_REFRESH_MIN_MS}. */
  readonly refreshIfStale: () => void
  /** Plugin annotations of each changes view of the Session, by address. */
  readonly annotations: Map<string, AnnotationView>
  readonly release: () => void
}

/**
 * Least time between automatic revisits of one Session, which run when the
 * Session panel opens and when the window regains focus; repeated focus
 * changes then cost one checkout inspection.
 */
const AUTO_REFRESH_MIN_MS = 10_000

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'forge-panel: dictionaries')
  const t = ctx.locale.bind(NS)
  const notices = createNoticeSource()
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })
  ctx.on('workspace/archive-notice', async (sessionId, next) => {
    const fallback = await next()
    const result = await ctx.remote.forgePanel.worktreeCleanup(sessionId, null)
    if (!result.ok || result.value === null) return fallback
    const { revision, status } = result.value
    if (status === 'failed') return { text: t('toast.archiveCleanupFailed'), tone: 'warning' }
    if (status !== 'scheduled') return fallback
    void ctx.remote.forgePanel.worktreeCleanup(sessionId, revision).then((completed) => {
      if (lifetime.signal.aborted || !completed.ok || completed.value === null) return
      if (completed.value.status === 'failed') ctx.emit('workspace/archive-followup-failed', sessionId, t('toast.archiveCleanupFailed'))
      else if (completed.value.status === 'retained') ctx.emit('workspace/archive-followup-settled', sessionId)
    }).catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.warn('archive worktree cleanup result unavailable:', error)
    })
    return { text: t('toast.archiveCleanupScheduled'), tone: 'success' }
  })
  /**
   * Follow a Session's panel only after its own history connection opened: the Host resolves the `follow` argument
   * by resuming the Session's Agent, which would otherwise read the Session log a second time beside that opening.
   * The stream holds a Session reference until it ends, and calls `followed` once its first state arrived.
   */
  const followOpened = (sessionId: SessionId, signal: AbortSignal, followed: () => void): PanelStream => {
    let inner: PanelStream | undefined
    async function* frames(): AsyncGenerator<ForgePanelState> {
      const reference = ctx.sessions.retain(sessionId, { source: 'forgePanel', signal })
      try {
        const state = (await reference.ready).session.getSnapshot()
        if (state.openState !== 'open') throw state.openError ?? new Error(`forge-panel: Session ${sessionId} is not open`)
        inner = ctx.remote.forgePanel.follow(sessionId, signal)
        let first = true
        for await (const frame of inner) {
          yield frame
          // The source published the frame before asking for the next one.
          if (first) {
            first = false
            followed()
          }
        }
      } finally {
        reference.release()
      }
    }
    return Object.assign(frames(), { dispose: () => { inner?.dispose() } })
  }
  const stores = new Map<SessionId, SessionStores>()
  ctx.effect(() => () => {
    for (const store of [...stores.values()]) store.release()
    stores.clear()
  }, 'forge-panel: panel streams')
  const storesOf = (sessionId: SessionId): SessionStores => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      const scope = ctx.sessions.scope(sessionId)
      if (scope === undefined) throw new Error(`forge-panel: Session ${sessionId} is not retained`)
      // A refresh asked for before the Host follows the panel would find no panel there, so it waits for the first state.
      let deferred = false
      const panel = createPanelSource({
        open: signal => followOpened(sessionId, signal, () => {
          if (!deferred) return
          deferred = false
          refreshIfStale()
        }),
        subscribeReset: listener => ctx.on('connection/reset', listener),
        visibility: pageVisibility,
      })
      const dispose = scope.effect(() => () => {
        panel.close()
        stores.delete(sessionId)
      }, 'forge-panel: release Session state')
      let refreshedAt: number | undefined
      const refreshIfStale = (): void => {
        if (panel.hooks.panel.getSnapshot().state === null) {
          deferred = true
          return
        }
        const now = Date.now()
        if (refreshedAt !== undefined && now - refreshedAt < AUTO_REFRESH_MIN_MS) return
        refreshedAt = now
        void ctx.remote.forgePanel.revisit(sessionId).then((result) => { settled(result, 'toast.refreshFailed') })
      }
      store = {
        panel, reviews: new WeakMap(), viewed: new ViewedFiles(sessionId), annotations: new Map(), refreshIfStale,
        release: () => { void dispose() },
      }
      stores.set(sessionId, store)
    }
    return store
  }
  // The Host's lenses and annotation limit, streamed while any view reads them.
  const extensionSource = createStreamSource<ForgeExtensionState, ForgeExtensionState | null>({
    open: signal => ctx.remote.forgePanel.extensions(signal),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  }, null, (_previous, frame) => frame)
  ctx.effect(() => () => { extensionSource.close() }, 'forge-panel: extension stream')
  const changes = new ForgeChangesService({
    mounted: () => ctx.sidebarRight.mounted.getSnapshot(),
    openResource: (address, params) => { ctx.sidebarRight.openResource(address, params === undefined ? undefined : { params }) },
  }, {
    getSnapshot: () => extensionSource.observable.getSnapshot().state,
    subscribe: listener => extensionSource.observable.subscribe(listener),
  }, { changes: CHANGES_KIND })
  const withdrawChanges = ctx.reflect.provide('forgeChanges', changes)
  ctx.effect(() => () => { void withdrawChanges() }, 'forge-panel: changes view face')
  const annotationsOf = (store: SessionStores, address: string): AnnotationView => {
    let view = store.annotations.get(address)
    if (view === undefined) {
      const target = parseChangesAddress(address)
      if (target === undefined) throw new Error(`forge-panel: not a changes address "${address}"`)
      view = new AnnotationView(changes.annotationSources, target)
      store.annotations.set(address, view)
    }
    return view
  }
  const settled = (result: RemoteResult<unknown>, failure: ForgePanelKey, codes: Partial<Record<string, ForgePanelKey>> = {}): boolean => {
    if (result.ok) return true
    notices.report(codes[result.error.code] ?? failure)
    return false
  }
  const copy = (text: string, copied: ForgePanelKey): void => {
    void navigator.clipboard.writeText(text).then(
      () => { notices.report(copied, { tone: 'success' }) },
      () => { notices.report('toast.copyFailed') },
    )
  }
  const copyText = (text: string): void => { copy(text, 'toast.copied') }
  const copyPath = (path: string): void => { copy(path, 'toast.pathCopied') }
  /** Send the request for a change request to the Session as a message from the user. */
  const createChangeRequest = (sessionId: SessionId): void => {
    const text = t('changes.local.prompt')
    const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
    if (conversation === undefined) {
      notices.report('toast.promptFailed')
      return
    }
    void conversation.send(text).then(
      () => { notices.report('toast.prompted', { tone: 'success', params: { text } }) },
      () => { notices.report('toast.promptFailed') },
    )
  }
  /** Insert one quote into the Session's main input, numbering it after the quotes of the same heading already there. */
  const quoteInInput = (sessionId: SessionId, heading: RegExp, quote: (index: number) => string, summary: QuoteSummary): boolean => {
    const scope = ctx.sessions.scope(sessionId)
    const conversation = scope?.get('conversation')
    if (scope === undefined || conversation === undefined) return false
    const input = conversation.input.for(scope)
    const numbers = Array.from(input.state.getSnapshot().draft.matchAll(heading), match => Number(match[1]))
    if (!input.insertQuote(quote(Math.max(0, ...numbers) + 1), summary)) return false
    input.focus()
    return true
  }
  const addReviewToInput = (sessionId: SessionId, selection: ReviewSelection): boolean => quoteInInput(sessionId,
    /(?:^|\n)(?:> )?## User Comment (\d+)/g, index => formatReviewComment(selection, index), reviewQuoteSummary(selection.comment))
  const addThreadToInput = (sessionId: SessionId, thread: ForgeReviewThread, url: string, range: string | null): boolean =>
    quoteInInput(sessionId, /(?:^|\n)(?:> )?## Review Thread (\d+)/g, index => formatThreadQuote(thread, url, index),
      threadQuoteSummary(thread, range))
  /** How toasts name a change request: its number, else its title, else its URL. */
  const nameOf = (entry: ChangeRequestEntry): string => {
    const number = numberOf(entry)
    return number === null ? entry.snapshot?.title ?? entry.url : t('change.number', { number })
  }
  const reportAction = actionReporter(notices, nameOf)
  const remove = (sessionId: SessionId, entry: ChangeRequestEntry): void => {
    void ctx.remote.forgePanel.dismiss(sessionId, entry.url).then((result) => {
      if (!settled(result, 'toast.removeFailed')) return
      notices.report('toast.removed', {
        tone: 'success',
        params: { name: nameOf(entry) },
        // Restoring needs a provider that recognizes the URL; an unrecognized one is removed without undo.
        ...entry.ref === null ? {} : {
          undo: () => {
            void ctx.remote.forgePanel.track(sessionId, entry.url).then(restored => settled(restored, 'toast.undoFailed'))
          },
        },
      })
    })
  }
  const host: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  const restore = async (sessionId: SessionId): Promise<string | undefined> => {
    const result = await ctx.remote.forgePanel.restoreWorktree(sessionId)
    if (!result.ok) return result.error.message
    notices.report('toast.restored', { tone: 'success' })
    return undefined
  }
  const locale: HostObservable<string> = {
    getSnapshot: () => ctx.locale.getLocale().active,
    subscribe: listener => ctx.locale.subscribe(listener),
  }
  const refreshOf = (sessionId: SessionId) => async (): Promise<void> => {
    settled(await ctx.remote.forgePanel.refresh(sessionId), 'toast.refreshFailed')
  }
  const openChanges = (sessionId: SessionId, source: ChangesSource): void => {
    ctx.sidebarRight.openResourceIn(sessionId, changesAddress({ sessionId, source }))
  }
  const sectionFace = (sessionId: SessionId): ChangeRequestsSectionInjected => {
    const store = storesOf(sessionId)
    return {
      hooks: { panel: store.panel.hooks.panel, locale },
      refresh: refreshOf(sessionId),
      remove: (entry) => { remove(sessionId, entry) },
      readChecks: async (url, headSha, signal) => {
        const result = await ctx.remote.forgePanel.changeRequestChecks(sessionId, url, headSha, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      markReady: async (entry) => {
        reportAction(entry, await ctx.remote.forgePanel.markReady(sessionId, entry.url),
          { done: 'toast.markedReady', failed: 'toast.markReadyFailed' })
      },
      merge: async (entry, request) => {
        reportAction(entry, await ctx.remote.forgePanel.merge(sessionId, entry.url, request.method, request.headSha),
          { done: 'toast.merged', stale: 'toast.mergeStale', failed: 'toast.mergeFailed' })
      },
      rerunChecks: async (entry, request) => {
        reportAction(entry, await ctx.remote.forgePanel.rerunChecks(sessionId, entry.url, request),
          { done: 'toast.rerunRequested', stale: 'toast.rerunStale', failed: 'toast.rerunFailed' })
      },
      requestReviews: async (entry, reviewers) => {
        reportAction(entry, await ctx.remote.forgePanel.requestReviews(sessionId, entry.url, reviewers),
          { done: 'toast.reviewRequested', failed: 'toast.reviewRequestFailed' },
          { login: reviewers.map(reviewer => reviewer.login).join(', ') })
      },
      reviewerCandidates: async (url, query, signal) => {
        const result = await ctx.remote.forgePanel.reviewerCandidates(sessionId, url, query, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      updateBranch: async (entry, request) => {
        reportAction(entry, await ctx.remote.forgePanel.updateBranch(sessionId, entry.url, request.method, request.headSha),
          { done: 'toast.branchUpdated', stale: 'toast.branchUpdateStale', failed: 'toast.branchUpdateFailed' })
      },
      openLink,
      copyText,
      viewChanges: (entry) => { openChanges(sessionId, { kind: 'change', url: entry.url }) },
    }
  }
  const sectionActionsFace = (sessionId: SessionId): ChangeRequestsActionsInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel },
  })
  const checkoutFace = (sessionId: SessionId): CheckoutRowInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel, host },
    refreshIfStale: storesOf(sessionId).refreshIfStale,
    restore: () => {
      void restore(sessionId).then((message) => {
        if (message !== undefined) notices.report('toast.restoreFailed', { params: { message } })
      })
    },
  })
  const localFace = (sessionId: SessionId): LocalChangesRowInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel },
    viewLocalChanges: () => { openChanges(sessionId, { kind: 'local' }) },
    createChangeRequest: () => { createChangeRequest(sessionId) },
  })
  const connectionFace = (sessionId: SessionId): ConnectionRowInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel },
    reconnect: storesOf(sessionId).panel.reconnect,
  })
  const attentionFace = (sessionId: SessionId): AttentionIndicatorInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel },
  })
  const changesFace = (sessionId: SessionId): ChangesTabInjected => {
    const store = storesOf(sessionId)
    return {
      keyedHooks: {
        panel: visibility => visibility === 'visible' ? store.panel.hooks.panel : undefined,
        annotations: address => annotationsOf(store, address),
      },
      hooks: { lenses: changes.lenses, extensions: extensionSource.observable },
      changesLens: (request, signal) => ctx.remote.forgePanel.changesLens(sessionId, request, signal),
      reconnect: store.panel.reconnect,
      localDiff: (scope, signal) => ctx.remote.forgePanel.localDiff(sessionId, scope, signal),
      diffBases: (query, signal) => ctx.remote.forgePanel.diffBases(sessionId, query, signal),
      localText: (scope, path) => ctx.remote.forgePanel.localText(sessionId, scope, path),
      localCommits: (base, signal) => ctx.remote.forgePanel.localCommits(sessionId, base, signal),
      changeRequestDiff: (url, commits, signal) => ctx.remote.forgePanel.changeRequestDiff(sessionId, url, commits, signal),
      changeRequestCommits: (url, signal) => ctx.remote.forgePanel.changeRequestCommits(sessionId, url, signal),
      viewedFiles: store.viewed,
      changeRequestViewed: (url, headSha, fresh, signal) =>
        ctx.remote.forgePanel.changeRequestViewed(sessionId, url, headSha, fresh, signal),
      setFileViewed: (url, request) => ctx.remote.forgePanel.setFileViewed(sessionId, url, request),
      changeRequestText: (url, commit, path) => ctx.remote.forgePanel.changeRequestText(sessionId, url, commit, path),
      addReviewToInput: selection => addReviewToInput(sessionId, selection),
      addThreadToInput: (thread, url, range) => addThreadToInput(sessionId, thread, url, range),
      changeRequestReview: (url, headSha, fresh, signal) =>
        ctx.remote.forgePanel.changeRequestReview(sessionId, url, headSha, fresh, signal),
      changeRequestReviewWrite: (url, write) => ctx.remote.forgePanel.changeRequestReviewWrite(sessionId, url, write),
      reviewQueue: ({ id, signal }) => {
        let queue = store.reviews.get(signal)
        if (queue === undefined) {
          const records = new ReviewQueue(`dsh.forge-review.tab.v1.${JSON.stringify([sessionId, id])}`)
          queue = records
          store.reviews.set(signal, records)
          const clear = (): void => { if (!records.close()) notices.report('review.saveFailed') }
          if (signal.aborted) clear()
          else {
            const release = ctx.effect(() => {
              const close = (): void => { clear(); void release() }
              signal.addEventListener('abort', close, { once: true })
              return () => { signal.removeEventListener('abort', close) }
            }, 'forge-panel: review tab lifetime')
          }
        }
        return queue
      },
      submitReview: (url, request) => ctx.remote.forgePanel.submitReview(sessionId, url, request),
      openLink,
      copyPath,
      createChangeRequest: () => { createChangeRequest(sessionId) },
      report: notices.report,
    }
  }
  /** Request a worktree; a refused branch name goes back to the naming dialog, any other failure to a toast. */
  const requestWorktree = async (sessionId: SessionId, from: string | null, name: string | null): Promise<WorktreeRequestResult> => {
    const result = await ctx.remote.forgePanel.requestWorktree(sessionId, from, name)
    if (result.ok) return 'accepted'
    if (result.error.code === 'forgePanel/branch-exists') return 'branch-exists'
    if (result.error.code === 'forgePanel/invalid-name') return 'invalid-name'
    settled(result, 'toast.worktreeFailed', { 'forgePanel/session-started': 'toast.worktreeStarted' })
    return 'failed'
  }
  const progressFace = (sessionId: SessionId): WorktreeProgressInjected => {
    const store = storesOf(sessionId)
    return {
      hooks: { panel: store.panel.hooks.panel },
      stop: () => {
        void ctx.remote.forgePanel.stopCreation(sessionId).then(result => settled(result, 'toast.worktreeFailed'))
      },
      retry: (fetch) => {
        void ctx.remote.forgePanel.retryWorktree(sessionId, fetch).then(result => settled(result, 'toast.worktreeFailed'))
      },
      request: async (from, name) => await requestWorktree(sessionId, from, name),
      withdraw: () => {
        void ctx.remote.forgePanel.cancelWorktree(sessionId).then(result => settled(result, 'toast.worktreeFailed'))
      },
      restore: () => restore(sessionId),
      leave: () => {
        void ctx.remote.forgePanel.continueInProject(sessionId).then(result => settled(result, 'toast.leaveFailed'))
      },
    }
  }
  const worktreeFace = (sessionId: SessionId): WorktreeToggleInjected => {
    const store = storesOf(sessionId)
    return {
      hooks: { panel: store.panel.hooks.panel },
      request: async (from, name) => await requestWorktree(sessionId, from, name),
      cancel: async () => settled(await ctx.remote.forgePanel.cancelWorktree(sessionId), 'toast.worktreeFailed',
        { 'forgePanel/session-started': 'toast.worktreeStarted' }),
      bases: (query, signal) => ctx.remote.forgePanel.worktreeBases(sessionId, query, signal),
    }
  }
  ctx.slots.inject('conversation.session.panel.section', function* () {
    yield ctx.slots.register({
      name: 'conversation.session.panel.section',
      id: 'change-requests',
      // The first section after the Environment section (0).
      order: 100,
      label: () => t('tab.title'),
      locale: NS,
      store: createChangeRequestsSectionStore(),
      inject: sectionFace,
      children: { 'forge.change-request.card.actions': { kind: 'list', scope: 'session' } },
    }, ChangeRequestsSection)
    yield ctx.slots.register({
      name: 'conversation.session.panel.section.actions', key: 'change-requests', locale: NS, inject: sectionActionsFace,
    }, ChangeRequestsActions)
  })
  ctx.slots.inject('conversation.session.panel.environment.row', function* () {
    // After the project row (0).
    yield ctx.slots.register({
      name: 'conversation.session.panel.environment.row', id: 'forge.checkout', order: 20, locale: NS, inject: checkoutFace,
    }, CheckoutRow)
    yield ctx.slots.register({
      name: 'conversation.session.panel.environment.row', id: 'forge.local', order: 30, locale: NS, inject: localFace,
    }, LocalChangesRow)
    // Last in the section: a lost stream leaves every forge row above it out of date.
    yield ctx.slots.register({
      name: 'conversation.session.panel.environment.row', id: 'forge.connection', order: 40, locale: NS, inject: connectionFace,
    }, ConnectionRow)
  })
  ctx.slots.inject('conversation.session.panel.indicator', () => ctx.slots.register({
    name: 'conversation.session.panel.indicator',
    id: 'forge.attention',
    // Paints above running dots: what needs attention outranks what merely runs.
    order: 100,
    locale: NS,
    inject: attentionFace,
  }, AttentionIndicator))
  ctx.effect(() => ctx.sidebarRightTabs.register(changesDefinition(t)), 'forge-panel: changes tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CHANGES_ID, locale: NS, store: createChangesStore(), inject: changesFace,
    children: {
      'forge.changes.toolbar': { kind: 'list', scope: 'session' },
      'forge.changes.file.menu': { kind: 'list', scope: 'session' },
      'forge.diff.line.annotation': { kind: 'keyed', scope: 'session' },
      'forge.diff.comment.actions': { kind: 'list', scope: 'session' },
    },
  }, ChangesTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: CHANGES_ID, locale: NS,
  }, ChangesTabTitle))
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options', id: 'forge-panel.worktree', locale: NS, inject: worktreeFace,
  }, WorktreeToggle))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'forge-panel.worktree', order: 5, locale: NS, inject: progressFace,
  }, WorktreeProgress))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'forge-panel.toast', locale: NS,
    inject: () => ({ hooks: notices.hooks, dismiss: notices.dismiss }),
  }, ActionToast))
  // One stream of change request states serves every Session row while any row reads it.
  const states = createStreamSource<ForgeChangeRequestStatesFrame, ReadonlyMap<string, ForgeChangeRequestListState>>({
    open: signal => ctx.remote.forgePanel.changeRequestStates(signal),
    subscribeReset: listener => ctx.on('connection/reset', listener),
    visibility: pageVisibility,
  }, new Map(), foldStates)
  ctx.effect(() => () => { states.close() }, 'forge-panel: change request states')
  const listFace = (): SessionListInjected => ({ hooks: { states: states.observable } })
  ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing', id: 'forge-panel.row', order: 10, locale: NS, inject: listFace,
  }, SessionRowForge))
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover', id: 'forge-panel.row', order: 20, locale: NS, inject: listFace,
  }, SessionHoverForge))
  registerReviewPage(ctx, {
    notices, settled, nameOf, openLink, copyText, copyPath, locale, quoteReview: addReviewToInput, quoteThread: addThreadToInput,
  })
  const worktreeSettings = new WorktreeSettingsForm(ctx.configForms.get<WorktreeSettingsFields>(WORKTREE_NS))
  ctx.effect(() => () => { worktreeSettings.dispose() }, 'forge-panel: worktree settings form')
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: WORKTREE_ROW_KEY, locale: NS, inject: () => worktreeSettings.inject(),
  }, WorktreeSettings))
}

/**
 * Mount the forge panel Remote, then the UI that calls it; the UI is withdrawn before the Remote.
 * @param ctx - client plugin lifetime.
 * @param contribution - generated forge panel Remote definitions.
 * @returns the disposer that removes both contributions.
 */
export async function mountForgePanel(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.forgePanel', ...inject.slice(1)], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
