/** Watch and read ownership for the Files panel's expanded directory tree. */
import type { DirLevel } from './store.ts'

/** One open directory and its active child nodes; cached view preferences live in the store. */
export class DirectoryNode {
  /** Open direct-child directories, keyed by absolute path. */
  readonly children = new Map<string, DirectoryNode>()
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private task: Promise<void> | undefined
  private reading: Promise<void> | undefined
  private dirty = false
  private initialized = false
  private automatic = true

  constructor(
    readonly path: string,
    private readonly load: (path: string, signal: AbortSignal) => Promise<DirLevel | undefined>,
    private readonly watch: (path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>,
    private readonly failed: (path: string, error: unknown) => void,
    lifetime: AbortSignal,
    private restore: readonly string[] = [],
  ) {
    this.signal = AbortSignal.any([lifetime, this.controller.signal])
  }

  /**
   * Start observation once; readiness triggers the initial listing.
   * @returns this node.
   */
  open(): this {
    this.task ??= this.follow()
    return this
  }

  /**
   * Find an active node in this subtree.
   * @param path - absolute directory path.
   * @returns the matching node, or undefined when that directory is closed.
   */
  find(path: string): DirectoryNode | undefined {
    if (path === this.path) return this
    for (const child of this.children.values()) {
      const found = child.find(path)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * Update the expansion preferences used by pending directory listings.
   * @param expanded - latest expansion preferences from the store.
   */
  setExpanded(expanded: readonly string[]): void {
    this.restore = expanded
    for (const child of this.children.values()) child.setExpanded(expanded)
  }

  /**
   * Open a direct child using this node's lifetime and automatic-refresh setting.
   * @param path - absolute direct-child directory path.
   * @param restore - descendant expansion preferences to restore after listing.
   * @returns the active child, or undefined after cancellation.
   */
  expand(path: string, restore: readonly string[] = []): DirectoryNode | undefined {
    if (this.signal.aborted) return undefined
    let child = this.children.get(path)
    if (child === undefined) {
      child = new DirectoryNode(path, this.load, this.watch, this.failed, this.signal, restore)
      child.automatic = this.automatic
      this.children.set(path, child)
    }
    return child.open()
  }

  /**
   * Remove a child and its pending restoration preferences.
   * @param path - absolute direct-child directory path.
   * @returns once the child subtree's reads and watches have ended.
   */
  async collapse(path: string): Promise<void> {
    this.restore = this.restore.filter(value => value !== path && !value.startsWith(`${path}/`))
    const child = this.children.get(path)
    this.children.delete(path)
    await child?.close()
  }

  /**
   * Control subtree rereads without ending subscriptions.
   * @param enabled - refresh dirty nodes automatically.
   */
  setAutomatic(enabled: boolean): void {
    this.automatic = enabled
    if (enabled && this.dirty) void this.refresh()
    for (const child of this.children.values()) child.setAutomatic(enabled)
  }

  /** Queue a reread, coalescing with active work. @returns completion of the active read and its coalesced rereads. */
  refresh(): Promise<void> {
    this.dirty = true
    this.reading ??= this.read()
    return this.reading
  }

  /** Refresh this node and its open descendants. @returns once their listings settle. */
  async refreshTree(): Promise<void> {
    await this.refresh()
    await Promise.all([...this.children.values()].map(child => child.refreshTree()))
  }

  /** Cancel the active subtree. @returns once all owned reads and watches have ended. */
  async close(): Promise<void> {
    this.controller.abort()
    await Promise.all([this.task, this.reading, ...[...this.children.values()].map(child => child.close())])
    this.children.clear()
  }

  private async follow(): Promise<void> {
    try {
      for await (const _event of this.watch(this.path, this.signal)) {
        this.dirty = true
        if (!this.initialized || this.automatic) void this.refresh()
      }
    } catch (error) {
      if (!this.signal.aborted) {
        if (!this.initialized) await this.refresh()
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'workspace-file/watch-unsupported')) {
          this.failed(this.path, error)
        }
      }
    }
  }

  private async read(): Promise<void> {
    const readAgain = (): boolean => this.dirty && this.automatic && !this.signal.aborted
    try {
      do {
        this.dirty = false
        const level = await this.load(this.path, this.signal)
        if (this.signal.aborted || level === undefined) return
        this.initialized = true
        const directories = new Set(level.entries.filter(entry => entry.type === 'directory')
          .map(entry => `${this.path.replace(/[/\\]+$/, '')}/${entry.name}`))
        for (const path of this.children.keys()) {
          if (!directories.has(path)) await this.collapse(path)
        }
        for (const path of directories) {
          if (this.restore.includes(path)) this.expand(path, this.restore)
        }
        this.restore = []
      } while (readAgain())
    } finally {
      this.reading = undefined
    }
  }
}
