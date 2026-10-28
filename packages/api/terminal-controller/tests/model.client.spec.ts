/** Browser view ownership across slow RPCs, remounts and transport generations. */
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteStream, RemoteStreamCarrierError, type ClientRemote, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteMock, streamMethod, type StreamHandle } from '@deepseek-ai/dsh-remote-mock'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TerminalView, type TerminalRemote } from '../src/client/model.ts'
import { TerminalInventory } from '../src/client/inventory.ts'
import type { TerminalInput, TerminalEnvironment, TerminalFrame, WebTerminalId, WebTerminalInfo } from '../src/types.ts'

const sessionId = 'session' as SessionId
const info: WebTerminalInfo = { id: 'terminal' as WebTerminalId, shell: { name: 'bash', path: '/bin/bash', args: ['-i'] }, title: 'bash', cwd: '/workspace', rows: 24, cols: 80, state: 'running', exitCode: null }
const environment: TerminalEnvironment = {
  cwd: info.cwd, maxInputBytes: 1000, maxBufferedBytes: 100_000, maxCols: 200, maxRows: 100, scrollback: 100,
}
const success = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function failure(message: string): RemoteResult<never> {
  return { ok: false, error: new RemoteError('gateway/bad-request', message, {}) }
}

function fixture(prepareStream?: <Item>(stream: RemoteStream<Item>) => void, inputWindow?: RemoteUplinkWindow) {
  const attachments: StreamHandle[] = []
  const sent: TerminalInput[][] = []
  const mock = RemoteMock.create().stream('terminal/attach', async (args, stream) => {
    attachments.push(stream)
    const commands: TerminalInput[] = []
    sent.push(commands)
    stream.push({ type: 'snapshot', sequence: 0, screen: 'ready', info: { ...info, id: args[1] }, writable: true, ...inputWindow === undefined ? {} : { inputWindow } })
    for await (const command of stream.uplink) commands.push(command as TerminalInput)
  })
  const remote: TerminalRemote = {
    retain: vi.fn<TerminalRemote['retain']>(streamMethod<TerminalRemote['retain']>(async function* (_session, _id, signal) {
      yield { type: 'retained' }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })),
    shells: vi.fn<TerminalRemote['shells']>(async () => success([info.shell])),
    environment: vi.fn<TerminalRemote['environment']>(async () => success(environment)), list: vi.fn<TerminalRemote['list']>(async () => success([])),
    create: vi.fn<TerminalRemote['create']>(async (_sessionId, request) => success({ ...info, id: request.id })),
    close: vi.fn<TerminalRemote['close']>(async () => success(undefined)), rename: vi.fn<TerminalRemote['rename']>(async () => success(undefined)),
    attach: mock.remote.terminal.attach,
  }
  const options: RemoteStreamOptions<unknown>[] = []
  const streams: { dispose(): Promise<void>; restart(): void }[] = []
  const generation = createSnapshotStore<ReturnType<ConstructorParameters<typeof RemoteStream>[0]['generation']['getSnapshot']>>(undefined)
  const gateway: Pick<ClientRemote, '$stream'> = {
    $stream: (option) => {
      options.push(option)
      const stream = new RemoteStream({ generation }, option)
      streams.push(stream)
      prepareStream?.(stream)
      return stream
    },
  }
  cleanups.push(async () => { await Promise.all(streams.map(stream => stream.dispose())) })
  const inventory = new TerminalInventory(() => remote.list(sessionId))
  cleanups.push(() => inventory.dispose())
  const model = new TerminalView(sessionId, remote, gateway, inventory, info.id)
  cleanups.push(() => model.dispose())
  return { model, remote, gateway, options, streams, generation, attachments, sent }
}

async function mount(model: TerminalView) {
  const detach = model.mount()
  await model.refresh()
  return detach
}

function acknowledge(model: TerminalView): void {
  const render = model.state.getSnapshot().render
  if (render !== undefined) model.acknowledge(render.revision)
}

async function connected(model: TerminalView): Promise<void> {
  await mount(model)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  acknowledge(model)
}

