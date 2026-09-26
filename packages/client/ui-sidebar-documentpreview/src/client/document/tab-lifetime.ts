/** Document view state belongs to tab records, including while their bodies are hidden. */
import type { Context } from '@deepseek-ai/cordis'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

/**
 * Release retained view state on tab closure or plugin disposal.
 * @param ctx - owning preview plugin context.
 * @returns a callback accepting the tab, its lifetime signal, and its store's forget action; repeated holds share one listener.
 */
export function retainDocumentTabs(ctx: Context): (tabId: TabId, signal: AbortSignal, forget: (tabId: TabId) => void) => void {
  const retained = new Map<AbortSignal, () => void>()
  ctx.effect(() => () => { for (const forget of retained.values()) forget() })
  return (tabId, signal, forgetTab) => {
    if (signal.aborted) { forgetTab(tabId); return }
    if (retained.has(signal)) return
    const forget = (): void => {
      signal.removeEventListener('abort', forget)
      retained.delete(signal)
      forgetTab(tabId)
    }
    retained.set(signal, forget)
    signal.addEventListener('abort', forget, { once: true })
  }
}
