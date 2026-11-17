import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { Panel } from './Panel.tsx'
import type { PanelInjected } from './Panel.tsx'
import { TaskDock } from './TaskDock.tsx'
import type { TaskDockInjected } from './TaskDock.tsx'
import { createSettingsStore, createViewStore } from './store.ts'
import { Settings } from './Settings.tsx'
import { TimelineIcon } from './TimelineIcon.tsx'
import { TaskCard } from './TaskCard.tsx'
import type { TaskCardInjected } from './TaskCard.tsx'
import type { SettingsInjected } from './Settings.tsx'
import { dictionaries } from './locales.ts'
import './timeline.css'
import { appLanguage, minuteAt, TIMELINE_CONFIG_ID } from '../policy.ts'
import { startMinuteClock } from './clock.ts'
import type { Config } from '../config.ts'
import { createTaskRequester } from './actions.ts'
import { TIMELINE_CHANNEL, TIMELINE_LOCALE } from '../protocol.ts'

// Leave the conversation visible when the sidebar would take over a narrow window.
const SIDEBAR_AUTO_OPEN_QUERY = '(width > 768px)'

/** Client services required to mount Timeline. */
export const inject = [
  'slots',
  'locale',
  'sidebarRightTabs',
  'sidebarRight',
  'configForms',
  'connection',
  'sessions',
]

/**
 * Register Timeline's plugin settings, right sidebar, and composer strip.
 * @param ctx Client context.
 */