it('waits for render acknowledgement before publishing subsequent output', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.attach).mockImplementation(streamMethod<TerminalRemote['attach']>(async function* (_sessionId, id, signal) {
    const frames: TerminalFrame[] = [
      { type: 'snapshot', writable: true, sequence: 0, screen: '', info: { ...info, id } },
      { type: 'output', sequence: 1, data: 'first' },
      { type: 'output', sequence: 2, data: 'second' },
    ]
    for (const frame of frames) yield frame
    await untilAborted(signal)
  }))
  await mount(model)
  await expect.poll(() => model.state.getSnapshot().render?.frame.type).toBe('snapshot')
  acknowledge(model)
  await expect.poll(() => model.state.getSnapshot().render?.frame).toMatchObject({ type: 'output', sequence: 1 })
  acknowledge(model)
  await expect.poll(() => model.state.getSnapshot().render?.frame).toMatchObject({ type: 'output', sequence: 2 })
})

it('treats carrier loss as disconnected only for the active attachment', async () => {
  const { model, options } = fixture()
  await connected(model)
  const first = options[0]!
  first.carrierFailed?.(new RemoteStreamCarrierError('offline'))
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'disconnected', writable: false })
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  first.carrierFailed?.(new RemoteStreamCarrierError('late old failure'))
  expect(model.state.getSnapshot().phase).toBe('connected')
})

it.each([
  ['output before snapshot', [{ type: 'output', sequence: 1, data: 'orphan' }], 'missing its screen snapshot'],
  ['sequence gap', [{ type: 'snapshot', writable: true, sequence: 4, screen: '', info }, { type: 'output', sequence: 6, data: 'gap' }], 'sequence has a gap'],
  ['repeated snapshot', [{ type: 'snapshot', writable: true, sequence: 4, screen: '', info }, { type: 'snapshot', writable: true, sequence: 4, screen: '', info }], 'Unexpected terminal screen snapshot'],
] satisfies readonly (readonly [string, readonly TerminalFrame[], string])[])('refuses a malformed output stream: %s', async (_name, frames, message) => {
  const { model, remote } = fixture()
  vi.mocked(remote.attach).mockImplementation(streamMethod<TerminalRemote['attach']>(async function* () { yield* frames }))
  await mount(model)
  if (frames[0]?.type === 'snapshot') {
    await expect.poll(() => model.state.getSnapshot().render).toBeDefined()
    acknowledge(model)
  }
  await expect.poll(() => model.state.getSnapshot().error).toContain(message)
  expect(model.state.getSnapshot().writable).toBe(false)
})

it('retains an exited screen and closes controls when its stream ends', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.attach).mockImplementation(streamMethod<TerminalRemote['attach']>(async function* (_sessionId, id) {
    yield { type: 'snapshot', writable: true, sequence: 0, screen: 'last screen', info: { ...info, id } }
    yield { type: 'state', writable: true, info: { ...info, id, state: 'exited', exitCode: 3 } }
  }))
  await connected(model)
  await expect.poll(() => model.state.getSnapshot().phase).toBe('closed')
  expect(model.state.getSnapshot()).toMatchObject({ writable: false, info: { state: 'exited', exitCode: 3 }, render: { frame: { screen: 'last screen' } } })
})

it('reports an attachment ending while the shell is still running and permits manual reconnect', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.attach).mockImplementationOnce(streamMethod<TerminalRemote['attach']>(async function* (_sessionId, id) {
    yield { type: 'snapshot', writable: true, sequence: 0, screen: '', info: { ...info, id } }
  }))
  await connected(model)
  await expect.poll(() => model.state.getSnapshot().issue).toBe('attachmentEnded')
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
})

it('publishes remote control transfer without replacing the retained screen', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.attach).mockImplementation(streamMethod<TerminalRemote['attach']>(async function* (_sessionId, id, signal) {
    yield { type: 'snapshot', writable: true, sequence: 0, screen: 'retained', info: { ...info, id } }
    yield { type: 'state', writable: false, info: { ...info, id } }
    await untilAborted(signal)
  }))
  await connected(model)
  await expect.poll(() => model.state.getSnapshot().writable).toBe(false)
  expect(model.state.getSnapshot().render?.frame).toMatchObject({ type: 'snapshot', writable: true, screen: 'retained' })
})

