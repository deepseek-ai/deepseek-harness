/** Source-safe browser registration of the mods band: the Remote stream behind a store, the dock entry, the press. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-experimental-claude-code-mods/remote'
import type { SurfaceSnapshot } from '@deepseek-ai/dsh-experimental-claude-code-mods/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { Band, type BandInjected } from './Band.tsx'
import { en, NS, zh, type ModsBandKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Chrome copy around a mod's band. */
    'claude-code-mods': ModsBandKey
  }
}

/** Required browser services: the Remote namespace, slots, and localized copy. */
export const inject = ['remote', 'slots', 'locale']

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A minimal observable the slot renderer turns into `useBand`. */
class BandStore {
  private snapshot: SurfaceSnapshot | undefined
  private readonly listeners = new Set<() => void>()

  getSnapshot(): SurfaceSnapshot | undefined {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: SurfaceSnapshot | undefined): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Keep one session's band store fed from the Host's `watchBand` stream until
 * disposed or until the stream ends; `onEnd` runs then, so the next
 * subscriber opens a fresh stream instead of reading a stale store.
 */
function watchSession(ctx: Context, sessionId: SessionId, onEnd: () => void): { store: BandStore; dispose: () => void } {
  const store = new BandStore()
  const controller = new AbortController()
  const handle = ctx.remote.claudeCodeMods.watchBand(sessionId, controller.signal)
  void (async () => {
    try {
      for await (const snapshot of handle) store.set(snapshot)
    } catch (error: unknown) {
      if (!controller.signal.aborted) ctx.logger.warn(`claude-code-mods band: watch of ${sessionId} ended: ${messageOf(error)}`)
    } finally {
      onEnd()
    }
  })()
  return {
    store,
    dispose: () => {
      controller.abort()
      handle.dispose()
    },
  }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-claude-code-mods: dictionaries')
  const watches = new Map<SessionId, ReturnType<typeof watchSession>>()
  ctx.effect(() => () => {
    for (const watch of watches.values()) watch.dispose()
    watches.clear()
  }, 'client-ui-claude-code-mods: band watches')
  const watchOf = (sessionId: SessionId): ReturnType<typeof watchSession> => {
    let watch = watches.get(sessionId)
    if (watch === undefined) {
      const opened: ReturnType<typeof watchSession> = watchSession(ctx, sessionId, () => {
        if (watches.get(sessionId) === opened) watches.delete(sessionId)
      })
      watch = opened
      watches.set(sessionId, watch)
    }
    return watch
  }
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'claude-code-mods',
    order: 20,
    locale: NS,
    inject: (sessionId): BandInjected => ({
      hooks: { band: watchOf(sessionId).store },
      press: async (generation, actionId) => {
        const result = await ctx.remote.claudeCodeMods.pressBand(sessionId, generation, actionId)
        if (!result.ok) throw result.error
        watchOf(sessionId).store.set(result.value)
      },
    }),
  }, Band))
}

/**
 * Mount the bridge's Remote contribution and register the band.
 * @param ctx - browser Context with `remote`, `slots`, and `locale`.
 * @param contribution - the generated `claudeCodeMods` Remote contribution.
 * @returns the disposer that withdraws the band and the Remote mount.
 */
export async function mountModsBand(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.claudeCodeMods', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
