/** Registers the target-neutral Conversation assembly, shell, input, and docks. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconPaperclipOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore, type BoundActions } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only service and declaration merges used by this assembly.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ShortcutCommandId, ShortcutFixedCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import { UiConversation } from './conversation/assembly.ts'
import type { ViewTab } from './contract/views.ts'
import type {
  ComposerBarInjected, ConversationInjected, ConversationSessionHeaderInjected,
  ConversationSessionInjected, DraftFileUploads,
} from './contract/slots.ts'
import type { InputNotice } from './contract/input.ts'
import type { ReferenceInsert } from './contract/draft-editor.ts'
import { createConversationStore, readConversationViewPreference } from './stores.ts'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { relativizeToCwd, workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { ConversationController, UnsupportedImageMediaTypeError, isImageMediaType } from './service.ts'
import type { IConversation } from './service.ts'
import { ComposerBlockRegistry } from './input/blocks.ts'
import type { ComposerBlock } from './contract/composer-blocks.ts'
import { InputHub } from './input/hub.ts'
import { ComposerSubmissionPolicy } from './input/submission-policy.ts'
import { queueDockEntry } from './queue/QueueDock.tsx'
import { EnterBehaviorRow } from './settings/EnterBehaviorRow.tsx'
import type { EnterBehaviorRowInjected } from './settings/EnterBehaviorRow.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { ConversationContent } from './skeleton/ConversationContent.tsx'
import { ConversationPanel } from './skeleton/ConversationPanel.tsx'
import { ConversationHeader } from './skeleton/ConversationHeader.tsx'
import { ConversationSession, ConversationSessionHeader } from './skeleton/ConversationSession.tsx'
import { InputBar } from './skeleton/InputBar.tsx'
import { todoDockEntry } from './skeleton/TodoPanel.tsx'
import { installStopShortcut } from './stop-shortcut.ts'
import { TRAJECTORY_VIEW_ID, resolveActiveView } from './view-selection.ts'
import { en, NS, zh, type ConversationKey } from './locales.ts'
import { CONVERSATION_SETTINGS_NAMESPACE, type ConversationSettings } from '../submission-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Conversation shell, composer, queue, and dock copy. */
    conversation: ConversationKey
  }
}

/** Services required by the Conversation plugin. */
export const inject = [
  'slots', 'sessions', 'fileUpload', 'uiSession', 'uiWorkspace', 'locale', 'configForms',
]

/** Conversation runtime configuration. */
export interface Config {
  /** Maximum generic-file uploads allowed to run concurrently in browser Workers. */
  maxConcurrentFileUploads?: number
}

/** Validated Conversation runtime configuration. */
export const Config: z<Config> = z.object({
  maxConcurrentFileUploads: z.natural().min(1).default(2),
})

// Stable no-session sources keep the renderer's observable-hook cache and
// hook order unchanged across current-Session transitions.
const ABSENT_NOTICES = {
  getSnapshot: (): InputNotice | null => null,
  subscribe: () => () => {},
}
const ABSENT_BLOCK = {
  getSnapshot: (): ComposerBlock | undefined => undefined,
  subscribe: () => () => {},
}
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()
const ABSENT_LEXICON = {
  getSnapshot: () => EMPTY_LEXICON,
  subscribe: () => () => {},
}
const ABSENT_MENU_LAUNCHER = {
  getSnapshot: (): string | null => null,
  subscribe: () => () => {},
}
const EMPTY_FILE_UPLOADS: DraftFileUploads = {}
const ABSENT_FILE_UPLOADS = {
  getSnapshot: () => EMPTY_FILE_UPLOADS,
  subscribe: () => () => {},
}

/**
 * Browser-shell bridge reporting the harness-host path of a picked file. The
 * Desktop preload exposes it on the application document; a served Web page
 * has none, so every non-image file uploads there.
 */
interface HostPathBridge {
  /** Absolute harness-host path of one picked file, or empty when the shell has none for it. */
  pathFor(file: File): string
}

