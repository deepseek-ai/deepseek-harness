/** Capture only fixture-owned environment fields at actual native process startup. */

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const probe = args.includes('--version') || args.includes('--help')
const names = [
  'OAR_FIXTURE_API_TOKEN', 'DSH_OAR_FIXTURE_ID', 'OAR_FIXTURE_KEEP',
  'OAR_FIXTURE_EXPLICIT_TOKEN', 'OAR_FIXTURE_DELETE',
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_HOST_WORKTREE_FENCE', 'TRACEPARENT',
]
appendFileSync(process.env.OAR_CAPTURE_PATH, `${JSON.stringify({
  kind: probe ? 'probe' : 'session',
  runtime: process.env.OAR_FIXTURE_RUNTIME,
  args,
  environment: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])),
})}\n`)
if (probe) {
  process.stdout.write('fixture 1.0.0\n')
} else {
  const lines = createInterface({ input: process.stdin })
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.type !== 'user') return
    emit({ type: 'system', subtype: 'init', session_id: 'environment-fixture', model: 'fixture' })
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'ENVIRONMENT_OK' }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'ENVIRONMENT_OK', usage: { input_tokens: 1, output_tokens: 1 } })
  })
}
