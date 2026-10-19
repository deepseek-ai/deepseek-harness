/** Harmless native-protocol fixture: records argv and returns one assistant answer. */

import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.285 (Claude Code)\n')
} else {
  writeFileSync(process.env.OAR_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
  const input = createInterface({ input: process.stdin })
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
  input.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.type !== 'user') return
    emit({ type: 'system', subtype: 'init', session_id: 'packed-fixture', model: 'fixture', permissionMode: 'dontAsk' })
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'PACKED_OAR_OK' }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'PACKED_OAR_OK', usage: { input_tokens: 1, output_tokens: 1 } })
  })
}
