/** Bounded, application-known history used only by the iframe provider. */
import type { BrowserTarget } from './url.ts'
import type { BrowserHistoryEntry, BrowserTabState } from './BrowserPersistence.ts'

/** Maximum retained application-known navigation entries per tab. */
export const MAX_BROWSER_HISTORY = 100

/**
 * Owns the application-known URL history and the iframe observation state machine.
 * The first load for a request keeps its URL authoritative; another load marks it unknown.
 */
export class BrowserNavigation {
  private value: BrowserTabState

  /**
   * @param initial - persisted state restored for this tab, or a fresh empty state.
   */
  constructor(initial: BrowserTabState = BrowserNavigation.empty()) {
    this.value = initial
  }

  /**
   * Create state before a tab has a controlled navigation target.
   * @returns empty serializable state.
   */
  static empty(): BrowserTabState {
    return { entries: [], index: -1, request: undefined, navigation: { status: 'empty' }, failure: undefined }
  }

  /**
   * Read the selected application-history entry.
   * @param state - serializable tab state.
   * @returns the current target, if any.
   */
  static current(state: BrowserTabState | undefined): BrowserHistoryEntry | undefined {
    return state === undefined || state.index < 0 ? undefined : state.entries[state.index]
  }

  /**
   * Test whether the Web carrier can use the preceding application-history entry.
   * @param state - serializable tab state.
   * @returns whether Back is available.
   */
  static canGoBack(state: BrowserTabState): boolean {
    return state.navigation.status !== 'unknown' && state.index > 0
  }

  /**
   * Test whether the Web carrier can use the following application-history entry.
   * @param state - serializable tab state.
   * @returns whether Forward is available.
   */
  static canGoForward(state: BrowserTabState): boolean {
    return state.navigation.status !== 'unknown'
      && state.index >= 0
      && state.index < state.entries.length - 1
  }

  /** Current immutable serializable state. */
  get snapshot(): BrowserTabState {
    return this.value
  }

  /** Whether the Web iframe can safely use the application-owned Back entry. */
  get canGoBack(): boolean {
    return BrowserNavigation.canGoBack(this.value)
  }

  /** Whether the Web iframe can safely use the application-owned Forward entry. */
  get canGoForward(): boolean {
    return BrowserNavigation.canGoForward(this.value)
  }

  /**
   * Add a controlled target and discard its stale forward branch.
   * @param target - validated canonical target.
   * @returns the new load request.
   */
  navigate(target: BrowserTarget): NonNullable<BrowserTabState['request']> {
    const entries = [...this.value.entries.slice(0, this.value.index + 1), target]
    if (entries.length > MAX_BROWSER_HISTORY) entries.splice(0, entries.length - MAX_BROWSER_HISTORY)
    return this.request(target, { ...this.value, entries, index: entries.length - 1 })
  }

  /**
   * Select the preceding application-known target.
   * @returns a new load request, or undefined when unavailable.
   */
  back(): BrowserTabState['request'] {
    if (!this.canGoBack) return undefined
    const index = this.value.index - 1
    const target = this.value.entries[index] as BrowserHistoryEntry
    return this.request(target, { ...this.value, index })
  }

  /**
   * Select the following application-known target.
   * @returns a new load request, or undefined when unavailable.
   */
  forward(): BrowserTabState['request'] {
    if (!this.canGoForward) return undefined
    const index = this.value.index + 1
    const target = this.value.entries[index] as BrowserHistoryEntry
    return this.request(target, { ...this.value, index })
  }

  /**
   * Start another load of the last application-known target.
   * @returns a new load request, or undefined before the first target.
   */
  reload(): BrowserTabState['request'] {
    const target = BrowserNavigation.current(this.value)
    return target === undefined ? undefined : this.request(target, this.value)
  }

  /**
   * Record a frame load for its captured revision.
   * @param revision - revision bound to the rendered frame.
   */
  frameLoaded(revision: number): void {
    const navigation = this.value.navigation
    if (navigation.status === 'empty' || navigation.revision !== revision) return
    if (navigation.status === 'loading') {
      this.value = { ...this.value, navigation: { status: 'known', revision } }
    } else if (navigation.status === 'known') {
      this.value = { ...this.value, navigation: { status: 'unknown', revision } }
    }
  }

  private request(
    target: BrowserTarget,
    basis: BrowserTabState,
  ): NonNullable<BrowserTabState['request']> {
    const request = { revision: (this.value.request?.revision ?? 0) + 1, target }
    this.value = {
      ...basis,
      request,
      navigation: { status: 'loading', revision: request.revision },
      failure: undefined,
    }
    return request
  }
}
