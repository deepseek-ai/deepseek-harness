/** Session-owned terminal discovery shared across view occurrences. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WebTerminalId, WebTerminalInfo } from '../types.ts'

type Inventory = ReadonlyMap<WebTerminalId, WebTerminalInfo>
interface Loading {
  readonly kind: 'loading'
  readonly promise: Promise<Inventory>
  readonly updates: Map<WebTerminalId, WebTerminalInfo | undefined>
}
type LoadState = { readonly kind: 'unloaded' | 'ready' | 'disposed' }
  | { readonly kind: 'failed'; readonly error: Error }
  | Loading

/** One Session's cached list, retained failures and in-flight mutation reconciliation. */
export class TerminalInventory {
  private state: LoadState = { kind: 'unloaded' }
  private items = new Map<WebTerminalId, WebTerminalInfo>()
  private readonly pending = new Set<Promise<Inventory>>()

  /** @param load - fetch the Session's retained Host terminals. */
  constructor(private readonly load: () => Promise<RemoteResult<WebTerminalInfo[]>>) {}

  /**
   * Read the cached list or join its single in-flight request.
   * @param refresh - explicitly replace a settled result or failure; overlapping refreshes share one request.
   * @returns current terminal metadata; failures remain cached until refresh or reset.
   */
  read(refresh: boolean = false): Promise<Inventory> {
    if (this.state.kind === 'disposed') return Promise.reject(new Error('Terminal inventory disposed'))
    if (this.state.kind === 'loading') return this.state.promise
    if (!refresh && this.state.kind === 'ready') return Promise.resolve(this.items)
    if (!refresh && this.state.kind === 'failed') return Promise.reject(this.state.error)
    const completed = Promise.withResolvers<Inventory>()
    const request: Loading = { kind: 'loading', promise: completed.promise, updates: new Map() }
    this.state = request
    this.pending.add(completed.promise)
    void this.loadRequest(request).then(completed.resolve, completed.reject)
    void completed.promise.then(() => { this.pending.delete(completed.promise) }, () => { this.pending.delete(completed.promise) })
    return completed.promise
  }

  private async loadRequest(request: Loading): Promise<Inventory> {
    try {
      const result = await this.load()
      if (this.state !== request) return await this.read()
      if (!result.ok) throw result.error
      const items = new Map(result.value.map(info => [info.id, info]))
      for (const [id, info] of request.updates) {
        if (info === undefined) items.delete(id)
        else items.set(id, info)
      }
      this.items = items
      this.state = { kind: 'ready' }
      return items
    } catch (error) {
      if (this.state !== request) return this.read()
      const failure = error instanceof Error ? error : new Error('Terminal discovery failed', { cause: error })
      this.state = { kind: 'failed', error: failure }
      throw failure
    }
  }

  /**
   * Preserve acknowledged mutations and attachment metadata across a pending list response.
   * @param info - latest confirmed terminal metadata.
   */
  update(info: WebTerminalInfo): void {
    if (this.state.kind === 'disposed') return
    this.items.set(info.id, info)
    if (this.state.kind === 'loading') this.state.updates.set(info.id, info)
  }

  /**
   * Remove a terminal after confirmed closure or unavailability.
   * @param id - terminal identity.
   */
  remove(id: WebTerminalId): void {
    if (this.state.kind === 'disposed') return
    this.items.delete(id)
    if (this.state.kind === 'loading') this.state.updates.set(id, undefined)
  }

  /**
   * Replace discovery after a connection change; never discover a Session that has not needed a list.
   * @returns the replacement lookup, or undefined for an unused or disposed inventory.
   */
  reset(): Promise<Inventory> | undefined {
    if (this.state.kind === 'unloaded' || this.state.kind === 'disposed') return undefined
    this.state = { kind: 'unloaded' }
    return this.read()
  }

  /**
   * Discard metadata and prevent late responses from publishing.
   * @returns after all owned list requests settle.
   */
  async dispose(): Promise<void> {
    this.state = { kind: 'disposed' }
    this.items.clear()
    await Promise.allSettled(this.pending)
  }
}
