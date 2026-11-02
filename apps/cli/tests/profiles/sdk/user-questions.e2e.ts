/** Keyless SDK questions through the shipped profile, native tools, and both tool-call modes. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type SdkUserQuestionRequest } from '@deepseek-ai/dsh-sdk-client'
import { clearAmbientProxyEnv } from '../../../../../scripts/test-proxy-environment.ts'
import { expect, it, onTestFinished } from 'vitest'
import { messagesResponse } from './fixtures/messages-response.ts'

it.each([
  { mode: 'native', cancel: false }, { mode: 'ptc', cancel: false }, { mode: 'native', cancel: true },
])('handles a built-in question through $mode (cancel: $cancel)', async ({ mode, cancel }) => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-question-profile-'))
  const requests: Record<string, unknown>[] = []
  const questions = [{ id: 'format', question: 'Which format?', options: [{ label: 'CSV' }, { label: 'JSON' }] }]
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => { body += chunk })
    incoming.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      const tool = mode === 'ptc' ? {
        type: 'tool_use', id: 'question-call', name: 'run_code', input: {
          code: `return await tools.ask_user_question(${JSON.stringify({ questions })});`, description: 'Ask which output format to use',
        },
      } : { type: 'tool_use', id: 'question-call', name: 'ask_user_question', input: { questions } }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse(requests.length === 1 ? tool : { type: 'text', text: 'answer received' },
        requests.length === 1 ? 'tool_use' : 'end_turn'))
    })
  })
  const state: { harness?: DeepSeekHarness } = {}
  onTestFinished(async () => {
    try { await state.harness?.close() } finally {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })
      }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no port')
  const env = { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'keyless-question-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(address.port)}` }
  clearAmbientProxyEnv(env)
  const seen: SdkUserQuestionRequest[] = []
  const entered = Promise.withResolvers<AbortSignal>()
  const harness = state.harness = new DeepSeekHarness({
    cwd: root, dshHome: join(root, '.dsh'), env, model: 'deepseek-v4-pro', maxTokens: 1234, initializeTimeoutMs: 30_000,
    patches: mode === 'ptc' ? [fileURLToPath(new URL('../../../config/examples/ptc.yml', import.meta.url))] : [],
    onUserQuestion: async (request, { signal }) => {
      expect(signal.aborted).toBe(false)
      seen.push(request)
      entered.resolve(signal)
      if (cancel) return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('question cancelled')) }, { once: true })
      })
      return { answers: [{ id: 'format', selected: ['CSV'] }] }
    },
  })
  const pending = harness.session('question-session').run('Ask which output format to use')
  if (cancel) {
    const settled = pending.catch(() => undefined)
    const signal = await entered.promise
    await harness.close()
    await settled
    expect(signal.aborted).toBe(true)
    expect(requests).toHaveLength(1)
    return
  }
  const result = await pending
  expect(seen).toEqual([{ requestId: expect.any(String) as string, sessionId: 'question-session', questions }])
  expect(result.finalResponse).toBe('answer received')
  expect(requests).toHaveLength(2)
  expect(requests[1]?.max_tokens).toBe(1234)
  expect(JSON.stringify(requests[1]?.messages)).toContain('CSV')
  expect(result.events.some(event => event.type === 'tool/result' && event.data.error !== undefined)).toBe(false)
})
