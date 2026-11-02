/** Durable Host-wide Schedule tasks, independently of Session activation. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { decodeScheduleRecord } from './domain.ts'
import type { ScheduleDeliveryRecord, ScheduleId, ScheduleRecord, ScheduleTarget } from './types.ts'

const recordSchema = z.unknown().transform((value, context): ScheduleRecord => {
  try {
    return decodeScheduleRecord(value)
  } catch (error: unknown) {
    context.addIssue({ code: 'custom', message: String(error) })
  }
  return z.NEVER
})

/** Canonical millisecond UTC instant with a four-digit year. */
const instantSchema = z.iso.datetime({ precision: 3 }).refine(value => !value.startsWith('0000-'), {
  message: 'Expected a canonical four-digit-year UTC calendar instant',
})

/** Identity of one delivered inbox message: non-empty, without surrounding whitespace. */
const messageIdSchema = z.string().min(1).refine(value => value.trim() === value).transform(MessageId)

/** Non-empty saved Session identity. */
const sessionIdSchema = z.string().min(1).transform(SessionId)

const deliveryReceiptSchema = z.object({
  scheduledAt: instantSchema,
  deliveredAt: instantSchema,
  messageId: messageIdSchema,
  targetSessionId: sessionIdSchema.optional(),
}).strict()

const deliveryHistorySchema = z.object({
  records: z.array(deliveryReceiptSchema.extend({ prompt: z.string().exactOptional() }).strict()),
  earlierRecordsUnavailable: z.boolean(),
  earlierRecordsPruned: z.boolean().default(false),
}).strict().refine(history => new Set(history.records.map(record => record.messageId)).size === history.records.length, {
  message: 'Delivery history message identities must be unique within a task',
})

const createSpecSchema = z.object({
  cwd: z.string().min(1).exactOptional(),
  agentPreset: z.string().min(1).exactOptional(),
}).strict()

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: sessionIdSchema }).strict(),
  z.object({ kind: z.literal('new_once'), sessionId: sessionIdSchema.optional(), create: createSpecSchema.default({}) }).strict(),
  z.object({ kind: z.literal('new'), create: createSpecSchema.default({}) }).strict(),
])

/** Stable reservation for a task without a saved destination; reads never allocate or persist a Session. */
function defaultSessionId(id: ScheduleId): SessionId {
  return SessionId(`session-schedule-${createHash('sha256').update(id).digest('hex')}`)
}

/**
 * Version-2 task schema accepting version-1 rows. New metadata is optional on disk. An explicit target
 * ignores the former Session binding; a missing target uses that binding or a stable create-once destination.
 * Normal decoding does not write. The next edit or delivery writes this current shape without `sessionId`.
 */
export const scheduleTaskSchema = z.object({
  record: recordSchema,
  sessionId: z.unknown().optional(),
  target: targetSchema.optional(),
  involvedSessionIds: z.array(sessionIdSchema).optional(),
  status: z.enum(['active', 'paused', 'ended', 'inactive']).default('active'),
  createdAt: instantSchema.optional(),
  updatedAt: instantSchema.optional(),
  lastDelivery: deliveryReceiptSchema.optional(),
  deliveryHistory: deliveryHistorySchema.optional(),
  pendingDelivery: z.object({ targetSessionId: sessionIdSchema }).strict().optional(),
}).strict().transform(({ sessionId, target: savedTarget, lastDelivery, deliveryHistory, ...task }, context) => {
  const binding = savedTarget === undefined && sessionId !== undefined ? sessionIdSchema.safeParse(sessionId) : undefined
  if (binding?.success === false) {
    context.addIssue({ code: 'custom', path: ['sessionId'], message: 'A missing target requires a valid stored Session binding' })
    return z.NEVER
  }
  const target: ScheduleTarget = savedTarget === undefined
    ? binding?.success === true
      ? { kind: 'session', sessionId: binding.data }
      : { kind: 'new_once', sessionId: defaultSessionId(task.record.id), create: {} }
    : savedTarget.kind === 'new_once'
      ? { ...savedTarget, sessionId: savedTarget.sessionId ?? defaultSessionId(task.record.id) }
      : savedTarget
  const hasReceiptTarget = savedTarget === undefined
    ? binding?.success === true
    : savedTarget.kind !== 'new' && savedTarget.sessionId !== undefined
  const receipts = [lastDelivery, ...(deliveryHistory?.records ?? [])]
  if (!hasReceiptTarget && receipts.some(value => value !== undefined && value.targetSessionId === undefined)) {
    context.addIssue({ code: 'custom', message: 'A saved delivery without an existing destination must name its target Session' })
    return z.NEVER
  }
  const receipt = <T extends z.infer<typeof deliveryReceiptSchema>>(value: T): T & { targetSessionId: SessionId } => {
    if (value.targetSessionId !== undefined) return { ...value, targetSessionId: value.targetSessionId }
    /* v8 ignore next -- the receipt-destination validation above rejects this combination before normalization. */
    if (target.kind === 'new') throw new Error('A delivery to a fresh Session must name its target Session')
    return { ...value, targetSessionId: target.sessionId }
  }
  const last = lastDelivery === undefined ? undefined : receipt(lastDelivery)
  const history: {
    records: ScheduleDeliveryRecord[]
    earlierRecordsUnavailable: boolean
    earlierRecordsPruned: boolean
  } = deliveryHistory === undefined
    ? { records: last === undefined ? [] : [last], earlierRecordsUnavailable: true, earlierRecordsPruned: false }
    : { ...deliveryHistory, records: deliveryHistory.records.map(value => receipt(value)) }
  return {
    ...task,
    target,
    status: task.status === 'inactive' ? 'ended' as const : task.status,
    involvedSessionIds: task.involvedSessionIds ?? (target.kind === 'new' ? [] : [target.sessionId]),
    ...(last === undefined ? {} : { lastDelivery: last }),
    deliveryHistory: history,
  }
}).refine((task) => {
  const latest = task.deliveryHistory.records.at(-1)
  if (latest === undefined) return task.lastDelivery === undefined
  const { prompt: _prompt, ...receipt } = latest
  return isDeepStrictEqual(receipt, task.lastDelivery)
}, {
  message: 'Last delivery must match the latest saved delivery receipt',
})

/** Persistent task value; a delivery receipt does not record model execution completion. */
export type ScheduleTask = z.infer<typeof scheduleTaskSchema>

/** Authoritative Host tasks retain their domain, backend routing, and envelope; v2 also reads v1 without startup writes. */
export const scheduleDomain = defineDomain({
  name: 'schedule', version: 2, compatibleVersions: [1],
  tables: { tasks: domainTable<ScheduleId, ScheduleTask>(scheduleTaskSchema) },
})
