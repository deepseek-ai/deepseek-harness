/** Read a recorded summary into a temporary Markdown preview. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export type { CompactionKey } from './locales.ts'

/** Summary preview navigation. */
export interface CompactionPreviews {
  /**
   * Open the recorded summary unless the requesting row has been cancelled.
   * @param address - complete history address.
   * @param summarySeq - compaction/summary event sequence.
   * @param signal - requesting row lifetime.
   * @returns a localized failure for the row, or null after navigation or cancellation.
   */
  open(address: SessionAddress, summarySeq: number, signal: AbortSignal): Promise<string | null>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Available while document previews are loaded. */
    compactionPreviews: CompactionPreviews
  }
}

/** Services required to read summary text. */
export const inject = ['locale', 'remote', 'remote.session', 'sidebarRight']

/** @param ctx - browser context with Session history and locale services. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('compaction')
  ctx.effect(() => ctx.locale.register('compaction', { zh, en, ja, es, fr, de, ru, pt }), 'ui-compaction: dictionaries')
  ctx.inject(['documentPreviews'], (scope) => {
    const lifetime = new AbortController()
    scope.effect(() => () => { lifetime.abort() }, 'ui-compaction: navigation lifetime')
    const service: CompactionPreviews = {
      async open(address, summarySeq, signal) {
        const active = AbortSignal.any([signal, lifetime.signal])
        const cancelled = (): boolean => active.aborted
        if (cancelled()) return null
        let result
        try {
          result = await scope.remote.session.events({ address, throughSeq: summarySeq, maxMessages: 1 }, active)
        } catch (_error) {
          // A cancelled row has no read failure to display.
          return cancelled() ? null : t('preview.readFailed')
        }
        if (cancelled()) return null
        if (!result.ok) return t('preview.readFailed')
        const event = result.value.records.find(entry => entry.event.seq === summarySeq)?.event
        const text = event && summaryText(event)
        if (text === undefined) return t('preview.notFound')
        const identity = address.kind === 'session' ? [address.sessionId] : [address.parentSessionId, address.childSessionId, address.mode]
        const opened = scope.sidebarRight.openContent({ mediaType: 'text/markdown', text }, {
          title: t('preview.title'), key: `compaction:${JSON.stringify([...identity, summarySeq])}`,
        })
        return opened ? null : t('preview.notFound')
      },
    }
    const dispose = scope.reflect.provide('compactionPreviews', service)
    scope.effect(() => dispose, 'ui-compaction: preview service')
  })
}

/** Extract text only from a valid summary event returned by the history API.
 * @param event - Wire event with untrusted JSON data.
 * @returns Markdown, or undefined for unrelated, empty or malformed content.
 */
function summaryText(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'compaction/summary') return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null || !('summary' in data) || !Array.isArray(data.summary)) return undefined
  const text: string[] = []
  const blocks: readonly unknown[] = data.summary
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null || !('type' in block)) return undefined
    if (block.type !== 'text') continue
    if (!('text' in block) || typeof block.text !== 'string') return undefined
    text.push(block.text)
  }
  const markdown = text.join('')
  return markdown.trim() === '' ? undefined : markdown
}
