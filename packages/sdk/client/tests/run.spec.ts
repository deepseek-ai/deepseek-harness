/** Unified input receipt and observation over an independently running protocol peer. */
import { fileURLToPath } from 'node:url'
import { expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'
import * as sdk from '../src/index.ts'
import { JsonRpcResponseError, RequestTimeoutError, SdkProtocolError, TransportClosedError } from '../src/index.ts'
import type { SdkEncodedImageBlock, SdkPromptContentBlock } from '../src/index.ts'
import type { HarnessNotification, RunResult } from '../src/types.ts'

function harnessWith(environment: Record<string, string> = {}, requestTimeoutMs?: number) {
  const harness = createProcessDeepSeekHarness({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/query.ts', import.meta.url))],
    environment: () => ({ ...process.env, ...environment }),
    description: 'query protocol fixture',
    initializeTimeoutMs: 5000,
    ...requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
  })
  onTestFinished(() => harness.close())
  return harness
}

const images: [SdkEncodedImageBlock, SdkEncodedImageBlock] = [
  { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', name: 'diagram.png' },
  { type: 'image', data: 'c2Vjb25k', mimeType: 'image/jpeg' },
]

it('exposes run while keeping its routing request helper internal', () => {
  expect(sdk.HarnessClient.prototype).not.toHaveProperty('query')
  expect(sdk).not.toHaveProperty('queryInput')
  expectTypeOf<sdk.HarnessClient>().not.toHaveProperty('query')
  expect(sdk).not.toHaveProperty('RunCommandResult')
  expectTypeOf<Awaited<ReturnType<sdk.HarnessSession['run']>>>().toEqualTypeOf<RunResult>()
})

it('returns generated Session identities that can receive subsequent input', async () => {
  const harness = harnessWith()
  const first = await harness.run('/compact')
  const second = await harness.run('/compact')
  expect(first.sessionId).toEqual(expect.any(String))
  expect(first.sessionId).not.toBe('')
  expect(second.sessionId).not.toBe(first.sessionId)
  const continued = await harness.run('continue', { sessionId: first.sessionId })
  expect(continued.sessionId).toBe(first.sessionId)
  expect(continued.finalResponse).toBe('reply:continue')
  expect(await harness.client.request('test/state')).toHaveProperty('queries', [
    { sessionId: first.sessionId, contentBlocks: [{ type: 'text', text: '/compact' }] },
    { sessionId: second.sessionId, contentBlocks: [{ type: 'text', text: '/compact' }] },
    { sessionId: first.sessionId, contentBlocks: [{ type: 'text', text: 'continue' }] },
  ])
})

it.each(['session', 'harness'])('runs a native command through the %s entry without waiting for idle', async (entry) => {
  const harness = harnessWith()
  const notifications: HarnessNotification[] = []
  const onNotification = (notification: HarnessNotification): void => { notifications.push(notification) }
  const result = entry === 'session'
    ? await harness.session('main').run('/compact', { onNotification })
    : await harness.run('/compact', { sessionId: 'main', onNotification })
  expect(result).toMatchObject({ sessionId: 'main', finalResponse: 'compacted', finishReason: 'completed' })
  expect(notifications.filter(notification => notification.method === 'session.event')
    .map(notification => (notification.params.event as { type: string }).type))
    .toEqual(['command/run', 'command/done'])
})

it('preserves prompt text and observes its receipt-to-idle activity', async () => {
  const notifications: HarnessNotification[] = []
  const result = await harnessWith().session('main').run(' first\n', {
    onNotification: (notification) => { notifications.push(notification) },
  })
  expect(result.finalResponse).toBe('reply: first\n')
  expect(result.notifications).toEqual(notifications)
  expect(result.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block =>
    block.type === 'text' && block.text === 'before receipt'))).toBe(false)
})

