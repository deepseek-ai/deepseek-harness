/** Office bodies retained until their owning tab occurrence closes. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PreviewProps } from './Preview.tsx'

/** One stable portal target; attachment changes do not replace its React tree. */
export interface RetainedOfficeView {
  readonly key: number
  readonly target: HTMLDivElement
  readonly props: PreviewProps
  readonly attached: boolean
}

/** Plugin-owned Office bodies, keyed by the tab occurrence's abort signal. */
export class RetainedOfficeViews implements ObservableSnapshot<readonly RetainedOfficeView[]> {
  private readonly held = new Map<AbortSignal, {
    view: RetainedOfficeView
    abort: () => void
    scroll?: { left: number; top: number }
  }>()
  private readonly listeners = new Set<() => void>()
  private current: readonly RetainedOfficeView[] = []
  private nextKey = 0
  private disposed = false
  constructor(private readonly onError: (error: unknown) => void = console.error) {}
  /** Read the retained bodies. @returns Stable snapshot until attachment or props change. */
  readonly getSnapshot: () => readonly RetainedOfficeView[] = () => this.current
  /** Observe body ownership. @param listener - Store observer. @returns Observer disposer. */
  readonly subscribe: (listener: () => void) => () => void = (listener) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify(): void {
    this.current = [...this.held.values()].map(({ view }) => view)
    for (const listener of this.listeners) {
      try { listener() } catch (error) { this.onError(error) }
    }
  }
  /** Attach an open tab's body without replacing its document or local state.
   * @param signal - Tab occurrence lifetime; abort releases the retained body.
   * @param mount - Currently mounted sidebar container.
   * @param props - Framework-bound document hooks and renderer callbacks.
   * @returns Detach only; the tab occurrence still owns its body.
   */
  attach(signal: AbortSignal, mount: HTMLDivElement, props: PreviewProps): () => void {
    if (signal.aborted || this.disposed) return () => {}
    let entry = this.held.get(signal)
    if (entry === undefined) {
      const target = mount.ownerDocument.createElement('div')
      target.style.cssText = 'height:100%;min-height:0'
      const abort = (): void => {
        this.held.delete(signal)
        target.remove()
        this.notify()
      }
      entry = { view: { key: ++this.nextKey, target, props, attached: true }, abort }
      this.held.set(signal, entry)
      signal.addEventListener('abort', abort, { once: true })
    } else entry.view = { ...entry.view, props, attached: true }
    mount.append(entry.view.target)
    const viewport = entry.view.target.querySelector<HTMLElement>('[data-office-viewport]')
    if (viewport !== null && entry.scroll !== undefined) {
      viewport.scrollLeft = entry.scroll.left
      viewport.scrollTop = entry.scroll.top
    }
    this.notify()
    const owned = entry
    return () => {
      if (this.held.get(signal) !== owned || owned.view.target.parentElement !== mount) return
      const viewport = owned.view.target.querySelector<HTMLElement>('[data-office-viewport]')
      if (viewport !== null) owned.scroll = { left: viewport.scrollLeft, top: viewport.scrollTop }
      owned.view.target.remove()
      owned.view = { ...owned.view, attached: false }
      this.notify()
    }
  }
  /** Refresh a mounted body's callbacks without changing its attempt.
   * @param signal - Tab occurrence lifetime.
   * @param props - Latest framework-bound document props.
   */
  update(signal: AbortSignal, props: PreviewProps): void {
    const entry = this.held.get(signal)
    if (entry === undefined || (Object.keys(entry.view.props).length === Object.keys(props).length
      && Object.keys(props).every(key => entry.view.props[key as keyof PreviewProps] === props[key as keyof PreviewProps]))) return
    entry.view = { ...entry.view, props }
    this.notify()
  }
  /** Drop every body when the Office plugin unloads. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [signal, { view, abort }] of this.held) {
      signal.removeEventListener('abort', abort)
      view.target.remove()
    }
    this.held.clear()
    this.notify()
  }
}
