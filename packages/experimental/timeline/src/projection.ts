import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  activitySchema,
  annotationRecordSchema,
  deliveryRecordSchema,
  priorityRecordSchema,
  replyRecordSchema,
  failureRecordSchema,
  reportRecordSchema,
  selectionRecordSchema,
  treeRecordSchema,
  importRecordSchema,
  importContinuationSchema,
  importReadySchema,
  removalRecordSchema,
  treeId,
  taskReceiptSchema,
  viewSchema,
} from './records.ts'
import { HISTORY_MS, MAX_ANNOTATIONS, MINUTE_MS } from './policy.ts'
import { recordTaskHistory } from './tasks.ts'
import { mergeRanges } from './periods.ts'
import type { Activity, TimeRange } from './records.ts'
import { reconcileControl, controlTargetsOverlap } from './controls.ts'

/** Validate the private recovery state and its user view. */
export const stateSchema = z.object({
  sessionId: z.string(),
  inherited: z.number().int().nonnegative(),
  hasTurn: z.boolean().default(false),
  toolCount: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
  lastReportEnd: z.number(),
  activity: activitySchema,
  preparedImport: importRecordSchema.nullable(),
  calls: z
    .array(z.object({
      id: z.string(),
      tree: treeId,
      receipt: taskReceiptSchema.nullable().optional(),
      continuation: importContinuationSchema.optional(),
      notified: z.literal(true).optional(),
    }))
    .max(64)
    .default([]),
  view: viewSchema,
})
/** Session recovery facts and current Timeline view. */
export type TimelineState = z.infer<typeof stateSchema>

/** Internal reader shared by tools and the scheduler. */
export interface TimelineReader {
  stateOf(session: Session): TimelineState
}

/**
 * Register the session projection before exposing a synchronous reader.
 * @param ctx - owning plugin context.
 * @returns a reader after registration is ready.
 */
export async function registerProjection(ctx: Context): Promise<TimelineReader> {
  return ctx.sessionProjections.register(createProjection())
}

function retainActivity(activity: Activity, time: number, coveredUntil: number, baseSaved = false): Activity {
  const start = Math.max(activity.start, time - HISTORY_MS)
  let olderWorkMs = baseSaved ? 0 : activity.olderWorkMs
  const ranges: TimeRange[] = []
  for (const [from, to] of activity.ranges) {
    olderWorkMs += Math.max(0, Math.min(to, start) - Math.max(from, coveredUntil))
    if (to > start) ranges.push([Math.max(from, start), to])
  }
  return { ...activity, start, olderWorkMs, ranges }
}

type TimelineProjection = ProjectionDefinition<'timeline', TimelineState>

/**
 * Replay Timeline records and inherit the plan at the fork point.
 * @returns the Timeline and session activity projection definition.
 */
export function createProjection(): TimelineProjection & {
  wire: NonNullable<TimelineProjection['wire']>
} {
  return {
    key: 'timeline',
    stateVersion: 9,
    stateSchema,
    wire: { viewSchema, view: state => state.view, summary: false },
    init: (header, inherited) => ({
      sessionId: header.id,
      inherited,
      hasTurn: inherited > 0 || header.isSeeded,
      toolCount: 0,
      covered: 0,
      lastReportEnd: header.createdAt,
      activity: { start: header.createdAt, olderWorkMs: 0, ranges: [], open: null },
      preparedImport: null,
      calls: [],
      view: {
        trees: [],
        annotations: [],
        activeTreeId: null,
        reports: [],
        error: null,
      },
    }),
    apply: (state, event) => {
      // Each fork cut ends the previous branch's pending requests and retry scope.
      if (event.type === 'session/end-seed' && event.data.inherited === true) {
        const annotations = state.view.annotations.filter(
          note => note.control?.outcome !== null && note.control?.outcome.status !== 'answered',
        )
        return { ...state, calls: [], preparedImport: null, view: { ...state.view, annotations } }
      }
      if (event.seq < state.inherited) {
        const record = pluginRecordOf(event)
        if (record?.type.startsWith('plugin:timeline/') !== true) return state
        if (record.type === 'plugin:timeline/report' || record.type === 'plugin:timeline/failure') return state
        if (typeof record.data !== 'object' || record.data === null) return state
        return foldRecord(state, { type: record.type, data: { ...record.data, sessionId: state.sessionId } })
      }
      const { activity } = state
      if (event.type === 'turn/start')
        return {
          ...state,
          hasTurn: true,
          activity: { ...activity, open: event.time },
        }
      if (event.type === 'turn/end' && activity.open !== null)
        return {
          ...state,
          activity: retainActivity({
            ...activity,
            open: null,
            ranges: mergeRanges([...activity.ranges, [activity.open, event.time]]),
          }, event.time, state.lastReportEnd),
        }
      if (event.type === 'tool/call') return { ...state, toolCount: state.toolCount + 1 }
      if (event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0) {
        const ids = new Set<string>(event.data.inserted.map(message => message.id))
        if (state.calls.some(call => call.continuation !== undefined && !call.notified && ids.has(call.continuation.id)))
          return {
            ...state,
            calls: state.calls.map(call => call.continuation !== undefined && ids.has(call.continuation.id)
              ? { ...call, notified: true } : call),
          }
      }
      const record = pluginRecordOf(event)
      if (record === undefined) return state
      return foldRecord(state, record)
    },
  }
}

