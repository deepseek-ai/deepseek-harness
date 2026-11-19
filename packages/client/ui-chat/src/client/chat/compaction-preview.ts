/** Session-bound Markdown previews for manual and automatic compaction rows. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from '../locale.ts'
import type { CompactionRowInjected } from './CompactionItem.tsx'

/** Bind summary reads to the requesting row and the document viewer lifetime.
 * @param ctx - Chat plugin context.
 * @returns the preview action and availability hook for a Session.
 */
export function compactionRows(ctx: Context): (sessionId: SessionId) => CompactionRowInjected {
  const compactionPreview = createSnapshotStore(false)
  const t = ctx.locale.bind(NS)
  let lifetime: AbortController | undefined
  ctx.inject(['documentPreviews'], scope => scope.effect(() => {
    const controller = new AbortController()
    lifetime = controller
    compactionPreview.set(true)
    return () => {
      controller.abort()
      lifetime = undefined
      compactionPreview.set(false)
    }
  }))
  return sessionId => ({
    hooks: { compactionPreview },
    async openCompaction(summarySeq, signal) {
      if (lifetime === undefined) return null
      const child = ctx.sessions.subagentAddress(sessionId)
      const address: SessionAddress = child === undefined ? { kind: 'session', sessionId } : { kind: 'subagent', ...child }
      const active = AbortSignal.any([signal, lifetime.signal])
      const cancelled = (): boolean => active.aborted
      if (cancelled()) return null
      let result
      try {
        result = await ctx.remote.session.events({ address, throughSeq: summarySeq, maxMessages: 1 }, active)
      } catch (_error) {
        // A cancelled row has no read failure to display.
        return cancelled() ? null : t('message.compaction.readFailed')
      }
      if (cancelled()) return null
      if (!result.ok) return t('message.compaction.readFailed')
      const event = result.value.records.find(entry => entry.event.seq === summarySeq)?.event
      const text = event && summaryText(event)
      if (text === undefined) return t('message.compaction.notFound')
      const identity = address.kind === 'session' ? [address.sessionId] : [address.parentSessionId, address.childSessionId, address.mode]
      ctx.sidebarRight.openContent('compaction-summary', { summaryMarkdown: text }, {
        key: JSON.stringify([...identity, summarySeq]),
      })
      return null
    },
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
