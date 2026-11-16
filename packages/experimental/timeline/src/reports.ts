// Scheduler and auxiliary-call mechanism adapted from kermanx/dsh-progress-check (MIT).
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { newId, reportId } from './records.ts'
import type { IntervalReport, StoredRequest } from './records.ts'
import type { Config } from './config.ts'
import type { OwnsAgent } from './delegation.ts'
import type { TimelineStorage } from './storage.ts'
import { languageText, MINUTE_MS, outputLanguage } from './policy.ts'
import { summarizeReport } from './summary.ts'
import { activeRanges, mergeRanges, reportPeriods, reportRanges } from './periods.ts'

type Outcome = { ok: true } | { ok: false; message: string }

interface Snapshot {
  request: StoredRequest
  toolCount: number
  seq: number
  time: number
  prefixLength: number
}
interface Work {
  agent: Agent
  timer: ReturnType<typeof setTimeout> | undefined
  retryAt: Map<number, number>
  snapshot: Snapshot | undefined
  snapshotCurrent: boolean
  rollupSnapshot: Snapshot | undefined
  covered: number
  lastEnd: number
  operation: Promise<Outcome> | undefined
  controller: AbortController | undefined
  requestSignal: AbortSignal | undefined
}

/** Combine unconsumed children once the level's elapsed-time threshold is reached. */
function rollupBatch(
  reports: readonly IntervalReport[],
  level: number,
  period: number,
  policy: string,
  now: number,
): IntervalReport[] {
  const parents = reports.filter(item => item.level === level && item.policy === policy)
  const used = new Set(parents.flatMap(item => item.children))
  const available = reports
    .filter(
      item =>
        item.level === level - 1 &&
        item.policy === policy &&
        Math.max(item.end, item.createdAt ?? item.end) <= now &&
        !used.has(item.id),
    )
    .sort((a, b) => a.end - b.end)
  const start =
    parents.length === 0
      ? (available[0]?.start ?? now)
      : parents.reduce((end, item) => Math.max(end, item.end, item.createdAt ?? item.end), 0)
  return now - start >= period ? available : []
}

/**
 * Check elapsed thresholds while active; idle Sessions catch up on their next turn.
 * @param ctx - owning plugin context.
 * @param config - current Timeline settings.
 * @param storage - Timeline's session data service.
 * @param owns - whether this installation owns the agent's planning tools.
 */
