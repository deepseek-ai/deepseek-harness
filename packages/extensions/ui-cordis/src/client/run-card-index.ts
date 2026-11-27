/** Session-local ownership index for Package business views on `cordis_run` cards. */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from './events.ts'

/** Stable keyed-slot identity of one Package-owned business view. */
export type CordisToolViewKey = `${CordisDynamicPluginId}.${CordisDynamicPackageId}`

/** One successful tool result competing to host a Package business view. */
export interface CordisRunCardPointer {
  readonly key: CordisToolViewKey
  readonly callId: string
  readonly seq: number
  readonly pluginRunId: CordisDynamicPluginRunId
}

/** Per-session observable index consumed by every mounted Run card. */
export interface CordisRunCardStore extends HostObservable<ReadonlyMap<CordisToolViewKey, CordisRunCardPointer>> {
  /** Publish one successful Run result; only a greater log sequence can replace it. */
  observe(pointer: CordisRunCardPointer): void
}

function createStore(): CordisRunCardStore {
  const pointers = new Map<CordisToolViewKey, CordisRunCardPointer>()
  const listeners = new Set<() => void>()
  let cache: ReadonlyMap<CordisToolViewKey, CordisRunCardPointer> | undefined
  return {
    getSnapshot: () => cache ??= new Map(pointers),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    observe: (pointer) => {
      const current = pointers.get(pointer.key)
      if (current !== undefined && current.seq >= pointer.seq) return
      pointers.set(pointer.key, pointer)
      cache = undefined
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Page-lifetime registry that gives all cards of one session the same Store. */
export class CordisRunCardRegistry {
  private readonly sessions = new Map<SessionId, CordisRunCardStore>()

  /**
   * Return the persistent page-local Store for a session.
   * @param sessionId - session whose cards share supersession state.
   * @returns the page-local Store retained for that session.
   */
  forSession(sessionId: SessionId): CordisRunCardStore {
    let store = this.sessions.get(sessionId)
    if (store === undefined) {
      store = createStore()
      this.sessions.set(sessionId, store)
    }
    return store
  }
}

/**
 * Build the Package business-view key shared by registrations and Run cards.
 * @param pluginId - stable Plugin identity.
 * @param packageId - immutable Package identity.
 * @returns the shared business-view key.
 */
export function cordisToolViewKey(
  pluginId: CordisDynamicPluginId,
  packageId: CordisDynamicPackageId,
): CordisToolViewKey {
  return `${pluginId}.${packageId}`
}
