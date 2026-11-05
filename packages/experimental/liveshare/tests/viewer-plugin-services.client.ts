/**
 * Test-only Client services for viewer plugin benches.
 *
 * `remoteAccess` answers over the remote-access package's own snapshot owner, so a bench drives it
 * with the same `remoteAccess/follow` frames the owner's Gateway sends a share reader; `connection`
 * carries only the recovery state the viewer page reads.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/tests/viewer-plugin-services
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteAccessFrame, TypertResourceKind } from '@deepseek-ai/dsh-api-remote-access/client'
import { ClientAccessState } from '@deepseek-ai/dsh-api-remote-access/src/client/state.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Scripted access snapshot of one viewer page. */
export interface ViewerRemoteAccess {
  /**
   * Deliver one `remoteAccess/follow` frame.
   * @param frame - Baseline, upsert, or remove frame.
   */
  push(frame: RemoteAccessFrame): void
}

/**
 * Provide `remoteAccess` on `ctx`, starting from the baseline the served index injected; every answer
 * is false until a baseline arrives.
 * @param ctx - Bench root context.
 * @param initial - The page's injected opening baseline, when the bench serves one.
 * @returns The scripted snapshot.
 */
export function provideViewerRemoteAccess(
  ctx: Context,
  initial?: Extract<RemoteAccessFrame, { type: 'baseline' }>,
): ViewerRemoteAccess {
  const state = new ClientAccessState(initial)
  ctx.provide('remoteAccess', {
    source: (kind: TypertResourceKind, id: string, action: string) => state.resource(kind, id, action),
  })
  return {
    push(frame) {
      if (frame.type === 'baseline') state.replace(frame)
      else state.update(frame)
    },
  }
}

/**
 * Provide `connection` on `ctx` with a scripted recovery state.
 * @param ctx - Bench root context.
 * @returns The state store; undefined until the first connection outcome.
 */
export function provideViewerConnection(ctx: Context): SnapshotStore<ConnectionState | undefined> {
  const state = createSnapshotStore<ConnectionState | undefined>(undefined)
  ctx.provide('connection', { state } as never)
  return state
}

/**
 * Provide the client locale registry with this package's dictionaries, bound to one language.
 *
 * The viewer surfaces read their copy through the same locale seat the owner's dialogs do, so a bench
 * that mounts one provides it exactly as the assembled viewer page does.
 * @param ctx - Bench root context.
 * @param language - Language the mounted surfaces state their copy in.
 * @returns The provided registry, for a case that switches language mid-test.
 */
export function provideViewerLocale(ctx: Context, language: 'zh' | 'en' = 'zh'): LocaleRuntime {
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.register(NS, { zh, en })
  locale.setLocale(language)
  return locale
}
