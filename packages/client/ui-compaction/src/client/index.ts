/** Open checkpoint replacement text through the shared direct-content preview. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
import { readCheckpoint } from './resource.ts'

export type { CompactionKey } from './locales.ts'

/** Checkpoint preview navigation. */
export interface CompactionPreviews {
  /**
   * Read and open one checkpoint while its transcript row is still mounted.
   * @param sessionId - owning sidebar Session.
   * @param address - complete history address.
   * @param seq - replacement-message sequence.
   * @param signal - requesting row lifetime.
   * @returns null on success or cancellation, otherwise a localized failure line.
   */
  open(sessionId: SessionId, address: SessionAddress, seq: number, signal: AbortSignal): Promise<string | null>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Available while direct content previews are loaded. */
    compactionPreviews: CompactionPreviews
  }
}

/** Services required to read checkpoint text. */
export const inject = ['locale', 'remote', 'remote.session']

/** @param ctx - browser context with Session history and locale services. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('compaction')
  ctx.effect(() => ctx.locale.register('compaction', { zh, en, ja, es, fr, de, ru, pt }), 'ui-compaction: dictionaries')
  ctx.inject(['contentPreviews'], (scope) => {
    // Aborted when this activation ends, including a withdrawal of `contentPreviews`
    // that a later provider may follow, so a read started here never opens content.
    const activation = new AbortController()
    scope.effect(() => () => { activation.abort() }, 'ui-compaction: activation lifetime')
    const service: CompactionPreviews = {
      async open(sessionId, address, seq, signal) {
        const combined = AbortSignal.any([signal, activation.signal])
        const result = await readCheckpoint(scope.remote.session, address, seq, kind => t(`block.${kind}`), combined)
        if (result === undefined || combined.aborted) return null
        if (!result.ok) return result.error.code === 'compaction/not-found' ? t('preview.notFound') : t('preview.readFailed')
        scope.contentPreviews.open(result.value, { title: t('preview.title'), key: `compaction:${sessionId}:${seq}` })
        return null
      },
    }
    const dispose = scope.reflect.provide('compactionPreviews', service)
    scope.effect(() => dispose, 'ui-compaction: preview service')
  })
}
