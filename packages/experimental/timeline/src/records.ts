import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
// Shared durable data and legacy Session record readers.
import { z } from 'zod'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { PluginRecordMap, SessionId } from '@deepseek-ai/dsh-session/types'

const id = z.string().trim().min(1).max(80)
/** Validate an agent-assigned identifier within a tree. */
export const taskId = id.brand<'TimelineTaskId'>()
/** Validate a host-assigned task tree identifier. */
export const treeId = id.brand<'TimelineTreeId'>()
/** Validate a report identifier. */
export const reportId = id.brand<'TimelineReportId'>()
/** Status values accepted in saved task data. */
export const statuses = ['pending', 'active', 'paused', 'blocked', 'done', 'retired'] as const
/** Priority values the user can choose. */
export const priorities = ['P0', 'P1', 'P2', 'P3'] as const
/** Validate a user priority or its absence. */
export const prioritySchema = z.enum(priorities).nullable()
/** Validate the tree or task scope of a work request. */
export const controlTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tree'), tree: treeId }).strict(),
  z.object({ kind: z.literal('task'), tree: treeId, task: taskId }).strict(),
])
/** Validate the tree, task, or report linked to a note. */
export const annotationTargetSchema = z.discriminatedUnion('kind', [
  ...controlTargetSchema.options,
  z.object({ kind: z.literal('report'), report: reportId }).strict(),
])
/** Validate current and historical note identifiers. */
export const annotationId = z.union([z.uuid(), z.string().regex(/^note-[0-9a-f]{16}$/)])
/** Validate the body of a user note or agent reply. */
export const annotationText = z.string().trim().min(1).max(4000)
/** Validate a wall clock timestamp in milliseconds. */
export const timestampSchema = z.number().nonnegative().max(8640000000000000)
/** Validate pause and continue actions. */
export const controlActionSchema = z.enum(['pause', 'resume'])
/** Validate the admission state of a work request. */
export const controlDeliverySchema = z.enum(['sending', 'accepted', 'unknown'])
const controlSchema = z
  .object({
    action: controlActionSchema,
    delivery: controlDeliverySchema,
    outcome: z
      .object({
        status: z.enum(['applied', 'completed', 'unavailable', 'answered', 'superseded']),
        at: z.number().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
/** Validate a saved discussion and its optional work request. */
export const annotationSchema = z
  .object({
    id: annotationId,
    target: annotationTargetSchema,
    text: annotationText,
    createdAt: timestampSchema,
    reply: z.object({ text: annotationText, createdAt: timestampSchema }).strict().nullable(),
    control: controlSchema.optional(),
  })
  .strict()
  .refine(annotation => annotation.control === undefined || annotation.target.kind !== 'report', {
    message: 'Control requests address a task or tree',
  })

const taskStateSchema = z
  .object({
    id: taskId,
    parent: taskId.nullable(),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(320),
    status: z.enum(statuses),
    done: z.tuple([z.number().nonnegative(), z.number().positive()]),
    timeShare: z.number().positive(),
    remaining: z.number().nonnegative().nullable(),
    mode: z.enum(['serial', 'parallel']),
    note: z.string().max(400),
    details: z.string().max(4000),
    priority: prioritySchema.default(null),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()
/** Validate one entry in a task's edit history. */
export const taskRevisionSchema = taskStateSchema
  .omit({ id: true, createdAt: true, updatedAt: true, timeShare: true, remaining: true, mode: true })
  .extend({
    at: timestampSchema,
    progress: z.number().min(0).max(1),
    previousProgress: z.number().min(0).max(1).nullable(),
    weight: z.number().positive(),
  })
/** Validate one task in the saved plan. */
export const taskSchema = taskStateSchema.extend({ history: taskRevisionSchema.array().default([]) })
/** Validate partial updates to one task. */
export const patchSchema = taskSchema
  .omit({ createdAt: true, updatedAt: true, priority: true, history: true })
  .partial()
  .extend({
    id: taskId,
    subtree: z.boolean().optional(),
  })
  .strict()
/** Validate a tree and its task records. */
export const treeSchema = z
  .object({
    id: treeId,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(320),
    tasks: z.array(taskSchema),
    createdAt: z.number(),
    lastTaskUpdate: timestampSchema.optional(),
  })
  .strict()

/** Bounded, replayable UI data; ordinary native tool text excludes it. */
export const taskReceiptSchema = z
  .object({
    version: z.literal(1),
    tree: treeId,
    title: z.string().min(1).max(120),
    branch: z.string().max(120).nullable(),
    at: timestampSchema,
    previousAt: timestampSchema.nullable(),
    before: z.number().min(0).max(1),
    after: z.number().min(0).max(1),
    total: z.number().int().positive().max(1000),
    tasks: z
      .array(
        z
          .object({
            id: taskId,
            title: z.string().min(1).max(120),
            note: z.string().max(400),
            status: z.enum(statuses),
            before: z.number().min(0).max(1),
            after: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .refine(receipt => receipt.total >= receipt.tasks.length)
/** Changes shown in a conversation card after a task update. */
export type TaskReceipt = z.infer<typeof taskReceiptSchema>

/** Compact progress-check-style content; empty optional groups are normal. */
export const summarySchema = z
  .object({
    progress: z.array(z.string().trim().min(1).max(600)).min(1).max(4),
    uncertainties: z.array(z.string().trim().min(1).max(600)).max(5),
    userActions: z.array(z.string().trim().min(1).max(600)).max(5),
  })
  .strict()
const timeRangeSchema = z.tuple([z.number(), z.number()]).refine(([start, end]) => end > start)
/** Host-only turn timing retained for report generation. */
export const activitySchema = z.object({
  start: z.number(),
  olderWorkMs: z.number().nonnegative(),
  ranges: z.array(timeRangeSchema),
  open: z.number().nullable(),
})
/** Validate a saved interval or rollup report. */
export const reportSchema = z
  .object({
    id: reportId,
    level: z.number().int().min(0).max(4),
    start: timestampSchema,
    end: timestampSchema,
    // Coverage can precede generation; older reports use end for their elapsed threshold.
    createdAt: timestampSchema.optional(),
    policy: z.string(),
    children: z.array(reportId),
    source: z.enum(['model', 'no-activity']),
    toolCount: z.number().int().nonnegative(),
    covered: z.number().int().nonnegative(),
    contextSeq: z.number().int().nonnegative(),
    workMs: z.number().nonnegative().optional(),
    ranges: z.array(timeRangeSchema).optional(),
    summary: summarySchema,
  })
  .strict()
  .refine(
    report => report.ranges?.every(([start, end]) => start >= report.start && end <= report.end) ?? true,
    {
      message: 'Work ranges must stay inside report coverage',
    },
  )
/** Validate Timeline state sent to the client. */
export const viewSchema = z.object({
  trees: z.array(treeSchema),
  annotations: z.array(annotationSchema).default([]),
  activeTreeId: treeId.nullable(),
  reports: z.array(reportSchema),
  error: z.string().nullable(),
})

/** One task or group in a plan. */
export type Task = z.infer<typeof taskSchema>
/** A saved task edit shown in the task history. */
export type TaskRevision = z.infer<typeof taskRevisionSchema>
/** A user note with an optional reply or request state. */
export type Annotation = z.infer<typeof annotationSchema>
/** The task tree, task, or report referenced by a note. */
export type AnnotationTarget = z.infer<typeof annotationTargetSchema>
/** The tree or task a work request addresses. */
export type ControlTarget = Exclude<AnnotationTarget, { kind: 'report' }>
/** An assigned priority or no priority. */
export type Priority = z.infer<typeof prioritySchema>
/** A start and end time in milliseconds. */
export type TimeRange = z.infer<typeof timeRangeSchema>
/** Observed intervals during which the session ran. */
export type Activity = z.infer<typeof activitySchema>
/** A partial change to a task record. */
export type TaskPatch = z.infer<typeof patchSchema>
/** The tasks and identifying details for one goal. */
export type Tree = z.infer<typeof treeSchema>
/** A saved progress summary for a time interval. */
export type IntervalReport = z.infer<typeof reportSchema>
/** Report text grouped by progress, questions, and user actions. */
export type Summary = z.infer<typeof summarySchema>
/** Task trees, reports, and discussions shown for a session. */
export type TimelineView = z.infer<typeof viewSchema>
/** Captured model request with its live cancellation signal removed. */
export type StoredRequest = Omit<GenerateOptions, 'signal'>

interface TreeRecord {
  version: 1
  sessionId: SessionId
  callId: string
  tree: Tree
  receipt?: TaskReceipt | null
}
interface SelectionRecord {
  version: 1
  sessionId: SessionId
  callId: string
  treeId: Tree['id']
}
interface ReportRecord {
  version: 1
  sessionId: SessionId
  report: IntervalReport
}

/** Import continuation admitted through the normal user inbox. */
export const importContinuationSchema = z.object({ id: z.uuid(), text: z.string().min(1) })

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Restore a user-selected task tree and its discussions. */
    'plugin:timeline/import': TreeRecord & {
      annotations: Annotation[]
      prepared?: true
      continuation?: z.infer<typeof importContinuationSchema>
    }
    /** Publish an import after its full payload has reached durable storage. */
    'plugin:timeline/import-ready': { version: 1; sessionId: SessionId; callId: string }
    /** Remove a tree and its discussions from the current plan. */
    'plugin:timeline/remove': { version: 1; sessionId: SessionId; treeId: Tree['id'] }
    /** Save a task tree and the tool call that changed it. */
    'plugin:timeline/tree': TreeRecord
    /** Select a saved task tree for subsequent work. */
    'plugin:timeline/select': SelectionRecord
    /** Save a validated interval report and its coverage. */
    'plugin:timeline/report': ReportRecord
    /** Record a discussion or control request from the user. */
    'plugin:timeline/annotation': {
      version: 1
      sessionId: SessionId
      annotation: Annotation
    }
    /** Save the agent’s reply to one discussion. */
    'plugin:timeline/reply': {
      version: 1
      sessionId: SessionId
      id: Annotation['id']
      text: string
      createdAt: number
    }
    /** Record whether the agent accepted a control request. */
    'plugin:timeline/delivery': {
      version: 1
      sessionId: SessionId
      id: Annotation['id']
      delivery: 'accepted' | 'unknown'
    }
    /** Save a priority change made by the user. */
    'plugin:timeline/priority': {
      version: 1
      sessionId: SessionId
      treeId: Tree['id']
      taskId: Task['id']
      priority: Priority
      createdAt: number
    }
    /** Record the report request with its reference to a reused Session prefix. */
    'plugin:timeline/request': {
      version: 1
      sessionId: SessionId
      id: IntervalReport['id']
      contextSeq: number
      prefixLength: number
      request: StoredRequest
    }
    /** Record a failed interval report attempt. */
    'plugin:timeline/failure': { version: 1; sessionId: SessionId; id: IntervalReport['id']; message: string }
  }
}

/** Timeline changes stored as ignorable Session records. */
export type TimelineRecordMap = Pick<PluginRecordMap, Extract<keyof PluginRecordMap, `plugin:timeline/${string}`>>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    timeline: TimelineView
  }
}

/** Validate a saved task tree update. */
export const treeRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  callId: z.string(),
  tree: treeSchema,
  receipt: taskReceiptSchema.nullable().optional(),
})
/** Validate an imported tree and its discussions. */
export const importRecordSchema = treeRecordSchema.extend({
  annotations: annotationSchema.array(),
  prepared: z.literal(true).optional(),
  continuation: importContinuationSchema.optional(),
})
/** Validate the reference to a durably saved import. */
export const importReadySchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  callId: z.string(),
})
/** Validate a removed tree reference. */
export const removalRecordSchema = z.object({ version: z.literal(1), sessionId: z.string(), treeId })
/** Validate a selected tree reference. */
export const selectionRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  callId: z.string(),
  treeId,
})
/** Validate a new saved user note. */
export const annotationRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  annotation: annotationSchema,
})
/** Validate a saved agent reply. */
export const replyRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  id: annotationId,
  text: annotationText,
  createdAt: z.number().nonnegative(),
})
/** Validate a work request's admission result. */
export const deliveryRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  id: annotationId,
  delivery: controlDeliverySchema.exclude(['sending']),
})
/** Validate a user priority change. */
export const priorityRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  treeId,
  taskId,
  priority: prioritySchema,
  createdAt: z.number().nonnegative(),
})
/** Validate a saved interval report record. */
export const reportRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  report: reportSchema,
})
/** Validate a report failure record. */
export const failureRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  id: reportId,
  message: z.string(),
})
/** Validate the saved report request and its reference to the Session message prefix. */
export const requestRecordSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  id: reportId,
  contextSeq: z.number().int().nonnegative(),
  prefixLength: z.number().int().nonnegative(),
  request: z.json(),
})

/**
 * Match Harness Job-style IDs; a supplied digest keeps new-tree retries repeatable.
 * @param kind - the kind of record being identified.
 * @param hex - random or stable hexadecimal input for the identifier.
 * @returns the identifier for the requested kind of record.
 */
export function newId(
  kind: 'tree' | 'report' | 'note',
  hex = randomUUID().replaceAll('-', ''),
): string {
  return `${kind}-${hex.slice(0, 16)}`
}
