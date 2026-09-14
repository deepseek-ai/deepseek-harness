/** External stdio fixture; it never reads or controls the host desktop. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = process.argv[2]
const mode = process.argv[3]
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const record = (event, data = {}) => appendFileSync(join(root, 'driver.ndjson'), JSON.stringify({ event, pid: process.pid, ...data }) + '\n')
record('start')
process.once('exit', () => record('exit'))
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) {
    if (request.method === 'notifications/cancelled') record('cancelled', request.params)
    return
  }
  let result
  switch (request.method) {
    case 'server/discover':
      record('discover')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
      return
    case 'initialize':
      record('initialize')
      if (mode === 'fail') process.exit(1)
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cua-driver-fixture', version: '1.0.0' } }
      break
    case 'tools/list':
      result = { tools: [
        { name: 'screenshot', description: 'Capture the selected display.', inputSchema: { type: 'object', properties: { display: { type: 'integer', minimum: 0 } }, required: ['display'], additionalProperties: false } },
        { name: 'disconnect', description: 'Disconnect the fixture.', inputSchema: { type: 'object', properties: {} } },
      ] }
      break
    case 'tools/call':
      record('call', { name: request.params.name, arguments: request.params.arguments })
      result = request.params.name === 'screenshot'
        ? { content: [{ type: 'text', text: `Display ${request.params.arguments.display}` }, { type: 'image', mimeType: 'image/png', data: png }], structuredContent: { display: request.params.arguments.display } }
        : { content: [{ type: 'text', text: 'Disconnected.' }] }
      break
    default:
      throw new Error(`Unexpected fixture method ${request.method}`)
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n', () => {
    if (request.method === 'tools/call' && request.params.name === 'disconnect') process.exit(0)
  })
})
