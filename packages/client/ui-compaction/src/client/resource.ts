/**
 * One read of a compaction checkpoint: the replacement `user/message` the model
 * reads in place of the compacted history, converted to Markdown preview content.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PreviewContent } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import { RemoteError, remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Session has no checkpoint replacement message at the addressed seq. */
    'compaction/not-found': Record<string, never>
    /** The Session history read failed. */
    'compaction/read-failed': Record<string, never>
  }
}

/** Non-text content block kinds the preview replaces with a localized label. */
export type PlaceholderKind = 'image' | 'file' | 'other'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function placeholderKind(block: Record<string, unknown>): PlaceholderKind {
  switch (block.type) {
    case 'image': return 'image'
    case 'file': return 'file'
    // Merge-extensible block types, and malformed text blocks, have no text to show.
    default: return 'other'
  }
}

/**
 * Convert logged message content to Markdown. Text blocks concatenate with no
 * separator, as the model adapters join adjacent text blocks, so the framed
 * checkpoint reads as the single text the model receives. Every other block
 * becomes an emphasized bracketed label in its own paragraph, so adjacent
 * labels never merge into one emphasis run.
 * @param content - the logged `content` array of the replacement message.
 * @param label - localized label for one non-text block kind.
 * @returns the Markdown text.
 */
export function checkpointMarkdown(content: readonly unknown[], label: (kind: PlaceholderKind) => string): string {
  let markdown = ''
  let afterLabel = false
  for (const block of content) {
    if (record(block) && block.type === 'text' && typeof block.text === 'string') {
      markdown += afterLabel ? `\n\n${block.text}` : block.text
      afterLabel = false
      continue
    }
    const kind = record(block) ? placeholderKind(block) : 'other'
    markdown += `${markdown === '' ? '' : '\n\n'}*[${label(kind)}]*`
    afterLabel = true
  }
  return markdown
}

/**
 * Read a checkpoint's content from one untrusted wire event.
 * @param event - the Session event at the addressed seq.
 * @returns the logged content array, or undefined when the event is not a checkpoint replacement message.
 */
function checkpointContent(event: { readonly type: string; readonly data: unknown }): readonly unknown[] | undefined {
  if (event.type !== 'user/message' || !record(event.data)) return undefined
  const { source, content } = event.data
  if (!record(source) || typeof source.kind !== 'string' || !Array.isArray(content)) return undefined
  // Wire JSON whose `kind` is a string; the predicate reads only `kind`.
  return isCompactCheckpointSource(source as MessageSource) ? content : undefined
}

/**
 * Read the replacement message at a checkpoint's exact sequence number.
 * @param remote - Session history reader.
 * @param session - complete ordinary or subagent Session address.
 * @param seq - checkpoint replacement-message sequence.
 * @param label - localized non-text block labels.
 * @param signal - lifetime of the requesting transcript row.
 * @returns content or a structured read failure; undefined after cancellation.
 */
export async function readCheckpoint(
  remote: Pick<Context['remote']['session'], 'events'>,
  session: SessionAddress,
  seq: number,
  label: (kind: PlaceholderKind) => string,
  signal: AbortSignal,
): Promise<RemoteResult<PreviewContent> | undefined> {
  const isAborted = () => signal.aborted
  if (isAborted()) return undefined
  try {
    const page = await remote.events({ address: session, throughSeq: seq, maxMessages: 1 }, signal)
    if (isAborted()) return undefined
    if (!page.ok) return page
    const event = page.value.records.find(entry => entry.event.seq === seq)?.event
    const content = event === undefined ? undefined : checkpointContent(event)
    if (content === undefined) return {
      ok: false, error: new RemoteError('compaction/not-found', 'The compaction checkpoint was not found in this Session.', {}),
    }
    return { ok: true, value: { mediaType: 'text/markdown', text: checkpointMarkdown(content, label) } }
  } catch (error) {
    if (isAborted()) return undefined
    return {
      ok: false,
      error: remoteErrorOf(error) ?? new RemoteError('compaction/read-failed', error instanceof Error ? error.message : String(error), {}),
    }
  }
}
