/** Plugin page selection shared by the page and cross-plugin navigation. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/**
 * The main or additional plugin list, or one bundle, official item, or bundle row of the Installed tab. A bundle or row
 * opened from a contributed tab names it in `returnTab`, and the bundle page's back returns to that tab's list.
 */
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'more' }
  | { readonly kind: 'package'; readonly name: string; readonly from?: 'more'; readonly returnTab?: string }
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'row'; readonly name: string; readonly rowId: string; readonly from?: 'more'; readonly returnTab?: string }

/** `installed` is the page's own tab; any other value is the id of a `plugins.tab` entry. */
type NavigationState = { view: View; tab: string }
type NavigationActions = {
  setView: (draft: NavigationState, view: View) => void
  setTab: (draft: NavigationState, tab: string) => void
}

/**
 * Create plugin page selection before the first page render.
 * @returns the registration-owned navigation store handle.
 */
export function createNavigationStore(): EngineStoreHandle<NavigationState, NavigationActions> {
  return defineStore({
    init: (): NavigationState => ({ view: { kind: 'list' }, tab: 'installed' }),
    actions: {
      setView: (draft, view: View) => { draft.view = view },
      setTab: (draft, tab: string) => { draft.tab = tab },
    },
  })
}