/** Pause delivery after the real Gateway iterator settles, before the model observes it. */
function deliveryBarrier() {
  const ready = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let held = false
  function prepare<Item>(stream: RemoteStream<Item>): void {
    if (held) return
    held = true
    const iterator = stream[Symbol.asyncIterator]()
    let first = true
    vi.spyOn(stream, Symbol.asyncIterator).mockReturnValue({
      async next() {
        if (!first) return iterator.next()
        first = false
        try {
          return await iterator.next()
        } finally {
          ready.resolve(undefined)
          await release.promise
        }
      },
      async return() { return iterator.return!() },
    })
  }
  cleanups.push(() => { release.resolve(undefined) })
  return { ready: ready.promise, release: () => { release.resolve(undefined) }, prepare }
}

it('ignores an already delivered screen when its attachment is replaced before the model receives it', async () => {
  const barrier = deliveryBarrier()
  const { model, remote } = fixture(barrier.prepare)
  await mount(model)
  await barrier.ready
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  const current = model.state.getSnapshot()
  barrier.release()
  await model.rename('settled')
  expect(model.state.getSnapshot().render).toBe(current.render)
  expect(remote.attach).toHaveBeenCalledTimes(2)
})

it('ignores an already settled stream error after a newer attachment has become writable', async () => {
  const barrier = deliveryBarrier()
  const { model, remote } = fixture(barrier.prepare)
  vi.mocked(remote.attach).mockImplementationOnce(streamMethod<TerminalRemote['attach']>(async function* () {
    yield* []
    throw new Error('retired attachment failed')
  }))
  await mount(model)
  await barrier.ready
  model.connect()
  await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
  barrier.release()
  await model.rename('settled')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', writable: true, error: undefined })
})

it('releases a pending screen render on carrier generation cancellation and accepts the replacement screen', async () => {
  const { model, remote, streams } = fixture()
  await mount(model)
  await expect.poll(() => model.state.getSnapshot().render).toBeDefined()
  const revision = model.state.getSnapshot().render!.revision
  streams[0]!.restart()
  await expect.poll(() => model.state.getSnapshot().render?.revision).toBe(revision + 1)
  expect(remote.attach).toHaveBeenCalledTimes(2)
  expect(model.state.getSnapshot().writable).toBe(true)
})

it('does not wait for the DOM callback of a screen whose generation was already cancelled at delivery', async () => {
  const barrier = deliveryBarrier()
  const { model, remote, streams } = fixture(barrier.prepare)
  await mount(model)
  await barrier.ready
  streams[0]!.restart()
  barrier.release()
  await expect.poll(() => model.state.getSnapshot().render?.revision).toBe(2)
  expect(remote.attach).toHaveBeenCalledTimes(2)
  expect(model.state.getSnapshot().writable).toBe(true)
})

it('renames an existing terminal, skips unchanged names, and exposes rename failures', async () => {
  const { model, remote } = fixture()
  await connected(model)
  await model.rename(`  ${info.title}  `)
  expect(remote.rename).not.toHaveBeenCalled()
  await model.rename('  Build  ')
  expect(model.state.getSnapshot()).toMatchObject({ title: 'Build', info: { title: 'Build' } })
  vi.mocked(remote.rename).mockRejectedValueOnce('rename connection lost')
  await model.rename('Other')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'rename connection lost', title: 'Build' })
  await model.dispose()
  await model.rename('Ignored')
  expect(remote.rename).toHaveBeenCalledTimes(2)
})

it('classifies a discovery carrier failure as disconnected and supports explicit retry', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.environment).mockRejectedValueOnce(new RemoteStreamCarrierError('offline'))
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'disconnected', error: 'offline' })
  expect(remote.create).not.toHaveBeenCalled()
  await model.refresh()
  expect(model.state.getSnapshot().info?.id).toBe(info.id)
  expect(remote.create).toHaveBeenCalledOnce()
})

it('retains state when disposal overtakes successful allocation or a failed discovery', async () => {
  for (const operation of ['creation', 'discovery'] as const) {
    const { model, remote } = fixture()
    const creation = Promise.withResolvers<RemoteResult<WebTerminalInfo>>()
    const discovery = Promise.withResolvers<RemoteResult<TerminalEnvironment>>()
    if (operation === 'creation') vi.mocked(remote.create).mockReturnValueOnce(creation.promise)
    else vi.mocked(remote.environment).mockReturnValueOnce(discovery.promise)
    const loading = model.refresh()
    if (operation === 'creation') await expect.poll(() => remote.create).toHaveBeenCalledOnce()
    await model.dispose()
    const before = model.state.getSnapshot()
    if (operation === 'creation') creation.resolve(success(info))
    else discovery.reject(new Error('late discovery failure'))
    await loading
    expect(model.state.getSnapshot()).toBe(before)
    expect(remote.attach).not.toHaveBeenCalled()
  }
})

