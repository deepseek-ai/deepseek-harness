/** Workspace command registration and browser-owned opening requests. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionForkError } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCommand, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UiWorkspace } from './navigation.ts'

/** Transient requests consumed by the existing workspace browser. */
export interface WorkspaceShortcutState {
  readonly searchRequest: number
  readonly addRequested: boolean
  readonly directoryBusy: boolean
  readonly renameTarget: { readonly sessionId: SessionId; readonly currentTitle: string } | null
}

interface WorkspaceShortcutControls {
  state: SnapshotStore<WorkspaceShortcutState>
  search: () => void
  add: () => void
  closeAdd: () => void
  directoryBusy: (busy: boolean) => void
  rename: (sessionId: SessionId, currentTitle: string) => void
  closeRename: () => void
}

/**
 * Create the private browser request source shared by commands and controls.
 * @returns observable state and its complete mutation callbacks.
 */
export function createWorkspaceShortcutControls(): WorkspaceShortcutControls {
  const state = createSnapshotStore<WorkspaceShortcutState>({
    searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null,
  })
  return {
    state,
    search: () => { state.set({ ...state.getSnapshot(), searchRequest: state.getSnapshot().searchRequest + 1 }) },
    add: () => { state.set(state.getSnapshot().directoryBusy ? state.getSnapshot() : { ...state.getSnapshot(), addRequested: true }) },
    closeAdd: () => { state.set({ ...state.getSnapshot(), addRequested: false }) },
    directoryBusy: (busy: boolean) => { state.set({ ...state.getSnapshot(), directoryBusy: busy }) },
    rename: (sessionId: SessionId, currentTitle: string) => {
      state.set({ ...state.getSnapshot(), renameTarget: { sessionId, currentTitle } })
    },
    closeRename: () => { state.set({ ...state.getSnapshot(), renameTarget: null }) },
  }
}

/**
 * Register navigation commands against the existing workspace owner.
 * Rename requires a nonblank main Conversation with no modal other than the navigation drawer obscuring it.
 * @param ctx - plugin context with the shortcut, locale, and model services.
 * @param navigation - session creation and forking from the pointer controls' navigation service.
 * @param controls - browser-owned opening requests.
 * @param archiveSession - shared archive action, including running-work confirmation and notices.
 * @param reportForkFailure - publish a classified failure through the frame-wide notice channel.
 * @param markSession - shared reading action; only failed writes raise a notice.
 */
