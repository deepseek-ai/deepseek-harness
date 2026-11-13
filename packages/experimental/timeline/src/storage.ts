import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { PluginRecordMap, Session } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Checkpoint, CHECKPOINT_BYTES } from './checkpoint.ts'
import { foldRecord } from './projection.ts'
import type { TimelineReader, TimelineState } from './projection.ts'
import { newId, requestRecordSchema, treeId } from './records.ts'
import type { Annotation, TimelineRecordMap } from './records.ts'
import {
  browserLanguageSchema,
  editRequestSchema,
  TIMELINE_CHANNEL,
  TIMELINE_EDIT,
  TIMELINE_LOCALE,
} from './protocol.ts'
import type { UserEdit, UserEditResult } from './protocol.ts'
import { measureAll, prioritiesOf } from './tasks.ts'
import { pendingControl } from './controls.ts'
import { MAX_ANNOTATIONS } from './policy.ts'
import type { OutputLanguage } from './policy.ts'
import { TimelineError } from './error.ts'

function changesUrgentPriority(
  previous: TimelineState,
  next: TimelineState,
  change: TimelineRecordMap['plugin:timeline/priority'],
): boolean {
  const before = previous.view.trees.find(tree => tree.id === change.treeId)
  const after = next.view.trees.find(tree => tree.id === change.treeId)
  // An accepted priority record can only update an existing tree.
  assert(before !== undefined && after !== undefined)
  if (change.priority === 'P0' || before.tasks.find(task => task.id === change.taskId)?.priority === 'P0') return true
  return (prioritiesOf(before.tasks).get(change.taskId) === 'P0') !== (prioritiesOf(after.tasks).get(change.taskId) === 'P0')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    timeline: TimelineStorage
  }
  interface Events {
    /**
     * A saved user edit entered or left P0. Model task patches do not emit it.
     * @mode emit
     * @param session - the session that owns the task.
     */
    'timeline/priority'(session: Session): void

  }
}

/** Coordinate Timeline edits through the live Session writer. */
export class TimelineStorage extends Service implements TimelineReader {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly unflushed = new WeakMap<Session, boolean>()
  private closed = false

  constructor(
    ctx: Context,
    private readonly projection: TimelineReader,
    private readonly config: Config,
    setBrowserLanguage: (language: OutputLanguage) => void,
  ) {
    super(ctx, 'timeline')
    ctx.effect(() => async () => {
      this.closed = true
      await Promise.all(this.pending.values())
    }, 'timeline: pending session writes')
    ctx.inject(['connection', 'webServer'], (scope) => {
      scope.connection.rpc.handle(TIMELINE_CHANNEL, async (method, payload, signal, peer) => {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- other plugins can define non-owner principals.
        if (peer.principal.kind !== 'owner' || (method !== TIMELINE_EDIT && method !== TIMELINE_LOCALE)) {
          return {
            ok: false,
            error: { code: 'timeline/forbidden', message: 'Timeline requests require owner access.', details: {} },
          }
        }
        try {
          signal.throwIfAborted()
          if (method === TIMELINE_LOCALE) {
            setBrowserLanguage(browserLanguageSchema.parse(payload))
            return { ok: true, value: null }
          }
          return { ok: true, value: await this.edit(editRequestSchema.parse(payload)) }
        } catch (error: unknown) {
          if (signal.aborted) throw error
          return {
            ok: false,
            error: {
              code: 'timeline/request-failed',
              message: error instanceof Error ? error.message : 'Timeline request failed',
              details: {},
            },
          }
        }
      })
    })
  }

  /**
   * Check whether the live Session can own new Timeline records.
   * @param session - the session whose plan or reports are affected.
   * @returns whether the Session is live with a persistence backend.
   */
  available(session: Session): boolean {
    return !this.closed && this.ctx.sessions.get(session.id) === session && this.ctx.get('sessionPersistence') !== undefined
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new TimelineError('Timeline storage is closed', 'TIMELINE_PERSISTENCE'))
    const result = (this.pending.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(sessionId, settled)
    void settled.then(() => {
      if (this.pending.get(sessionId) === settled) this.pending.delete(sessionId)
    })
    return result
  }

