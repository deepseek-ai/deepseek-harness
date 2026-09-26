/** File-resource membership and invalidation for one document preview. */
import type { Resources, ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'

/** Forwards member metadata changes to one document preview. */
export class ResourceGroup {
  private readonly members = new Map<string, () => void>()

  /** @param resources - shared file sources. @param changed - marks the owning preview stale. */
  constructor(private readonly resources: Resources, private readonly changed: () => void) {}

  /**
   * Subscribe once; initial metadata establishes the baseline for later changes.
   * @param address - complete resource address.
   */
  add(address: string): void {
    if (this.members.has(address)) return
    const source = this.resources.source(address)
    let previous: string | undefined
    const observe = (): void => {
      const next = source.getSnapshot() as ResourceSnapshot<WorkspaceFileStat>
      if (next.status !== 'live' && next.status !== 'failed') return
      const key = next.status === 'live' ? `live:${next.value?.version}` : `failed:${next.failure?.code}`
      const changed = previous !== undefined && key !== previous
      previous = key
      if (changed) this.changed()
    }
    this.members.set(address, source.subscribe(observe))
    observe()
  }

  /**
   * Release dependencies absent from the current document.
   * @param addresses - complete membership of the latest document load.
   */
  set(addresses: readonly string[]): void {
    const retained = new Set(addresses)
    for (const address of retained) this.add(address)
    for (const [address, release] of this.members) {
      if (retained.has(address)) continue
      this.members.delete(address)
      release()
    }
  }

  /** Release every member when the preview tab ends. */
  close(): void {
    this.set([])
  }
}
