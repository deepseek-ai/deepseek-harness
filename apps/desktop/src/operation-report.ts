/** Best-effort operation history appended only after the independent basic report exists. */
import { writeFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { readOperationHistory, type OperationHistoryReadLimits } from './operation-history.ts'
import type { OperationJournalStatus } from './operation-journal.ts'

/** Read budgets and the complete appended section's UTF-8 byte budget. */
export interface OperationReportLimits extends OperationHistoryReadLimits {
  readonly outputBytes: number
}

/**
 * Append a bounded summary without rewriting the basic report's bytes.
 * A missing completion marker means the auxiliary section is unavailable or incomplete.
 * @param reportPath - Successfully saved basic report.
 * @param directory - Owned operation history directory.
 * @param limits - Read and parse budgets.
 * @param signal - Collection deadline or shutdown cancellation; already-issued OS I/O must settle.
 * @param journal - Current writer status, or null when this shell has not received operation records.
 * @returns Whether the complete auxiliary section was appended.
 */
export async function appendOperationReport(
  reportPath: string,
  directory: string,
  limits: OperationReportLimits,
  signal: AbortSignal,
  journal: OperationJournalStatus | null,
): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(limits.outputBytes) || limits.outputBytes < 1) return false
    const cancelled = (): boolean => signal.aborted
    const history = await readOperationHistory(directory, limits, signal)
    if (cancelled()) return false

    const { records, ...facts } = history
    const renderHeader = (omitted: number): string => '\n--- recent plugin operations (context, not proof of cause) ---\n'
      + JSON.stringify({ journal, ...facts, outputRecordsOmitted: omitted }).slice(0, -1) + ',"records":['
    const completionFooter = ']}\n--- operation history collection complete; consult omission counters above ---\n'
    let outputBytes = Buffer.byteLength(renderHeader(records.length) + completionFooter)
    if (outputBytes > limits.outputBytes) return false

    const encodedRecords: string[] = []
    for (const record of records) {
      await setImmediate()
      if (cancelled()) return false
      const encodedRecord = JSON.stringify(record)
      const additionalBytes = Buffer.byteLength(encodedRecord) + (encodedRecords.length === 0 ? 0 : 1)
      if (outputBytes + additionalBytes > limits.outputBytes) break
      encodedRecords.push(encodedRecord)
      outputBytes += additionalBytes
    }

    const reportSection = renderHeader(records.length - encodedRecords.length) + encodedRecords.join(',') + completionFooter
    await setImmediate()
    if (cancelled()) return false
    await writeFile(reportPath, reportSection, { flag: 'a', signal })
    return true
  } catch (_error) {
    // The independently written basic report remains usable, including after a partial append.
    return false
  }
}
