/** Host-wide durable reminders and shared human/model management. */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { ScheduleRuntime } from './runtime.ts'
import { scheduleDomain } from './storage.ts'
import { deliveryHistoryPage } from './delivery-history.ts'
import { resolveScheduleUpdate } from './update.ts'
import {
  foldScheduleEvents, ScheduleInputError, ScheduleLogError, ScheduleId, createAfterScheduleRecord, createAtScheduleRecord,
  createEveryScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord,
  scheduleTitle,
} from './domain.ts'
import type {
  DeliveryRetentionBounds, ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleDeleteRequest, ScheduleDeleteResult,
  ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult, ScheduleListRequest, ScheduleRecord,
  ScheduleUpdateRequest, ScheduleUpdateResult, SubagentSessionError,
} from './types.ts'

export type * from './types.ts'
export { scheduleDomain } from './storage.ts'
export type { ScheduleTask } from './storage.ts'
export type { RecurringOccurrence } from './domain.ts'
export {
  SCHEDULE_CHANGE_VERSION,
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TITLE_LENGTH,
  REQUIRED_TITLE_MESSAGE,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  createDailyScheduleRecord,
  createWeeklyScheduleRecord,
  createCronScheduleRecord,
  decodeScheduleChange,
  decodeScheduleRecord,
  foldScheduleEvents,
  isRecurringScheduleRecord,
  normalizeWeekdays,
  parseCronInput,
  parseWeeklyInput,
  renderReminderFraming,
  renderRecurringReminderBatchFraming,
  resolveEveryOccurrence,
  resolveDailyOccurrence,
  resolveWeeklyOccurrence,
  resolveCronOccurrence,
  resolveRecurringOccurrence,
  scheduleTitle,
  scheduleView,
  weeklyTime,
} from './domain.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Host-wide reminder management. */
    schedule: ScheduleService
  }
}

/** Configuration for the Host Schedule domain. */
export interface Config {
  /**
   * Delivery-history window retained per task, in days; omission defaults to 30.
   * Pruning happens when an acknowledgment is appended, and `lastDelivery` is always retained.
   */
  deliveryHistoryDays?: number
  /**
   * Retained delivery records per task; omission defaults to 200. The older of this
   * cap and the window wins, and the newest records survive.
   */
  deliveryHistoryRecords?: number
}

/** Retained delivery-history window applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30

/** Retained delivery-history record cap applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/**
 * Shared management service; reads, deletion, and timing edits never activate a Session.
 *
 * `sessionPersistence` is a load-order requirement rather than a directly called
 * service: a delivery commits only when `ctx.sessions.flush()` reports that a
 * `session/flush` listener participated, and the persistence backend providing this
 * service is the plugin that registers that listener.
 */
