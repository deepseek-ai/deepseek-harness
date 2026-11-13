import type { ISessions, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { z } from 'zod'
import type { Annotation, Task, Tree } from '../records.ts'
import { newId, statuses, summarySchema } from '../records.ts'
import { editResponseSchema, TIMELINE_CHANNEL, TIMELINE_EDIT } from '../protocol.ts'
import type { UserEdit, UserEditResult } from '../protocol.ts'

type TaskAction = 'resume' | 'pause'
/** A user request to pause or continue a tree or one branch. */
export interface TaskRequest {
  action: TaskAction
  tree: Pick<Tree, 'id' | 'title'>
  task?: Pick<Task, 'id' | 'title'>
}
/** User discussion text and the task or report it addresses. */
export type AnnotationRequest = Omit<Extract<UserEdit, { action: 'annotate' }>, 'action' | 'sessionId'>
/** User priority change for a task in a selected tree. */
export type PriorityRequest = Omit<Extract<UserEdit, { action: 'priority' }>, 'action' | 'sessionId'>
/** A validated portable tree and its import destination. */
export type ImportRequest = Omit<Extract<UserEdit, { action: 'import' }>, 'action' | 'sessionId'>

const contextPreview = z.object({
  treeTitle: z.string().optional(),
  taskTitle: z.string().nullable().optional(),
  status: z.enum(statuses).nullable().optional(),
  note: z.string().optional(),
  description: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  summary: summarySchema.optional(),
})

/** Present the saved target before the request and keep exact references for tool calls. */
function messageContext(annotation: Annotation, context: unknown, t: TranslateNS<'timeline'>): string {
  const data = contextPreview.parse(context ?? {})
  const target = annotation.target
  const lines: string[] = []
  if (target.kind === 'report') {
    const period = data.start && data.end ? `${data.start} – ${data.end} (${target.report})` : target.report
    lines.push(`${t('rollup')}: ${period}`)
    if (data.summary !== undefined) {
      lines.push(`${t('progress')}: ${data.summary.progress.join(' ')}`)
      if (data.summary.uncertainties.length > 0)
        lines.push(`${t('uncertainties')}: ${data.summary.uncertainties.join(' ')}`)
      if (data.summary.userActions.length > 0)
        lines.push(`${t('userActions')}: ${data.summary.userActions.join(' ')}`)
    }
  } else {
    if (target.kind === 'task') {
      const task = data.taskTitle ? `${data.taskTitle} (${target.task})` : target.task
      lines.push(`${t('taskTarget')}: ${task}${data.status ? ` · ${t(data.status)}` : ''}`)
    }
    lines.push(`${t('planTarget')}: ${data.treeTitle ? `${data.treeTitle} (${target.tree})` : target.tree}`)
    const note = data.note || data.description
    if (note)
      lines.push(
        `${t(data.note ? 'latestUpdate' : 'details')}: ${note.length > 200 ? `${note.slice(0, 200)}…` : note}`,
      )
  }
  lines.push(`${t('discussionRef')}: ${annotation.id}`)
  return lines.join('\n')
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    timelineTaskAction: unknown
  }
}

/** Session actions owned by the Timeline client fiber. */
interface TaskRequester {
  importTree: (sessionId: SessionId, request: ImportRequest) => Promise<Extract<UserEditResult, { action: 'import' }>>
  removeTree: (sessionId: SessionId, tree: Tree['id'], draft?: boolean) => Promise<Extract<UserEditResult, { action: 'remove' }>>
  send: (sessionId: SessionId, request: TaskRequest) => Promise<void>
  setPriority: (sessionId: SessionId, request: PriorityRequest) => Promise<void>
  annotate: (sessionId: SessionId, request: AnnotationRequest) => Promise<{ notified: boolean }>
  close: () => Promise<void>
}

/**
 * Send visible user instructions through the normal Session admission path; the agent owns task edits.
 * @param sessions - client service that opens sessions for user actions.
 * @param connection - authenticated connection to the host.
 * @param t - Timeline label translator.
 * @returns client actions and a cleanup function.
 */