export function apply(ctx: Context): void {
  const id = '@deepseek-ai/dsh-timeline'
  const clock = createSnapshotStore(minuteAt(Date.now()))
  const selection = createSnapshotStore<SessionId | null>(null)
  ctx.effect(() => ctx.locale.register('timeline', dictionaries), 'timeline: labels')
  const t = ctx.locale.bind('timeline')
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => {
    const controller = new AbortController()
    let sent: string | undefined
    const sync = () => {
      if (connection.state.getSnapshot() !== 'connected') {
        sent = undefined
        return
      }
      const language = appLanguage(ctx.locale.getSnapshot().active)
      if (language === sent) return
      sent = language
      void connection.rpc.call(TIMELINE_CHANNEL, TIMELINE_LOCALE, language, controller.signal)
        .catch(() => undefined)
    }
    const stopConnection = connection.state.subscribe(sync)
    const stopLocale = ctx.locale.subscribe(sync)
    sync()
    return () => {
      stopLocale()
      stopConnection()
      controller.abort()
    }
  }, 'timeline: browser language')
  const sessions = ctx.get('sessions') as ISessions
  const sidebar = ctx.sidebarRight
  const isSidebarOpen = (sessionId: SessionId) =>
    sidebar.mounted.getSnapshot() === sessionId && sidebar.isExpanded() && sidebar.active()?.kind === 'timeline'
  const openTaskTree = (sessionId: SessionId) => {
    selection.set(sessionId)
    sidebar.openTabIn(sessionId, 'timeline')
  }
  const requests = createTaskRequester(sessions, connection, t)
  ctx.effect(() => () => requests.close(), 'timeline: task requests')
  ctx.inject(['commandUi'], (scope) => {
    scope.on('command/executed', (sessionId, name, result) => {
      if (name !== 'timeline' || result.kind !== 'success') return
      openTaskTree(sessionId)
    })
  })
  const settings = ctx.configForms.get<Config>(TIMELINE_CONFIG_ID)
  const viewStore = createViewStore()
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: 'timeline_tasks',
        locale: 'timeline',
        store: viewStore,
        inject: (sessionId, actions): TaskCardInjected => ({
          hooks: { settings, locale: ctx.locale },
          openTask: (tree, task) => {
            actions.open(tree, task)
            ctx.sidebarRight.openTabIn(sessionId, 'timeline')
          },
        }),
      },
      TaskCard,
    ),
  )
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: id,
        locale: 'timeline',
        store: createSettingsStore(),
        inject: (): SettingsInjected => ({
          hooks: { settings, locale: ctx.locale },
          save: (value, revision) => {
            const [intervalMs, ...higher] = value.periods
            if (intervalMs === undefined) return Promise.resolve(false)
            let previous = intervalMs
            const rollupFactors = higher.map((period) => {
              const factor = period / previous
              previous = period
              return factor
            })
            const next = {
              reportsEnabled: value.reportsEnabled,
              intervalMs,
              rollupFactors,
              language: value.language,
              progressDecimals: value.progressDecimals,
              segmentedProgress: value.segmentedProgress,
              allowTodo: value.allowTodo,
              autoOpenSidebar: value.autoOpenSidebar,
              reminderIterations: value.reminderIterations,
              taskPrompt: value.taskPrompt,
              summaryPrompt: value.summaryPrompt,
              levelPrompts: value.levelPrompts,
            }
            return settings.mutate(
              (Object.keys(next) as (keyof typeof next)[]).map(field => ({
                op: 'set',
                path: [field],
                value: next[field],
              })),
              revision,
            )
          },
        }),
      },
      Settings,
    ),
  )
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id,
        kind: 'timeline',
        priority: 'extension',
        title: () => t('title'),
        guide: [
          {
            id: 'timeline',
            order: 50,
            title: () => t('title'),
            description: () => t('guide'),
            icon: TimelineIcon,
          },
        ],
      }),
    'timeline: sidebar page',
  )
  ctx.effect(() => startMinuteClock((time) => { clock.set(time) }), 'timeline: minute clock')
  ctx.effect(() => {
    let stopProjection: (() => void) | undefined
    const observeSession = () => {
      stopProjection?.()
      stopProjection = undefined
      const sessionId = sidebar.mounted.getSnapshot()
      const source = sessionId === undefined ? undefined : sessions.binding(sessionId)?.session.projections.faceOf('timeline')
      if (sessionId === undefined || source === undefined) return
      let hasTree: boolean | undefined
      let firstTreePending = false
      const observeTree = () => {
        const view = source.getSnapshot()
        if (typeof view !== 'object' || view === null || !('trees' in view) || !Array.isArray(view.trees)) return
        if (hasTree !== true) {
          firstTreePending = hasTree === false && view.trees.length > 0
          hasTree = view.trees.length > 0
        }
        if (!firstTreePending) return
        // Wait for the accepted setting before opening a panel.
        const { status, value } = settings.getSnapshot()
        if (status === 'loading') return
        firstTreePending = false
        // A fullscreen sidebar would cover the conversation; the dock still opens it on request.
        if (
          value?.autoOpenSidebar === true &&
          view.trees.length > 0 &&
          !isSidebarOpen(sessionId) &&
          matchMedia(SIDEBAR_AUTO_OPEN_QUERY).matches
        ) {
          openTaskTree(sessionId)
        }
      }
      const stopTree = source.subscribe(observeTree)
      const stopSettings = settings.subscribe(observeTree)
      stopProjection = () => {
        stopTree()
        stopSettings()
      }
      observeTree()
    }
    const stopSession = sidebar.mounted.subscribe(observeSession)
    observeSession()
    return () => {
      stopSession()
      stopProjection?.()
    }
  }, 'timeline: first task tree')
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: id,
        locale: 'timeline',
        store: viewStore,
        inject: (sessionId): PanelInjected => ({
          hooks: { clock, settings, selection, locale: ctx.locale },
          consumeSelection: () => {
            if (selection.getSnapshot() === sessionId) selection.set(null)
          },
          requestTask: request => requests.send(sessionId, request),
          setPriority: request => requests.setPriority(sessionId, request),
          annotate: request => requests.annotate(sessionId, request),
          importTree: request => requests.importTree(sessionId, request),
          removeTree: tree => requests.removeTree(sessionId, tree),
        }),
      },
      Panel,
    ),
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'timeline',
        order: 20,
        locale: 'timeline',
        store: viewStore,
        inject: (sessionId): TaskDockInjected => ({
          hooks: { settings },
          removeTree: tree => requests.removeTree(sessionId, tree, true),
          toggleSidebar: (showingTree) => {
            if (showingTree && isSidebarOpen(sessionId)) sidebar.toggleExpanded()
            else sidebar.openTabIn(sessionId, 'timeline')
          },
        }),
      },
      TaskDock,
    ),
  )
}
