// An enclosing `[data-conversation-scroll]` owns scrolling when present;
// otherwise this view owns it. Each row subscribes to one stable node key.

import { memo, useCallback, useMemo, useRef, useState, type ComponentProps } from 'react'
import type {
  NodeKey, RenderEntry, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  Button, IconChevronDownOutlineRegular, MarkdownDelegateProvider, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, OpenFileOptions } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { chatRenderKey } from './render-entry.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { TurnNavigator } from './TurnNavigator.tsx'
import { mergeTurnRailItems } from './turn-rail-items.ts'
import { useChatScroll } from './use-chat-scroll.ts'
import { fileMediaUrl, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import css from './ChatView.module.css'

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/**
 * Durable input identities suppress matching echoes in the same render.
 * The last input's Turn also distinguishes an empty opening control from
 * one whose human input or trigger notice is already present.
 */
function observedInputs(
  order: readonly string[],
  nodes: ChatSnapshot['nodes'],
): { readonly rpcIds: ReadonlySet<string>; readonly lastInputTurn: number | undefined } {
  const observed = new Set<string>()
  let lastInputTurn: number | undefined
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering' && node.kind !== 'turn-trigger')) continue
    if (node.location.kind === 'turn' || node.location.kind === 'step') lastInputTurn = node.location.turn.turn
    if (node.kind === 'turn-trigger') continue
    const source = (node.data as { readonly source?: unknown }).source as
      | { readonly kind?: unknown; readonly rpcId?: unknown }
      | undefined
    if (source?.kind === 'user' && typeof source.rpcId === 'string') observed.add(source.rpcId)
  }
  return { rpcIds: observed, lastInputTurn }
}

type PendingInput = PendingSubmission | InboxState['next-step'][number]

type ChatNodeListProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart'> & {
  readonly entries: readonly RenderEntry[]
  readonly useChatGroup: ChatViewSlotProps['useChatGroup']
  readonly pendingInputs: readonly PendingInput[]
  readonly lastInputTurn: number | undefined
}

