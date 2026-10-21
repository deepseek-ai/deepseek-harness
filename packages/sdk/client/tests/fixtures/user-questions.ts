/** Protocol-only peer: requests host input while an unrelated client request is pending. */
import { createInterface } from 'node:readline'

const pending = new Map<string, string | number>()
let serial = 0
const input = createInterface({ input: process.stdin })
function write(value: object): void { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`) }
input.on('line', (line) => {
  const frame = JSON.parse(line) as {
    id: string | number
    method?: string
    params?: Record<string, unknown>
    result?: unknown
    error?: unknown
  }
  if (frame.method === undefined) {
    const original = pending.get(String(frame.id))
    if (original !== undefined) {
      pending.delete(String(frame.id))
      write({ id: original, result: { answer: frame.result ?? null, error: frame.error ?? null } })
    }
    return
  }
  if (frame.method === 'initialize') {
    write({ id: frame.id, result: { serverInfo: { name: 'question-test', version: JSON.stringify(frame.params?.capabilities ?? null) } } })
  } else if (frame.method === 'test/question') {
    const id = `host-${String(++serial)}`
    pending.set(id, frame.id)
    write({ id, method: frame.params?.method ?? 'user-question/ask', params: {
      requestId: typeof frame.params?.requestId === 'string' ? frame.params.requestId : id, sessionId: 'main',
      questions: frame.params?.questions ?? [{ id: 'format', question: 'Which format?' }],
    } })
  } else if (frame.method === 'test/cancel') {
    write({ method: 'user-question.cancelled', params: frame.params })
    write({ id: frame.id, result: {} })
  } else if (frame.method === 'test/disconnect') {
    process.exit(0)
  } else if (frame.method === 'shutdown') {
    write({ id: frame.id, result: {} })
    input.close()
    process.stdin.destroy()
  }
})