it.each(['session', 'harness'])('forwards native command content blocks through the %s entry', async (entry) => {
  const execution = { commandId: 'plan-command', result: { kind: 'success' } }
  const harness = harnessWith({ QUERY_RESULT: JSON.stringify({ kind: 'command', execution }) })
  const contentBlocks: SdkPromptContentBlock[] = [{ type: 'text', text: '/plan explain the diagram' }, ...images]
  const result = entry === 'session'
    ? await harness.session('images').run(contentBlocks)
    : await harness.run(contentBlocks, { sessionId: 'images' })
  expect(result).toMatchObject({ sessionId: 'images', finalResponse: '', finishReason: 'completed' })
  expect(await harness.client.request('test/state')).toHaveProperty('queries', [
    { sessionId: 'images', contentBlocks },
  ])
})

it.each([
  { entry: 'session', text: ' explain the diagram\n' },
  { entry: 'harness', text: 'explain the diagram' },
  { entry: 'harness', text: '/unknown explain the diagram' },
  { entry: 'session', text: undefined },
] as const)('preserves image content for $entry text "$text"', async ({ entry, text }) => {
  const harness = harnessWith()
  const contentBlocks: SdkPromptContentBlock[] = text === undefined ? images : [{ type: 'text', text }, ...images]
  const result = entry === 'session'
    ? await harness.session('images').run(contentBlocks)
    : await harness.run(contentBlocks, { sessionId: 'images' })
  expect(result.finalResponse).toBe(`reply:${text ?? ''}`)
  expect(await harness.client.request('test/state')).toHaveProperty('queries', [
    { sessionId: 'images', contentBlocks },
  ])
})

it('normalizes text and preserves block order through run', async () => {
  const harness = harnessWith()
  await harness.start()
  const contentBlocks: SdkPromptContentBlock[] = [
    images[0], { type: 'text', text: 'inspect ' }, images[1], { type: 'text', text: 'both' },
  ]
  expect((await harness.run(' inspect\n', { sessionId: 'images' })).finalResponse).toBe('reply: inspect\n')
  expect((await harness.run(contentBlocks, { sessionId: 'images' })).finalResponse).toBe('reply:inspect \nboth')
  const state = await harness.client.request('test/state')
  expect(state).toHaveProperty('queries', [
    { sessionId: 'images', contentBlocks: [{ type: 'text', text: ' inspect\n' }] },
    { sessionId: 'images', contentBlocks },
  ])
})

it('returns native command results for text-only blocks', async () => {
  const harness = harnessWith()
  const contentBlocks: SdkPromptContentBlock[] = [{ type: 'text', text: '/compact' }]
  expect(await harness.session('blocks').run(contentBlocks)).toMatchObject({
    sessionId: 'blocks', finalResponse: 'compacted', finishReason: 'completed',
  })
  expect(await harness.client.request('test/state')).toHaveProperty('queries', [
    { sessionId: 'blocks', contentBlocks },
  ])
})

it('retains a rejected command outcome without retrying its content as a prompt', async () => {
  const execution = { commandId: 'rejected-command', result: { kind: 'error', text: 'command rejected images' } }
  const harness = harnessWith({ QUERY_RESULT: JSON.stringify({ kind: 'command', execution }) })
  expect(await harness.session('images').run([{ type: 'text', text: '/plan off' }, ...images]))
    .toMatchObject({ sessionId: 'images', finalResponse: 'command rejected images', finishReason: 'error' })
  expect(await harness.client.request('test/state')).toHaveProperty('methods', ['initialize', 'session/query', 'test/state'])
})