export function installReports(ctx: Context, config: Config, storage: TimelineStorage, owns: OwnsAgent): void {
  const work = new Map<Agent['session']['id'], Work>()
  const pending = new Set<Promise<Outcome>>()
  const disabled = new Error('Timeline interval reports disabled')
  let enabled = config.reportsEnabled
  let stopped = false
  let active = 0
  const stateOf = (entry: Work) => storage.stateOf(entry.agent.session)
  const pause = (entry: Work) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
  }
  const arm = (entry: Work) => {
    if (
      stopped ||
      !enabled ||
      work.get(entry.agent.session.id) !== entry ||
      entry.agent.status !== 'running' ||
      !owns(entry.agent) ||
      !storage.available(entry.agent.session) ||
      entry.timer !== undefined ||
      entry.operation !== undefined
    )
      return
    // Only active Agents own a minute tick; saved coverage owns every deadline.
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      pump()
    }, MINUTE_MS)
    entry.timer.unref()
  }
  const attach = (agent: Agent) => {
    if (
      work.has(agent.session.id) ||
      !storage.available(agent.session) ||
      agent.session.header.origin === 'subagent' ||
      !owns(agent)
    )
      return
    const state = storage.stateOf(agent.session)
    const entry: Work = {
      agent,
      timer: undefined,
      retryAt: new Map(),
      snapshot: undefined,
      snapshotCurrent: false,
      rollupSnapshot: undefined,
      covered: state.covered,
      lastEnd: state.lastReportEnd,
      operation: undefined,
      controller: undefined,
      requestSignal: undefined,
    }
    work.set(agent.session.id, entry)
    arm(entry)
  }
  const flush = async (entry: Work) => {
    if (!(await ctx.sessions.flush(entry.agent.session)))
      throw new Error('Timeline requires durable session persistence')
    // A failed Session flush can follow a durable report. A recovered flush acknowledges it once.
    const state = stateOf(entry)
    if (state.lastReportEnd > entry.lastEnd) {
      entry.covered = state.covered
      entry.lastEnd = state.lastReportEnd
    }
  }
  const baseStart = (entry: Work, state: ReturnType<typeof stateOf>, now: number) =>
    state.toolCount === 0 && state.lastReportEnd === entry.agent.session.header.createdAt
      ? (state.activity.open ?? now)
      : entry.lastEnd
  const baseDue = (entry: Work, now: number, period = config.intervalMs) => {
    const state = stateOf(entry)
    const start = baseStart(entry, state, now)
    const last = state.view.reports.reduce(
      (end, report) => (report.level === 0 ? Math.max(end, report.createdAt ?? report.end) : end),
      start,
    )
    if (now - last < period) return false
    const activity = state.activity
    return (
      state.toolCount > entry.covered ||
      activity.olderWorkMs > 0 ||
      activeRanges(activity, start, now).length > 0 ||
      activity.open === now
    )
  }
  const baseEnd = (entry: Work, now: number): number | undefined => {
    const count = stateOf(entry).toolCount
    if (count === entry.covered) return now
    const { snapshot } = entry
    if (snapshot === undefined || snapshot.toolCount <= entry.covered) return undefined
    if (snapshot.toolCount === count) return entry.snapshotCurrent ? now : undefined
    // Cover only the last complete request. A later tool batch keeps its own watermark.
    return snapshot.time > entry.lastEnd && snapshot.time <= now ? snapshot.time : undefined
  }
  const save = async (
    entry: Work,
    report: IntervalReport,
    snapshot: Snapshot | undefined,
    children: IntervalReport[],
    signal: AbortSignal,
    settings: Parameters<typeof summarizeReport>[1]['settings'],
  ) => {
    signal.throwIfAborted()
    let result = report
    if (report.source === 'model') {
      assert(snapshot !== undefined, 'Waiting for a complete model request')
      result = {
        ...report,
        summary: await summarizeReport(
          ctx.llm,
          {
            draft: report,
            request: snapshot.request,
            previous: stateOf(entry).view.reports.findLast(
              item => item.level === 0 && item.end <= report.start,
            )?.summary,
            children,
            settings,
            record: async (request) => {
              await flush(entry)
              signal.throwIfAborted()
              const sharesPrefix = children.length === 0 && request.messages[0] === snapshot.request.messages[0]
              const prefixLength = sharesPrefix ? snapshot.prefixLength : 0
              await storage.append(entry.agent.session, 'plugin:timeline/request', {
                version: 1,
                sessionId: entry.agent.session.id,
                id: report.id,
                contextSeq: snapshot.seq,
                prefixLength,
                request: { ...request, messages: request.messages.slice(prefixLength) },
              })
            },
          },
          signal,
        ),
      }
    }
    signal.throwIfAborted()
    await flush(entry)
    await storage.append(entry.agent.session, 'plugin:timeline/report', () => {
      signal.throwIfAborted()
      return {
        version: 1,
        sessionId: entry.agent.session.id,
        report: { ...result, createdAt: Date.now() },
      }
    })
    await flush(entry)
  }
  const check = async (entry: Work, signal: AbortSignal): Promise<Outcome> => {
    let id = reportId.parse(newId('report'))
    let failure: { id: IntervalReport['id']; error: unknown } | undefined
    const attempt = async (level: number, run: (requestSignal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController()
      const timer = setTimeout(
        () => { controller.abort(new Error('Timeline summary timed out')) },
        config.timeoutMs,
      ).unref()
      try {
        await run(AbortSignal.any([signal, controller.signal]))
        entry.retryAt.delete(level)
      } catch (error: unknown) {
        signal.throwIfAborted()
        entry.retryAt.set(level, Date.now() + MINUTE_MS)
        failure = { id, error }
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      if (stateOf(entry).lastReportEnd > entry.lastEnd) await flush(entry)
      // One operation keeps one policy/prompt snapshot, including any rollups it creates.
      const settings = {
        intervalMs: config.intervalMs,
        rollupFactors: config.rollupFactors,
        language: config.language,
        uiLanguage: config.uiLanguage,
        levelPrompts: config.levelPrompts,
        reportMaxTokens: config.reportMaxTokens,
        ...(config.reportReasoningEffort === undefined ? {} : { reportReasoningEffort: config.reportReasoningEffort }),
        summaryPrompt: config.summaryPrompt,
        maxResponseBytes: config.maxResponseBytes,
      }
      const policy = JSON.stringify([settings.intervalMs, ...settings.rollupFactors])
      const snapshot = entry.snapshot
      const count = snapshot?.toolCount ?? stateOf(entry).toolCount
      const now = Date.now()
      const end = ready(entry, 0, now) && baseDue(entry, now, settings.intervalMs) ? baseEnd(entry, now) : undefined
      const state = stateOf(entry)
      const { activity } = state
      const start = baseStart(entry, state, now)
      const ranges = activeRanges(activity, start, end ?? now)
      const workMs = ranges.reduce(
        (sum, [from, to]) => sum + to - from,
        start === entry.lastEnd ? activity.olderWorkMs : 0,
      )
      const draft: IntervalReport = {
        id,
        level: 0,
        start,
        end: end ?? now,
        policy,
        children: [],
        source: count === entry.covered ? 'no-activity' : 'model',
        toolCount: Math.max(0, count - entry.covered),
        covered: count,
        contextSeq: snapshot?.seq ?? 0,
        workMs,
        ranges,
        summary: {
          progress: [languageText[outputLanguage(settings.language, settings.uiLanguage)].noActivity],
          uncertainties: [],
          userActions: [],
        },
      }
      if (end !== undefined)
        await attempt(0, requestSignal => save(entry, draft, snapshot, [], requestSignal, settings))
      const periods = reportPeriods(settings)
      for (const [index, period] of periods.entries()) {
        const childPeriod = periods[index - 1]
        const now = Date.now()
        if (childPeriod === undefined || !ready(entry, index, now)) continue
        const children = rollupBatch(stateOf(entry).view.reports, index, period, policy, now)
        const first = children[0]
        const last = children.at(-1)
        if (first === undefined || last === undefined) continue
        if (
          snapshot === undefined &&
          entry.rollupSnapshot === undefined &&
          children.some(item => item.source === 'model')
        )
          continue
        id = reportId.parse(newId('report'))
        const { activity } = stateOf(entry)
        const childRanges = children.map(child => reportRanges(child, activity))
        const combined = childRanges.every(ranges => ranges !== undefined)
          ? mergeRanges(childRanges.flat())
          : undefined
        const admitted = snapshot ?? entry.rollupSnapshot
        const selection = entry.agent.model.current()
        const route = admitted === undefined || selection === undefined
          ? admitted
          : {
            ...admitted,
            request: { provider: selection.provider, model: selection.model, sessionId: entry.agent.session.id, messages: [] },
          }
        await attempt(index, requestSignal => save(
          entry,
          {
            ...draft,
            id,
            level: index,
            start: first.start,
            end: last.end,
            source: children.every(item => item.source === 'no-activity') ? 'no-activity' : 'model',
            covered: last.covered,
            contextSeq: last.contextSeq,
            toolCount: children.reduce((sum, item) => sum + item.toolCount, 0),
            children: children.map(item => item.id),
            workMs: children.reduce((sum, item) => sum + (item.workMs ?? childPeriod), 0),
            ranges: combined,
          },
          route,
          children,
          requestSignal,
          settings,
        ))
      }
      entry.retryAt.delete(-1)
    } catch (error: unknown) {
      if (signal.reason === disabled) return { ok: true }
      entry.retryAt.set(-1, Date.now() + MINUTE_MS)
      failure = { id, error }
    }
    if (failure === undefined) return { ok: true }
    const { error } = failure
    const message = error instanceof Error ? error.message : String(error)
    if (
      !stopped &&
      work.get(entry.agent.session.id) === entry &&
      ctx.sessions.get(entry.agent.session.id) === entry.agent.session
    ) {
      try {
        await storage.append(entry.agent.session, 'plugin:timeline/failure', {
          version: 1,
          sessionId: entry.agent.session.id,
          id: failure.id,
          message,
        })
        await flush(entry)
      } catch (persistError: unknown) {
        ctx.logger.warn('Timeline persistence failed', persistError)
      }
      ctx.logger.warn('Timeline summary failed; retrying after one minute while active', error)
    }
    return { ok: false, message }
  }
  const ready = (entry: Work, level: number, now: number) => now >= (entry.retryAt.get(level) ?? 0)
  function pump(): void {
    if (stopped || !enabled || active >= config.maxConcurrent) return
    const cadence = { intervalMs: config.intervalMs, rollupFactors: config.rollupFactors }
    const policy = JSON.stringify([cadence.intervalMs, ...cadence.rollupFactors])
    const periods = reportPeriods(cadence)
    for (const entry of work.values()) {
      if (
        entry.operation !== undefined ||
        entry.agent.status !== 'running' ||
        !owns(entry.agent) ||
        !storage.available(entry.agent.session)
      )
        continue
      const now = Date.now()
      if (
        !ready(entry, -1, now) ||
        (!(ready(entry, 0, now) && baseDue(entry, now, cadence.intervalMs) && baseEnd(entry, now) !== undefined) &&
          !periods.some((period, level) => {
            if (level === 0 || !ready(entry, level, now)) return false
            const children = rollupBatch(stateOf(entry).view.reports, level, period, policy, now)
            return (
              children.length > 0 &&
              (entry.rollupSnapshot !== undefined || children.every(item => item.source === 'no-activity'))
            )
          }))
      ) {
        arm(entry)
        continue
      }
      if (active >= config.maxConcurrent) break
      // An admitted Session goes behind Sessions still waiting for a slot.
      work.delete(entry.agent.session.id)
      work.set(entry.agent.session.id, entry)
      pause(entry)
      active++
      const controller = new AbortController()
      entry.controller = controller
      // Session events are synchronous. Defer record writes until their publication finishes.
      const operation = Promise.resolve()
        .then(() => check(entry, controller.signal))
        .finally(() => {
          pause(entry)
          pending.delete(operation)
          entry.operation = undefined
          entry.controller = undefined
          active--
          arm(entry)
          pump()
        })
      entry.operation = operation
      pending.add(operation)
      arm(entry)
    }
  }
  ctx.on('loader/volatile-update', () => {
    if (enabled === config.reportsEnabled) return
    enabled = config.reportsEnabled
    if (enabled) {
      pump()
      return
    }
    for (const entry of work.values()) {
      pause(entry)
      entry.snapshot = undefined
      entry.rollupSnapshot = undefined
      entry.retryAt.clear()
      entry.controller?.abort(disabled)
    }
  })
  ctx.on(
    'agent/created',
    ({ agent }) => {
      attach(agent)
    },
    { global: true },
  )
  ctx.on(
    'agent/status',
    ({ agent, status }) => {
      attach(agent)
      const entry = work.get(agent.session.id)
      if (entry === undefined) return
      if (status === 'idle') {
        pause(entry)
      } else {
        arm(entry)
        pump()
      }
    },
    { global: true },
  )
  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      const entry = work.get(agent.session.id)
      if (entry === undefined) return
      pause(entry)
      entry.controller?.abort(new Error('Agent disposed'))
      work.delete(agent.session.id)
    },
    { global: true },
  )
  ctx.on(
    'session/event',
    (session, event) => {
      const entry = work.get(session.id)
      if (entry === undefined) return
      if ('surfaceOp' in event) entry.snapshotCurrent = false
      if (event.type === 'turn/end') entry.snapshot = undefined
      if (event.type === 'turn/start') pump()
    },
    { global: true },
  )
  ctx.on(
    'agent/request',
    ({ agent, signal }, next) => {
      const entry = work.get(agent.session.id)
      if (entry !== undefined) entry.requestSignal = signal
      return next()
    },
    { global: true },
  )
  ctx.on(
    'llm/stream',
    (options: GenerateOptions, next) => {
      // Main requests have no declared purpose; an extension call may carry one.
      if (enabled && options.sessionId !== undefined && options.purpose === undefined) {
        const entry = work.get(options.sessionId)
        // Public Agent admission identifies the main turn across independent LLM module copies.
        // Compaction can share the turn signal; its public purpose keeps it out of main context.
        if (entry !== undefined && options.signal !== undefined && options.signal === entry.requestSignal) {
          const { signal, ...request } = options
          if (signal.aborted) return next()
          const messages = entry.agent.session.deriveMessages()
          const mismatch = request.messages.findIndex((message, index) => message !== messages[index])
          const prefixLength = mismatch < 0 ? request.messages.length : mismatch
          entry.snapshot = {
            request: Object.isFrozen(request.messages) ? request : { ...request, messages: structuredClone(request.messages) },
            prefixLength,
            toolCount: stateOf(entry).toolCount,
            seq: Math.max(0, Number(entry.agent.session.seq) - 1),
            time: Date.now(),
          }
          entry.snapshotCurrent = true
          // Rollups retain routing metadata, not a second main-context snapshot after tool activity.
          entry.rollupSnapshot = {
            ...entry.snapshot,
            prefixLength: 0,
            request: {
              provider: request.provider,
              model: request.model,
              sessionId: options.sessionId,
              messages: [],
            },
          }
          pump()
        }
      }
      return next()
    },
    // The LLM dispatcher is global. The scoped admission map limits its consumers.
    { global: true, prepend: true },
  )
  ctx.effect(
    () => async () => {
      stopped = true
      for (const entry of work.values()) {
        pause(entry)
        entry.controller?.abort(new Error('Timeline unloaded'))
      }
      work.clear()
      await Promise.all([...pending])
    },
    'timeline: timers and requests',
  )
  for (const agent of ctx.agents.list()) attach(agent)
}