it('ignores a successful rename after the view is disposed', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const rename = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.rename).mockReturnValueOnce(rename.promise)
  const pending = model.rename('Late')
  await model.dispose()
  const before = model.state.getSnapshot()
  rename.resolve(success(undefined))
  await pending
  expect(model.state.getSnapshot()).toBe(before)
})

it('allows retry after failed process cleanup and never reconnects while close is pending', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const closing = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.close).mockReturnValueOnce(closing.promise)
  const first = model.close()
  expect(model.close()).toBe(first)
  model.connect()
  expect(remote.attach).toHaveBeenCalledOnce()
  closing.resolve(failure('close refused'))
  await expect(first).rejects.toThrow('close refused')
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'close refused' })
  await model.close()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'closed', writable: false })
  expect(remote.close).toHaveBeenCalledTimes(2)
})

it('does not publish a close result or reconnect after disposal', async () => {
  const { model, remote } = fixture()
  await connected(model)
  const closing = Promise.withResolvers<RemoteResult<void>>()
  vi.mocked(remote.close).mockReturnValueOnce(closing.promise)
  const pending = model.close()
  await model.dispose()
  const before = model.state.getSnapshot()
  closing.resolve(success(undefined))
  await pending
  model.mount()
  model.connect()
  expect(model.state.getSnapshot()).toBe(before)
  expect(remote.attach).toHaveBeenCalledOnce()
})

it('exposes a localized quota error and clears it after a successful retry', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.create).mockResolvedValueOnce({ ok: false, error: new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: 8 }) })
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', issue: 'terminalLimit' })
  await connected(model)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', issue: undefined, error: undefined })
})

it('sends input and clamped resize in order without waiting for acknowledgements', async () => {
  const h = fixture()
  await connected(h.model)
  h.model.resize(80, 24)
  h.model.write('first')
  h.model.write('second')
  h.model.resize(500, 300)
  await expect.poll(() => h.sent[0]?.length).toBe(3)
  expect(h.sent[0]).toEqual([
    { type: 'write', sequence: 1, data: 'first' },
    { type: 'write', sequence: 2, data: 'second' },
    { type: 'resize', sequence: 3, cols: 200, rows: 100 },
  ])
})

it('releases the UTF-8 input budget only on acknowledgement', async () => {
  const h = fixture()
  vi.mocked(h.remote.environment).mockResolvedValue(success({ ...environment, maxInputBytes: 6 }))
  await connected(h.model)
  h.model.write('界界')
  await expect.poll(() => h.sent[0]?.length).toBe(1)
  h.attachments[0]!.push({ type: 'ack', sequence: 1 })
  h.attachments[0]!.push({ type: 'state', info: { ...info, cols: 90 }, writable: true })
  await expect.poll(() => h.model.state.getSnapshot().info?.cols).toBe(90)
  h.model.write('界界')
  await expect.poll(() => h.sent[0]?.length).toBe(2)
  h.model.write('a')
  expect(h.model.state.getSnapshot()).toMatchObject({ phase: 'failed', issue: 'inputFull' })
})

it('keeps output attached after an input refusal and stops further input', async () => {
  const h = fixture()
  await connected(h.model)
  h.model.write('before transfer')
  h.attachments[0]!.push({ type: 'ack', sequence: 1, refusal: 'read-only' })
  await expect.poll(() => h.model.state.getSnapshot().writable).toBe(false)
  h.model.write('refused')
  h.model.resize(100, 30)
  h.attachments[0]!.push({ type: 'output', sequence: 1, data: 'still following' })
  await expect.poll(() => h.model.state.getSnapshot().render?.frame).toMatchObject({ data: 'still following' })
  expect(h.model.state.getSnapshot()).toMatchObject({ phase: 'connected', error: undefined })
  expect(h.remote.attach).toHaveBeenCalledOnce()
  expect(h.sent[0]).toHaveLength(1)
})

