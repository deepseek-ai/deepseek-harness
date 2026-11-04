/** Single-popup viewing state and feedback retained outside trigger components. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MenuActionView, MenuPoint, ContextMenuTarget } from './types.ts'

interface Notice { id: number; text: string; success: boolean; action?: { label: string; onClick: () => void } }
interface MenuState {
  occurrence: number
  closing: boolean
  replacing: boolean
  target: ContextMenuTarget | null
  point: MenuPoint
  items: readonly MenuActionView[]
  notice: Notice | null
}
type MenuActions = {
  open(draft: MenuState, target: ContextMenuTarget, point: MenuPoint): void
  items(draft: MenuState, items: readonly MenuActionView[]): void
  exit(draft: MenuState, replacing: boolean): void
  close(draft: MenuState): void
  notify(draft: MenuState, notice: Notice | null): void
}

/**
 * Create the root popup store.
 * @returns the presentation and its mutation actions.
 */
export function createMenuStore(): EngineStoreHandle<MenuState, MenuActions> {
  return defineStore<MenuState, MenuActions>({
    init: () => ({ occurrence: 0, closing: false, replacing: false, target: null, point: { x: 0, y: 0 }, items: [], notice: null }),
    actions: {
      open(draft, target, point) {
        draft.occurrence++; draft.closing = false; draft.replacing = false
        draft.target = target; draft.point = point; draft.items = []
      },
      items(draft, items) { draft.items = items },
      exit(draft, replacing) { draft.closing = true; draft.replacing = replacing },
      close(draft) { draft.target = null; draft.items = [] },
      notify(draft, notice) { draft.notice = notice },
    },
  })
}
