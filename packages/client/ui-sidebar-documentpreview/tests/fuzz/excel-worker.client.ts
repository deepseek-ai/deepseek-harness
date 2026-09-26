/** Test-only Client parser isolation; the parent owns deadlines and termination. */
import { parentPort, workerData } from 'node:worker_threads'
import { convertExcel } from '../../src/client/excel/convert.ts'
import type { ExcelLimits, ExcelPreview } from '../../src/client/excel/model.ts'

if (parentPort === null) throw new Error('The Excel fuzz worker requires a parent port')
const port = parentPort
const options = workerData as { source?: string }
const baseline = options.source === undefined ? undefined : await import(options.source) as {
  convertXlsx: (bytes: Uint8Array<ArrayBuffer>, limits: ExcelLimits) => Promise<ExcelPreview>
}
port.on('message', (bytes: Uint8Array<ArrayBuffer>) => { void parseWorkbook(bytes) })

async function parseWorkbook(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const before = bytes.slice()
  try {
    const limits = { maxBytes: 20_000_000, maxCells: 1_000_000, timeoutMs: 10_000 }
    const preview = baseline === undefined ? await convertExcel(bytes, 'xlsx', limits) : await baseline.convertXlsx(bytes, limits)
    port.postMessage({ ok: true, preview, inputUnchanged: before.every((value, index) => value === bytes[index]) })
  } catch (error) {
    const causes: string[] = []
    let current: unknown = error
    while (current instanceof Error && causes.length < 8) {
      causes.push(`${current.name}: ${current.message}`)
      current = current.cause
    }
    port.postMessage({ ok: false, causes, inputUnchanged: before.every((value, index) => value === bytes[index]) })
  }
}