it('keeps root result events separate from descendant notifications', async () => {
  const result = await harnessWith().session('main').run('with-child')
  expect(result.finalResponse).toBe('reply:with-child')
  expect(result.notifications.some(notification => notification.params.sessionId === 'child')).toBe(true)
  expect(result.notifications.some(notification => notification.params.sessionId === 'unrelated')).toBe(false)
  expect(result.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
})

it('retains independent results for concurrent calls on one Session', async () => {
  const session = harnessWith().session('main')
  const results = await Promise.all([session.run('first'), session.run('second')])
  expect(results.map(result => result.finalResponse)).toEqual(['reply:first', 'reply:second'])
})

it('returns a busy command result while another run waits for model activity', async () => {
  const harness = harnessWith()
  const session = harness.session('main')
  const entered = Promise.withResolvers<undefined>()
  const running = session.run('hold', { onNotification(notification) {
    if (notification.method === 'session.status' && notification.params.status === 'running') entered.resolve(undefined)
  } })
  await entered.promise
  expect(await session.run('/compact')).toMatchObject({ sessionId: 'main', finalResponse: 'busy', finishReason: 'error' })
  await harness.client.request('test/release')
  expect((await running).finalResponse).toBe('reply:hold')
})

it('keeps a plan run pending when another command completes on the same Session', async () => {
  const harness = harnessWith()
  const session = harness.session('main')
  const admitted = Promise.withResolvers<undefined>()
  let finished = false
  const running = session.run('/plan hold', { onNotification(notification) {
    if (notification.method === 'session.event'
      && (notification.params.event as { type: string }).type === 'command/done') {
      admitted.resolve(undefined)
    }
  } }).then((result) => { finished = true; return result })
  try {
    await admitted.promise
    expect(await session.run('/compact')).toMatchObject({ finalResponse: 'busy', finishReason: 'error' })
    expect(await harness.client.request('test/state')).toHaveProperty('waitingPrompts', 1)
    expect(finished).toBe(false)
  } finally {
    await harness.client.request('test/release')
  }
  expect(await running).toMatchObject({ finalResponse: 'the generated plan', finishReason: 'completed' })
})

it.each(['/model', ' /compact extra '])('preserves unsupported command input as text: %s', async (text) => {
  expect((await harnessWith().session('main').run(text)).finalResponse).toBe(`reply:${text}`)
})

it.each(['missing-run', 'missing-done', 'missing-both', 'unrelated-done', 'invalid-done'])('rejects an incomplete command lifecycle: %s', async (lifecycle) => {
  const execution = { commandId: 'command-no-events', result: { kind: 'success' } }
  const harness = harnessWith({
    QUERY_RESULT: JSON.stringify({ kind: 'command', execution }), QUERY_LIFECYCLE: lifecycle,
  })
  const subscribe = harness.client.subscribeSessionTree.bind(harness.client)
  const closes: ReturnType<typeof vi.fn>[] = []
  vi.spyOn(harness.client, 'subscribeSessionTree').mockImplementation((id) => {
    const subscription = subscribe(id)
    closes.push(vi.spyOn(subscription, 'close'))
    return subscription
  })
  await expect(harness.session('main').run('/compact')).rejects.toThrow(SdkProtocolError)
  expect(closes[0]).toHaveBeenCalledOnce()
  expect(await harness.client.request('test/state')).toHaveProperty('queries.length', 1)
})

it('retains failure completion when the native handler settles later but before its RPC response', async () => {
  const harness = harnessWith({
    QUERY_RESULT: JSON.stringify({ kind: 'command', execution: { commandId: 'early-failure', result: { kind: 'success' } } }),
    QUERY_COMPLETION: JSON.stringify({ finalResponse: 'goal service unloaded', finishReason: 'error' }),
    QUERY_LIFECYCLE: 'late-done',
  })
  const result = await harness.session('main').run('/goal task')
  expect(result).toMatchObject({ finalResponse: 'goal service unloaded', finishReason: 'error' })
  expect(result.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
})

it.each(['ordinary', '/compact'])('releases its subscription after an observer rejects %s', async (text) => {
  const harness = harnessWith()
  const subscribe = harness.client.subscribeSessionTree.bind(harness.client)
  const closes: ReturnType<typeof vi.fn>[] = []
  vi.spyOn(harness.client, 'subscribeSessionTree').mockImplementation((id) => {
    const subscription = subscribe(id)
    closes.push(vi.spyOn(subscription, 'close'))
    return subscription
  })
  await expect(harness.session('main').run(text, { onNotification() { throw new Error('observer failed') } }))
    .rejects.toThrow('observer failed')
  expect(closes[0]).toHaveBeenCalled()
  expect((await harness.session('main').run('after')).finalResponse).toBe('reply:after')
})

it('propagates routing rejection without retrying as a prompt', async () => {
  const harness = harnessWith({ QUERY_ERROR_TEXT: 'reject this input' })
  await expect(harness.session('main').run('reject this input')).rejects.toThrow(JsonRpcResponseError)
  expect(await harness.client.request('test/state')).toMatchObject({ methods: ['initialize', 'session/query', 'test/state'] })
})

it.each([
  null,
  {},
  { kind: 'unknown' },
  { kind: 'prompt' },
  { kind: 'prompt', messageId: '' },
  { kind: 'command', execution: { commandId: 'c', result: { kind: 'error' } } },
])('rejects malformed routing results: %j', async (result) => {
  await expect(harnessWith({ QUERY_RESULT: JSON.stringify(result) }).session('main').run('input'))
    .rejects.toThrow(SdkProtocolError)
})

it.each([
  null,
  {},
  { commandId: '', result: { kind: 'success' } },
  { commandId: 'c', result: { kind: 'unknown' } },
  { commandId: 'c', result: { kind: 'success', text: 1 } },
  { commandId: 'c', result: { kind: 'success', text: null } },
  { commandId: 'c', result: { kind: 'success', sourceEventSeq: -1 } },
  { commandId: 'c', result: { kind: 'success', sourceEventSeq: '1' } },
  { commandId: 'c', result: { kind: 'success', sourceEventSeq: null } },
  { commandId: 'c', result: { kind: 'success', sourceEventSeq: Number.MAX_SAFE_INTEGER + 1 } },
  { commandId: 'c', result: { kind: 'error', text: '  ' } },
])('rejects an invalid native result through run: %j', async (execution) => {
  await expect(harnessWith({ QUERY_RESULT: JSON.stringify({ kind: 'command', execution }) }).session('main').run('/compact'))
    .rejects.toThrow(SdkProtocolError)
})

it('reports command timeout without cancelling the runtime operation', async () => {
  const harness = harnessWith({ QUERY_HOLD_COMMAND: '1' }, 50)
  await expect(harness.session('main').run('/compact')).rejects.toThrow(RequestTimeoutError)
  expect(await harness.client.request('test/state', undefined, 5000)).toMatchObject({ waitingCommands: 1 })
  await harness.client.request('test/release', undefined, 5000)
})

it('reports runtime loss from run', async () => {
  await expect(harnessWith({ QUERY_DISCONNECT: '1' }).session('main').run('disconnect')).rejects.toThrow(TransportClosedError)
})

it('keeps run pending after the plan command until its model output arrives', async () => {
  const harness = harnessWith()
  const admitted = Promise.withResolvers<undefined>()
  const running = harness.session('plan').run('/plan hold', { onNotification(notice) {
    const event = notice.params.event as { type?: string } | undefined
    if (event?.type === 'command/done') admitted.resolve(undefined)
  } })
  let returned = false
  void running.then(() => { returned = true })
  await admitted.promise
  expect(returned).toBe(false)
  await harness.client.request('test/release')
  expect(await running).toMatchObject({ sessionId: 'plan', finalResponse: 'the generated plan', finishReason: 'completed' })
})

it.each([{ commandId: null }, { finalResponse: 1 }, { finishReason: null }, { finishReason: '' }])(
  'rejects malformed command completion: %j', async (completion) => {
    const harness = harnessWith({
      QUERY_RESULT: JSON.stringify({ kind: 'command', execution: { commandId: 'c', result: { kind: 'success' } } }),
      QUERY_COMPLETION: JSON.stringify(completion),
    })
    await expect(harness.session('plan').run('/plan')).rejects.toThrow(SdkProtocolError)
  },
)

it('reports transport loss after the command has acknowledged its model work', async () => {
  await expect(harnessWith().session('plan').run('/plan disconnect')).rejects.toThrow(TransportClosedError)
})
