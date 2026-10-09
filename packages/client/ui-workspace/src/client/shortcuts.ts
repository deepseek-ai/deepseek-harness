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
  readonly forkError: { readonly reason: 'unavailable' | 'failed'; readonly seq: number } | null
}

interface WorkspaceShortcutControls {
  state: SnapshotStore<WorkspaceShortcutState>
  search: () => void
  add: () => void
  closeAdd: () => void
  directoryBusy: (busy: boolean) => void
  rename: (sessionId: SessionId, currentTitle: string) => void
  closeRename: () => void
  forkFailed: (reason: 'unavailable' | 'failed') => void
  dismissForkError: () => void
}

/**
 * Create the private browser request source shared by commands and controls.
 * @returns observable state and its complete mutation callbacks.
 */
export function createWorkspaceShortcutControls(): WorkspaceShortcutControls {
  const state = createSnapshotStore<WorkspaceShortcutState>({
    searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null, forkError: null,
  })
  let forkErrorSeq = 0
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
    forkFailed: (reason) => {
      forkErrorSeq += 1
      state.set({ ...state.getSnapshot(), forkError: { reason, seq: forkErrorSeq } })
    },
    dismissForkError: () => { state.set({ ...state.getSnapshot(), forkError: null }) },
  }
}

/**
 * Register navigation commands against the existing workspace owner.
 * Rename requires a nonblank main Conversation with no modal obscuring it.
 * @param ctx - plugin context with the shortcut, locale, and model services.
 * @param navigation - session creation and forking from the pointer controls' navigation service.
 * @param controls - browser-owned opening requests.
 * @param archiveSession - shared archive action, including running-work confirmation and notices.
 */
export function installWorkspaceShortcuts(
  ctx: Context,
  navigation: Pick<UiWorkspace, 'startSession' | 'forkSession'>,
  controls: ReturnType<typeof createWorkspaceShortcutControls>,
  archiveSession: (sessionId: SessionId) => void,
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
      regions: ['page', 'editable'], modals: [], resolve,
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
    return target === undefined || target.blank || context.modal !== null || ctx.layout.panelInfo.getSnapshot().activePanelId !== null
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
        controls.forkFailed(unavailable ? 'unavailable' : 'failed')
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
}