export function installWorkspaceShortcuts(
  ctx: Context,
  navigation: Pick<UiWorkspace, 'startSession' | 'forkSession'>,
  controls: ReturnType<typeof createWorkspaceShortcutControls>,
  archiveSession: (sessionId: SessionId) => void,
  reportForkFailure: (reason: 'unavailable' | 'failed') => void,
  markSession: (sessionId: SessionId, unread: boolean) => void,
): void {
  const t = ctx.locale.bind('workspace')
  const current = () => Object.values(ctx.sessions.list.getSnapshot().byId)
    .find(row => (row.retainedBy.mainView ?? 0) > 0)
  const addReason = () => ctx.slots.entries('sidebar.workspaces.directoryFlow').length === 0
    ? t('shortcut.noPicker')
    : controls.state.getSnapshot().directoryBusy ? t('shortcut.directoryBusy') : null
  const register = (id: string, label: () => string, aliases: string[], code: string,
    modifiers: ('primary' | 'alt' | 'shift')[], webModifiers: ('primary' | 'alt' | 'shift')[], resolve: ShortcutCommand['resolve']): void => {
    ctx.effect(() => ctx.shortcuts.register({
      id: id as ShortcutCommandId, label, aliases, defaults: {
        'desktop:macos': { code, modifiers }, 'desktop:windows': { code, modifiers }, 'desktop:linux': { code, modifiers },
        'web:macos': { code, modifiers: webModifiers }, 'web:windows': { code, modifiers: webModifiers },
      },
      regions: ['page', 'editable'], modals: ['sidebar'], resolve,
    }), `ui-workspace: ${id}`)
  }
  register('session.new', () => t('session.new'), ['new session', 'new chat'], 'KeyN', ['primary'], ['primary', 'alt'],
    () => ({ status: 'handled', run: () => { navigation.startSession() } }))
  register('session.search', () => t('search.sessions.aria'), ['search sessions'], 'KeyK', ['primary'], ['primary', 'alt'],
    () => ({ status: 'handled', run: controls.search }))
  register('workspace.add', () => t('workspace.add'), ['add workspace', 'open folder'], 'KeyO', ['primary'], ['primary', 'alt'],
    () => {
      const reason = addReason()
      return reason === null ? { status: 'handled', run: controls.add } : { status: 'blocked', reason }
    })
  register('session.rename', () => t('rename.session.title'), ['rename session'], 'KeyG', ['primary', 'alt'], ['primary', 'alt'], (context) => {
    const target = current()
    return target === undefined || target.blank || (context.modal !== null && context.modal !== 'sidebar') || ctx.layout.panelInfo.getSnapshot().activePanelId !== null
      ? { status: 'blocked', reason: t('shortcut.noSession') }
      : { status: 'handled', run: () => { controls.rename(target.id, target.title?.trim() ?? '') } }
  })
  register('session.fork', () => t('menu.fork'), ['fork session'], 'KeyF', ['primary', 'alt'], ['primary', 'shift'], () => {
    const target = current()
    if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
    if (target.blank) return { status: 'blocked', reason: t('shortcut.noCompletedTurn') }
    return { status: 'handled', run: () => {
      // The main view owns history opening for this target.
      void navigation.forkSession(target.id).catch((error: unknown) => {
        // Client plugin bundles do not share error-class identity.
        const unavailable = error instanceof Error && error.name === 'SessionForkError'
          && (error as SessionForkError).rpcError.code === 'session/fork-unavailable'
        reportForkFailure(unavailable ? 'unavailable' : 'failed')
        if (!unavailable) console.warn('session fork rejected:', error)
      })
    } }
  })
  register('session.archive', () => t('menu.archiveSession'), ['archive session'], 'KeyA', ['primary', 'shift'], ['primary', 'alt'], () => {
    const target = current()
    return target === undefined ? { status: 'blocked', reason: t('shortcut.noSession') }
      : { status: 'handled', run: () => {
        archiveSession(target.id)
      } }
  })
  ctx.effect(() => ctx.shortcuts.register({
    id: 'session.toggleRead' as ShortcutCommandId,
    label: () => t('shortcut.toggleRead'), aliases: ['mark as read', 'mark as unread', 'toggle unread'],
    defaults: {
      'desktop:macos': { code: 'KeyU', modifiers: ['primary', 'shift'] },
      'desktop:windows': { code: 'KeyU', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyU', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyU', modifiers: ['primary', 'shift'] },
    },
    regions: ['page', 'editable'], modals: [],
    resolve: (context) => {
      const target = current()
      if (target === undefined || target.blank) return { status: 'blocked', reason: t('shortcut.noSession') }
      // Like the row menu, a Peer that may not mark reading has no reading command.
      if (!ctx.remoteAccess.source('session', target.id, 'sessionStatus/mark').getSnapshot()) return { status: 'pass' }
      if (context.modal !== null) return { status: 'blocked', reason: t('shortcut.closeDialog') }
      if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return { status: 'blocked', reason: t('shortcut.closePanel') }
      if (ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(target.id)) {
        return { status: 'blocked', reason: t('shortcut.archivedReading') }
      }
      const status = ctx.uiSession.sessionStatus
      if (!status.readingReady.getSnapshot()) return { status: 'blocked', reason: t('shortcut.readingUnavailable') }
      const unread = status.getSnapshot().get(target.id)?.completionUnread === true
      return { status: 'handled', run: () => { markSession(target.id, !unread) } }
    },
  }), 'ui-workspace: session.toggleRead')
}