/**
 * Apply one validated change to the current Timeline state.
 * @param state - the current Timeline recovery state.
 * @param record - the change to validate and apply.
 * @returns the updated state, or the original state for an invalid change.
 */
export function foldRecord(state: TimelineState, record: { type: string; data: unknown }): TimelineState {
  if (record.type === 'plugin:timeline/import' || record.type === 'plugin:timeline/import-ready') {
    let data: z.infer<typeof importRecordSchema> | undefined
    if (record.type === 'plugin:timeline/import-ready') {
      const marker = importReadySchema.safeParse(record.data).data
      if (marker?.sessionId !== state.sessionId || state.preparedImport?.callId !== marker.callId) return state
      data = state.preparedImport
    } else {
      data = importRecordSchema.safeParse(record.data).data
    }
    if (data?.sessionId !== state.sessionId || state.view.annotations.length + data.annotations.length > MAX_ANNOTATIONS) return state
    const ids = new Set(state.view.annotations.map(note => note.id))
    for (const note of data.annotations) {
      const target = note.target
      if (
        ids.has(note.id) ||
        note.control !== undefined ||
        target.kind === 'report' ||
        target.tree !== data.tree.id ||
        (target.kind === 'task' && !data.tree.tasks.some(task => task.id === target.task))
      )
        return state
      ids.add(note.id)
    }
    if (record.type === 'plugin:timeline/import' && data.prepared) return { ...state, preparedImport: data }
    const next = applyTree(state, data, data)
    return {
      ...next,
      preparedImport: record.type === 'plugin:timeline/import-ready' ? null : next.preparedImport,
      view: { ...next.view, annotations: [...next.view.annotations, ...data.annotations] },
    }
  }
  if (record.type === 'plugin:timeline/remove') {
    const { data } = removalRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId) return state
    const index = state.view.trees.findIndex(tree => tree.id === data.treeId)
    if (index < 0) return state
    const trees = state.view.trees.filter(tree => tree.id !== data.treeId)
    return {
      ...state,
      view: {
        ...state.view,
        trees,
        activeTreeId:
          state.view.activeTreeId === data.treeId
            ? (trees[index]?.id ?? trees.at(-1)?.id ?? null)
            : state.view.activeTreeId,
        annotations: state.view.annotations.filter(
          note => note.target.kind === 'report' || note.target.tree !== data.treeId,
        ),
      },
    }
  }
  if (record.type === 'plugin:timeline/annotation') {
    const { data } = annotationRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId || data.annotation.reply !== null) return state
    if (
      data.annotation.control !== undefined &&
      (data.annotation.control.delivery !== 'sending' || data.annotation.control.outcome !== null)
    )
      return state
    const target = data.annotation.target
    const exists =
      target.kind === 'report'
        ? state.view.reports.some(report => report.id === target.report)
        : state.view.trees.some(
          tree =>
            tree.id === target.tree &&
              (target.kind === 'tree' ||
                tree.tasks.some(task => task.id === target.task && task.status !== 'retired')),
        )
    if (
      !exists ||
      state.view.annotations.length >= MAX_ANNOTATIONS ||
      state.view.annotations.some(annotation => annotation.id === data.annotation.id)
    ) return state
    const annotation = reconcileControl(data.annotation, state.view.trees, data.annotation.createdAt)
    const annotations = state.view.annotations.map((item) => {
      if (
        annotation.control === undefined ||
        item.control === undefined ||
        (item.control.outcome !== null && item.control.outcome.status !== 'answered') ||
        !controlTargetsOverlap(item.target, annotation.target, state.view.trees)
      )
        return item
      return {
        ...item,
        control: { ...item.control, outcome: { status: 'superseded' as const, at: annotation.createdAt } },
      }
    })
    return { ...state, view: { ...state.view, annotations: [...annotations, annotation] } }
  }
  if (record.type === 'plugin:timeline/delivery') {
    const { data } = deliveryRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId) return state
    const annotation = state.view.annotations.find(item => item.id === data.id)
    if (annotation?.control?.delivery !== 'sending') return state
    return {
      ...state,
      view: {
        ...state.view,
        annotations: state.view.annotations.map(item =>
          item.id !== data.id || item.control === undefined
            ? item
            : { ...item, control: { ...item.control, delivery: data.delivery } },
        ),
      },
    }
  }
  if (record.type === 'plugin:timeline/reply') {
    const { data } = replyRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId) return state
    const annotation = state.view.annotations.find(annotation => annotation.id === data.id)
    if (annotation === undefined || annotation.reply !== null) return state
    return {
      ...state,
      view: {
        ...state.view,
        annotations: state.view.annotations.map(item =>
          item.id !== data.id
            ? item
            : reconcileControl(
              {
                ...item,
                reply: { text: data.text, createdAt: data.createdAt },
                ...(item.control === undefined
                  ? {}
                  : {
                    control: {
                      ...item.control,
                      outcome: item.control.outcome ?? { status: 'answered', at: data.createdAt },
                    },
                  }),
              },
              state.view.trees,
              data.createdAt,
            ),
        ),
      },
    }
  }
  if (record.type === 'plugin:timeline/priority') {
    const { data } = priorityRecordSchema.safeParse(record.data)
    const tree = state.view.trees.find(tree => tree.id === data?.treeId)
    const task = tree?.tasks.find(task => task.id === data?.taskId)
    if (
      data?.sessionId !== state.sessionId ||
      tree === undefined ||
      task === undefined ||
      task.status === 'retired'
    )
      return state
    return {
      ...state,
      view: {
        ...state.view,
        trees: state.view.trees.map(item =>
          item.id !== tree.id
            ? item
            : {
              ...item,
              tasks: recordTaskHistory(item.tasks, item.tasks.map(item =>
                item.id === task.id ? { ...item, priority: data.priority, updatedAt: data.createdAt } : item,
              ), data.createdAt),
            },
        ),
      },
    }
  }
  if (record.type === 'plugin:timeline/tree') {
    const { data } = treeRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId) return state
    return applyTree(state, data)
  }
  if (record.type === 'plugin:timeline/select') {
    const { data } = selectionRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId || !state.view.trees.some(tree => tree.id === data.treeId))
      return state
    return {
      ...state,
      calls: [
        ...state.calls.filter(call => call.id !== data.callId),
        { id: data.callId, tree: data.treeId },
      ].slice(-64),
      view: { ...state.view, activeTreeId: data.treeId },
    }
  }
  if (record.type === 'plugin:timeline/report') {
    const { data } = reportRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId || data.report.end < data.report.start) return state
    const report = data.report
    const newestEnd = Math.max(state.lastReportEnd, report.end)
    const cutoff = newestEnd - HISTORY_MS
    const lastReportEnd = report.level === 0 ? newestEnd : state.lastReportEnd
    const limit = 5 * Math.ceil(HISTORY_MS / MINUTE_MS)
    const previous = state.view.reports
    const reports = previous.filter(item => item.id !== report.id && item.end >= cutoff)
    reports.push(report)
    if (reports.length > limit) reports.splice(0, reports.length - limit)
    const { annotations } = state.view
    const ids = reports.length <= previous.length && annotations.some(note => note.target.kind === 'report')
      ? new Set(reports.map(item => item.id))
      : undefined
    return {
      ...state,
      covered:
        report.level === 0
          ? Math.max(state.covered, Math.min(state.toolCount, report.covered))
          : state.covered,
      lastReportEnd,
      activity: retainActivity(state.activity, newestEnd, lastReportEnd, report.level === 0 && report.end >= state.activity.start),
      view: {
        ...state.view,
        error: null,
        reports,
        annotations: ids === undefined
          ? annotations
          : annotations.filter(note => note.target.kind !== 'report' || ids.has(note.target.report)),
      },
    }
  }
  if (record.type === 'plugin:timeline/failure') {
    const { data } = failureRecordSchema.safeParse(record.data)
    if (data?.sessionId !== state.sessionId) return state
    return { ...state, view: { ...state.view, error: data.message } }
  }
  return state
}