export class ScheduleService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'storageDomain', 'sessionController', 'sessionPersistence']

  static Config: z<Config> = z.object({
    deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(DEFAULT_DELIVERY_HISTORY_DAYS),
    deliveryHistoryRecords: z.number().step(1).min(1).max(10_000).default(DEFAULT_DELIVERY_HISTORY_RECORDS),
  })

  /** Resolved retention bounds shared with the runtime that appends acknowledgments. */
  private readonly retention: DeliveryRetentionBounds
  private readonly ready: Promise<Domain<typeof scheduleDomain>>
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private runtime: ScheduleRuntime | undefined
  private stopping = false

  /**
   * @param ctx - Host services owning storage, dispatch, and Session restoration.
   * @param config - Validated retention configuration for delivery history.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'schedule')
    this.retention = {
      days: config.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
      records: config.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS,
    }
    this.ready = ctx.storageDomain.open(scheduleDomain).then(async (domain) => {
      for (const [key, task] of domain.table('tasks').entries()) {
        if (key !== task.record.id) {
          // The mismatch is the actionable failure; a rejecting close must not replace it.
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`schedule: closing the domain after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`schedule: stored task key "${key}" differs from record id "${task.record.id}"`)
        }
      }
      return domain
    })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.runtime?.dispose()
          await this.chain // The chain contains failures after returning them to their callers.
          await domain.close()
        })
      } catch (error) {
        this.stopping = true
        await domain.close()
        throw error
      }
      const tasks = domain.table('tasks')
      this.runtime = new ScheduleRuntime(ctx,
        () => [...tasks.entries()].map(([, task]) => task),
        work => this.serialize(work),
        async (task) => {
          await tasks.put(task.record.id, task)
          this.emitChanged()
        },
        this.retention)
      this.runtime.requestDrive()
      return cleanup
    })
    ctx.on('session/created', (session) => {
      // Historical Schedule events remain readable but do not populate Host tasks.
      // A throwing `session/created` listener rolls the attach back, so an unreadable
      // legacy stream must warn here instead of blocking Session creation.
      let activeLegacy = 0
      try {
        // oxlint-disable-next-line typescript/no-deprecated -- Explicit warning for legacy Schedule history.
        activeLegacy = foldScheduleEvents(session.ownEvents()).active.length
      } catch (error: unknown) {
        /* v8 ignore next -- foldScheduleEvents normalizes every rejected stream to ScheduleLogError. */
        if (!(error instanceof ScheduleLogError)) throw error
        ctx.logger.warn(`schedule: Session "${session.id}" historical events could not be read (${error.message}); the legacy reminder is ignored.`)
        return
      }
      if (activeLegacy > 0) {
        ctx.logger.warn(`schedule: Session "${session.id}" contains legacy reminders; recreate active reminders with schedule_create.`)
      }
    }, { global: true })
    // Host tasks outlive their Session's Agent, so archive admission reads the
    // stored rows rather than a live runtime: an idle Session whose reminders
    // are still armed refuses the archive, and an archiving stop deletes those
    // rows instead of letting them deliver into a closed Session.
    ctx.effect(() => {
      const activity = ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        const active = await this.list({ sessionId })
        const rest = await next()
        if (active.length === 0) return rest
        const own: SessionActivity = {
          kind: 'schedule',
          items: active.map(record => ({ id: record.id, label: record.title })),
        }
        return [own, ...rest]
      })
      const stop = ctx.on('workspace/session-stop', async ({ sessionId }) => {
        await this.stopSessionTasks(sessionId)
      })
      return () => {
        stop()
        activity()
      }
    }, 'schedule.archiveAdmission()')
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Create a reminder bound to the caller-selected Session without activating it.
   *
   * The request must supply a title; a missing, blank-after-trim, or over-long
   * title rejects with `invalid_prompt` instead of deriving one from the prompt.
   * A Session a delegated child owns rejects with `subagent_session`, because delivery
   * can never reach it: the child is one whose delegation depth is above zero.
   * The record is built from the clock reading taken before the request joins the
   * serialized queue, so a create that waits behind a longer operation keeps its
   * request-time anchor and may already be due when the queue reaches it.
   * @param sessionId - Original Session receiving the reminder.
   * @param request - Validated tool selector, required title, and reminder content.
   * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
   * @returns The durably stored schedule. Cancellation does not roll back an in-flight write.
   */
  async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord> {
    if (Number(request.at !== undefined) + Number(request.after_seconds !== undefined)
      + Number(request.every_seconds !== undefined) + Number(request.daily !== undefined)
      + Number(request.weekly !== undefined) + Number(request.cron !== undefined) > 1) {
      throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    }
    const title = scheduleTitle(request.title)
    const id = ScheduleId(`schedule-${randomUUID()}`)
    const now = Date.now()
    let record: ScheduleRecord
    if (request.at !== undefined) {
      record = createAtScheduleRecord(id, request.prompt, request.at, now, title)
    }
    else if (request.after_seconds !== undefined) {
      record = createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
    }
    else if (request.every_seconds !== undefined) {
      record = createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
    }
    else if (request.daily !== undefined) record = createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
    else if (request.weekly !== undefined) record = createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
    else if (request.cron !== undefined) record = createCronScheduleRecord(id, request.prompt, request.cron, now, title)
    else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    return this.serialize(async () => {
      const refusal = this.reminderTargetRefusal(sessionId)
      if (refusal !== undefined) throw new ScheduleInputError('subagent_session', refusal.message)
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      await domain.table('tasks').put(id, {
        sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      this.emitChanged()
      this.runtime?.requestDrive()
      return record
    })
  }

  /**
   * Read the selected Session's active tasks without resuming its Agent.
   * @param request - Session whose task list is requested.
   * @returns Persisted reminders in storage order.
   */
  @Remote('list')
  async list(request: ScheduleListRequest): Promise<ScheduleRecord[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .filter(([, task]) => task.sessionId === request.sessionId && task.status === 'active')
      .map(([, task]) => task.record)
  }

  /**
   * Read all active and inactive Host reminders with their original Session bindings.
   * A deleted reminder has no row, so it is absent here.
   * Does not activate Sessions or read Session history.
   * @returns Reminders ordered by scheduledAt ascending, then lexicographically by id.
   */
  @Remote('catalog')
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .map(([, task]) => ({
        ...task.record, sessionId: task.sessionId, status: task.status,
        ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
      }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  }

  /**
   * Read saved inbox deliveries without activating or reading the original Session.
   * The task's own row supplies its binding, so its records stay readable through this lookup.
   * @param request - Session binding, task identity, explicit limit, and optional exclusive message cursor.
   * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
   * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
   */
  @Remote('history')
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    const task = (await this.getDomain()).table('tasks').get(request.id)
    if (task === undefined || task.sessionId !== request.sessionId) {
      return { id: request.id, code: 'schedule_not_found' }
    }
    return deliveryHistoryPage(task, request, this.retention)
  }

  /**
   * Delete one task belonging to the selected Session, leaving queued messages intact.
   *
   * The row is removed: the task no longer schedules, leaves `list` and `catalog`, and its
   * saved delivery records go with it. A task bound to a Session a delegated child owns
   * stays deletable even though creation and timing edits refuse that binding, so a task
   * stored before that rule existed remains removable.
   * @param request - Session and exact task identity.
   * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
   * @returns Whether that Session owned a deleted task. Cancellation does not roll back an in-flight write.
   */
  @Remote('delete')
  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    return this.serialize<ScheduleDeleteResult>(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      await tasks.delete(request.id)
      this.emitChanged()
      this.runtime?.requestDrive()
      return { id: request.id, deleted: true }
    })
  }

  /**
   * Update the name, instruction, and timing of an active task within the original Session
   * binding without activating the Session or changing saved deliveries.
   *
   * Each supplied field replaces its stored value; an omitted field keeps it. A name or
   * instruction change alone does not reset the committed target. A Session a delegated
   * child owns returns the non-mutating `subagent_session` result, so an edit cannot
   * re-arm a task bound to a Session delivery can never reach, and the Web editor can
   * explain the refusal through the ordinary result it already renders.
   * @param request - Task binding, complete observed record, and any combination of timing, name, and instruction.
   * @param signal - Cancellation checked after domain readiness and FIFO waits, before persistence begins.
   * @returns The committed record, unchanged record for a no-op, or a non-mutating input/lookup/conflict/refusal result.
   * Storage and lifecycle failures reject; cancellation after a write starts does not roll it back.
   */
  @Remote('update')
  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    return this.serialize<ScheduleUpdateResult>(async () => {
      const refusal = this.reminderTargetRefusal(request.sessionId)
      if (refusal !== undefined) return refusal
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, updated: false, code: 'schedule_not_found' }
      }
      if (current.status === 'inactive') return { id: request.id, updated: false, code: 'schedule_ended' }
      const result = resolveScheduleUpdate(current.record, request.expected, request.change, Date.now(), request)
      if (!('record' in result) || !result.updated) return result
      await tasks.put(request.id, { ...current, record: result.record })
      this.emitChanged()
      this.runtime?.requestDrive()
      return result
    })
  }

  /**
   * Dispatch one post-commit `schedule/changed` notification, containing
   * synchronous listener failures: every call site emits only after its durable
   * task write landed, so a throwing listener must not reject the caller or
   * skip the following `requestDrive()`.
   */
  private emitChanged(): void {
    try {
      this.ctx.emit('schedule/changed')
    } catch (error: unknown) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant.
      this.ctx.logger.warn(`schedule: schedule/changed listener failed: ${String(error)}`)
    }
  }

  private async getDomain(): Promise<Domain<typeof scheduleDomain>> {
    await this.initialized
    return this.ready
  }

  /**
   * Refuse a Session no delivery can reach because a delegated child owns it.
   *
   * Delivery resolves the bound Session through `ctx.sessionController.resolveAgent`,
   * which rejects the live Agent of a delegated child; a stored task for such a Session
   * would stay permanently overdue and retry on every drive. Both operations that can
   * arm a delivery read that same fact here instead of restating it: a delegated child
   * is one whose {@link delegationDepthOf} is above zero, the accounting the delegation
   * cap itself enforces, which survives a cold resume through the persisted header.
   * @param sessionId - Session the task would be bound to.
   * @returns The stable refusal for a delegated child's Session, or undefined when the Session is eligible.
   */
  private reminderTargetRefusal(sessionId: SessionId): SubagentSessionError | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined || delegationDepthOf(agent) === 0) return undefined
    return {
      code: 'subagent_session',
      message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
    }
  }

  /**
   * Remove every active task stored for one Session, inside the queue the tools
   * use.
   *
   * Enumerating and deleting in one queue slot is what makes an archive stop
   * ordered behind a create whose write is still in flight: a stop that read the
   * table outside the queue could miss a row the create was about to commit and
   * leave an armed reminder behind. Re-entering the public `delete()` from here
   * would deadlock on this queue, so the rows are removed directly.
   * @param sessionId - Session whose active Host tasks must stop.
   */
  private async stopSessionTasks(sessionId: SessionId): Promise<void> {
    await this.serialize(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      const active = [...tasks.entries()]
        .filter(([, task]) => task.sessionId === sessionId && task.status === 'active')
        .map(([, task]) => task.record.id)
      if (active.length === 0) return
      // One row per write: the domain table has no batch delete, and each row is
      // durable on its own, so a failure partway through leaves the rows already
      // removed committed. Observers hear about that change before the failure
      // reaches the caller, which still receives it.
      let removed = false
      let failure: Error | undefined
      for (const id of active) {
        try {
          await tasks.delete(id)
          removed = true
        } catch (error: unknown) {
          // Every row is attempted: the archive has already landed, so a row this
          // stop skipped would stay armed in a Session whose runtime then refuses
          // its model steps. A rejection reason that carries no Error still has to
          // report a failure, so it is wrapped before the first one is kept.
          failure ??= error instanceof Error ? error : new Error(`schedule stop failed: ${String(error)}`)
        }
      }
      if (removed) {
        this.emitChanged()
        this.runtime?.requestDrive()
      }
      if (failure !== undefined) throw failure
    })
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined) // Preserve FIFO progress after the caller receives the failure.
    return pending
  }
}

export default ScheduleService
