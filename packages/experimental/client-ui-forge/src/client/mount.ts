/** Remote contribution and slot registrations of the forge panel. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-forge/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeChangeRequestListState, ForgeChangeRequestStatesFrame, ForgePanelChangeRequest } from '../types.ts'
import { ActionToast } from './ActionToast.tsx'
import { CHANGES_ID, changesDefinition } from './changes-address.ts'
import { createChangesStore } from './changes-store.ts'
import { ChangesTab, type ChangesTabInjected } from './ChangesTab.tsx'
import { ChangesTabTitle } from './ChangesTabTitle.tsx'
import { ForgeTab, type ForgeTabInjected } from './ForgeTab.tsx'
import { ForgeTabTitle } from './ForgeTabTitle.tsx'
import { HeaderButton, type HeaderButtonInjected } from './HeaderButton.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh, type ForgePanelKey } from './locales.ts'
import type { SessionListInjected } from './session-list.ts'
import { SessionHoverForge } from './SessionHoverForge.tsx'
import { SessionRowForge } from './SessionRowForge.tsx'
import {
  createNoticeSource, createPanelSource, createStreamSource, createVisibilitySource, foldStates, type PanelSource, type VisibilitySource,
} from './source.ts'
import { numberOf } from './status.ts'
import { WorktreeProgress, type WorktreeProgressInjected } from './WorktreeProgress.tsx'
import { WorktreeToggle, type WorktreeToggleInjected } from './WorktreeToggle.tsx'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions']

/** Registry id of the forge tab type, also its slot key. */
export const TAB_ID = '@deepseek-ai/dsh-experimental-client-ui-forge'

/** Kind of the forge tab. */
export const TAB_KIND = 'forge-panel'

/**
 * Open a URL in a new browsing context without giving it access to this page.
 * @param url - change request web URL.
 */
function openLink(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Per-Session stores shared by the tab, the header button, the New Session option, and the worktree card. */
interface SessionStores {
  readonly panel: PanelSource
  readonly visibility: VisibilitySource
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
      store = { panel, visibility: createVisibilitySource(), release: () => { void dispose() } }
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
  const tabFace = (sessionId: SessionId): ForgeTabInjected => {
    const store = storesOf(sessionId)
    return {
      hooks: { panel: store.panel.hooks.panel, host, locale },
      reconnect: store.panel.reconnect,
      refresh: async () => {
        settled(await ctx.remote.forgePanel.refresh(sessionId), 'toast.refreshFailed')
      },
      remove: (entry) => { remove(sessionId, entry) },
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
      restore: () => {
        void restore(sessionId).then((message) => {
          if (message !== undefined) notices.report('toast.restoreFailed', { params: { message } })
        })
      },
      openLink,
      copyText,
      copyPath,
      reportVisible: store.visibility.set,
      createChangeRequest: () => { createChangeRequest(sessionId) },
    }
  }
  const changesFace = (sessionId: SessionId): ChangesTabInjected => {
    const store = storesOf(sessionId)
    return {
      keyedHooks: { panel: visibility => visibility === 'visible' ? store.panel.hooks.panel : undefined },
      reconnect: store.panel.reconnect,
      localDiff: (scope, signal) => ctx.remote.forgePanel.localDiff(sessionId, scope, signal),
      localText: (scope, path) => ctx.remote.forgePanel.localText(sessionId, scope, path),
      changeRequestDiff: (url, signal) => ctx.remote.forgePanel.changeRequestDiff(sessionId, url, signal),
      changeRequestText: (url, commit, path) => ctx.remote.forgePanel.changeRequestText(sessionId, url, commit, path),
      openLink,
      copyPath,
      createChangeRequest: () => { createChangeRequest(sessionId) },
      report: (key, params) => { notices.report(key, params === undefined ? {} : { params }) },
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
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, title: () => t('tab.title') }), 'forge-panel: sidebar tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject: tabFace,
  }, ForgeTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
  }, ForgeTabTitle))
  ctx.effect(() => ctx.sidebarRightTabs.register(changesDefinition(t)), 'forge-panel: changes tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CHANGES_ID, locale: NS, store: createChangesStore(), inject: changesFace,
  }, ChangesTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: CHANGES_ID, locale: NS,
  }, ChangesTabTitle))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'forge-panel',
    // Left of the schedule entry (-5) and the overflow menu (0), right of open-in-app (-10).
    order: -8,
    locale: NS,
    inject: (sessionId: SessionId): HeaderButtonInjected => {
      const store = storesOf(sessionId)
      return {
        hooks: { panel: store.panel.hooks.panel, visible: store.visibility.hooks.visible },
        toggle: (visible) => {
          if (!visible) { ctx.sidebarRight.openTab(TAB_KIND); return }
          const tab = ctx.sidebarRight.tabsIn(sessionId).find(tab => tab.kind === TAB_KIND)
          if (tab === undefined) return
          ctx.sidebarRight.hide(tab.id)
        },
      }
    },
  }, HeaderButton))
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
