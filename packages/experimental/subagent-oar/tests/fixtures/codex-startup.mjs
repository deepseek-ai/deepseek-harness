/** Native Codex startup failures with a barrier that retains the process after SIGTERM. */

import { existsSync, watch, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

writeFileSync(process.env.OAR_FIXTURE_PID, String(process.pid))
process.on('SIGTERM', () => {
  const release = process.env.OAR_FIXTURE_RELEASE
  if (release === undefined) process.exit(0)
  const leave = () => {
    if (existsSync(release)) process.exit(0)
  }
  watch(dirname(release), leave)
  writeFileSync(process.env.OAR_FIXTURE_STOPPING, 'stopping')
  leave()
})
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    emit(process.env.OAR_FIXTURE_FAILURE === 'initialize'
      ? { id: request.id, error: { code: -32602, message: 'fixture initialization refused' } }
      : { id: request.id, result: {} })
  } else if (request.method === 'thread/start') {
    emit(process.env.OAR_FIXTURE_FAILURE === 'missing-thread-id'
      ? { id: request.id, result: {} }
      : { id: request.id, error: { code: -32602, message: 'fixture thread refused' } })
  }
})
// A closed stdin must not release the process before the SIGTERM barrier.
setInterval(() => {}, 1000)
