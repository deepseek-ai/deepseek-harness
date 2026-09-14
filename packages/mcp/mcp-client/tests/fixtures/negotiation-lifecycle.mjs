/** Legacy stdio server with a file barrier around protocol discovery. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout } from 'node:timers/promises'

const [eventsPath, releasePath] = process.argv.slice(2)
const record = (event, extra = {}) => appendFileSync(eventsPath, `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`)
const previous = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const previousPid = previous.findLast(item => item.event === 'start')?.pid
let previousAlive = false
if (previousPid !== undefined) {
  try {
    process.kill(previousPid, 0)
    previousAlive = true
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
record('start', { previousAlive })
process.once('exit', () => record('exit'))
process.stdin.once('end', () => process.exit(0))

createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  record(request.method)
  if (request.method === 'server/discover') {
    while (!existsSync(releasePath)) await setTimeout(10)
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy server' },
    })}\n`)
    return
  }
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : { tools: [] }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
})
