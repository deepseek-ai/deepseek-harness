/** Private worker entry for SQLite compaction and WAL truncation. @module */
import { parentPort, workerData } from 'node:worker_threads'
import { runCompaction } from './vacuum.ts'

if (parentPort === null) throw new Error('SQLite compaction requires a parent port')
try {
  parentPort.postMessage(runCompaction(workerData))
} finally {
  parentPort.close()
}