const ChatNodeList = memo(function ChatNodeList({ entries, useChatGroup, pendingInputs, lastInputTurn, ...seatProps }: ChatNodeListProps) {
  const rows = entries.map((entry) => {
    switch (entry.kind) {
      case 'node':
        return <ChatNodeSeat {...seatProps} key={chatRenderKey(entry)} nodeKey={entry.key}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...seatProps} key={chatRenderKey(entry)} groupKey={entry.key} useChatGroup={useChatGroup} />
      default:
        return assertNever(entry)
    }
  })
  const pendingRows = pendingInputs.map(item => 'requestId' in item ? (
    <PendingSubmissionBubble key={item.requestId} submission={item}
      renderMessageImages={seatProps.renderMessageImages} t={seatProps.t} />
  ) : (
    <PendingSteeringBubble key={item.id} content={item.content}
      renderMessageImages={seatProps.renderMessageImages} t={seatProps.t} />
  ))
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? seatProps.nodeStore.get(tail.key) : undefined
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    const index = pendingInputs.findIndex(item => 'requestId' in item && item.placement === 'transcript')
    if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1))
  }
  return [...rows, ...pendingRows]
})

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useChat, useChatNode, useChatNodeProcess, useChatGroup, useConversation, useSessions, useStore, actions, renderSlot,
  sessionId, openFile, openSkill, openExternalLink, loadOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt, fileMentions,
  usePresentation, useProjection, t,
}: ChatViewSlotProps) {
  const order = useChat(s => s.order)
  const groupedEntries = useConversation(snapshot => snapshot.views.grouped('chat')?.entries)
  const entries = useMemo<readonly RenderEntry[]>(() => groupedEntries
    ?? order.map(key => ({ kind: 'node', key: key as NodeKey })), [groupedEntries, order])
  const nodeStore = useChat(s => s.nodes)
  // The rail's items are accumulated in the Chat snapshot, so this selector is
  // both the data and its change signal: the array identity moves only when a
  // Turn enters, leaves, or changes its preview.
  const turnNavigationItems = useChat(s => s.navigation.items())
  // Host-computed whole-log outline; the merge is view-layer only (the
  // conversation snapshot never carries projection values).
  const turnOutline = useProjection('turnOutline')
  const railItems = useMemo(
    () => mergeTurnRailItems(turnNavigationItems, turnOutline),
    [turnNavigationItems, turnOutline],
  )
  const inbox = useProjection('inbox') as unknown as InboxState | undefined
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const fileImages = useMemo(() => ({
    resolve: (path: string) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
    labels: {
      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),
      dialog: t('image.dialog'), close: t('image.close'),
    },
  }), [cwd, t])
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const requestOpenFile = useCallback((path: string, options?: OpenFileOptions) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void (options === undefined ? openFile(path) : openFile(path, options)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t('fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const inboxSteering = useMemo(
    () => inbox?.['next-step'].filter(message => message.source.kind === 'user') ?? [],
    [inbox],
  )
  const pendingSubmissions = useSession(s => s.pendingSubmissions)
  // Submission echoes still awaiting their durable counterpart. `order` is the
  // recompute trigger: durable user material always arrives as an append, and
  // every append replaces the order array.
  const [visibleSubmissions, lastInputTurn] = useMemo(() => {
    if (pendingSubmissions.length === 0) return [pendingSubmissions, undefined] as const
    const observed = observedInputs(order, nodeStore)
    return [pendingSubmissions.filter(submission => (
      submission.placement !== 'queued' && !observed.rpcIds.has(submission.requestId)
    )), observed.lastInputTurn] as const
  }, [pendingSubmissions, order, nodeStore])
  const pendingInputs = useMemo(() => {
    const local = new Map(visibleSubmissions.map(submission => [submission.requestId, submission]))
    // Admitted local identities outlive their bubbles until the Inbox claim watermark.
    const localIds = new Set(pendingSubmissions.filter(submission => submission.placement !== 'queued')
      .map(submission => submission.requestId))
    const pending = inboxSteering.flatMap<PendingInput>((item) => {
      const source = item.source
      if (source.kind !== 'user' || !('rpcId' in source)) return [item]
      const submission = local.get(source.rpcId)
      if (submission === undefined) return localIds.has(source.rpcId) ? [] : [item]
      local.delete(source.rpcId)
      return [submission]
    })
    return [...pending, ...local.values()]
  }, [inboxSteering, pendingSubmissions, visibleSubmissions])
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const latestSteering = pendingInputs.findLast(item => 'source' in item)
  const steeringId = latestSteering?.source.kind === 'user' && 'rpcId' in latestSteering.source
    ? latestSteering.source.rpcId : latestSteering?.id ?? null
  const scroll = useChatScroll({
    ready: openState === 'open',
    order, firstSeq, lastKey, running, loadingOlder, hasMore, chatScroll, loadOlder, loadThrough,
    lastIsUser: lastKey !== null && nodeStore.get(lastKey)?.kind === 'user',
    steeringId,
    submissionId: visibleSubmissions.at(-1)?.requestId ?? null,
    loadedTurns: turnNavigationItems,
  })

  return (
    <div className={css.frame}>
      {scroll.initialized && (
        <TurnNavigator
          items={railItems}
          activeTurn={scroll.activeTurn}
          busyTurn={scroll.busyTurn}
          onNavigate={scroll.navigateToTurn}
          t={t}
        />
      )}
      <div className={css.root} data-chat-following-tail={scroll.followingTail ? '' : undefined}>
        <div ref={scroll.listRef} className={css.scroll}>
          <div ref={scroll.columnRef} className={css.column} data-chat-flow="">
            {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
            {openState === 'error' && openError !== null && (
              <div className={css.openError}>
                {t('chat.loadError', { message: openError.message, code: openError.code })}
              </div>
            )}
            {hasMore && (
              <div className={css.older}>
                <button type="button" disabled={loadingOlder} onClick={scroll.loadEarlier}>
                  {loadingOlder ? t('loading') : t('chat.loadOlder')}
                </button>
              </div>
            )}
            <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={requestOpenFile} fileImages={fileImages}>
              <ChatNodeList
                entries={entries}
                pendingInputs={pendingInputs}
                lastInputTurn={lastInputTurn}
                nodeStore={nodeStore}
                useChatGroup={useChatGroup}
                useChatNode={useChatNode}
                useChatNodeProcess={useChatNodeProcess}
                usePresentation={usePresentation}
                useStore={useStore}
                actions={actions}
                cwd={cwd}
                openFile={requestOpenFile}
                openSkill={openSkill}
                inspectCall={inspectCall}
                forkAt={forkAt}
                loadImage={loadImage}
                renderMessageImages={renderMessageImages}
                fileMentions={fileMentions}
                renderSlot={renderSlot}
                t={t}
              />
            </MarkdownDelegateProvider>
            {/* No pending placeholders: questions (ui-user-questions) and approvals
                (ApprovalPanel) both take over the composer, so a flow card would
                double-render the same wait. */}
          </div>
        </div>
      </div>
      {!scroll.followingTail && (
        <div className={css.toBottomSlot}>
          <button
            type="button"
            className={css.toBottom}
            aria-label={t('chat.toBottom')}
            onClick={scroll.returnToBottom}
          >
            <IconChevronDownOutlineRegular />
          </button>
        </div>
      )}
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  message, busy, onClose, onRetry, t,
}: {
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
