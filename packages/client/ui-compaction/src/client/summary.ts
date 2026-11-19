/** Durable identities and Markdown for compaction summary resources. */
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'

/** A summary event in an ordinary or delegated Session. */
export interface SummaryAddress {
  readonly session: SessionAddress
  readonly seq: SessionSeq
}

/** Read-only content recovered from the compaction event. */
export interface CompactionDocument {
  readonly markdown: string
}

/** Encode a summary without putting its text in layout storage.
 * @param target - Session address and exact summary event.
 * @returns a stable resource address.
 */
export function summaryAddress(target: SummaryAddress): string {
  const { session, seq } = target
  const parts = session.kind === 'session' ? [session.sessionId, String(seq)]
    : ['subagent', session.parentSessionId, session.childSessionId, session.mode, String(seq)]
  return `dsh-resource://compaction/${parts.map(encodeURIComponent).join('/')}`
}

/** Validate a persisted summary address.
 * @param address - Resource URL.
 * @returns its identity, or undefined for an invalid URL.
 */
export function parseSummaryAddress(address: string): SummaryAddress | undefined {
  const match = /^dsh-resource:\/\/compaction\/([^?#]+)$/.exec(address)
  if (match === null) return undefined
  try {
    const parts = (match[1] as string).split('/').map(decodeURIComponent)
    if (parts.some(part => part === '')) return undefined
    const rawSeq = parts[parts.length - 1] as string
    if (!/^(0|[1-9][0-9]*)$/.test(rawSeq) || !Number.isSafeInteger(Number(rawSeq))) return undefined
    const seq = SessionSeq(Number(rawSeq))
    if (parts.length === 2) return { session: { kind: 'session', sessionId: parts[0] as SessionId }, seq }
    if (parts.length === 5 && parts[0] === 'subagent'
      && (parts[3] === 'one-shot' || parts[3] === 'continuable' || parts[3] === 'unknown')) return {
      session: { kind: 'subagent', parentSessionId: parts[1] as SessionId, childSessionId: parts[2] as SessionId, mode: parts[3] }, seq,
    }
    return undefined
  } catch (_error) {
    // Invalid percent encoding cannot identify a saved summary.
    return undefined
  }
}

/** Extract text only from a valid summary event returned by the history API.
 * @param event - Wire event with untrusted JSON data.
 * @returns Markdown, or undefined for unrelated, empty or malformed content.
 */
export function summaryDocument(event: { readonly type: string; readonly data: unknown }): CompactionDocument | undefined {
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
  return markdown.trim() === '' ? undefined : { markdown }
}
