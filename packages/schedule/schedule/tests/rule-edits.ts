/** Assertion projection for table-driven rule edits; exercises the current typed edit implementation. */
import { isDeepStrictEqual } from 'node:util'
import { ScheduleInputError } from '../src/domain.ts'
import { updateScheduleRecord } from '../src/update.ts'
import type { ScheduleRecord, ScheduleTiming } from '../src/types.ts'

/** Evaluate timing and expose changed fields or the stable input reason for data-driven assertions. */
export function updateResult(current: ScheduleRecord, timing: ScheduleTiming, now: number) {
  try {
    const record = updateScheduleRecord(current, { timing }, now, false)
    return { id: current.id, updated: !isDeepStrictEqual(current, record), record }
  } catch (error: unknown) {
    if (!(error instanceof ScheduleInputError)) throw error
    return { code: error.code, message: error.message }
  }
}