/** The shell-installed bridge, when this document runs inside the Desktop application. */
function hostPathBridge(): HostPathBridge | undefined {
  return (globalThis as { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
}

interface WorkspaceNavigation {
  openSession(sessionId: SessionId): void
  openWorkspace(
    workspaceId: Parameters<ConversationInjected['selectWorkspace']>[0],
    beforeOpen: (sessionId: SessionId) => void,
  ): Promise<void>
}

/** Action registration used by the composer without importing its command-UI consumer. */
interface FileCommandRegistry {
  register(contribution: {
    name: string
    label(): string
    icon: typeof IconPaperclipOutlineRegular
    available(session: { sessionId: SessionId }): boolean
    ui: { kind: 'action'; run(session: { sessionId: SessionId }): void }
  }): () => void
}

/** Resolve the session-scoped Conversation action face, failing loud. */
function scopedConversation(sessions: ISessions, id: SessionId): IConversation {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`ui-conversation: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) {
    throw new Error('ui-conversation: conversation service unavailable through the session scope')
  }
  return conversation
}

/** Resolve package-internal attachment operations from the public service. */
function concreteConversation(ctx: Context): ConversationController {
  const conversation = ctx.get('conversation') as ConversationController | undefined
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable')
  return conversation
}

/**
 * Mount the Conversation core and target-neutral presentation.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const sessions = ctx.sessions
  const slots = ctx.slots
  // Schemastery's field default is materialized before Cordis calls apply.
  const maxConcurrentFileUploads = config.maxConcurrentFileUploads as number
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  const uiConversation = new UiConversation(ctx, sessions)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-conversation: dictionaries')
  const t = ctx.locale.bind(NS)
  const conversationStore = createConversationStore()
  const submissionPolicy = new ComposerSubmissionPolicy(
    ctx.configForms.get<ConversationSettings>(CONVERSATION_SETTINGS_NAMESPACE),
  )

  ctx.effect(() => () => { submissionPolicy.dispose() })

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'composer-enter',
    order: 20,
    locale: NS,
    inject: (): EnterBehaviorRowInjected => ({
      hooks: { busyEnter: submissionPolicy.busyEnter },
      setBusyEnter: (behavior) => { submissionPolicy.setBusyEnter(behavior) },
    }),
  }, EnterBehaviorRow))

  const viewTabs = (): ViewTab[] => {
    const tabs: ViewTab[] = []
    for (const entry of slots.entries('conversation.view')) {
      /* v8 ignore next -- list registration validates id at load. */
      if (entry.options.id === undefined) continue
      if (!ctx.configForms.developerTools.enabled.getSnapshot() && entry.options.id === TRAJECTORY_VIEW_ID) continue
      tabs.push({
        id: entry.options.id,
        label: resolveSlotLabel(entry.options.label) ?? entry.options.id,
      })
    }
    return tabs
  }
  const activateView = (sessionId: SessionId, preferred: string | null): void => {
    const active = resolveActiveView(viewTabs(), preferred)
    if (active !== undefined) uiConversation.binding(sessionId).activate(active.id)
  }
  const restoreView = (sessionId: SessionId): void => {
    activateView(sessionId, readConversationViewPreference(sessionId))
  }
  const conversationViews = createSnapshotStore<readonly ViewTab[]>(viewTabs())
  const bindings = new Set<SessionBinding>()
  const trackedBindings = new WeakSet<SessionBinding>()
  const trackBinding = (binding: SessionBinding): void => {
    if (trackedBindings.has(binding)) return
    trackedBindings.add(binding)
    bindings.add(binding)
    binding.ctx.effect(() => () => { bindings.delete(binding) }, 'ui-conversation: active Provider binding')
  }
  const refreshViews = (): void => {
    const current = conversationViews.getSnapshot()
    const next = viewTabs()
    const unchanged = current.length === next.length
      && current.every((tab, index) => {
        const candidate = next.at(index)
        return candidate !== undefined && tab.id === candidate.id && tab.label === candidate.label
      })
    if (!unchanged) conversationViews.set(next)
    for (const binding of bindings) restoreView(binding.sessionId)
  }
  ctx.effect(() => {
    const disposeViews = slots.subscribe('conversation.view', refreshViews)
    const disposeLocale = ctx.locale.subscribe(refreshViews)
    const disposeDeveloperTools = ctx.configForms.developerTools.enabled.subscribe(refreshViews)
    return () => {
      disposeDeveloperTools()
      disposeLocale()
      disposeViews()
    }
  }, 'ui-conversation: View selection')

  const stop = (sessionId: SessionId): void => {
    scopedConversation(sessions, sessionId).cancel().catch((_error: unknown) => {
      // Stop failure is published through Session promptError.
    })
  }
  const stopShortcut = createSnapshotStore<readonly string[]>([])
  ctx.inject(['shortcuts'], (scope) => {
    const fixedInputs: readonly ShortcutFixedCommand[] = [
      { id: 'fixed.send' as ShortcutCommandId, label: () => t('input.send'), keys: ['Enter'],
        bindings: [{ code: 'Enter', modifiers: [] }], group: 'input' },
      { id: 'fixed.newline' as ShortcutCommandId, label: () => t('shortcut.newline'),
        keys: scope.shortcuts.describeBinding({ code: 'Enter', modifiers: ['shift'] }).keys,
        bindings: [{ code: 'Enter', modifiers: ['shift'] }], group: 'input' },
      { id: 'fixed.complementary' as ShortcutCommandId, label: () => t('shortcut.complementary'),
        keys: scope.shortcuts.describeBinding({ code: 'Enter', modifiers: ['primary'] }).keys,
        bindings: [{ code: 'Enter', modifiers: ['control'] }, { code: 'Enter', modifiers: ['meta'] }], group: 'input' },
      { id: 'fixed.slash' as ShortcutCommandId, label: () => t('shortcut.slash'), keys: ['/'],
        bindings: [{ code: 'Slash', modifiers: [] }], group: 'input' },
      { id: 'fixed.mention' as ShortcutCommandId, label: () => t('shortcut.mention'), keys: ['@'],
        bindings: [{ code: 'Digit2', modifiers: ['shift'] }], group: 'input' },
    ]
    for (const command of fixedInputs) {
      scope.effect(() => scope.shortcuts.registerFixed(command), `ui-conversation: ${command.id}`)
    }
    scope.effect(() => installStopShortcut(
      scope.shortcuts, sessions, binding => uiConversation.binding(binding).openTurn, ctx.uiSession, stop,
    ), 'ui-conversation: fixed stop input')
    scope.effect(() => {
      const command: ShortcutFixedCommand = {
        id: 'response.stop' as ShortcutCommandId, label: () => t('input.stop'), keys: ['Esc', 'Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'input',
      }
      const dispose = scope.shortcuts.registerFixed(command)
      stopShortcut.set(command.keys)
      return () => { stopShortcut.set([]); dispose() }
    }, 'ui-conversation: fixed stop reference')
  })

  const inputHub = new InputHub(ctx, t)
  const composerBlocks = new ComposerBlockRegistry()

  ctx.inject(['commandUi'], (scope) => {
    const commands = scope.get('commandUi') as FileCommandRegistry
    scope.effect(() => commands.register({
      name: 'file',
      label: () => t('input.file'),
      icon: IconPaperclipOutlineRegular,
      available: session => inputHub.canPickFiles(session.sessionId),
      ui: { kind: 'action', run: (session) => { inputHub.pickFiles(session.sessionId) } },
    }), 'ui-conversation: File action')
  })

  // Conversation assembly and input share the Session binding lifecycle. The
  // source roster is installed before any consuming Slot entry.
  ctx.uiSession.provide({
    hooks: ['conversation', 'input'],
    props: ['inputActions'],
    resolve: (binding) => {
      trackBinding(binding)
      const shell = inputHub.shellFor(binding)
      const conversation = uiConversation.binding(binding)
      restoreView(binding.sessionId)
      return {
        hooks: {
          conversation: conversation.snapshot,
          input: shell.state,
        },
        props: { inputActions: shell.actions },
      }
    },
  })

  const registerConversationRoot = () => slots.register({
    name: 'main.conversation',
    children: {
      'conversation.header': { kind: 'single', scope: 'session-maybe' },
    },
  }, ConversationRoot)

  const registerConversationContent = () => slots.registerFactory({
    name: 'conversation.content',
    scope: 'session-maybe',
    locale: NS,
    children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
      'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' },
    },
    slots: {
      views: { scope: 'session' },
      widthControls: { scope: 'root' },
    },
    inject: (sessionId: SessionId | undefined): ConversationInjected => ({
      hooks: {
        composerBlock: sessionId === undefined ? ABSENT_BLOCK : composerBlocks.storeFor(sessionId),
      },
      selectWorkspace: workspaceId => workspaceNavigation.openWorkspace(workspaceId, (nextId) => {
        if (sessionId !== undefined && nextId !== sessionId) {
          const from = inputHub.shell(sessionId)
          const draft = from.snapshot.draft
          const attachmentIds = from.snapshot.attachmentIds
          const next = inputHub.shell(nextId)
          if (attachmentIds.length === 0 || next.addAttachments(attachmentIds)) {
            if (sessions.binding(nextId) === undefined) {
              throw new Error(`ui-conversation: session "${nextId}" resolved no binding`)
            }
            concreteConversation(ctx).rebindDraftFiles(nextId, attachmentIds)
            if (draft !== '') {
              next.setDraft(draft)
              from.setDraft('')
            }
            if (attachmentIds.length > 0) {
              for (const id of attachmentIds) from.removeAttachment(id)
            }
          }
        }
      }),
    }),
  }, ConversationContent)

  const registerConversationSession = () => slots.register({
    name: 'conversation.session',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
    },
    store: conversationStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof conversationStore>): ConversationSessionInjected => {
      const openView = (view: string, focus: string): void => {
        if (!viewTabs().some(tab => tab.id === view)) return
        activateView(sessionId, view)
        actions.openView(view, focus)
      }
      const inspectionTarget = () => uiConversation.views.entries().find(definition =>
        definition.toolCallFocus !== undefined
        && conversationViews.getSnapshot().some(view => view.id === definition.target),
      )
      const inspectCall = (callId: string): void => {
        const target = inspectionTarget()
        if (target?.toolCallFocus !== undefined) openView(target.target, target.toolCallFocus(callId))
      }
      return {
        hooks: {
          conversationViews,
          inspectCall: {
            getSnapshot: () => inspectionTarget() === undefined ? undefined : inspectCall,
            subscribe: (listener) => {
              const disposeViews = conversationViews.subscribe(listener)
              const disposeDefinitions = uiConversation.views.subscribe(listener)
              return () => { disposeViews(); disposeDefinitions() }
            },
          },
        },
        bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
        openView,
      }
    },
  }, ConversationSession)

  const registerHeader = () => slots.register({
    name: 'conversation.header',
    children: {
      'conversation.header.leading': { kind: 'single', scope: 'root' },
      'conversation.session.header': { kind: 'single', scope: 'session' },
    },
  }, ConversationHeader)

  const registerSessionHeader = () => slots.register({
    name: 'conversation.session.header',
    locale: NS,
    children: {
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.session.header.corner': { kind: 'single', scope: 'session' },
    },
    store: conversationStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof conversationStore>): ConversationSessionHeaderInjected => ({
      hooks: { conversationViews },
      open: (id) => { workspaceNavigation.openSession(id) },
      selectView: (view) => {
        activateView(sessionId, view)
        actions.setView(view)
      },
    }),
  }, ConversationSessionHeader)

  const registerComposerBar = () => slots.register({
    name: 'conversation.composer.bar',
    locale: NS,
    children: {
      'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'conversation.input.permission': { kind: 'single', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
      'conversation.input.activity': { kind: 'single', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
    },
    inject: (sessionId: SessionId | undefined): ComposerBarInjected => {
      if (sessionId === undefined) {
        return {
          keyboard: undefined,
          addFiles: undefined,
          removeAttachment: undefined,
          resolveDraftAttachments: undefined,
          retryFileUpload: undefined,
          toggleCommandMenu: undefined,
          stop: undefined,
          hooks: {
            stopShortcut,
            busyEnter: submissionPolicy.busyEnter,
            fileUploads: ABSENT_FILE_UPLOADS,
            notices: ABSENT_NOTICES,
            lexicon: ABSENT_LEXICON,
            menuLauncher: ABSENT_MENU_LAUNCHER,
          },
        }
      }
      const conversation = concreteConversation(ctx)
      const shell = inputHub.shell(sessionId)
      const inputTriggers = inputHub.inputTriggers(sessionId)
      const bridge = hostPathBridge()
      return {
        keyboard: shell,
        addFiles: (files, directories = new Set()) => {
          if (sessions.binding(sessionId) === undefined) return t('file.sessionUnavailable')
          if (shell.snapshot.phase === 'adjudicating' || shell.snapshot.phase === 'submitting') {
            return t('attachment.dropBlocked')
          }
          const uploads: File[] = []
          const references: ReferenceInsert[] = []
          const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
          for (const file of files) {
            const directory = directories.has(file)
            if (bridge === undefined && directory) return t('attachment.directoryDesktopOnly')
            const path = bridge?.pathFor(file) ?? ''
            if (directory && path === '') return t('attachment.pathUnavailable')
            if (path === '' || (!directory && isImageMediaType(file.type))) {
              uploads.push(file)
              continue
            }
            const relative = relativizeToCwd(path, cwd)
            // A completed directory chip needs closed quotes; the directory grammar keeps them open for drill.
            const mention = formatFileMention({ path: directory ? `${relative}/` : relative, kind: 'file' }, false)
            if (mention === undefined) return t('attachment.pathUnsupported')
            const label = workspaceTitleOf(path) || file.name
            references.push({
              source: 'reference', ref: mention, label: directory ? `${label}/` : label,
              appearance: directory ? 'folder' : 'file', clipboardText: mention,
            })
          }
          try {
            const drafts = conversation.createDrafts(sessionId, uploads)
            if (!shell.addFiles(references, drafts.map(draft => draft.id))) {
              conversation.releaseDraftAttachments(drafts)
              return t('attachment.dropBlocked')
            }
            return null
          } catch (error: unknown) {
            if (error instanceof UnsupportedImageMediaTypeError) return t('image.unsupportedType')
            return error instanceof Error ? error.message : String(error)
          }
        },
        removeAttachment: (id) => {
          if (shell.removeAttachment(id)) conversation.releaseDraftAttachment(id)
        },
        resolveDraftAttachments: ids => conversation.resolveDraftAttachments(ids),
        retryFileUpload: (id) => {
          if (sessions.binding(sessionId) !== undefined) conversation.retryFileUpload(sessionId, id)
        },
        toggleCommandMenu: inputTriggers === undefined
          ? undefined
          : (selection) => {
            shell.dismissPopup()
            const snapshot = shell.snapshot
            inputTriggers.toggleSource('command', {
              trigger: '/',
              query: '',
              quoted: false,
              position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
              span: { ...selection, draftRev: snapshot.draftRev },
            })
          },
        stop: () => { stop(sessionId) },
        hooks: {
          stopShortcut,
          busyEnter: submissionPolicy.busyEnter,
          fileUploads: conversation.fileUploads,
          notices: shell.notices,
          lexicon: shell.lexicon,
          menuLauncher: inputTriggers?.launcher ?? ABSENT_MENU_LAUNCHER,
        },
      }
    },
  }, InputBar)

  slots.inject('main', function* () {
    yield slots.register({
      name: 'main',
      key: 'conversation',
      children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } },
    }, ConversationPanel)
    yield registerConversationRoot()
    yield registerConversationContent()
    yield registerConversationSession()
    yield registerHeader()
    yield registerSessionHeader()
    yield registerComposerBar()
  })

  ctx.plugin(ConversationController, {
    input: inputHub,
    blocks: composerBlocks,
    maxConcurrentFileUploads,
  })
  ctx.plugin(todoDockEntry)
  ctx.plugin(queueDockEntry)
}
