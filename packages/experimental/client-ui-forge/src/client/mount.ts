/** Remote contribution and slot registrations of the forge panel. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-forge/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeChangeRequestListState, ForgeChangeRequestStatesFrame, ForgePanelChangeRequest } from '../types.ts'
import { ReviewQueue } from './review-queue.ts'
import { formatReviewComment, type ReviewSelection } from './review.ts'
import { ActionToast } from './ActionToast.tsx'
import { AttentionIndicator, type AttentionIndicatorInjected } from './AttentionIndicator.tsx'
import { CHANGES_ID, changesAddress, changesDefinition, type ChangesSource } from './changes-address.ts'
import {
  ChangeRequestsActions, ChangeRequestsSection, type ChangeRequestsActionsInjected, type ChangeRequestsSectionInjected,
} from './ChangeRequestsSection.tsx'
import { createChangesStore } from './changes-store.ts'
import { ChangesTab, type ChangesTabInjected } from './ChangesTab.tsx'
import { ChangesTabTitle } from './ChangesTabTitle.tsx'
import {
  CheckoutRow, EnvironmentActions, LocalChangesRow, type CheckoutRowInjected, type LocalChangesRowInjected,
} from './EnvironmentRows.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh, type ForgePanelKey } from './locales.ts'
import type { SessionListInjected } from './session-list.ts'
import { SessionHoverForge } from './SessionHoverForge.tsx'
import { SessionRowForge } from './SessionRowForge.tsx'
import {
  createNoticeSource, createPanelSource, createStreamSource, foldStates, type PanelSource,
} from './source.ts'
import { numberOf } from './status.ts'
import { WorktreeProgress, type WorktreeProgressInjected } from './WorktreeProgress.tsx'
import { WorktreeToggle, type WorktreeToggleInjected } from './WorktreeToggle.tsx'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions']

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
  readonly release: () => void
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'forge-panel: dictionaries')
  const t = ctx.locale.bind(NS)
  const notices = createNoticeSource()
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
      const panel = createPanelSource({
        open: signal => ctx.remote.forgePanel.follow(sessionId, signal),
        subscribeReset: listener => ctx.on('connection/reset', listener),
      })
      const dispose = scope.effect(() => () => {
        panel.close()
        stores.delete(sessionId)
      }, 'forge-panel: release Session state')
      store = { panel, reviews: new WeakMap(), release: () => { void dispose() } }
      stores.set(sessionId, store)
    }
    return store
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
  const addReviewToInput = (sessionId: SessionId, selection: ReviewSelection): boolean => {
    const scope = ctx.sessions.scope(sessionId)
    const conversation = scope?.get('conversation')
    if (scope === undefined || conversation === undefined) return false
    const input = conversation.input.for(scope)
    const numbers = Array.from(input.state.getSnapshot().draft.matchAll(/(?:^|\n)(?:> )?## User Comment (\d+)/g), match => Number(match[1]))
    if (!input.insertQuote(formatReviewComment(selection, Math.max(0, ...numbers) + 1))) return false
    input.focus()
    return true
  }
  /** How toasts name a change request: its number, else its title, else its URL. */
  const nameOf = (entry: ForgePanelChangeRequest): string => {
    const number = numberOf(entry)
    return number === null ? entry.snapshot?.title ?? entry.url : t('change.number', { number })
  }
  const remove = (sessionId: SessionId, entry: ForgePanelChangeRequest): void => {
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
      reconnect: store.panel.reconnect,
      refresh: refreshOf(sessionId),
      remove: (entry) => { remove(sessionId, entry) },
      readChecks: async (url, headSha, signal) => {
        const result = await ctx.remote.forgePanel.changeRequestChecks(sessionId, url, headSha, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      markReady: async (entry) => {
        const result = await ctx.remote.forgePanel.markReady(sessionId, entry.url)
        if (result.ok) notices.report('toast.markedReady', { tone: 'success', params: { name: nameOf(entry) } })
        else notices.report('toast.markReadyFailed', { params: { message: result.error.message } })
      },
      merge: async (entry, request) => {
        const result = await ctx.remote.forgePanel.merge(sessionId, entry.url, request.method, request.headSha)
        if (result.ok) notices.report('toast.merged', { tone: 'success', params: { name: nameOf(entry) } })
        else if (result.error.code === 'forgePanel/stale-head') notices.report('toast.mergeStale', { params: { name: nameOf(entry) } })
        else notices.report('toast.mergeFailed', { params: { message: result.error.message } })
      },
      openLink,
      copyText,
      viewChanges: (entry) => { openChanges(sessionId, { kind: 'change', url: entry.url }) },
    }
  }
  const sectionActionsFace = (sessionId: SessionId): ChangeRequestsActionsInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel },
    refresh: refreshOf(sessionId),
  })
  const checkoutFace = (sessionId: SessionId): CheckoutRowInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel, host },
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
  const attentionFace = (sessionId: SessionId): AttentionIndicatorInjected => ({
    hooks: { panel: storesOf(sessionId).panel.hooks.panel },
  })
  const changesFace = (sessionId: SessionId): ChangesTabInjected => {
    const store = storesOf(sessionId)
    return {
      keyedHooks: { panel: visibility => visibility === 'visible' ? store.panel.hooks.panel : undefined },
      reconnect: store.panel.reconnect,
      localDiff: (scope, signal) => ctx.remote.forgePanel.localDiff(sessionId, scope, signal),
      diffBases: (query, signal) => ctx.remote.forgePanel.diffBases(sessionId, query, signal),
      localText: (scope, path) => ctx.remote.forgePanel.localText(sessionId, scope, path),
      changeRequestDiff: (url, signal) => ctx.remote.forgePanel.changeRequestDiff(sessionId, url, signal),
      changeRequestText: (url, commit, path) => ctx.remote.forgePanel.changeRequestText(sessionId, url, commit, path),
      addReviewToInput: selection => addReviewToInput(sessionId, selection),
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
      report: (key, params) => {
        notices.report(key, { tone: key === 'review.published' || key === 'review.submitted' ? 'success' : 'failure',
          ...params === undefined ? {} : { params } })
      },
    }
  }
  const progressFace = (sessionId: SessionId): WorktreeProgressInjected => {
    const store = storesOf(sessionId)
    return {
      hooks: { panel: store.panel.hooks.panel },
      stop: () => {
        void ctx.remote.forgePanel.stopCreation(sessionId).then(result => settled(result, 'toast.worktreeFailed'))
      },
      retry: () => {
        void ctx.remote.forgePanel.retryWorktree(sessionId).then(result => settled(result, 'toast.worktreeFailed'))
      },
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
    const worktreeCodes: Partial<Record<string, ForgePanelKey>> = { 'forgePanel/session-started': 'toast.worktreeStarted' }
    const store = storesOf(sessionId)
    return {
      hooks: { panel: store.panel.hooks.panel },
      request: async from => settled(await ctx.remote.forgePanel.requestWorktree(sessionId, from), 'toast.worktreeFailed', worktreeCodes),
      cancel: async () => settled(await ctx.remote.forgePanel.cancelWorktree(sessionId), 'toast.worktreeFailed', worktreeCodes),
      branches: async () => {
        const result = await ctx.remote.forgePanel.branches(sessionId)
        return settled(result, 'toast.branchesFailed') && result.ok ? result.value : undefined
      },
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
      inject: sectionFace,
    }, ChangeRequestsSection)
    yield ctx.slots.register({
      name: 'conversation.session.panel.section.actions', key: 'change-requests', locale: NS, inject: sectionActionsFace,
    }, ChangeRequestsActions)
  })
  ctx.slots.inject('conversation.session.panel.environment.row', function* () {
    // The checkout this refresh inspects is what the Environment section shows.
    yield ctx.slots.register({
      name: 'conversation.session.panel.section.actions', key: 'environment', locale: NS, inject: sectionActionsFace,
    }, EnvironmentActions)
    // After the project row (0).
    yield ctx.slots.register({
      name: 'conversation.session.panel.environment.row', id: 'forge.checkout', order: 20, locale: NS, inject: checkoutFace,
    }, CheckoutRow)
    yield ctx.slots.register({
      name: 'conversation.session.panel.environment.row', id: 'forge.local', order: 30, locale: NS, inject: localFace,
    }, LocalChangesRow)
  })
  ctx.slots.inject('conversation.session.panel.indicator', () => ctx.slots.register({
    name: 'conversation.session.panel.indicator', id: 'forge.attention', locale: NS, inject: attentionFace,
  }, AttentionIndicator))
  ctx.effect(() => ctx.sidebarRightTabs.register(changesDefinition(t)), 'forge-panel: changes tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CHANGES_ID, locale: NS, store: createChangesStore(), inject: changesFace,
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
  }, new Map(), foldStates)
  ctx.effect(() => () => { states.close() }, 'forge-panel: change request states')
  const listFace = (): SessionListInjected => ({ hooks: { states: states.observable } })
  ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing', id: 'forge-panel.row', order: 10, locale: NS, inject: listFace,
  }, SessionRowForge))
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover', id: 'forge-panel.row', order: 20, locale: NS, inject: listFace,
  }, SessionHoverForge))
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