export function createTaskRequester(
  sessions: Pick<ISessions, 'using'>,
  connection: Pick<ConnectionHandle, 'rpc'>,
  t: TranslateNS<'timeline'>,
): TaskRequester {
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const using = <T>(sessionId: SessionId, run: (session: SessionFace) => Promise<T>): Promise<T> => {
    const operation = sessions.using(
      sessionId,
      { source: 'timelineTaskAction', signal: controller.signal },
      async (reference) => {
        const { session } = await reference.ready
        controller.signal.throwIfAborted()
        const current = session.getSnapshot()
        if (current.removed || current.openState !== 'open') throw new Error(t('taskRequestUnavailable'))
        return run(session)
      },
    )
    pending.add(operation)
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    )
    return operation
  }
  const prompt = async (session: SessionFace, text: string) => {
    const current = session.getSnapshot()
    const result = await session.prompt(
      [{ type: 'text', text }],
      current.running ? 'steer' : 'queue',
      controller.signal,
    )
    if (!result.ok) throw new Error(result.error.message)
  }
  const edit = async (value: UserEdit) => {
    controller.signal.throwIfAborted()
    const result = await connection.rpc.call(TIMELINE_CHANNEL, TIMELINE_EDIT, value, controller.signal)
    if (!result.ok) throw new Error(result.error.message)
    return editResponseSchema.parse(result.value)
  }
  return {
    importTree(sessionId: SessionId, request: ImportRequest) {
      return using(sessionId, async () => {
        const result = await edit({ ...request, sessionId, action: 'import' })
        if (result.action !== 'import') throw new Error('Invalid Timeline import response')
        return result
      })
    },
    removeTree(sessionId: SessionId, tree: Tree['id'], draft = false) {
      return using(sessionId, async () => {
        const result = await edit({ action: 'remove', sessionId, tree, ...(draft ? { draft } : {}) })
        if (result.action !== 'remove') throw new Error('Invalid Timeline removal response')
        return result
      })
    },
    send(sessionId: SessionId, request: TaskRequest): Promise<void> {
      return using(sessionId, async (session) => {
        const key = request.action === 'resume' ? 'resumeRequest' : 'pauseRequest'
        const result = await edit({
          action: 'control',
          sessionId,
          id: newId('note'),
          intent: request.action,
          text: t(key),
          target:
            request.task === undefined
              ? { kind: 'tree', tree: request.tree.id }
              : { kind: 'task', tree: request.tree.id, task: request.task.id },
        })
        if (result.action !== 'control') throw new Error('Invalid Timeline request response')
        if (!result.dispatch) return
        let delivery: 'accepted' | 'unknown' = 'accepted'
        try {
          await prompt(
            session,
            [
              `${t('title')} · ${t('taskControls')}`,
              messageContext(result.annotation, result.context, t),
              `${result.annotation.text}\n${t('controlReplyRequest')}`,
            ].join('\n\n'),
          )
        } catch {
          // Admission can fail after send. Keep the saved request with unknown delivery.
          delivery = 'unknown'
        }
        await edit({ action: 'delivery', sessionId, id: result.annotation.id, delivery })
      })
    },
    setPriority(sessionId: SessionId, request: PriorityRequest): Promise<void> {
      return using(sessionId, async () => {
        const result = await edit({ ...request, sessionId, action: 'priority' })
        if (result.action !== 'priority') throw new Error('Invalid Timeline edit response')
      })
    },
    annotate(sessionId: SessionId, request: AnnotationRequest): Promise<{ notified: boolean }> {
      return using(sessionId, async (session) => {
        const result = await edit({ ...request, sessionId, action: 'annotate' })
        if (result.action !== 'annotate') throw new Error('Invalid Timeline annotation response')
        if (result.annotation.reply !== null) return { notified: true }
        try {
          await prompt(
            session,
            [
              `${t('title')} · ${t('annotations')}`,
              messageContext(result.annotation, result.context, t),
              t('annotationRequest'),
              `${t('discussionMessage')}:\n${result.annotation.text}`,
            ].join('\n\n'),
          )
          return { notified: true }
        } catch {
          // Saving and admission have separate outcomes. The committed annotation survives either one.
          return { notified: false }
        }
      })
    },
    async close(): Promise<void> {
      controller.abort()
      await Promise.allSettled(pending)
    },
  }
}
