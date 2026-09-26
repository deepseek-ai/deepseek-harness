/** Shortcut reference visibility and search state, shared by its entry points. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

type State = { open: boolean; query: string; focusRequest: number }
type Actions = { open(draft: State): void; close(draft: State): void; search(draft: State, query: string): void }

/**
 * Declare the reference dialog store.
 * @returns root-scoped visibility, focus request, and search actions.
 */
export function createShortcutsStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ open: false, query: '', focusRequest: 0 }),
    actions: {
      open: (d) => { d.open = true; d.focusRequest++ },
      close: (d) => { d.open = false; d.query = '' },
      search: (d, query: string) => { d.query = query },
    },
  })
}
