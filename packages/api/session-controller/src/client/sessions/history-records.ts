/** Client range access and type narrowing for aligned Session history records. */

import type {
  SessionHistoryRecord,
} from '../../types.ts'
import type { SessionEventLikeEntry, SessionLiveEventEntry } from '../contract/events.ts'

/**
 * Narrow aligned wire records to their Client event types without allocation.
 * @param records - validated history transport records.
 * @returns the same record array with typed inner events.
 */
export function historyEntries(
  records: readonly SessionHistoryRecord[],
): readonly SessionEventLikeEntry[] {
  // Both views share the same validated objects.
  const aligned: readonly unknown[] = records
  return aligned as readonly SessionEventLikeEntry[]
}

/**
 * View durable window entries, which the Client received as validated wire records, as those records again.
 * @param entries - durable entries taken from the event window.
 * @returns the same array typed as history transport records.
 */
export function historyRecords(
  entries: readonly SessionLiveEventEntry[],
): readonly SessionHistoryRecord[] {
  const aligned: readonly unknown[] = entries
  return aligned as readonly SessionHistoryRecord[]
}

/**
 * Read the first logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive first Session sequence.
 */
export function historyRecordFirstSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}

/**
 * Read the final logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive final Session sequence.
 */
export function historyRecordLastSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}
