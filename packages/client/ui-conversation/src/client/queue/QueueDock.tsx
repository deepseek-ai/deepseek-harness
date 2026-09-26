import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular,
  FileTypeIcon, fileSizeText, IconEditOutlineRegular, IconQueueOutlineRegular, IconSendOutlineRegular,
  IconTrashOutlineRegular, projectUserText, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { NS } from '../locales.ts'
import css from './QueueDock.module.css'

const EMPTY_QUEUE = [] as const
const QUEUE_PREVIEW_CHARS = 200

function previewOf(content: InboxState['next-turn'][number]['content']): string {
  const flat = content
    .filter(block => block.type !== 'image' && block.type !== 'file')
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

function textOf(content: InboxState['next-turn'][number]['content']): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text).join('')
}

/** Queue operations injected by the session-scoped registration. */
export interface QueueDockInjected {
  updateQueue: (itemId: MessageId, action: QueueAction) => Promise<void>
  notify: (level: 'info' | 'error', text: string) => void
  /** Resolve one durable queued image into a session-scoped browser URL. */
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>
}

/**
 * Durable references carried by one queued row. Inbox projections are wire data
 * despite their typed face, so an image block without a reference is skipped
 * rather than trusted.
 * @param content - the row's wire content blocks.
 * @returns the row's durable image references in block order.
 */
function queueAttachments(content: InboxState['next-turn'][number]['content']): Array<
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }
> {
  const attachments: Array<
    | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
    | { readonly type: 'file'; readonly attachment: FileAttachmentRef }
  > = []
  for (const block of content) {
    if (block.type === 'image') {
      const { attachment } = block as { attachment?: ImageAttachmentRef }
      if (attachment !== undefined) attachments.push({ type: 'image', attachment })
    }
    if (block.type === 'file') {
      const { attachment } = block as { attachment?: FileAttachmentRef }
      if (attachment !== undefined) attachments.push({ type: 'file', attachment })
    }
  }
  return attachments
}

/** Compact file identity used beside queue thumbnails. */
function QueueFile({ attachment, label }: { attachment: FileAttachmentRef; label: string }) {
  return (
    <span className={css.file} aria-label={label} title={attachment.name}>
      <span className={css.fileIcon} aria-hidden><FileTypeIcon path={attachment.name} size={16} /></span>
      <span className={css.fileName}>{attachment.name}</span>
      <span className={css.fileSize}>{fileSizeText(attachment.bytes)}</span>
    </span>
  )
}

/** One durable queued image as a fixed-size thumbnail; a load failure keeps the empty placeholder. */
function QueueThumb({ attachment, loadImage, label }: {
  attachment: ImageAttachmentRef
  loadImage: QueueDockInjected['loadImage']
  label: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    loadImage(attachment).then(
      (resolved) => { if (alive) setUrl(resolved) },
      () => { /* placeholder retained; the durable transcript surfaces read errors */ },
    )
    return () => { alive = false }
  }, [attachment, loadImage])
  return url === null
    ? <span className={css.thumb} aria-hidden />
    : <img className={css.thumb} src={url} alt={label} />
}

/**
 * Inline editor for one queued row. A textarea rather than an input: HTML
 * strips newlines from single-line input values, so editing a multi-line
 * queued message through one rewrites it as a single line. It grows with its
 * content up to the CSS cap, then scrolls. Enter saves, Shift+Enter breaks the
 * line, Escape cancels.
 */
