import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { IntervalReport, Task, Tree } from '../records.ts'
import type { EditableSettings } from './Settings.tsx'
import type { DetailTarget } from './navigation.ts'

/** One unsaved discussion and its request identity across navigation. */
export interface AnnotationDraft {
  open: boolean
  text: string
  id: string | null
  busy: boolean
  messageKey: 'annotationSaved' | 'annotationNotifyFailed' | 'annotationSaveFailed' | null
}

/** Initial state before a discussion editor has been opened. */
export const emptyDraft: AnnotationDraft = { open: false, text: '', id: null, busy: false, messageKey: null }

/** The current discussion draft and its target-scoped update. */
export interface AnnotationDraftControl {
  draft: AnnotationDraft
  update: (patch: Partial<AnnotationDraft>) => void
}

/** Session view state shared by the dock, sidebar, and tool cards. */
export interface ViewState {
  tree: Tree['id'] | null
  collapsed: Record<string, Task['id'][]>
  zoom: number | null
  /** Null follows the first available level. All gives the columns equal widths. */
  level: number | 'all' | null
  /** A positive offset in live mode keeps the newest report in view. */
  scrollMs: number
  scrollLeft: number
  /** An explicit history position, or null to follow live reports. */
  anchor: number | null
  /** The last report present when the user entered history. Null means the list was empty. */
  historyReport: IntervalReport['id'] | null | undefined
  tab: 'tasks' | 'timeline'
  historyOpen: boolean
  details: Record<'tasks' | 'timeline', { target: DetailTarget; scrollTop: number }[]>
  drafts: Record<string, AnnotationDraft>
}

/**
 * Session-scoped viewing state, owned and instantiated by slot registration.
 * @returns a handle that creates independent session views.
 */
export function createViewStore(): EngineStoreHandle<ViewState, {
  open: (state: ViewState, tree: Tree['id'], task?: Task['id']) => void
  forgetTree: (state: ViewState, tree: Tree['id']) => void
  update: (state: ViewState, patch: Partial<ViewState>) => void
  toggle: (state: ViewState, tree: Tree['id'], id: Task['id']) => void
  draft: (state: ViewState, key: string, patch: Partial<AnnotationDraft>) => void
}> {
  return defineStore({
    init: (): ViewState => ({
      tree: null,
      collapsed: {},
      zoom: null,
      level: null,
      scrollMs: 0,
      scrollLeft: 0,
      anchor: null,
      historyReport: undefined,
      tab: 'tasks',
      historyOpen: false,
      details: { tasks: [], timeline: [] },
      drafts: {},
    }),
    actions: {
      open: (state, tree: Tree['id'], task?: Task['id']) => {
        state.tree = tree
        state.tab = 'tasks'
        state.details.tasks =
          task === undefined ? [] : [{ target: { kind: 'task', tree, task }, scrollTop: 0 }]
      },
      forgetTree: (state, tree: Tree['id']) => {
        if (state.tree === tree) state.tree = null
        for (const tab of ['tasks', 'timeline'] as const) {
          state.details[tab] = state.details[tab].filter(
            ({ target }) => target.kind !== 'task' || target.tree !== tree,
          )
        }
      },
      update: (state, patch: Partial<ViewState>) => {
        Object.assign(state, patch)
      },
      draft: (state, key: string, patch: Partial<AnnotationDraft>) => {
        state.drafts = { ...state.drafts, [key]: { ...emptyDraft, ...state.drafts[key], ...patch } }
      },
      toggle: (state, tree: Tree['id'], id: Task['id']) => {
        const collapsed = Object.hasOwn(state.collapsed, tree) ? state.collapsed[tree] : undefined
        state.collapsed = {
          ...state.collapsed,
          [tree]: collapsed?.includes(id) ? collapsed.filter(item => item !== id) : [...(collapsed ?? []), id],
        }
      },
    },
  })
}

/** Unsaved settings and the current editor selection. */
export interface SettingsState {
  draft: EditableSettings | null
  revision: number | undefined
  level: number
  units: ('minute' | 'hour')[]
  saving: boolean
  messageKey: 'saved' | 'saveFailed' | null
}

/**
 * Keep unsaved edits across panel navigation; the official settings service owns accepted values.
 * @returns a handle that creates a settings editor store.
 */
export function createSettingsStore(): EngineStoreHandle<SettingsState, {
  update: (state: SettingsState, patch: Partial<SettingsState>) => void
}> {
  return defineStore({
    init: (): SettingsState => ({
      draft: null,
      revision: undefined,
      level: -1,
      units: [],
      saving: false,
      messageKey: null,
    }),
    actions: {
      update: (state, patch: Partial<SettingsState>) => {
        Object.assign(state, patch)
      },
    },
  })
}
