/**
 * Session-scoped draft state for the generic question composer. The Slot
 * registry owns store instances; this module exports only the factory so a
 * plugin reload cannot reuse a module-global handle.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** One in-progress answer, including an explicit skip. */
export interface QuestionDraftAnswer {
  /** Offered labels currently selected. */
  selected: string[]
  /** Human-authored alternative or additional answer. */
  custom: string
  /** Whether the user explicitly skipped this question. */
  skipped: boolean
}

/** Navigation and answer drafts for one pending request. */
export interface QuestionDraftProgress {
  /** Current question index. */
  index: number
  /** One draft per question, in request order. */
  drafts: QuestionDraftAnswer[]
  /** Local indefinite-wait choice restored with the draft. */
  wait?: 'editing' | 'waiting'
}

interface QuestionDraftState {
  progressByRequest: Record<string, QuestionDraftProgress>
}

type QuestionDraftActions = {
  replace: (draft: QuestionDraftState, requestKey: string, progress: QuestionDraftProgress) => void
  clear: (draft: QuestionDraftState, requestKey: string) => void
  prune: (draft: QuestionDraftState, keep: readonly string[]) => void
}

/**
 * Declare the question composer's Session store. Drafts persist per Session so
 * leaving the Session or restarting the Client does not erase an unfinished answer.
 * @returns a persisted store handle whose instance is owned by the Slot registry.
 */
export function createQuestionDraftStore(): EngineStoreHandle<QuestionDraftState, QuestionDraftActions> {
  return defineStore({
    init: (): QuestionDraftState => ({ progressByRequest: {} }),
    persist: 'dsh.user-questions.drafts.v1',
    actions: {
      replace: (draft, requestKey, progress) => {
        draft.progressByRequest[requestKey] = progress
      },
      clear: (draft, requestKey) => {
        draft.progressByRequest = Object.fromEntries(
          Object.entries(draft.progressByRequest).filter(([key]) => key !== requestKey),
        )
      },
      prune: (draft, keep) => {
        const live = new Set(keep)
        draft.progressByRequest = Object.fromEntries(
          Object.entries(draft.progressByRequest).filter(([key]) => live.has(key)),
        )
      },
    },
  })
}
