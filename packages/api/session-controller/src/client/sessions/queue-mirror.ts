import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionQueuedItem } from '../../types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { QueuedMessage } from '../contract/snapshot.ts'

const QUEUE_PREVIEW_CHARS = 200

// Attachment blocks are excluded: queue presentation renders them from
// `content`, so the text preview covers only what has no visual form.
function previewOf(content: readonly ContentBlock[]): string {
  const flat = content
    .filter(block => block.type !== 'image' && block.type !== 'file')
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

function textOf(content: readonly ContentBlock[]): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text).join('')
}

type QueueItems = readonly SessionQueuedItem[]

/** Authoritative transient queue projection and durable steering handoff. */
export class SessionQueueMirror {
  private current: readonly QueuedMessage[] = []

  /**
   * Return the current immutable queue projection.
   * @returns current queue rows.
   */
  snapshot(): readonly QueuedMessage[] {
    return this.current
  }

  /**
   * Replace from one authoritative stream queue frame.
   * @param items - complete host queue snapshot.
   */
  replace(items: QueueItems): void {
    this.current = items.map((item) => {
      const content = item.message.content as unknown as readonly ContentBlock[]
      return {
        id: item.id,
        messageId: item.message.id,
        placement: item.placement,
        ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
        content,
        preview: previewOf(content),
        text: textOf(content),
      }
    })
  }

  /**
   * Retire a transient steering row once its durable message enters the log.
   * @param event - newly contiguous durable Session event.
   * @returns whether the projection changed.
   */
  acceptDurable(event: SessionEvent): boolean {
    if (event.type !== 'user/message') return false
    const messageId = event.data.id
    const index = this.current.findIndex(item =>
      item.placement === 'steering' && item.messageId === messageId)
    if (index < 0) return false
    this.current = this.current.filter((_item, candidate) => candidate !== index)
    return true
  }
}
