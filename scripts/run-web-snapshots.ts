/**
 * Run serial browser owners before one bounded snapshot pool of the other projects
 * (scripts/web-snapshot-projects.ts).
 * `DSH_WEB_SNAPSHOT_SHARD=<index>/<count>` runs one weighted shard of the pool
 * (scripts/web-snapshot-sequencer.ts); the serial files, which rewrite the shared
 * build output, run only in the last shard so no other shard needs to wait for them.
 */
import { spawn } from 'node:child_process'
import { pnpmInvocation } from './pnpm-invocation.ts'
import {
  WEB_SNAPSHOT_POOL_PROJECTS,
  WEB_SNAPSHOT_SERIAL_FILES,
  WEB_SNAPSHOT_SERIAL_PROJECT,
  ownsWebSnapshotSerialFiles,
  parseWebSnapshotShard,
} from './web-snapshot-projects.ts'

const workerRaw = process.env.DSH_WEB_SNAPSHOT_WORKERS
const workers = Number.parseInt(workerRaw ?? '', 10)
if (!Number.isSafeInteger(workers) || workers < 1 || String(workers) !== workerRaw) {
  throw new Error(`DSH_WEB_SNAPSHOT_WORKERS must be a positive integer, got ${JSON.stringify(workerRaw)}.`)
}
const shard = parseWebSnapshotShard(process.env.DSH_WEB_SNAPSHOT_SHARD)
const shardArgs = shard === undefined ? [] : [`--shard=${String(shard.index)}/${String(shard.count)}`]
const ownsSerialFiles = ownsWebSnapshotSerialFiles(shard)
const invocation = pnpmInvocation(['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts'])
let serialStatus = 0
for (const file of ownsSerialFiles ? WEB_SNAPSHOT_SERIAL_FILES : []) {
  serialStatus = await run(invocation.command, [...invocation.args, `--project=${WEB_SNAPSHOT_SERIAL_PROJECT}`, file])
  if (serialStatus !== 0) break
}
if (serialStatus === 0) {
  process.exitCode = await run(invocation.command, [
    ...invocation.args,
    ...WEB_SNAPSHOT_POOL_PROJECTS.map(project => `--project=${project}`),
    '--fileParallelism',
    `--maxWorkers=${String(workers)}`,
    ...shardArgs,
  ])
} else {
  process.exitCode = serialStatus
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (exitCode, signalCode) => {
      if (signalCode !== null) {
        console.error(`web snapshots terminated by ${signalCode}`)
        resolveRun(1)
        return
      }
      resolveRun(exitCode ?? 1)
    })
  })
}
