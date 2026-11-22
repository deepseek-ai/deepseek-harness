/**
 * Session-scoped Host confirmation that a mentioned path exists.
 *
 * Each Session and path pair is stat'ed at most once while the owning plugin
 * is live. Only a definitive Host answer is retained; any other failure leaves
 * the pair unconfirmed, and the next subscriber asks again. Retained answers
 * are not refreshed when the path is created or removed later. Entries live as
 * long as the plugin, one per distinct mention the client has rendered. Each
 * unconfirmed pair starts its own Host request when first subscribed; nothing
 * bounds how many are outstanding at once.
 */
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Session whose filesystem resolves a mention. */
export type MentionSessionId = UserTextNodeProps<'file'>['sessionId']

/** Host answer for one mentioned path; `undefined` means unconfirmed. */
export type PathPresence = 'present' | 'absent'

/**
 * Session-authorized stat of one path, absolute or relative to the Session's workspace root.
 * @param sessionId - Session whose filesystem resolves the path.
 * @param path - path as the mention spells it.
 * @param signal - cancellation owned by the presence sources.
 * @returns the regular file's metadata, or the Host's typed failure.
 */
export type PathStat = (
  sessionId: MentionSessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileStat>>

/** Presence sources shared by every mention one plugin instance renders. */
export interface PathPresenceSources {
  /**
   * Observe one path; the first subscription to an unconfirmed path starts its Host stat.
   * @param sessionId - Session whose filesystem resolves the path.
   * @param path - decoded mention path.
   * @returns the same source for the same pair until disposal.
   */
  source(sessionId: MentionSessionId, path: string): HostObservable<PathPresence | undefined>
  /**
   * Record a path the Host has just listed, such as a picked completion candidate.
   * @param sessionId - Session whose filesystem listed the path.
   * @param path - decoded mention path.
   */
  confirm(sessionId: MentionSessionId, path: string): void
  /** Abort outstanding stats; later subscriptions start none. */
  dispose(): void
}

interface Entry {
  presence: PathPresence | undefined
  probing: boolean
  readonly listeners: Set<() => void>
  readonly source: HostObservable<PathPresence | undefined>
}

/**
 * Classify one stat. A directory, a symbolic link whatever it points to, or
 * another non-regular entry still exists; failures that do not describe the
 * path leave it unconfirmed.
 * @param result - Host stat result.
 * @returns the definitive presence, or undefined.
 */
function presenceOf(result: RemoteResult<WorkspaceFileStat>): PathPresence | undefined {
  if (result.ok) return 'present'
  switch (result.error.code) {
    case 'workspace-file/not-regular-file':
      return 'present'
    case 'workspace-file/not-found':
      return 'absent'
    default:
      return undefined
  }
}

/**
 * Create presence sources over one stat function.
 * @param stat - Session-authorized Host stat.
 * @returns sources the caller disposes with its plugin.
 */
export function createPathPresence(stat: PathStat): PathPresenceSources {
  const lifetime = new AbortController()
  const entries = new Map<string, Entry>()

  const publish = (entry: Entry, presence: PathPresence) => {
    entry.presence = presence
    for (const listener of [...entry.listeners]) listener()
  }

  const probe = (entry: Entry, sessionId: MentionSessionId, path: string) => {
    if (entry.probing || entry.presence !== undefined || lifetime.signal.aborted) return
    entry.probing = true
    // Cancellation and carrier faults resolve as failures. Only a Remote
    // assembly fault rejects: it stays an unhandled rejection so the fault is
    // reported, and the pair stays unconfirmed for the next subscriber.
    void stat(sessionId, path, lifetime.signal).then((result) => {
      const presence = presenceOf(result)
      // A confirmation recorded while this stat was outstanding is newer.
      if (presence === undefined || entry.presence !== undefined || lifetime.signal.aborted) return
      publish(entry, presence)
    }).finally(() => { entry.probing = false })
  }

  const entryFor = (sessionId: MentionSessionId, path: string): Entry => {
    const key = JSON.stringify([sessionId, path])
    const existing = entries.get(key)
    if (existing !== undefined) return existing
    const entry: Entry = {
      presence: undefined,
      probing: false,
      listeners: new Set(),
      source: {
        getSnapshot: () => entry.presence,
        subscribe: (listener) => {
          entry.listeners.add(listener)
          probe(entry, sessionId, path)
          return () => { entry.listeners.delete(listener) }
        },
      },
    }
    entries.set(key, entry)
    return entry
  }

  return {
    source: (sessionId, path) => entryFor(sessionId, path).source,
    confirm(sessionId, path) {
      const entry = entryFor(sessionId, path)
      if (entry.presence !== 'present') publish(entry, 'present')
    },
    dispose() {
      lifetime.abort()
    },
  }
}
