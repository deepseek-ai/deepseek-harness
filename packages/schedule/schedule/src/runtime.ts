/**
 * Disposable live timer projection for one exact root agent.
 * @module @deepseek-ai/dsh-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { EveryScheduleRecord, OneShotScheduleRecord } from './types.ts'
import {
  foldScheduleEvents,
  renderEveryReminderBatchFraming,
  renderReminderFraming,
  resolveEveryOccurrence,
  ScheduleLogError,
} from './domain.ts'
import type { FoldedSchedules } from './domain.ts'
import { flushSchedulePersistence } from './persistence.ts'
import { runScheduleTransaction } from './transaction.ts'

/** Largest delay that Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

interface EveryDue {
  readonly record: EveryScheduleRecord
  readonly occurrenceAt: string
}

type DueDecision =
  | { readonly kind: 'one-shot'; readonly record: OneShotScheduleRecord }
  | { readonly kind: 'every'; readonly reminders: readonly EveryDue[]; readonly acceptedAt: string }
  | { readonly kind: 'wait'; readonly target?: number }

/** Select one due one-shot, one complete fixed-rate batch, or the next wake. */
function dueDecision(folded: FoldedSchedules, now: number): DueDecision {
  const indexed = folded.active.map((record, index) => ({ record, index }))
  const byTargetThenCreate = (
    left: { readonly record: { readonly scheduledAt: string }; readonly index: number },
    right: { readonly record: { readonly scheduledAt: string }; readonly index: number },
  ): number => Date.parse(left.record.scheduledAt) - Date.parse(right.record.scheduledAt)
    || left.index - right.index

  const oneShot = indexed
    .filter((entry): entry is { record: OneShotScheduleRecord; index: number } =>
      entry.record.kind !== 'every' && Date.parse(entry.record.scheduledAt) <= now)
    .sort(byTargetThenCreate)[0]?.record
  if (oneShot !== undefined) return { kind: 'one-shot', record: oneShot }

  const every = indexed
    .filter((entry): entry is { record: EveryScheduleRecord; index: number } =>
      entry.record.kind === 'every' && Date.parse(entry.record.scheduledAt) <= now)
    .sort(byTargetThenCreate)
  if (every.length > 0) {
    return {
      kind: 'every',
      acceptedAt: new Date(now).toISOString(),
      reminders: every.map(({ record }) => ({
        record,
        occurrenceAt: resolveEveryOccurrence(record, now).occurrenceAt,
      })),
    }
  }

  const target = folded.active.reduce<number | undefined>((selected, record) => {
    const candidate = Date.parse(record.scheduledAt)
    return candidate > now && (selected === undefined || candidate < selected) ? candidate : selected
  }, undefined)
  return { kind: 'wait', ...(target === undefined ? {} : { target }) }
}

/** Render an unknown value for process-local diagnostics only. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** One process-local, disposable projection of an exact agent's durable schedules. */
export class ScheduleRuntime {
  private readonly stop = Promise.withResolvers<void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private idleWait: Promise<void> | undefined
  private run: Promise<void> | undefined
  private requested = false
  private stopping = false
  private faulted = false
  private disposal: Promise<void> | undefined

  /**
   * Construct an inactive runtime; {@link start} begins the first preflight.
   * @param ctx - Global service context.
   * @param agent - Exact live root agent.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {}

  /** Begin the initial durability preflight and timer derivation. */
  start(): void {
    this.requestDrive()
  }