it('discards the old generation budget and never replays unacknowledged input after reconnect', async () => {
  const h = fixture()
  h.generation.set({ id: 1, host: { home: '/home/fixture' } })
  await connected(h.model)
  h.model.write('unconfirmed')
  await expect.poll(() => h.sent[0]?.length).toBe(1)
  h.generation.set(undefined)
  h.attachments[0]!.fail(new RemoteStreamCarrierError('connection lost'))
  await expect.poll(() => h.model.state.getSnapshot().phase).toBe('disconnected')
  h.model.write('offline')
  h.generation.set({ id: 2, host: { home: '/home/fixture' } })
  await expect.poll(() => h.attachments.length).toBe(2)
  await expect.poll(() => h.model.state.getSnapshot().writable).toBe(true)
  acknowledge(h.model)
  h.model.write('fresh')
  await expect.poll(() => h.sent[1]?.length).toBe(1)
  expect(h.sent[1]).toEqual([{ type: 'write', sequence: 1, data: 'fresh' }])
  h.attachments[0]!.push({ type: 'ack', sequence: 1, refusal: 'read-only' })
  expect(h.model.state.getSnapshot().writable).toBe(true)
  expect(h.remote.create).toHaveBeenCalledOnce()
})

it('ignores controls before mount and after detach, then reuses the process on remount', async () => {
  const h = fixture()
  h.model.write('early')
  h.model.resize(100, 30)
  const unmount = await mount(h.model)
  await expect.poll(() => h.model.state.getSnapshot().writable).toBe(true)
  unmount()
  h.model.write('detached')
  h.model.resize(100, 30)
  expect(h.sent[0]).toEqual([])
  h.model.mount()
  await expect.poll(() => h.remote.attach).toHaveBeenCalledTimes(2)
  expect(h.remote.create).toHaveBeenCalledOnce()
})

it('rejects an out-of-order acknowledgement and reports synchronous send failures', async () => {
  const h = fixture()
  await connected(h.model)
  h.model.write('input')
  h.attachments[0]!.push({ type: 'ack', sequence: 2 })
  await expect.poll(() => h.model.state.getSnapshot().issue).toBe('invalidOutput')
  h.model.connect()
  await expect.poll(() => h.model.state.getSnapshot().writable).toBe(true)
  const handle = vi.mocked(h.remote.attach).mock.results.at(-1)!.value as ReturnType<TerminalRemote['attach']>
  vi.spyOn(handle, 'send').mockImplementation(() => { throw new Error('send failed') })
  h.model.write('next')
  expect(h.model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'send failed' })
})

it.each(['write', 'resize'] as const)('ignores empty input and stale render acknowledgements and refuses %s without limits', async (operation) => {
  const h = fixture()
  await connected(h.model)
  h.model.acknowledge(-1)
  h.model.write('')
  const state = h.model.state.getSnapshot()
  h.model.state.set({ ...state, info: undefined })
  h.model.write('missing')
  h.model.resize(100, 30)
  expect(h.sent[0]).toEqual([])
  h.model.state.set({ ...state, environment: undefined })
  if (operation === 'write') h.model.write('no budget')
  else h.model.resize(100, 30)
  expect(h.sent[0]).toEqual([])
  expect(h.model.state.getSnapshot().issue).toBe('inputFull')
})

function encodedFrame(command: TerminalInput): number {
  return new TextEncoder().encode(JSON.stringify({ type: 'item', streamId: '00000000-0000-0000-0000-000000000000', value: command })).byteLength
}

function inputWindow(maxBytes: number): RemoteUplinkWindow {
  const command: TerminalInput = { type: 'write', sequence: 1, data: 'a' }
  return { maxBytes, frameOverheadBytes: encodedFrame(command) - new TextEncoder().encode(JSON.stringify(command)).byteLength }
}

