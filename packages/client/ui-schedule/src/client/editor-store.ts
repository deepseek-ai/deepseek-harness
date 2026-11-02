/** Unsaved task forms survive navigation without persisting business records. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { TaskEditorDraft } from './TaskEditorFields.tsx'
import type { HostEditFailure, TaskCreateOutcome } from './TaskDetail.tsx'

type EditorFailure = HostEditFailure | Extract<TaskCreateOutcome, { failed: string }>['failed']

interface EditorDraft {
  readonly draft: TaskEditorDraft
  readonly base: ScheduleCatalogEntry | undefined
  readonly initial?: TaskEditorDraft
  readonly pending?: boolean
  readonly failure?: EditorFailure
}

interface EditorState {
  drafts: Record<string, EditorDraft | undefined>
}

const editorActions = {
  setDraft: (state: EditorState, key: string, draft: EditorDraft) => { state.drafts[key] = draft },
  clearDraft: (state: EditorState, key: string) => {
    state.drafts = Object.fromEntries(Object.entries(state.drafts).filter(([id]) => id !== key))
  },
}

/**
 * Declare drafts retained by the framework for one entry's scope.
 * @returns the entry's store handle.
 */
export function createEditorStore(): EngineStoreHandle<EditorState, typeof editorActions> {
  return defineStore({
    init: (): EditorState => ({ drafts: {} }),
    actions: editorActions,
  })
}

/** Framework-bound selectors and actions; components never receive the store itself. */
export type TaskEditorStoreProps = PropsStore<ReturnType<typeof createEditorStore>>