  /** Recompute the live projection after a committed mutation or idle transition. */
  requestDrive(): void {
    if (this.stopping || this.faulted) return
    this.clearTimer()
    this.requested = true
    if (this.run !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(() => this.runRequested())
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`schedule: could not start runtime for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    this.run = run
    void run.then(
      () => { this.retire(run) },
      (error: unknown) => {
        if (this.isLive()) {
          this.ctx.logger.warn(`schedule: runtime failed for agent "${this.agent.id}": ${renderThrown(error)}`)
        }
        this.faulted = true
        this.retire(run)
      },
    )
  }

  /** Stop future work, cancel timers, and await every outstanding runtime promise. */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopping = true
      this.requested = false
      this.clearTimer()
      this.stop.resolve()
      const pending = [this.run, this.idleWait].filter((value): value is Promise<void> => value !== undefined)
      await Promise.allSettled(pending)
    })())
  }

  /** Drain coalesced triggers serially. */
  private async runRequested(): Promise<void> {
    while (this.requested && !this.stopping && !this.faulted) {
      this.requested = false
      await runScheduleTransaction(this.agent, () => this.driveOnce())
    }
  }

  /** Retire one exact run and honor a trigger that landed during its final microtask. */
  private retire(run: Promise<void>): void {
    /* v8 ignore next -- only the exact stored run installs this callback. */
    if (this.run !== run) return
    this.run = undefined
    /* v8 ignore next -- covers a trigger in the promise-settlement microtask gap. */
    if (this.requested && !this.stopping && !this.faulted) this.requestDrive()
  }

  /** Whether this exact root lifecycle remains authoritative. */
  private isLive(): boolean {
    return this.ctx.agents.get(this.agent.id) === this.agent
      && this.ctx.agents.roots().includes(this.agent)
  }

  /** Whether this runtime may start or continue Schedule work. */
  private isRunnable(): boolean {
    return !this.stopping && this.isLive()
  }

  /** Cancel the currently armed timer, if any. */
  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arm one bounded timer segment; every wake rechecks the wall clock. */
  private arm(target: number, now: number): void {
    const delay = Math.min(target - now, MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }

  /** Await one public idle boundary without holding admission or creating a retry timer. */
  private waitForIdle(): void {
    if (this.idleWait !== undefined) return
    const wait = Promise.race([this.agent.whenIdle(), this.stop.promise])
    this.idleWait = wait
    void wait.then(
      () => {
        this.idleWait = undefined
        this.requestDrive()
      },
      (error: unknown) => {
        this.idleWait = undefined
        if (this.isLive()) {
          this.ctx.logger.warn(`schedule: idle wait failed for agent "${this.agent.id}": ${renderThrown(error)}`)
        }
      },
    )
  }

  /** Fold the current exact runtime suffix and contain a corrupt durable stream. */
  private readFolded(): FoldedSchedules | undefined {
    try {
      return foldScheduleEvents(
        this.agent.session.snapshotEvents(),
        this.agent.session.header.seedLength ?? 0,
      )
    } catch (error: unknown) {
      this.faulted = true
      const detail = error instanceof ScheduleLogError ? error.message : renderThrown(error)
      this.ctx.logger.warn(`schedule: corrupt schedule log for agent "${this.agent.id}": ${detail}`)
      return undefined
    }
  }

  /** Contain an invalid wall-clock decision without permanently faulting this runtime. */
  private decide(folded: FoldedSchedules, now: number): DueDecision | undefined {
    try {
      return dueDecision(folded, now)
    } catch (error: unknown) {
      this.ctx.logger.warn(`schedule: fixed-rate decision failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      return undefined
    }
  }

  /** Preflight, fold, arm, or dispatch the next one-shot or fixed-rate batch. */
  private async driveOnce(): Promise<void> {
    this.clearTimer()
    if (!this.isRunnable()) return
    try {
      await flushSchedulePersistence(this.ctx, this.agent.session)
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`schedule: preflight failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    if (!this.isRunnable()) return

    const folded = this.readFolded()
    if (folded === undefined) return
    const wakeNow = Date.now()
    const wakeDecision = this.decide(folded, wakeNow)
    if (wakeDecision === undefined) return
    if (wakeDecision.kind === 'wait') {
      if (wakeDecision.target !== undefined) this.arm(wakeDecision.target, wakeNow)
      return
    }

    let maintenance: Promise<boolean>
    try {
      maintenance = this.agent.runMaintenance(() => {
        if (!this.isRunnable()) return Promise.resolve(false)
        const claimed = this.readFolded()
        if (claimed === undefined) return Promise.resolve(false)
        const decisionNow = Date.now()
        const decision = this.decide(claimed, decisionNow)
        if (decision === undefined) return Promise.resolve(false)
        if (decision.kind === 'wait') {
          if (decision.target !== undefined) this.arm(decision.target, decisionNow)
          return Promise.resolve(false)
        }
        try {
          const text = decision.kind === 'one-shot'
            ? renderReminderFraming(decision.record)
            : renderEveryReminderBatchFraming(decision.reminders)
          const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'schedule' },
          })
          this.agent.followup(message)
        } catch (error: unknown) {
          if (this.isLive()) {
            this.ctx.logger.warn(`schedule: framing or followup failed for agent "${this.agent.id}": ${renderThrown(error)}`)
          }
          return Promise.resolve(false)
        }
        try {
          if (decision.kind === 'one-shot') {
            this.agent.session.append('schedule/change', {
              version: 1,
              operation: 'dispatch',
              id: decision.record.id,
            })
          } else {
            for (const reminder of decision.reminders) {
              this.agent.session.append('schedule/change', {
                version: 1,
                operation: 'dispatch',
                id: reminder.record.id,
                acceptedAt: decision.acceptedAt,
              })
            }
          }
        } catch (error: unknown) {
          this.faulted = true
          this.clearTimer()
          this.ctx.logger.warn(`schedule: dispatch append failed for agent "${this.agent.id}": ${renderThrown(error)}`)
          return Promise.resolve(false)
        }
        return Promise.resolve(true)
      })
    } catch (_busy: unknown) {
      // `runMaintenance` rejects synchronously only while another agent activity owns the idle phase.
      if (this.isLive()) this.waitForIdle()
      return
    }
    if (!await maintenance) return

    try {
      await flushSchedulePersistence(this.ctx, this.agent.session)
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`schedule: dispatch barrier failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    if (this.isRunnable()) this.requestDrive()
  }
}