function QueueEditor({ text, label, onChange, onSave, onCancel }: {
  text: string
  label: string
  onChange: (text: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const node = ref.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (node === null) return
    node.style.height = 'auto'
    // scrollHeight excludes the border that the border-box height includes.
    node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`
  }, [text])

  return (
    <textarea
      ref={ref}
      autoFocus
      rows={1}
      className={css.editor}
      aria-label={label}
      value={text}
      onChange={(event) => { onChange(event.currentTarget.value) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onCancel()
          return
        }
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
        event.preventDefault()
        onSave()
      }}
    />
  )
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat + the locale seat. */
export type QueueDockProps = PropsRuntime<'conversation.input.dock'> & QueueDockInjected & PropsLocale<'conversation'>

/**
 * Queue strip: one item renders directly; multiple items default to a
 * collapsible count header; an empty queue renders nothing. Local queued submissions
 * show sending status and disabled actions until their Host queue rows arrive.
 */
export function QueueDock({ useSession, useProjection, updateQueue, notify, loadImage, t }: QueueDockProps) {
  const inbox = useProjection('inbox') as unknown as InboxState | undefined
  const pendingSubmissions = useSession(s => s.pendingSubmissions)
  const queue = useMemo(() => {
    const rows = inbox?.['next-turn'] ?? EMPTY_QUEUE
    const inChat = new Set(pendingSubmissions.filter(item => item.placement === 'transcript').map(item => item.requestId))
    return inChat.size === 0 ? rows : rows.filter(({ source }) => (
      source.kind !== 'user' || !('rpcId' in source) || !inChat.has(source.rpcId)
    ))
  }, [inbox, pendingSubmissions])
  const pendingQueue = useMemo(() => {
    const admitted = new Set(queue.flatMap(({ source }) => (
      source.kind === 'user' && 'rpcId' in source ? [source.rpcId] : []
    )))
    return pendingSubmissions.filter(submission => (
      submission.placement === 'queued' && !admitted.has(submission.requestId)
    ))
  }, [pendingSubmissions, queue])
  const rowCount = queue.length + pendingQueue.length
  const running = useSession(s => s.running)
  const queueMutable = useSession(s => s.subagent === null || s.subagent.address.mode === 'continuable')
  const [editing, setEditing] = useState<{ id: MessageId; text: string } | null>(null)
  const [busy, setBusy] = useState<MessageId | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()

  useEffect(() => {
    if (rowCount === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && (!queueMutable || !queue.some(row => row.id === editing.id))) setEditing(null)
  }, [collapsed, editing, queue, queueMutable, rowCount])

  if (rowCount === 0) return null

  const interactionActive = queueMutable && (editing !== null || busy !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = rowCount === 1 || expanded

  const applyAction = async (
    itemId: MessageId,
    action: QueueAction,
    failure: string,
  ): Promise<boolean> => {
    setBusy(itemId)
    try {
      await updateQueue(itemId, action)
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => current === itemId ? null : current)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === '') return
    if (await applyAction(
      editing.id,
      { kind: 'edit', content: [{ type: 'text', text: editing.text }] },
      t('queue.editFailed'),
    )) setEditing(null)
  }

  return (
    <div className={css.dock} data-queue-dock="">
      <div className={css.panel}>
        {rowCount > 1 && (
          <button
            type="button"
            className={css.header}
            aria-controls={listId}
            aria-expanded={expanded}
            disabled={interactionActive}
            onClick={() => { setCollapsed(value => !value) }}
          >
            <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>
            <span className={css.count}>{t('queue.count', { n: rowCount })}</span>
            {!listVisible && pendingQueue.length > 0 && (
              <span className={css.status} role="status">{t('queue.sending')}</span>
            )}
            <span className={css.chevron} aria-hidden>
              {expanded ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}
            </span>
          </button>
        )}
        <ul id={listId} className={css.list} hidden={!listVisible}>
          {listVisible && queue.map((row) => {
            const attachments = queueAttachments(row.content)
            const text = textOf(row.content)
            return (
              <li key={row.id} className={css.row}>
                {/* Single-item strip has no count header, so the row itself carries the queue glyph. */}
                {rowCount === 1 && <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>}
                {editing?.id === row.id
                  ? (
                    <QueueEditor
                      text={editing.text}
                      label={t('queue.edit')}
                      onChange={(text) => { setEditing({ id: row.id, text }) }}
                      onSave={() => { void saveEdit() }}
                      onCancel={() => { setEditing(null) }}
                    />
                  )
                  : (
                    <>
                      {attachments.length > 0 && (
                        <span className={css.attachments}>
                          {attachments.map((item, index) => item.type === 'image'
                            ? (
                              <QueueThumb
                                key={`${item.attachment.attachmentId}:${index}`}
                                attachment={item.attachment}
                                loadImage={loadImage}
                                label={t('queue.image')}
                              />
                            )
                            : (
                              <QueueFile
                                key={`${item.attachment.attachmentId}:${item.attachment.name}:${index}`}
                                attachment={item.attachment}
                                label={t('queue.file', { name: item.attachment.name })}
                              />
                            ))}
                        </span>
                      )}
                      <span className={css.preview}>{projectUserText(previewOf(row.content), [])}</span>
                    </>
                  )}
                {queueMutable && <div className={css.actions}>
                  {editing?.id === row.id
                    ? (
                      <>
                        <Tooltip portal label={t('queue.save')} side="bottom" delayMs={500}>
                          <button
                            type="button"
                            className={css.action}
                            aria-label={t('queue.save')}
                            disabled={busy !== null || editing.text.trim() === ''}
                            onClick={() => { void saveEdit() }}
                          >
                            <IconCheckOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip portal label={t('queue.cancelEdit')} side="bottom" delayMs={500}>
                          <button
                            type="button"
                            className={css.action}
                            aria-label={t('queue.cancelEdit')}
                            disabled={busy !== null}
                            onClick={() => { setEditing(null) }}
                          >
                            <IconCloseOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                      </>
                    )
                    : (
                      <>
                        <Tooltip portal label={t('queue.edit')} side="bottom" delayMs={500} disabled={text === null}>
                          <button
                            type="button"
                            className={css.action}
                            aria-label={t('queue.edit')}
                            // Disabled buttons fire no hover events, so the
                            // unsupported hint stays a native title.
                            title={text === null ? t('queue.edit.unsupported') : undefined}
                            disabled={busy !== null || text === null}
                            onClick={() => {
                              if (text !== null) setEditing({ id: row.id, text: text })
                            }}
                          >
                            <IconEditOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip portal label={t('queue.remove')} side="bottom" delayMs={500}>
                          <button
                            type="button"
                            className={css.action}
                            aria-label={t('queue.remove')}
                            disabled={busy !== null}
                            onClick={() => {
                              void applyAction(
                                row.id,
                                { kind: 'remove' },
                                t('queue.removeFailed'),
                              )
                            }}
                          >
                            <IconTrashOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip portal label={t('queue.steer')} side="bottom" delayMs={500} disabled={!running}>
                          <button
                            type="button"
                            className={css.action}
                            aria-label={t('queue.steer')}
                            title={running ? undefined : t('queue.steer.unavailable')}
                            disabled={busy !== null || !running}
                            onClick={() => {
                              void applyAction(
                                row.id,
                                { kind: 'steer' },
                                t('queue.steerFailed'),
                              )
                            }}
                          >
                            <IconSendOutlineRegular />
                          </button>
                        </Tooltip>
                      </>
                    )}
                </div>}
              </li>
            )
          })}
          {listVisible && pendingQueue.map((submission) => {
            return (
              <li key={submission.requestId} className={`${css.row} ${css.pendingRow}`} data-submission-echo="">
                {rowCount === 1 && <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>}
                {submission.attachments.length > 0 && (
                  <span className={css.attachments}>
                    {submission.attachments.map((attachment, index) => attachment.type === 'image'
                      ? (
                        <img
                          key={`${attachment.value.previewUrl}:${index}`}
                          className={css.thumb}
                          src={attachment.value.previewUrl}
                          alt={t('queue.image')}
                        />
                      )
                      : (
                        <QueueFile
                          key={`${attachment.value.attachmentId}:${attachment.value.name}:${index}`}
                          attachment={attachment.value}
                          label={t('queue.file', { name: attachment.value.name })}
                        />
                      ))}
                  </span>
                )}
                <span className={css.preview}>{projectUserText(submission.text, [])}</span>
                <span className={css.status} role="status">{t('queue.sending')}</span>
                {queueMutable && <div className={css.actions}>
                  <button
                    type="button"
                    className={css.action}
                    aria-label={t('queue.edit')}
                    title={t('queue.sending')}
                    disabled
                  >
                    <IconEditOutlineRegular size={14} />
                  </button>
                  <button
                    type="button"
                    className={css.action}
                    aria-label={t('queue.remove')}
                    title={t('queue.sending')}
                    disabled
                  >
                    <IconTrashOutlineRegular size={14} />
                  </button>
                  <button
                    type="button"
                    className={css.action}
                    aria-label={t('queue.steer')}
                    title={t('queue.sending')}
                    disabled
                  >
                    <IconSendOutlineRegular />
                  </button>
                </div>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** Registers queue actions backed by the session-scoped conversation service. */
export const queueDockEntry = {
  name: 'conversation-queue-dock',
  inject: ['slots', 'conversation', 'sessions', 'uiConversation'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'queue',
      order: 20,
      locale: NS,
      inject: (sessionId: SessionId): QueueDockInjected => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`queue dock: session "${sessionId}" resolved no scope`)
        const conversation = actx.get('conversation')
        if (conversation === undefined) throw new Error('queue dock: conversation service unavailable')
        return {
          updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
          notify: (level, text) => { conversation.input.for(actx).notify(level, text) },
          loadImage: attachment => ctx.uiConversation.imageUrl(sessionId, attachment),
        }
      },
    }, QueueDock))
  },
}