function applyTree(
  state: TimelineState,
  data: z.infer<typeof treeRecordSchema>,
  imported?: z.infer<typeof importRecordSchema>,
): TimelineState {
  const before = state.view.trees.find(tree => tree.id === data.tree.id)
  const at = Math.max(data.tree.createdAt, ...data.tree.tasks.map(task => task.updatedAt))
  const tree = imported === undefined
    ? { ...data.tree, tasks: recordTaskHistory(before?.tasks ?? [], data.tree.tasks, at) }
    : before ?? data.tree
  const trees = before === undefined
    ? [...state.view.trees, tree]
    : state.view.trees.map(item => item.id === tree.id ? tree : item)
  return {
    ...state,
    calls: [
      ...state.calls.filter(call => call.id !== data.callId),
      {
        id: data.callId,
        tree: data.tree.id,
        ...(data.receipt === undefined ? {} : { receipt: data.receipt }),
        ...(imported?.continuation === undefined ? {} : { continuation: imported.continuation }),
      },
    ].slice(-64),
    view: {
      ...state.view,
      activeTreeId: data.tree.id,
      trees,
      annotations: state.view.annotations.map(item =>
        item.target.kind !== 'report' && item.target.tree === data.tree.id
          ? reconcileControl(item, trees, at)
          : item,
      ),
    },
  }
}
