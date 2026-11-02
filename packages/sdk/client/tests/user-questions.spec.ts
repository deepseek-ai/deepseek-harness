import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import type { HarnessClientOptions } from '../src/types.ts'
import { createProcessHarnessClient } from '../src/client.ts'

async function client(onUserQuestion?: HarnessClientOptions['onUserQuestion'], explicitStart = true) {
  const result = createProcessHarnessClient({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/user-questions.ts', import.meta.url))],
    environment: () => ({ ...process.env }),
    description: 'question protocol fixture', initializeTimeoutMs: 5000, requestTimeoutMs: 5000,
  })
  onTestFinished(() => result.close())
  if (onUserQuestion !== undefined) result.options.onUserQuestion = onUserQuestion
  if (explicitStart) result.start()
  const initialized = await result.initialize({ cwd: process.cwd(), provider: 'mock', model: 'mock' })
  const capabilities: unknown = JSON.parse(initialized.serverInfo.version)
  return { client: result, capabilities }
}

it.each([false, true])('advertises a callback and answers a runtime request with explicit start: %s', async (explicitStart) => {
  const answer = { answers: [{ id: 'format', selected: ['CSV'] }] }
  const seen: string[] = []
  const f = await client(async (request, { signal }) => {
    seen.push(request.sessionId)
    expect(signal.aborted).toBe(false)
    return answer
  }, explicitStart)
  expect(f.capabilities).toEqual({ userQuestions: true })
  await expect(f.client.request('test/question', {})).resolves.toEqual({ answer, error: null })
  expect(seen).toEqual(['main'])
})

it('does not advertise a missing callback and reports an unexpected question instead of hanging', async () => {
  const f = await client()
  expect(f.capabilities).toBeNull()
  await expect(f.client.request('test/question', {})).resolves.toMatchObject({ error: { message: expect.stringContaining('onUserQuestion') as string } })
})

it('forwards a user dismissal as a result distinct from callback failure', async () => {
  const f = await client(async () => ({ cancelled: true }))
  await expect(f.client.request('test/question', {})).resolves.toEqual({ answer: { cancelled: true }, error: null })
})

it.each([
  { params: { method: 'unexpected/request' }, message: 'unknown runtime request' },
  { params: { questions: [{ question: 'Missing identity' }] }, message: 'requires requestId, sessionId, and questions' },
])('rejects unsupported or malformed runtime requests: $message', async ({ params, message }) => {
  const f = await client(async () => { throw new Error('invalid requests must not reach the host') })
  await expect(f.client.request('test/question', params)).resolves.toMatchObject({
    error: { message: expect.stringContaining(message) as string },
  })
})

it('rejects a duplicate question identity without cancelling the original host callback', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const answer = { answers: [{ id: 'format', selected: ['CSV'] }] }
  const result = Promise.withResolvers<typeof answer>()
  const f = await client(async (_request, { signal }) => {
    entered.resolve(signal)
    return result.promise
  })
  const original = f.client.request('test/question', { requestId: 'shared' })
  const signal = await entered.promise
  await expect(f.client.request('test/question', { requestId: 'shared' })).resolves.toMatchObject({
    error: { message: expect.stringContaining('duplicate') as string },
  })
  expect(signal.aborted).toBe(false)
  result.resolve(answer)
  await expect(original).resolves.toEqual({ answer, error: null })
})

it('notifies a callback of cancellation and ignores its later answer', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const lateAnswer = Promise.withResolvers<{ answers: { id: string; selected: string[] }[] }>()
  const f = await client(async (_request, { signal }) => {
    entered.resolve(signal)
    return lateAnswer.promise
  })
  const pending = f.client.request('test/question', { requestId: 'cancel-me' })
  const signal = await entered.promise
  await f.client.request('test/cancel', { requestId: 'cancel-me', sessionId: 'main' })
  expect(signal.aborted).toBe(true)
  await expect(pending).resolves.toMatchObject({ answer: null, error: { message: expect.stringContaining('cancelled') as string } })
  lateAnswer.resolve({ answers: [{ id: 'format', selected: ['late'] }] })
  await f.client.close()
})

it.each(['close', 'disconnect'] as const)('aborts host work when the client or runtime %ss', async (kind) => {
  const entered = Promise.withResolvers<AbortSignal>()
  const stopped = Promise.withResolvers<undefined>()
  const f = await client(async (_request, { signal }) => {
    entered.resolve(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { stopped.resolve(undefined); reject(new Error('question cancelled')) }, { once: true })
    })
  })
  const pending = f.client.request('test/question', {}).catch(() => undefined)
  const signal = await entered.promise
  if (kind === 'close') await f.client.close()
  else await f.client.request('test/disconnect', {}).catch(() => undefined)
  await stopped.promise
  expect(signal.aborted).toBe(true)
  await pending
})

it('keeps native questions active beside the approval request handler', async () => {
  const answer = { answers: [{ id: 'format', selected: ['CSV'] }] }
  const f = await client(async () => answer)
  const approvals: string[] = []
  f.client.onRequest(async (method) => {
    approvals.push(method)
    return { outcome: 'allowed-once' }
  })
  const [question, approval] = await Promise.all([
    f.client.request('test/question', { requestId: 'native' }),
    f.client.request('test/question', { requestId: 'approval', method: 'approval/request' }),
  ])
  expect(question).toEqual({ answer, error: null })
  expect(approval).toEqual({ answer: { outcome: 'allowed-once' }, error: null })
  expect(approvals).toEqual(['approval/request'])
})