it('waits for complete-frame capacity and sends queued write and resize commands in order', async () => {
  const commands: TerminalInput[] = [
    { type: 'write', sequence: 1, data: '\u0001界' },
    { type: 'resize', sequence: 2, cols: 90, rows: 25 },
    { type: 'write', sequence: 3, data: 'last' },
  ]
  const h = fixture(undefined, inputWindow(Math.max(...commands.map(encodedFrame))))
  await connected(h.model)
  h.model.write('\u0001界')
  h.model.resize(90, 25)
  h.model.write('last')
  await expect.poll(() => h.sent[0]).toEqual(commands.slice(0, 1))
  h.attachments[0]!.push({ type: 'ack', sequence: 1 })
  await expect.poll(() => h.sent[0]).toEqual(commands.slice(0, 2))
  h.attachments[0]!.push({ type: 'ack', sequence: 2 })
  await expect.poll(() => h.sent[0]).toEqual(commands)
  expect(h.model.state.getSnapshot()).toMatchObject({ phase: 'connected', issue: undefined })
})

it('keeps a burst of short commands within the advertised inbox and resumes on acknowledgements', async () => {
  const window = inputWindow(262_144)
  const h = fixture(undefined, window)
  vi.mocked(h.remote.environment).mockResolvedValue(success({ ...environment, maxInputBytes: 65_536, maxBufferedBytes: 2_097_152 }))
  await connected(h.model)
  for (let index = 0; index < 3000; index++) h.model.write('a')
  await expect.poll(() => h.sent[0]?.length).toBe(2250)
  const first = h.sent[0]!
  expect(first.reduce((bytes, command) => bytes + encodedFrame(command), 0)).toBeLessThanOrEqual(window.maxBytes)
  for (let sequence = 1; sequence <= 1000; sequence++) h.attachments[0]!.push({ type: 'ack', sequence })
  await expect.poll(() => h.sent[0]?.length).toBe(3000)
  expect(h.sent[0]!.slice(1000).reduce((bytes, command) => bytes + encodedFrame(command), 0)).toBeLessThanOrEqual(window.maxBytes)
  expect(h.model.state.getSnapshot()).toMatchObject({ phase: 'connected', issue: undefined })
})

it('counts queued resize frames against the Client buffer and cancels unsent commands on overflow', async () => {
  const command: TerminalInput = { type: 'resize', sequence: 1, cols: 90, rows: 25 }
  const bytes = encodedFrame(command)
  const h = fixture(undefined, inputWindow(bytes))
  vi.mocked(h.remote.environment).mockResolvedValue(success({ ...environment, maxBufferedBytes: 2 * bytes }))
  await connected(h.model)
  h.model.resize(90, 25)
  h.model.resize(91, 25)
  await expect.poll(() => h.sent[0]?.length).toBe(1)
  h.model.resize(92, 25)
  expect(h.model.state.getSnapshot()).toMatchObject({ phase: 'failed', issue: 'inputFull' })
  expect(h.sent[0]).toEqual([command])
})

it('refuses a single escaped input frame larger than the carrier window before sending it', async () => {
  const h = fixture(undefined, inputWindow(150))
  await connected(h.model)
  h.model.write('\u0001'.repeat(20))
  expect(h.model.state.getSnapshot()).toMatchObject({ phase: 'failed', issue: 'inputFull' })
  expect(h.sent[0]).toEqual([])
})

it('rejects acknowledgements for commands still waiting in the Client queue', async () => {
  const h = fixture(undefined, inputWindow(120))
  await connected(h.model)
  h.model.write('a')
  h.model.write('b')
  await expect.poll(() => h.sent[0]?.length).toBe(1)
  h.attachments[0]!.push({ type: 'ack', sequence: 2 })
  await expect.poll(() => h.model.state.getSnapshot().issue).toBe('invalidOutput')
})

it('drops waiting commands when input is refused and never replays them on a new attachment', async () => {
  const h = fixture(undefined, inputWindow(120))
  await connected(h.model)
  h.model.write('a')
  h.model.write('b')
  await expect.poll(() => h.sent[0]?.length).toBe(1)
  h.attachments[0]!.push({ type: 'ack', sequence: 1, refusal: 'read-only' })
  await expect.poll(() => h.model.state.getSnapshot().writable).toBe(false)
  expect(h.sent[0]).toHaveLength(1)
  h.model.connect()
  await expect.poll(() => h.attachments.length).toBe(2)
  await expect.poll(() => h.model.state.getSnapshot().writable).toBe(true)
  acknowledge(h.model)
  h.model.write('c')
  await expect.poll(() => h.sent[1]).toEqual([{ type: 'write', sequence: 1, data: 'c' }])
})
