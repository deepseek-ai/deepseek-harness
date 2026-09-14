/** External browser fixture; screenshots contain no host or network content. */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
mkdirSync('.dsh', { recursive: true })
const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  switch (request.method) {
    case 'server/discover':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy browser fixture' } }) + '\n')
      return
    case 'initialize':
      writeFileSync('.dsh/browser-fixture.started', 'playwright-mcp\n', { flag: 'wx' })
      process.once('exit', () => unlinkSync('.dsh/browser-fixture.started'))
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'browser-fixture', version: '1' } }
      break
    case 'tools/list':
      result = catalog
      break
    case 'tools/call':
      if (request.params.name !== 'browser_take_screenshot') throw new Error(`Unexpected Playwright fixture tool: ${request.params.name}`)
      result = { content: [{ type: 'text', text: 'Chromium page' }, { type: 'image', mimeType: 'image/png', data: png }] }
      break
    default:
      throw new Error(`Unexpected Playwright fixture request: ${request.method}`)
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
