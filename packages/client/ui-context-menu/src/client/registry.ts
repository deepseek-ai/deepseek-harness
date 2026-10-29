/** Ordered menu resolution with cancellation and contribution-owned action lifetimes. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MenuAction, MenuActionView, MenuContribution, MenuResolution, ContextMenuTarget, ContextMenuTargetMap } from './types.ts'

interface Provider {
  readonly id: string
  readonly order: number
  readonly kind: keyof ContextMenuTargetMap
  readonly lifetime: AbortController
  observe(target: ContextMenuTarget): readonly ObservableSnapshot<unknown>[]
  resolve(target: ContextMenuTarget, signal: AbortSignal): readonly MenuAction[] | Promise<readonly MenuAction[]>
}

/** React-free registry; each occurrence captures the providers registered at opening. */
export class MenuRegistry {
  private readonly providers = new Map<string, Provider>()
  private readonly occurrences = new Set<() => void>()
  private disposed = false
  constructor(private readonly failed: (message?: string) => void, private readonly timeoutMs?: number) {}

  /**
   * Register actions for subsequent openings.
   * @param input - provider definition.
   * @returns removal of this contribution and its pending resolutions.
   */
  register<K extends keyof ContextMenuTargetMap>(input: MenuContribution<K>): () => void {
    if (this.disposed) throw new Error('Menu registry is disposed')
    const key = `${encodeURIComponent(input.target)}/${encodeURIComponent(input.id)}`
    if (this.providers.has(key)) throw new Error(`Duplicate menu contribution: ${key}`)
    const provider: Provider = {
      id: input.id, kind: input.target, order: input.order, lifetime: new AbortController(),
      observe: target => input.observe?.(target.value as ContextMenuTargetMap[K]) ?? [],
      resolve: (target, signal) => input.resolve(target.value as ContextMenuTargetMap[K], signal),
    }
    this.providers.set(key, provider)
    return () => {
      if (provider.lifetime.signal.aborted) return
      this.providers.delete(key)
      provider.lifetime.abort()
    }
  }

  /**
   * Resolve an independently owned occurrence.
   * @param target - captured clicked identity.
   * @returns presentation, selection, and disposal.
   */
  resolve(target: ContextMenuTarget): MenuResolution {
    if (this.disposed) throw new Error('Menu registry is disposed')
    const lifetime = new AbortController()
    const source = createSnapshotStore<readonly MenuActionView[]>([])
    const resolved = new Map<Provider, readonly MenuActionView[]>()
    const callbacks = new Map<string, { provider: Provider; action: MenuAction }>()
    const providers = [...this.providers.values()].filter(p => p.kind === target.kind)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const refresh = (): void => {
      source.set(providers.flatMap(provider =>
        provider.lifetime.signal.aborted ? [] : resolved.get(provider) ?? []))
    }
    const cleanup: (() => void)[] = []
    const dispose = (): void => {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      for (const detach of cleanup) detach()
      callbacks.clear()
      this.occurrences.delete(dispose)
    }
    this.occurrences.add(dispose)
    const pending: Promise<void>[] = []
    for (const provider of providers) {
      let preparation: AbortController | undefined
      let actionIds: string[] = []
      let preparing: Promise<void> | undefined
      const clear = (): void => {
        for (const id of actionIds) callbacks.delete(id)
        actionIds = []
        resolved.delete(provider)
        refresh()
      }
      const prepare = (): void => {
        preparation?.abort()
        const deadline = new AbortController()
        preparation = deadline
        const signal = AbortSignal.any([lifetime.signal, provider.lifetime.signal, deadline.signal])
        const accept = (actions: readonly MenuAction[]): void => {
          if (signal.aborted) return
          const next = new Map<string, MenuAction>()
          const project = (action: MenuAction, parent: string): MenuActionView => {
            const id = `${parent}/${encodeURIComponent(action.id)}`
            if (next.has(id)) throw new Error(`Duplicate menu action: ${id}`)
            next.set(id, action)
            const { run: _run, failureLabel: _failureLabel, children, ...view } = action
            return { ...view, id, ...(children === undefined ? {} : { children: children.map(child => project(child, id)) }) }
          }
          const views = actions.map(action => project(action, encodeURIComponent(provider.id)))
          for (const id of actionIds) callbacks.delete(id)
          for (const [id, action] of next) callbacks.set(id, { provider, action })
          actionIds = [...next.keys()]
          resolved.set(provider, views)
          refresh()
        }
        preparing = undefined
        try {
          const result = provider.resolve(target, signal)
          if (result instanceof Promise) clear()
          preparing = result instanceof Promise ? new Promise<void>((settle) => {
            const timer = this.timeoutMs === undefined ? undefined : setTimeout(() => {
              deadline.abort(); this.failed()
            }, this.timeoutMs)
            const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); settle() }
            signal.addEventListener('abort', finish, { once: true })
            void result.then(accept).catch(() => { if (!signal.aborted) this.failed() }).finally(finish)
          }) : undefined
          if (!(result instanceof Promise)) accept(result)
        } catch (_error) { if (!signal.aborted) { clear(); this.failed() } }
      }
      const subscriptions: (() => void)[] = []
      const withdraw = (): void => {
        preparation?.abort()
        for (const detach of subscriptions.splice(0)) detach()
        clear()
      }
      provider.lifetime.signal.addEventListener('abort', withdraw, { once: true })
      cleanup.push(() => {
        provider.lifetime.signal.removeEventListener('abort', withdraw)
        withdraw()
      })
      try {
        for (const input of provider.observe(target)) subscriptions.push(input.subscribe(prepare))
        prepare()
      } catch (_error) { if (!lifetime.signal.aborted && !provider.lifetime.signal.aborted) this.failed() }
      pending.push((async () => {
        let current: Promise<void> | undefined
        do { current = preparing; await current } while (current !== preparing)
      })())
    }
    return {
      source, dispose, ready: Promise.all(pending).then(() => {}),
      select: (id) => {
        const selected = callbacks.get(id)
        if (lifetime.signal.aborted || selected === undefined || selected.provider.lifetime.signal.aborted
          || selected.action.disabled || selected.action.children !== undefined) return
        const run = selected.action.run
        dispose()
        try { void Promise.resolve(run?.()).catch(() => { this.failed(selected.action.failureLabel) }) }
        catch (_error) { this.failed(selected.action.failureLabel) }
      },
    }
  }

  /** Cancel every occurrence and reject further registrations or resolutions. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.occurrences) dispose()
    for (const provider of this.providers.values()) provider.lifetime.abort()
    this.providers.clear()
  }
}
