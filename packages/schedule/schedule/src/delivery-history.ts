/** Saved delivery interpretation and identity-based pagination without Session reads. */
import type { ScheduleTask } from './storage.ts'
import type { DeliveryRetentionBounds, ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult, ScheduleDeliveryReceipt } from './types.ts'

/** Milliseconds in one day, the unit the retention window is stated in. */
const DAY_MS = 86_400_000

/**
 * Read retained history; missing history exposes only the actual legacy receipt.
 * @param task - Immutable stored task.
 * @returns Oldest-first retained deliveries without changing storage.
 */
function deliveryHistoryOf(task: ScheduleTask): NonNullable<ScheduleTask['deliveryHistory']> {
  return task.deliveryHistory ?? {
    records: task.lastDelivery === undefined ? [] : [task.lastDelivery],
    earlierRecordsUnavailable: true,
  }
}

/**
 * Prepare one real inbox acknowledgment for the same task write as its status and target.
 * Prunes to the configured window and record cap here, on the only write path: the
 * domain publishes one whole-unit document per write, so an unbounded array would
 * grow that document with every acknowledgment. The read path states no bound of
 * its own, because a whole-unit document over the schema's limits refuses to open.
 * @param task - Task supplying the immutable sent prompt and retained history.
 * @param receipt - Acknowledgment obtained after successful Session flush.
 * @param bounds - Configured retention window and record cap for the appended history.
 * @returns Receipt and retained history; the caller publishes them only after task persistence.
 */
export function appendDelivery(
  task: ScheduleTask,
  receipt: ScheduleDeliveryReceipt,
  bounds: DeliveryRetentionBounds,
): Required<Pick<ScheduleTask, 'lastDelivery' | 'deliveryHistory'>> {
  const history = deliveryHistoryOf(task)
  const appended = [...history.records, { ...receipt, prompt: task.record.prompt }]
  const floor = Date.parse(receipt.deliveredAt) - bounds.days * DAY_MS
  const retained = appended
    .filter(record => Date.parse(record.deliveredAt) >= floor)
    .slice(-bounds.records)
  return {
    lastDelivery: receipt,
    deliveryHistory: {
      records: retained,
      earlierRecordsUnavailable: history.earlierRecordsUnavailable || retained.length !== appended.length,
      earlierRecordsPruned: history.earlierRecordsPruned === true || retained.length !== appended.length,
    },
  }
}

/**
 * Read one newest-first page in append order, independent of wall-clock ordering.
 * @param task - Task already checked against the requested Session binding.
 * @param request - Validated explicit page size and optional exclusive message cursor.
 * @param retention - Current configured limits shared with the delivery writer.
 * @returns Copied delivery records or a cursor-not-found result.
 */
export function deliveryHistoryPage(
  task: ScheduleTask, request: ScheduleDeliveryHistoryRequest, retention: DeliveryRetentionBounds,
): ScheduleDeliveryHistoryResult {
  const history = deliveryHistoryOf(task)
  const end = request.before === undefined
    ? history.records.length
    : history.records.findIndex(record => record.messageId === request.before)
  if (end === -1) return { id: request.id, code: 'delivery_cursor_not_found' }
  const start = Math.max(0, end - request.limit)
  const records = history.records.slice(start, end).reverse().map(({ prompt, ...receipt }) => ({
    ...receipt, ...(prompt === undefined ? {} : { prompt }),
  }))
  const oldest = records.at(-1)
  return {
    id: request.id, records, earlierRecordsUnavailable: history.earlierRecordsUnavailable,
    earlierRecordsPruned: history.earlierRecordsPruned === true, retention: { ...retention },
    ...(oldest !== undefined && start > 0 ? { nextBefore: oldest.messageId } : {}),
  }
}