  /**
   * Only the owner Client can create feedback or set priority. Model tools have narrower operations.
   * @param input - input to validate.
   * @returns the acknowledged result of the edit.
   */
  async edit(input: UserEdit): Promise<UserEditResult> {
    const request = editRequestSchema.parse(input)
    const id = request.sessionId
    let agent = this.ctx.agents.get(id)
    if (agent === undefined) {
      const restored = await this.ctx.get('sessionController')?.resolveAgent(id)
      if (restored !== undefined && 'error' in restored) throw restored.error
      agent = restored?.agent
    }
    if (agent === undefined) throw new Error('Open the conversation before editing Timeline')
    const session = agent.session
    if (!(await this.ctx.sessions.flush(session)))
      throw new Error('Timeline requires durable session persistence')
    if (request.action === 'import' || request.action === 'remove') {
      const { result, notice } = await agent.runMaintenance(signal => this.transfer(agent, request, signal))
      if (notice !== undefined) {
        try {
          // Wake the agent after maintenance releases. Persist the admission receipt before acknowledging it.
          agent.followup(notice)
          if (request.action === 'import' && !(await this.ctx.sessions.flush(session)))
            throw new Error('Timeline continuation requires durable session persistence')
          result.notified = true
        } catch (error: unknown) {
          this.ctx.logger.warn('Timeline tree change saved, but its notification failed', error)
        }
      }
      return result
    }
    if (request.action === 'delivery') {
      await this.append(session, 'plugin:timeline/delivery', (state) => {
        const annotation = state.view.annotations.find(item => item.id === request.id)
        if (annotation?.control === undefined) throw new Error('Unknown Timeline control request')
        if (annotation.control.delivery !== 'sending') return
        return { version: 1, sessionId: session.id, id: request.id, delivery: request.delivery }
      })
      return { action: 'delivery' }
    }
    if (request.action === 'control') return this.control(session, request)
    if (request.action === 'priority') {
      await this.append(session, 'plugin:timeline/priority', (state) => {
        const tree = state.view.trees.find(tree => tree.id === request.tree)
        const task = tree?.tasks.find(task => task.id === request.task)
        if (tree === undefined || task === undefined || task.status === 'retired')
          throw new Error('Unknown available Timeline task')
        if (task.priority === request.priority) return
        return {
          version: 1,
          sessionId: session.id,
          treeId: request.tree,
          taskId: task.id,
          priority: request.priority,
          createdAt: Date.now(),
        }
      })
      return { action: 'priority' }
    }
    let saved: Annotation | undefined
    let context: Extract<UserEditResult, { action: 'annotate' }>['context'] | undefined
    await this.append(session, 'plugin:timeline/annotation', (state) => {
      const existing = state.view.annotations.find(annotation => annotation.id === request.id)
      if (
        existing !== undefined &&
        (existing.control !== undefined ||
          existing.text !== request.text ||
          JSON.stringify(existing.target) !== JSON.stringify(request.target))
      )
        throw new Error('An annotation identity cannot be reused for different content')
      const target = request.target
      if (target.kind === 'report') {
        const report = state.view.reports.find(report => report.id === target.report)
        if (report === undefined) throw new Error('Unknown Timeline report')
        context = {
          kind: 'report',
          report: report.id,
          start: new Date(report.start).toISOString(),
          end: new Date(report.end).toISOString(),
          level: report.level,
          summary: report.summary,
        }
      } else {
        const tree = state.view.trees.find(tree => tree.id === target.tree)
        const task = target.kind === 'task' ? tree?.tasks.find(task => task.id === target.task) : undefined
        if (
          tree === undefined ||
          (target.kind === 'task' &&
            (task === undefined || (task.status === 'retired' && existing === undefined)))
        )
          throw new Error('Unknown available Timeline task')
        const progress = task === undefined ? undefined : measureAll(tree.tasks).get(task.id)
        context = {
          kind: target.kind,
          tree: tree.id,
          treeTitle: tree.title,
          task: task?.id ?? null,
          taskTitle: task?.title ?? null,
          status: task?.status ?? null,
          progress: progress === undefined ? null : { progress: progress.progress, status: progress.status },
          description: task?.description ?? tree.description,
          note: task?.note ?? '',
          priority: task?.priority ?? null,
          details: task?.details ?? '',
        }
      }
      saved = existing ?? {
        id: request.id,
        target: request.target,
        text: request.text,
        createdAt: Date.now(),
        reply: null,
      }
      return existing === undefined ? { version: 1, sessionId: session.id, annotation: saved } : undefined
    })
    assert(saved !== undefined && context !== undefined, 'Timeline annotation was not saved')
    return { action: 'annotate', annotation: saved, context }
  }

  private async transfer(
    agent: Agent,
    request: Extract<UserEdit, { action: 'import' | 'remove' }>,
    signal: AbortSignal,
  ): Promise<{ result: Extract<UserEditResult, { action: 'import' | 'remove' }>; notice: UserMessage | undefined }> {
    const session = agent.session
    let notice: UserMessage | undefined
    let result: Extract<UserEditResult, { action: 'import' | 'remove' }>
    if (request.action === 'import') {
      const checkpoint = Checkpoint.fromString(request.content)
      const digest = createHash('sha256').update(JSON.stringify(checkpoint.toJson())).digest('hex')
      const id = treeId.parse(
        newId('tree', request.copy ? createHash('sha256').update(request.id).digest('hex') : digest),
      )
      let reused = false
      await this.append(session, 'plugin:timeline/import', (state) => {
        signal.throwIfAborted()
        const previous = state.calls.find(call => call.id === request.id)
        if (previous !== undefined) {
          if (previous.tree !== id)
            throw new Error('Import request identity was already used for another checkpoint')
          if (!state.view.trees.some(tree => tree.id === id))
            throw new Error('This import was removed. Start a new import to restore it.')
          reused = true
          return
        }
        const prepared = state.preparedImport
        if (prepared?.callId === request.id) {
          if (prepared.tree.id !== id)
            throw new Error('Import request identity was already used for another checkpoint')
          reused = true
          return
        }
        const existing = state.view.trees.find(tree => tree.id === id)
        if (existing === undefined && state.view.trees.length >= this.config.maxTrees)
          throw new Error(`At most ${this.config.maxTrees} task trees; remove an unused tree first`)
        if (checkpoint.tasks.length > this.config.maxTasks)
          throw new Error(`At most ${this.config.maxTasks} tasks per tree`)
        const restored = checkpoint.restore(id, Date.now())
        const tree = existing ?? restored.tree
        reused = existing !== undefined
        const noticeText = `Continue task tree ${JSON.stringify(tree.title)} (${tree.id}) from its saved progress. Tasks active at the checkpoint: ${restored.resume.join(', ') || 'none'}. Preserve other user pauses and recheck blockers.`
        const notice = request.continue
          ? createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: noticeText }] })
          : undefined
        return {
          version: 1,
          sessionId: session.id,
          callId: request.id,
          tree,
          annotations: existing === undefined ? restored.annotations : [],
          prepared: true,
          ...(notice === undefined ? {} : { continuation: { id: notice.id, text: noticeText } }),
        }
      })
      await this.append(session, 'plugin:timeline/import-ready', (state) => {
        if (state.preparedImport?.callId !== request.id) return
        signal.throwIfAborted()
        return { version: 1, sessionId: session.id, callId: request.id }
      })
      const state = this.stateOf(session)
      const call = state.calls.find(item => item.id === request.id)
      const tree = state.view.trees.find(item => item.id === id)
      assert(call !== undefined && tree !== undefined, 'Timeline import was not published')
      const continuation = request.continue ? call.continuation : undefined
      let notified = false
      if (continuation !== undefined) {
        if (call.notified) {
          // A cold Session can still have this request in its queue. Leave that occurrence intact.
          notified = !agent.inbox.nextTurn.some(message => message.id === continuation.id)
        } else {
          notice = {
            ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: continuation.text }] }),
            id: continuation.id as UserMessage['id'],
          }
        }
      }
      result = { action: 'import', tree: id, reused, notified }
    } else {
      let removed = false
      let draft = false
      await this.append(session, 'plugin:timeline/remove', (state) => {
        signal.throwIfAborted()
        if (request.draft === true && state.hasTurn)
          throw new Error('This conversation has started. Remove the task tree from its menu instead.')
        const tree = state.view.trees.find(tree => tree.id === request.tree)
        if (tree === undefined) return
        removed = true
        draft = !state.hasTurn
        if (!draft)
          notice = createUserMessage({
            source: { kind: 'user' },
            content: [{
              type: 'text',
              text: `User removed task tree ${JSON.stringify(tree.title)} (${tree.id}) from this session. Leave it removed unless the user requests it again.`,
            }],
          })
        return { version: 1, sessionId: session.id, treeId: tree.id }
      })
      result = { action: 'remove', removed, notified: false, draft }
    }
    signal.throwIfAborted()
    return { result, notice }
  }

  /** Save before admission. The write queue arbitrates duplicate requests from every Client. */
  private async control(
    session: Session,
    request: Extract<UserEdit, { action: 'control' }>,
  ): Promise<UserEditResult> {
    let saved: Annotation | undefined
    const update = { dispatch: false }
    let context: Extract<UserEditResult, { action: 'control' }>['context'] = null
    await this.append(session, 'plugin:timeline/annotation', (state) => {
      const existing = state.view.annotations.find(item => item.id === request.id)
      if (
        existing !== undefined &&
        (existing.control?.action !== request.intent ||
          existing.text !== request.text ||
          JSON.stringify(existing.target) !== JSON.stringify(request.target))
      )
        throw new Error('A request identity cannot be reused for different content')
      // A timeout is permission for an explicit new attempt, not an automatic retry or a failure.
      saved = existing ?? pendingControl(state.view.annotations, request.target, state.view.trees, Date.now())
      if (saved !== undefined) {
        context = { target: saved.target }
        return
      }
      const target = request.target
      const tree = state.view.trees.find(tree => tree.id === target.tree)
      const task = target.kind === 'task' ? tree?.tasks.find(task => task.id === target.task) : undefined
      if (tree === undefined || (target.kind === 'task' && (task === undefined || task.status === 'retired')))
        throw new Error('Unknown available Timeline task')
      context = { target, treeTitle: tree.title, taskTitle: task?.title ?? null }
      saved = {
        id: request.id,
        target,
        text: request.text,
        createdAt: Date.now(),
        reply: null,
        control: { action: request.intent, delivery: 'sending', outcome: null },
      }
      update.dispatch = true
      return { version: 1, sessionId: session.id, annotation: saved }
    })
    assert(saved !== undefined, 'Timeline request was not saved')
    // The reducer can observe that the requested plan state has already been reached.
    const id = saved.id
    const current = this.stateOf(session).view.annotations.find(item => item.id === id)
    return {
      action: 'control',
      annotation: current ?? saved,
      dispatch: update.dispatch && current?.control?.outcome === null,
      context,
    }
  }

  /** Read task, report, and activity state from the Session projection. */
  stateOf(session: Session): TimelineState {
    return this.projection.stateOf(session)
  }

  /**
   * Serialize changes to one live Session and flush its append-only log.
   * @param session - session whose plan or reports are affected.
   * @param type - discriminator of the record being written.
   * @param change - record or function that derives it from the latest state.
   */
  append<K extends keyof TimelineRecordMap>(
    session: Session,
    type: K,
    change: TimelineRecordMap[K] | ((state: TimelineState) => TimelineRecordMap[K] | undefined),
  ): Promise<void> {
    return this.enqueue(session.id, async () => {
      if (!this.available(session))
        throw new TimelineError('Timeline requires a live session with durable persistence', 'TIMELINE_PERSISTENCE')
      const previous = this.stateOf(session)
      const data = typeof change === 'function' ? change(previous) : change
      if (data !== undefined) {
        if (data.sessionId !== session.id) throw new TimelineError('Timeline update belongs to another session')
        if ((type === 'plugin:timeline/annotation' && previous.view.annotations.length >= MAX_ANNOTATIONS)
          || (type === 'plugin:timeline/import' && 'annotations' in data && previous.view.annotations.length + data.annotations.length > MAX_ANNOTATIONS))
          throw new TimelineError(`Timeline can hold up to ${MAX_ANNOTATIONS} discussions per Session`)
        // Log data has the same JSON boundary as the model transport.
        const serialized = JSON.stringify(data)
        if (type === 'plugin:timeline/tree' && Buffer.byteLength(serialized) > CHECKPOINT_BYTES)
          throw new TimelineError('Task tree updates can save up to 2 MiB. Shorten task details or split work across trees.')
        const encoded: unknown = JSON.parse(serialized)
        if (type === 'plugin:timeline/request') requestRecordSchema.parse(encoded)
        const next = type === 'plugin:timeline/request' ? previous : foldRecord(previous, { type, data: encoded })
        if (type !== 'plugin:timeline/request' && next === previous) throw new TimelineError('Invalid Timeline update')
        const urgent = this.unflushed.get(session) === true ||
          ('priority' in data && changesUrgentPriority(previous, next, data))
        appendPluginRecord(session, type, encoded as PluginRecordMap[K])
        this.unflushed.set(session, urgent)
      }
      // A no-op can see a buffered record left by an unsuccessful flush.
      const urgent = this.unflushed.get(session)
      if (urgent === undefined) return
      try {
        if (!(await this.ctx.sessions.flush(session))) throw new Error('No Session persistence listener')
      } catch (error: unknown) {
        throw new TimelineError('Timeline could not save the Session. Check storage and retry.', 'TIMELINE_PERSISTENCE', { cause: error })
      }
      this.unflushed.delete(session)
      if (urgent) this.ctx.emit('timeline/priority', session)
    })
  }
}
